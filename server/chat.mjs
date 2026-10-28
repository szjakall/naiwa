/**
 * 对话：多轮会话 + 真实模型调用。
 *
 * 不做流式：控制台是单操作员工具，一次问答 10 秒内完成，流式带来的复杂度
 * （SSE 重连、半截消息落库）大于收益。要流式的话前端自己轮询即可。
 *
 * 会话内容会落库，且**不清理**——审计需要。体积靠单条消息上限控制。
 */

import { randomUUID } from "node:crypto";
import { store } from "./store.mjs";
import { contextWindowOf, normalizeUsage, profileForRole, recordLlmCall } from "./agents.mjs";

const MAX_MESSAGES = 200;
const MAX_CONTENT = 12000;

function conversations() {
	if (!Array.isArray(store.state.conversations)) store.state.conversations = [];
	return store.state.conversations;
}

export function listConversations({ archived = false } = {}) {
	return conversations()
		.filter((c) => (archived ? c.archived === true : c.archived !== true))
		.map((c) => ({
			id: c.id,
			title: c.title,
			at: c.at,
			updatedAt: c.updatedAt,
			messageCount: c.messages.length,
			preview: c.messages.length ? String(c.messages[c.messages.length - 1].content).slice(0, 80) : "",
		}))
		.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export function getConversation(id) {
	return conversations().find((c) => c.id === id) ?? null;
}

export function createConversation(title = "新对话", systemPrompt = "") {
	const conversation = {
		id: `cv${randomUUID().slice(0, 10)}`,
		title: String(title || "新对话").slice(0, 120),
		systemPrompt: String(systemPrompt ?? "").slice(0, 8000),
		messages: [],
		at: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		archived: false,
	};
	conversations().unshift(conversation);
	store.save();
	return conversation;
}

export function renameConversation(id, title) {
	const conversation = getConversation(id);
	if (!conversation) return null;
	conversation.title = String(title).slice(0, 120);
	store.save();
	return conversation;
}

export function archiveConversation(id, archived = true) {
	const conversation = getConversation(id);
	if (!conversation) return null;
	conversation.archived = archived === true;
	store.save();
	return conversation;
}

export function deleteConversation(id) {
	const list = conversations();
	const index = list.findIndex((c) => c.id === id);
	if (index < 0) return false;
	list.splice(index, 1);
	store.save();
	return true;
}

/**
 * 发一条消息并取回复。
 *
 * 角色默认用 executor；如果配了 agents 里的角色绑定，就按绑定走。
 * 没配端点时明确报错，而不是假装回答——这一点比"能用"更重要。
 */
export async function sendMessage(id, content, options = {}) {
	const conversation = getConversation(id);
	if (!conversation) throw new Error("会话不存在");
	const text = String(content ?? "").trim();
	if (!text) throw new Error("消息为空");
	if (conversation.messages.length >= MAX_MESSAGES) throw new Error("这条会话消息太多，开一条新的吧");

	const profile = profileForRole(options.role ?? "executor");
	if (!profile) {
		throw new Error("没有可用的模型端点：请到「设置 → 模型」添加一个档案并激活");
	}

	conversation.messages.push({ role: "user", content: text.slice(0, MAX_CONTENT), at: new Date().toISOString() });
	conversation.updatedAt = new Date().toISOString();
	// 首条消息自动成为标题，省一次命名
	if (conversation.title === "新对话" && conversation.messages.length === 1) {
		conversation.title = text.slice(0, 40);
	}

	const messages = [];
	if (conversation.systemPrompt) messages.push({ role: "system", content: conversation.systemPrompt });

	// 输入侧预算：上下文窗口减去留给输出的部分，超出就从最旧的一轮开始丢。
	// 原版用"上下文窗口 K"作为压缩阈值，这里沿用同一口径——不裁剪的话长会话
	// 会直接被服务商按 400 拒掉，操作员只看到一句看不懂的报错。
	const window = contextWindowOf(profile);
	const reserveOut = Math.min(Math.max(Number(profile.maxTokens) || 2048, 256), 32768);
	// 预算不能超过窗口本身：早先写成 Math.max(window - reserveOut, 1000)，
	// 配上 1K 窗口时预算反而被抬到 1000，等于没算输出预留。
	const inputBudget = Math.max(Math.min(window - reserveOut, window), 256);

	// 粗略估 token。**必须偏保守**：宁可多裁两条，也不要因为低估而超窗被服务商整条拒掉。
	// 实测中文约 0.65 token/字，英文约 0.25 token/字，这里按 1/1.8 折算再留每轮固定开销。
	const estimateOne = (text) => Math.ceil(String(text ?? "").length / 1.8) + 8;
	const estimate = (list) => list.reduce((sum, m) => sum + estimateOne(m.content), 0);

	const history = conversation.messages
		.filter((m) => !m.error)
		.map((m) => ({ role: m.role, content: m.content }));
	let trimmed = 0;
	let kept = history.slice();
	while (kept.length > 1 && estimate([...messages, ...kept]) > inputBudget) {
		kept = kept.slice(1);
		trimmed += 1;
	}
	// 单条消息就超预算时按字符硬截，否则它会永远裁不掉（只剩 1 条时循环已退出）
	if (kept.length === 1) {
		const budgetChars = Math.max(Math.floor(inputBudget * 1.6) - 40, 200);
		if (kept[0].content.length > budgetChars) {
			kept[0] = { ...kept[0], content: `${kept[0].content.slice(0, budgetChars)}\n\n（本条过长已截断）` };
			trimmed += 1;
		}
	}
	if (trimmed > 0 && kept.length > 0) {
		// 裁过就明说，避免模型"失忆"却没人知道为什么
		const dropped = history.length - kept.length;
		if (dropped > 0) {
			kept[0] = {
				...kept[0],
				content: `（此前 ${dropped} 条历史因超出上下文窗口已省略）\n\n${kept[0].content}`,
			};
		}
	}
	messages.push(...kept);

	const started = Date.now();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 120000);
	try {
		const response = await fetch(`${profile.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(profile.apiKey ? { authorization: `Bearer ${profile.apiKey}` } : {}),
			},
			body: JSON.stringify({
				model: profile.modelId,
				messages,
				temperature: options.temperature ?? 0.3,
				// 推理型模型会把 max_tokens 先花在 reasoning_content 上。给 2048 时
				// 思考就耗尽预算，content 直接是空字符串——界面上就是一条空气泡。
				// 所以默认给足；档案里配了最大输出就以档案为准。
				max_tokens: Math.min(Number(options.maxTokens ?? profile.maxTokens ?? 8192) || 8192, 32768),
				...(profile.reasoningEffort ? { reasoning_effort: profile.reasoningEffort } : {}),
			}),
			signal: controller.signal,
		});
		if (!response.ok) {
			const body = await response.text().catch(() => "");
			recordLlmCall({ ok: false });
			// 把失败也记进会话，否则刷新后看不到"这里曾经失败过"
			conversation.messages.push({
				role: "assistant",
				content: `（调用失败：HTTP ${response.status}）${body.slice(0, 300)}`,
				at: new Date().toISOString(),
				error: true,
			});
			store.save();
			throw new Error(`模型返回 ${response.status}：${body.slice(0, 200)}`);
		}
		const data = await response.json();
		const choice = data?.choices?.[0] ?? {};
		const message = choice.message ?? {};
		const usage = normalizeUsage(data?.usage);
		const finish = String(choice.finish_reason ?? "");
		const content = String(message.content ?? "");
		const reasoning = String(message.reasoning_content ?? message.reasoning ?? "");
		const reasoningTokens = usage.reasoningTokens;

		// 正文为空时不能就存个空字符串：分三种情况给出人话，否则用户只看到一条空白气泡。
		let reply = content;
		let note;
		if (!reply.trim()) {
			if (reasoning.trim()) {
				reply = reasoning;
				note = "模型只产出了推理过程，没有给出最终答复（已把推理内容显示出来）";
			} else if (finish === "length") {
				note = "模型输出被 max_tokens 截断，没有产出正文 —— 到「设置 → 模型」把「最大输出」调大，或换个非推理模型";
			} else {
				note = `模型返回了空内容（finish_reason=${finish || "未知"}）`;
			}
		} else if (finish === "length") {
			note = "输出被 max_tokens 截断";
		}
		if (trimmed > 0 && !note) note = `已省略 ${trimmed} 条超窗历史`;

		conversation.messages.push({
			role: "assistant",
			content: reply.slice(0, MAX_CONTENT),
			at: new Date().toISOString(),
			model: profile.modelId,
			// 输入 / 输出分开记：只存总量分不清"上下文太长"还是"模型啰嗦"
			inputTokens: usage.inputTokens,
			outputTokens: usage.outputTokens,
			tokens: usage.totalTokens,
			cachedTokens: usage.cachedTokens,
			finishReason: finish,
			reasoningTokens,
			...(trimmed > 0 ? { trimmedMessages: trimmed } : {}),
			...(note ? { note } : {}),
			...(note && !content.trim() ? { error: true } : {}),
		});
		conversation.updatedAt = new Date().toISOString();
		store.save();
		recordLlmCall({ ok: true, tokens: usage.totalTokens, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
		return {
			ok: true,
			reply,
			model: profile.modelId,
			elapsedMs: Date.now() - started,
			inputTokens: usage.inputTokens,
			outputTokens: usage.outputTokens,
			tokens: usage.totalTokens,
			cachedTokens: usage.cachedTokens,
			finishReason: finish,
			reasoningTokens,
			contextWindow: window,
			trimmed,
			...(note ? { note } : {}),
			conversation: { id: conversation.id, title: conversation.title },
		};
	} catch (error) {
		if (error.name === "AbortError") throw new Error("模型调用超时（120s）");
		throw error;
	} finally {
		clearTimeout(timer);
	}
}

export function stats() {
	const list = conversations();
	return {
		conversations: list.length,
		messages: list.reduce((sum, c) => sum + c.messages.length, 0),
		archived: list.filter((c) => c.archived === true).length,
	};
}
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
import { profileForRole, recordLlmCall } from "./agents.mjs";

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
	for (const message of conversation.messages) messages.push({ role: message.role, content: message.content });

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
				max_tokens: Math.min(Number(options.maxTokens ?? 2048) || 2048, 8192),
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
		const reply = String(data?.choices?.[0]?.message?.content ?? "");
		const usage = data?.usage ?? {};
		conversation.messages.push({
			role: "assistant",
			content: reply.slice(0, MAX_CONTENT),
			at: new Date().toISOString(),
			model: profile.modelId,
			tokens: Number(usage.total_tokens ?? 0),
		});
		conversation.updatedAt = new Date().toISOString();
		store.save();
		recordLlmCall({ ok: true, tokens: Number(usage.total_tokens ?? 0) });
		return {
			ok: true,
			reply,
			model: profile.modelId,
			elapsedMs: Date.now() - started,
			tokens: Number(usage.total_tokens ?? 0),
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
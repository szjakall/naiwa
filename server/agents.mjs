/**
 * Agent 定义与模型配置（对应「Agent」与「设置 → 模型」两个页面）。
 *
 * 一个 Agent = 一段角色提示词 + 一组工具 + 一个模型角色绑定。
 * 模型配置用"档案 + 角色"两层：档案是端点与密钥，角色是把某个档案指到某个用途
 * （规划/执行/守门/收尾）。这样换端点只改一处，不用每个角色都改。
 */

import { randomUUID } from "node:crypto";
import { readSettings } from "./config.mjs";
import { store } from "./store.mjs";
import { catalogIds } from "./tool-ids.mjs";

// ---------------------------------------------------------------- 模型档案

const LLM_ROLES = [
	{ id: "planner", label: "规划", hint: "拆解目标、决定下一步探索方向" },
	{ id: "executor", label: "执行", hint: "调用工具、执行具体动作" },
	{ id: "judge", label: "守门", hint: "判定动作是否破坏性（AI 审批用）" },
	{ id: "wrapup", label: "收尾", hint: "阶段总结与报告叙述" },
];

const POOL_DEFAULTS = { calls: 0, failures: 0, tokens: 0, inputTokens: 0, outputTokens: 0 };

function llm() {
	if (!store.state.llm) store.state.llm = { profiles: [], roles: {}, pool: { ...POOL_DEFAULTS } };
	const state = store.state.llm;
	if (!Array.isArray(state.profiles)) state.profiles = [];
	if (!state.roles || typeof state.roles !== "object") state.roles = {};
	if (!state.pool) state.pool = { ...POOL_DEFAULTS };
	// 老数据只有 tokens 一个总量，补上拆分项，避免前端显示 undefined
	for (const [key, value] of Object.entries(POOL_DEFAULTS)) {
		if (state.pool[key] === undefined) state.pool[key] = value;
	}
	return state;
}

/** 出服务端前把密钥掩码：只回"是否已配置"。 */
function maskProfile(profile) {
	return { ...profile, apiKey: profile.apiKey ? "••••••••" : "" };
}

export function listProfiles() {
	const state = llm();
	return state.profiles.map((profile) => ({
		...maskProfile(profile),
		active: state.roles.__active === profile.id,
		usedBy: Object.entries(state.roles)
			.filter(([role, id]) => role !== "__active" && id === profile.id)
			.map(([role]) => role),
	}));
}

/** 上下文档位：原版以 K 为单位，0/空 视为默认 200K，最大 1000K（1M）。 */
const DEFAULT_CONTEXT_K = 200;
const MAX_CONTEXT_K = 1000;

export function clampContextK(value) {
	const n = Number(value ?? 0);
	if (!Number.isFinite(n) || n <= 0) return 0; // 0 表示"用默认"
	return Math.min(Math.round(n), MAX_CONTEXT_K);
}

/** 档案的上下文窗口（token 数）。0/空 → 200K。 */
export function contextWindowOf(profile) {
	const k = clampContextK(profile?.contextWindowK) || DEFAULT_CONTEXT_K;
	return k * 1000;
}

export function upsertProfile(input) {
	const state = llm();
	const id = String(input.id ?? "").trim() || `lp${randomUUID().slice(0, 8)}`;
	const existing = state.profiles.find((p) => p.id === id);
	// 密钥三态：不传 = 保持原值；传掩码 = 保持原值；传明文 = 更新。
	// 曾经写成"不传就置空"，任何局部更新（改上下文窗口、改限速）都会顺手清掉密钥。
	const apiKey =
		input.apiKey === undefined || input.apiKey === null || input.apiKey === "••••••••"
			? existing?.apiKey ?? ""
			: String(input.apiKey);
	const profile = {
		id,
		name: String(input.name ?? "").trim() || "未命名档案",
		baseUrl: String(input.baseUrl ?? "").trim(),
		apiKey,
		modelId: String(input.modelId ?? "").trim(),
		// 以下四项对齐原版的模型档案：上下文窗口决定裁剪阈值，
		// maxTokens 决定单次输出上限，速率用于限流（0 = 不限）。
		contextWindowK: clampContextK(input.contextWindowK ?? existing?.contextWindowK),
		maxTokens: Math.min(Math.max(Number(input.maxTokens ?? existing?.maxTokens ?? 0) || 0, 0), 32768),
		ratePerSecond: Math.max(Number(input.ratePerSecond ?? existing?.ratePerSecond ?? 0) || 0, 0),
		ratePerMinute: Math.max(Number(input.ratePerMinute ?? existing?.ratePerMinute ?? 0) || 0, 0),
		reasoningEffort: String(input.reasoningEffort ?? existing?.reasoningEffort ?? "").trim(),
		at: existing?.at ?? new Date().toISOString(),
	};
	if (!profile.baseUrl) throw new Error("Base URL 不能为空");
	if (!profile.modelId) throw new Error("模型 ID 不能为空");
	if (existing) Object.assign(existing, profile);
	else state.profiles.push(profile);
	// 第一个档案自动成为激活档案，省一次点击
	if (!state.roles.__active) state.roles.__active = profile.id;
	store.save();
	return { profile: maskProfile(profile) };
}

export function deleteProfile(id) {
	const state = llm();
	const index = state.profiles.findIndex((p) => p.id === id);
	if (index < 0) return false;
	state.profiles.splice(index, 1);
	// 删掉档案后，指向它的角色要一起清空，否则会指向不存在的端点
	for (const [role, value] of Object.entries(state.roles)) {
		if (value === id) delete state.roles[role];
	}
	store.save();
	return true;
}

export function activateProfile(id) {
	const state = llm();
	if (!state.profiles.some((p) => p.id === id)) return { ok: false, error: "档案不存在" };
	state.roles.__active = id;
	store.save();
	return { ok: true };
}

export function setRole(role, profileId) {
	const state = llm();
	if (!LLM_ROLES.some((r) => r.id === role)) return { ok: false, error: "未知角色" };
	if (profileId) {
		if (!state.profiles.some((p) => p.id === profileId)) return { ok: false, error: "档案不存在" };
		state.roles[role] = profileId;
	} else {
		delete state.roles[role];
	}
	store.save();
	return { ok: true };
}

/**
 * 角色实际生效的档案：显式指定 > 激活档案 > 旧版「大模型」配置。
 *
 * 第三档是补漏：上一轮把设置页里的大模型卡片换成了模型档案，但没迁移数据，
 * 结果"填过地址和密钥却显示未配置"。迁移函数会在启动时补上，这里的兜底保证
 * 即使迁移没跑（或档案被删）也还能用旧配置。
 */
export function profileForRole(role) {
	const state = llm();
	const id = state.roles[role] ?? state.roles.__active;
	if (id) {
		const found = state.profiles.find((p) => p.id === id);
		if (found) return found;
	}
	const legacy = readSettings().llm ?? {};
	if (legacy.enabled !== false && legacy.baseUrl && legacy.model && legacy.apiKey) {
		return {
			id: "legacy",
			name: "旧配置（大模型）",
			baseUrl: legacy.baseUrl,
			apiKey: legacy.apiKey,
			modelId: legacy.model,
		};
	}
	return null;
}

/**
 * 启动时把旧版 LLM 配置迁成模型档案。
 *
 * 只在"一个档案都没有"时动手：已有的档案是操作员明确配的，不能被旧值覆盖。
 */
export function migrateLegacyLlm() {
	const state = llm();
	if (state.profiles.length > 0) return { migrated: false, reason: "已有档案" };
	const legacy = readSettings().llm ?? {};
	if (!legacy.baseUrl || !legacy.model) return { migrated: false, reason: "旧配置不完整" };
	const profile = {
		id: "lp-legacy",
		name: "迁移自旧配置",
		baseUrl: String(legacy.baseUrl).trim(),
		apiKey: String(legacy.apiKey ?? ""),
		modelId: String(legacy.model).trim(),
		at: new Date().toISOString(),
	};
	state.profiles.push(profile);
	state.roles.__active = profile.id;
	store.save();
	store.log("info", `已把旧的 LLM 配置迁移为模型档案：${profile.baseUrl} / ${profile.modelId}`);
	return { migrated: true, profile: maskProfile(profile) };
}

export function llmState() {
	const state = llm();
	const legacy = readSettings().llm ?? {};
	const legacyComplete = Boolean(legacy.baseUrl && legacy.model && legacy.apiKey);
	const effective = profileForRole("executor");
	return {
		profiles: listProfiles(),
		roles: LLM_ROLES.map((role) => ({
			...role,
			profileId: state.roles[role.id] ?? null,
			effective: profileForRole(role.id) ? maskProfile(profileForRole(role.id)) : null,
		})),
		active: state.roles.__active ?? null,
		// 有没有一个"实际可用"的端点：档案或旧配置任一存在即可。
		// 前端用它决定"去配置"的提示要不要显示，光看 active 会把迁移场景误判成未配置。
		available: Boolean(effective),
		effectiveFrom: effective ? { id: effective.id, name: effective.name, modelId: effective.modelId } : null,
		legacy: {
			configured: legacyComplete,
			baseUrl: legacyComplete ? legacy.baseUrl : "",
			modelId: legacyComplete ? legacy.model : "",
			// 旧配置在兜底生效时告诉前端一声，避免"我明明配了却显示未配置"
			inUse: effective?.id === "legacy",
		},
		pool: state.pool,
	};
}

/**
 * 把各家 usage 结构归一成「输入 / 输出 / 缓存 / 推理」四项。
 *
 * 不同服务商返回的字段名不统一，混着用会导致统计口径漂移：
 *   OpenAI 兼容：prompt_tokens / completion_tokens / total_tokens，
 *                细节在 prompt_tokens_details.cached_tokens、completion_tokens_details.reasoning_tokens
 *   Anthropic ：input_tokens / output_tokens，缓存单列 cache_read_input_tokens /
 *                cache_creation_input_tokens（这两项算输入侧）
 * 任何一项缺失都不该让统计崩掉，缺就是 0。
 */
export function normalizeUsage(usage) {
	const u = usage ?? {};
	const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
	const input =
		num(u.prompt_tokens) ||
		num(u.input_tokens) ||
		num(u.promptTokens) ||
		num(u.inputTokens) ||
		0;
	const output =
		num(u.completion_tokens) ||
		num(u.output_tokens) ||
		num(u.completionTokens) ||
		num(u.outputTokens) ||
		0;
	const cached = num(u.prompt_tokens_details?.cached_tokens) + num(u.cache_read_input_tokens);
	const cacheWrite = num(u.cache_creation_input_tokens);
	const reasoning = num(u.completion_tokens_details?.reasoning_tokens);
	// total 优先用服务商给的；没给就自己加，避免出现"有输入输出但总量为 0"。
	const total = num(u.total_tokens) || input + output;
	return { inputTokens: input, outputTokens: output, totalTokens: total, cachedTokens: cached, cacheWriteTokens: cacheWrite, reasoningTokens: reasoning };
}

export function recordLlmCall({ ok, tokens, inputTokens, outputTokens }) {
	const state = llm();
	const pool = state.pool;
	pool.calls += 1;
	if (!ok) pool.failures += 1;
	if (tokens) pool.tokens += tokens;
	// 输入输出分开累计：只看总量无法判断是"上下文太长"还是"模型啰嗦"。
	if (inputTokens) pool.inputTokens = (pool.inputTokens ?? 0) + inputTokens;
	if (outputTokens) pool.outputTokens = (pool.outputTokens ?? 0) + outputTokens;
	store.save();
}

export function resetPool() {
	llm().pool = { calls: 0, failures: 0, tokens: 0, inputTokens: 0, outputTokens: 0 };
	store.save();
	return { ok: true };
}

/** 真调一次 chat completions，验证端点是否可用。 */
export async function testProfile(id) {
	// 支持测"旧配置"本身：前端在只有 legacy 时也能点测试
	const profile =
		id === "legacy"
			? profileForRole("executor")
			: llm().profiles.find((p) => p.id === id);
	if (!profile) return { ok: false, message: "档案不存在" };
	const started = Date.now();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 20000);
	try {
		const response = await fetch(`${profile.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(profile.apiKey ? { authorization: `Bearer ${profile.apiKey}` } : {}),
			},
			body: JSON.stringify({
				model: profile.modelId,
				messages: [{ role: "user", content: "只回复两个字：可用" }],
				max_tokens: 16,
				temperature: 0,
			}),
			signal: controller.signal,
		});
		const elapsed = Date.now() - started;
		if (!response.ok) {
			const body = await response.text().catch(() => "");
			recordLlmCall({ ok: false });
			// 把上游原文带出来：503 是"服务方不可用"、401 是"密钥不对"、
			// 404 常常是"模型名不存在"，三种处理方式完全不同，只给状态码没法排查。
			let hint = "";
			if (response.status === 503) hint = "（服务端不可用：通常是上游模型宕机或账号额度用尽，与本地配置无关）";
			else if (response.status === 401 || response.status === 403) hint = "（密钥无效或无权限）";
			else if (response.status === 404) hint = "（路径或模型名不对：确认 Base URL 是否带 /v1、模型 ID 是否存在）";
			return {
				ok: false,
				message: `端点返回 ${response.status}${hint}（${elapsed}ms）`,
				detail: body.slice(0, 400),
			};
		}
		const data = await response.json();
		const content = data?.choices?.[0]?.message?.content ?? "";
		const usage = normalizeUsage(data?.usage);
		recordLlmCall({ ok: true, tokens: usage.totalTokens, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
		return {
			ok: true,
			message: `可用：${profile.name} · ${profile.modelId}（${elapsed}ms，输入 ${usage.inputTokens} / 输出 ${usage.outputTokens} tokens）`,
			detail: String(content).slice(0, 200),
		};
	} catch (error) {
		recordLlmCall({ ok: false });
		const reason = error.name === "AbortError" ? "请求超时（20s）" : error.message;
		return { ok: false, message: `调用失败：${reason}` };
	} finally {
		clearTimeout(timer);
	}
}

// ---------------------------------------------------------------- Agent

const DEFAULT_TOOLS = catalogIds();

function agents() {
	if (!Array.isArray(store.state.agents)) store.state.agents = [];
	return store.state.agents;
}

export function listAgents() {
	return agents().map((agent) => ({ ...agent, toolCount: (agent.tools ?? []).length }));
}

export function getAgent(key) {
	return agents().find((a) => a.key === key) ?? null;
}

export function upsertAgent(input) {
	const key = String(input.key ?? "").trim() || `agent-${randomUUID().slice(0, 6)}`;
	if (!/^[a-z0-9][a-z0-9_-]{1,40}$/i.test(key)) throw new Error("key 只能是字母数字与下划线/短横线");
	const list = agents();
	const existing = list.find((a) => a.key === key);
	const agent = {
		key,
		name: String(input.name ?? "").trim() || key,
		description: String(input.description ?? "").slice(0, 500),
		systemPrompt: String(input.systemPrompt ?? "").slice(0, 8000),
		modelRole: ["planner", "executor", "judge", "wrapup"].includes(input.modelRole) ? input.modelRole : "executor",
		tools: Array.isArray(input.tools) ? input.tools.filter((t) => typeof t === "string") : existing?.tools ?? DEFAULT_TOOLS,
		maxTurns: Math.min(Math.max(Number(input.maxTurns ?? existing?.maxTurns ?? 40), 1), 200),
		enabled: input.enabled === undefined ? existing?.enabled !== false : input.enabled === true,
		at: existing?.at ?? new Date().toISOString(),
	};
	if (existing) Object.assign(existing, agent);
	else list.push(agent);
	store.save();
	return { agent };
}

export function deleteAgent(key) {
	const list = agents();
	const index = list.findIndex((a) => a.key === key);
	if (index < 0) return false;
	list.splice(index, 1);
	store.save();
	return true;
}

export { LLM_ROLES };
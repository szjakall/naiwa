/**
 * Web 搜索与页面抓取（Tavily）。
 *
 * 为什么单独一家而不是聚合：搜索 API 的质量差异很大，聚合反而让"哪家给的"
 * 变模糊，情报溯源时不好交代。这里只接一家，响应原样留档。
 */

import { store } from "./store.mjs";

function cfg() {
	if (!store.state.webSearch) {
		store.state.webSearch = { enabled: false, keys: [], history: [] };
	}
	const state = store.state.webSearch;
	if (!Array.isArray(state.keys)) state.keys = [];
	if (!Array.isArray(state.history)) state.history = [];
	return state;
}

export function state() {
	const state = cfg();
	return {
		enabled: state.enabled === true,
		keyCount: state.keys.length,
		// 密钥只回尾号，避免整串泄露
		keys: state.keys.map((k) => ({ id: k.id, mask: `••••${k.key.slice(-4)}`, at: k.at, uses: k.uses ?? 0 })),
		available: state.enabled === true && state.keys.length > 0,
		history: state.history.slice(0, 20),
	};
}

export function addKey(key) {
	const value = String(key ?? "").trim();
	if (value.length < 10) throw new Error("密钥格式不对");
	const state = cfg();
	if (state.keys.some((k) => k.key === value)) return { ok: true, duplicate: true };
	state.keys.push({ id: `wk${Date.now().toString(36)}`, key: value, at: new Date().toISOString(), uses: 0 });
	store.save();
	return { ok: true };
}

export function removeKey(id) {
	const state = cfg();
	const index = state.keys.findIndex((k) => k.id === id);
	if (index < 0) return false;
	state.keys.splice(index, 1);
	store.save();
	return true;
}

export function setEnabled(enabled) {
	cfg().enabled = enabled === true;
	store.save();
	return { ok: true };
}

/** 号池轮换：按使用次数取最少的那把。 */
function pickKey() {
	const state = cfg();
	const available = [...state.keys].sort((a, b) => (a.uses ?? 0) - (b.uses ?? 0));
	return available[0] ?? null;
}

function record(entry) {
	const state = cfg();
	state.history.unshift({ id: `wh${Date.now().toString(36)}`, at: new Date().toISOString(), ...entry });
	if (state.history.length > 100) state.history.splice(100);
	store.save();
}

/** 搜索。 */
export async function search(query, options = {}) {
	const state = cfg();
	if (!state.enabled) throw new Error("Web 搜索未启用");
	const key = pickKey();
	if (!key) throw new Error("没有可用的搜索密钥");
	const started = Date.now();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 25000);
	try {
		const response = await fetch("https://api.tavily.com/search", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				api_key: key.key,
				query,
				search_depth: options.deep === true ? "advanced" : "basic",
				max_results: Math.min(Math.max(Number(options.limit ?? 8) || 8, 1), 20),
				include_answer: true,
			}),
			signal: controller.signal,
		});
		const elapsed = Date.now() - started;
		const text = await response.text();
		let data;
		try {
			data = JSON.parse(text);
		} catch {
			throw new Error(`返回不是 JSON（HTTP ${response.status}）`);
		}
		if (!response.ok) {
			// 额度耗尽等错误要把原始信息带出来，否则只能看到"失败"
			record({ ok: false, query, error: text.slice(0, 200), elapsedMs: elapsed });
			throw new Error(`Tavily 返回 HTTP ${response.status}：${String(data.detail ?? data.error ?? text).slice(0, 200)}`);
		}
		key.uses = (key.uses ?? 0) + 1;
		const results = (data.results ?? []).map((item) => ({
			title: item.title ?? "",
			url: item.url ?? "",
			content: String(item.content ?? "").slice(0, 1500),
			score: item.score ?? 0,
		}));
		record({ ok: true, query, hits: results.length, elapsedMs: elapsed });
		return { ok: true, query, answer: data.answer ?? "", results, elapsedMs: elapsed };
	} finally {
		clearTimeout(timer);
	}
}

/** 抓页面正文：拿到 HTML 后做一次去标签。 */
export async function extract(url) {
	const started = Date.now();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 20000);
	try {
		const response = await fetch(url, {
			signal: controller.signal,
			headers: {
				"user-agent": "Mozilla/5.0 (compatible; regedit-console/1.0)",
				accept: "text/html,application/xhtml+xml,*/*;q=0.8",
			},
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const html = await response.text();
		const title = /<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(html)?.[1]?.trim() ?? "";
		const text = html
			.replace(/<script[\s\S]*?<\/script>/gi, " ")
			.replace(/<style[\s\S]*?<\/style>/gi, " ")
			.replace(/<[^>]+>/g, " ")
			.replace(/&nbsp;/g, " ")
			.replace(/&amp;/g, "&")
			.replace(/&lt;/g, "<")
			.replace(/&gt;/g, ">")
			.replace(/&quot;/g, '"')
			.replace(/\s+/g, " ")
			.trim();
		return {
			ok: true,
			url,
			title,
			text: text.slice(0, 20000),
			truncated: text.length > 20000,
			elapsedMs: Date.now() - started,
		};
	} finally {
		clearTimeout(timer);
	}
}
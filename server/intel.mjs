/**
 * 公网资产测绘：FOFA / 360 Quake / 奇安信 Hunter。
 *
 * 三家的查询语法各不相同，所以这里只做"透传查询串 + 归一化结果"：
 * 保留各自的 query 语法，把返回字段拉平成统一的 {host, ip, port, title, ...}。
 *
 * 密钥只存服务端，出接口时掩码；每次查询记一条流水（谁、什么语法、命中多少）。
 */

import { store } from "./store.mjs";

export const PLATFORMS = {
	fofa: {
		label: "FOFA",
		hint: "查询语法如 app=\"nginx\" && country=\"CN\"",
		official: "https://fofa.info",
		docs: "https://fofa.info/api",
	},
	quake: {
		label: "360 Quake",
		hint: "查询语法如 app:\"nginx\" AND country:\"China\"",
		official: "https://quake.360.net",
		docs: "https://quake.360.net/quake/#/help",
	},
	hunter: {
		label: "奇安信 Hunter",
		hint: "查询语法如 web.title=\"后台\" && ip.port=\"80\"",
		official: "https://hunter.qianxin.com",
		docs: "https://hunter.qianxin.com/home/Help",
	},
};

function intel() {
	if (!store.state.intel) store.state.intel = { platforms: {}, history: [] };
	const state = store.state.intel;
	if (!state.platforms || typeof state.platforms !== "object") state.platforms = {};
	if (!Array.isArray(state.history)) state.history = [];
	return state;
}

function configOf(id) {
	return intel().platforms[id] ?? { enabled: false, key: "", baseUrl: "", verified: false, verifiedAt: null };
}

export function listPlatforms() {
	return Object.entries(PLATFORMS).map(([id, meta]) => {
		const config = configOf(id);
		return {
			id,
			...meta,
			enabled: config.enabled === true,
			// 密钥不出服务端
			hasKey: Boolean(config.key),
			keyMask: config.key ? `${config.key.slice(0, 4)}••••${config.key.slice(-4)}` : "",
			baseUrl: config.baseUrl ?? "",
			verified: config.verified === true,
			verifiedAt: config.verifiedAt ?? null,
			// 只有"启用 + 有密钥 + 验证通过"才真正可用
			available: config.enabled === true && Boolean(config.key) && config.verified === true,
		};
	});
}

export function savePlatform(id, patch) {
	if (!PLATFORMS[id]) return { ok: false, error: "未知平台" };
	const state = intel();
	const current = configOf(id);
	const key = patch.key === "••••••••" || patch.key === undefined ? current.key : String(patch.key);
	state.platforms[id] = {
		enabled: patch.enabled === undefined ? current.enabled : patch.enabled === true,
		key,
		baseUrl: patch.baseUrl === undefined ? current.baseUrl : String(patch.baseUrl).trim(),
		// 换了密钥或地址就要重新验证
		verified: key === current.key && (patch.baseUrl === undefined || patch.baseUrl === current.baseUrl) ? current.verified : false,
		verifiedAt: current.verifiedAt,
	};
	store.save();
	return { ok: true, platform: listPlatforms().find((p) => p.id === id) };
}

/** 归一化 FOFA 的响应。 */
function normalizeFofa(data) {
	const results = Array.isArray(data.results) ? data.results : [];
	return results.map((row) => ({
		host: row.host ?? "",
		ip: row.ip ?? "",
		port: row.port ?? "",
		title: row.title ?? "",
		server: row.server ?? "",
		protocol: row.protocol ?? "",
		country: row.country ?? "",
		domain: row.domain ?? "",
		updated: row.lastupdatetime ?? "",
		raw: row,
	}));
}

function normalizeQuake(data) {
	const results = Array.isArray(data.data) ? data.data : [];
	return results.map((row) => ({
		host: row.service?.http?.host ?? row.ip ?? "",
		ip: row.ip ?? "",
		port: row.port ?? "",
		title: row.service?.http?.title ?? "",
		server: row.service?.http?.server ?? "",
		protocol: row.service?.name ?? "",
		country: row.location?.country_cn ?? "",
		domain: row.domain ?? "",
		updated: row.time ?? "",
		raw: row,
	}));
}

function normalizeHunter(data) {
	const results = Array.isArray(data.data?.arr) ? data.data.arr : [];
	return results.map((row) => ({
		host: row.url ?? "",
		ip: row.ip ?? "",
		port: row.port ?? "",
		title: row.web_title ?? "",
		server: row.web_server ?? "",
		protocol: row.protocol ?? "",
		country: row.country ?? "",
		domain: row.domain ?? "",
		updated: row.updated_at ?? "",
		raw: row,
	}));
}

function base64Url(text) {
	return Buffer.from(String(text), "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 真查一次。返回归一化结果 + 原始响应摘录。 */
export async function query(id, queryText, options = {}) {
	if (!PLATFORMS[id]) throw new Error("未知平台");
	const config = configOf(id);
	if (config.enabled !== true) throw new Error(`${PLATFORMS[id].label} 未启用`);
	if (!config.key) throw new Error(`${PLATFORMS[id].label} 未配置密钥`);
	const size = Math.min(Math.max(Number(options.size ?? 20) || 20, 1), 100);
	const qbase = config.baseUrl || "";

	let url;
	const headers = { accept: "application/json" };
	if (id === "fofa") {
		// FOFA: qbase64=base64url(query)，key 走 query 参数
		url = `${qbase || "https://fofa.info"}/api/v1/search/all?key=${encodeURIComponent(config.key)}&qbase64=${base64Url(queryText)}&size=${size}&fields=host,ip,port,title,server,protocol,country,domain,lastupdatetime`;
	} else if (id === "quake") {
		url = `${qbase || "https://quake.360.net"}/api/v3/search/quake_service`;
		headers["X-QuakeToken"] = config.key;
		headers["content-type"] = "application/json";
	} else {
		url = `${qbase || "https://hunter.qianxin.com"}/openApi/search?api-key=${encodeURIComponent(config.key)}&search=${encodeURIComponent(queryText)}&page_size=${size}`;
	}

	const started = Date.now();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 25000);
	try {
		const init = { method: id === "quake" ? "POST" : "GET", headers, signal: controller.signal };
		if (id === "quake") init.body = JSON.stringify({ query: queryText, start: 0, size });
		const response = await fetch(url, init);
		const elapsed = Date.now() - started;
		const text = await response.text();
		let data;
		try {
			data = JSON.parse(text);
		} catch {
			throw new Error(`返回不是 JSON（HTTP ${response.status}）`);
		}
		if (!response.ok) {
			throw new Error(`${PLATFORMS[id].label} 返回 HTTP ${response.status}：${text.slice(0, 200)}`);
		}
		// 三家都有各自的错误码字段
		const apiError = data?.error || (data?.code && data.code !== 0 && data.code !== 200 ? data.message : null);
		if (apiError) throw new Error(`${PLATFORMS[id].label}：${String(apiError).slice(0, 200)}`);

		const results =
			id === "fofa" ? normalizeFofa(data) : id === "quake" ? normalizeQuake(data) : normalizeHunter(data);

		intel().history.unshift({
			id: `iq${Date.now().toString(36)}`,
			at: new Date().toISOString(),
			platform: id,
			query: queryText,
			hits: results.length,
			elapsedMs: elapsed,
			ok: true,
		});
		// 流水只留最近 200 条，这是操作记录不是数据资产
		if (intel().history.length > 200) intel().history.splice(200);
		store.save();
		return { ok: true, platform: id, query: queryText, results, elapsedMs: elapsed, total: data?.total ?? results.length };
	} finally {
		clearTimeout(timer);
	}
}

/** 验证密钥：用一个必然有结果的宽泛查询。 */
export async function verify(id) {
	const probes = { fofa: 'app="nginx"', quake: 'app:"nginx"', hunter: 'web.title="nginx"' };
	try {
		const result = await query(id, probes[id], { size: 1 });
		const state = intel();
		state.platforms[id].verified = true;
		state.platforms[id].verifiedAt = new Date().toISOString();
		store.save();
		return { ok: true, message: `验证通过（${result.elapsedMs}ms，返回 ${result.results.length} 条）` };
	} catch (error) {
		const state = intel();
		if (state.platforms[id]) state.platforms[id].verified = false;
		store.save();
		return { ok: false, message: error.message };
	}
}

export function history() {
	return intel().history.slice(0, 100);
}
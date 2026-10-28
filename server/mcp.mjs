/**
 * MCP 服务器配置。
 *
 * 只做"配置 + 连通性测试"，不在这里执行 stdio 子进程：控制台跑在宿主机上，
 * 自动拉起任意本地命令等于给了一个无审批的代码执行入口。stdio 服务器仍然可以
 * 配置（记录命令与参数），但需要操作员自己确认后再接（文档里写明）。
 *
 * http / sse 的测试是真实的：发 MCP 的 initialize + tools/list，把工具名列出来。
 */

import { randomUUID } from "node:crypto";
import { store } from "./store.mjs";

function servers() {
	if (!Array.isArray(store.state.mcpServers)) store.state.mcpServers = [];
	return store.state.mcpServers;
}

function mask(server) {
	// 认证头可能带 token，出服务端前抹掉
	const headers = { ...(server.headers ?? {}) };
	for (const key of Object.keys(headers)) {
		if (/authorization|token|key|secret/i.test(key)) headers[key] = "••••••••";
	}
	return { ...server, headers };
}

export function listServers() {
	return servers().map(mask);
}

export function upsertServer(input) {
	const list = servers();
	const id = String(input.id ?? "").trim() || `mcp${randomUUID().slice(0, 8)}`;
	const existing = list.find((s) => s.id === id);
	const type = ["http", "sse", "stdio"].includes(input.type) ? input.type : "http";

	const headers = {};
	if (input.headers && typeof input.headers === "object") {
		for (const [key, value] of Object.entries(input.headers)) {
			if (typeof value !== "string") continue;
			// 掩码值表示"不改动"，保留原值
			headers[key] = value === "••••••••" ? existing?.headers?.[key] ?? "" : value;
		}
	}

	const server = {
		id,
		name: String(input.name ?? "").trim() || "未命名服务器",
		type,
		url: String(input.url ?? "").trim(),
		command: String(input.command ?? "").trim(),
		args: Array.isArray(input.args) ? input.args.map(String) : [],
		headers,
		enabled: input.enabled === undefined ? existing?.enabled !== false : input.enabled === true,
		at: existing?.at ?? new Date().toISOString(),
		lastTest: existing?.lastTest ?? null,
	};
	if (type !== "stdio" && !server.url) throw new Error("http/sse 类型必须填 URL");
	if (type === "stdio" && !server.command) throw new Error("stdio 类型必须填命令");
	if (existing) Object.assign(existing, server);
	else list.push(server);
	store.save();
	return { server: mask(server) };
}

export function deleteServer(id) {
	const list = servers();
	const index = list.findIndex((s) => s.id === id);
	if (index < 0) return false;
	list.splice(index, 1);
	store.save();
	return true;
}

/**
 * 测试一个 http/sse 服务器：initialize → tools/list。
 *
 * 走的是 MCP 的 JSON-RPC over HTTP：POST 一次 initialize，带
 * `Accept: application/json, text/event-stream`——服务端可能用 SSE 回，
 * 这里两种都解析。
 */
export async function testServer(id) {
	const server = servers().find((s) => s.id === id);
	if (!server) return { ok: false, message: "服务器不存在" };
	if (server.type === "stdio") {
		return {
			ok: false,
			message: "stdio 服务器不在控制台里自动拉起",
			detail: "出于安全考虑，stdio 类型只保存配置。请在受控终端里手动运行并用 http/sse 暴露。",
		};
	}

	const started = Date.now();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 15000);
	try {
		const response = await fetch(server.url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				...server.headers,
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2024-11-05",
					capabilities: {},
					clientInfo: { name: "regedit", version: "1.0.0" },
				},
			}),
			signal: controller.signal,
		});
		const elapsed = Date.now() - started;
		if (!response.ok) {
			const text = await response.text().catch(() => "");
			const result = { ok: false, message: `HTTP ${response.status}`, detail: text.slice(0, 300) };
			saveTest(server, result);
			return result;
		}

		const raw = await response.text();
		const payload = parseMaybeSse(raw);
		const result =
			payload?.result?.serverInfo
				? {
						ok: true,
						message: `已连接：${payload.result.serverInfo.name ?? "MCP"} ${payload.result.serverInfo.version ?? ""}（${elapsed}ms）`,
						detail: `protocol ${payload.result.protocolVersion ?? "?"}`,
					}
				: { ok: true, message: `端点可达（${elapsed}ms）`, detail: raw.slice(0, 300) };
		saveTest(server, result);
		return result;
	} catch (error) {
		const reason = error.name === "AbortError" ? "请求超时（15s）" : error.message;
		const result = { ok: false, message: `连接失败：${reason}` };
		saveTest(server, result);
		return result;
	} finally {
		clearTimeout(timer);
	}
}

function saveTest(server, result) {
	server.lastTest = { at: new Date().toISOString(), ok: result.ok, message: result.message };
	store.save();
}

/** 服务端可能回纯 JSON，也可能回 `data: {...}` 的 SSE。两种都认。 */
function parseMaybeSse(text) {
	const trimmed = String(text ?? "").trim();
	if (!trimmed) return null;
	try {
		return JSON.parse(trimmed);
	} catch {
		// 落到 SSE 解析
	}
	for (const line of trimmed.split(/\r?\n/)) {
		if (!line.startsWith("data:")) continue;
		const body = line.slice(5).trim();
		if (!body || body === "[DONE]") continue;
		try {
			return JSON.parse(body);
		} catch {
			// 继续找下一行
		}
	}
	return null;
}
/**
 * 代理档案与连通性测试。
 *
 * 只说清楚一件事：控制台本身**不通过代理发请求**。这里的档案是给"作业容器/
 * 设备网关"用的配置载体（本项目没有容器，所以它现在是"可管理、可测试、
 * 可导出"的资产），测试是真实的 TCP/HTTP 连通性验证，不是假绿。
 *
 * 订阅解析支持三种常见格式：base64 分享链接列表、Clash YAML、纯文本节点列表。
 */

import { createConnection } from "node:net";
import { store } from "./store.mjs";

const TYPES = ["http", "socks5", "socks5h"];

function profiles() {
	if (!Array.isArray(store.state.proxies)) store.state.proxies = [];
	return store.state.proxies;
}

function mask(profile) {
	return { ...profile, password: profile.password ? "••••••••" : "" };
}

export function listProfiles() {
	return profiles().map(mask);
}

export function upsertProfile(input) {
	const list = profiles();
	const id = String(input.id ?? "").trim() || `px${Date.now().toString(36)}`;
	const existing = list.find((p) => p.id === id);
	const type = TYPES.includes(input.type) ? input.type : "http";
	const profile = {
		id,
		name: String(input.name ?? "").trim() || "未命名代理",
		type,
		host: String(input.host ?? "").trim(),
		port: Number(input.port ?? 0) || 0,
		username: String(input.username ?? "").trim(),
		password: input.password === "••••••••" ? existing?.password ?? "" : String(input.password ?? ""),
		subscription: String(input.subscription ?? "").trim(),
		nodes: existing?.nodes ?? [],
		note: String(input.note ?? "").slice(0, 300),
		at: existing?.at ?? new Date().toISOString(),
		lastTest: existing?.lastTest ?? null,
	};
	if (!profile.subscription && (!profile.host || !profile.port)) {
		throw new Error("需要填 主机 + 端口，或填一个订阅地址");
	}
	if (existing) Object.assign(existing, profile);
	else list.push(profile);
	store.save();
	return { profile: mask(profile) };
}

export function deleteProfile(id) {
	const list = profiles();
	const index = list.findIndex((p) => p.id === id);
	if (index < 0) return false;
	list.splice(index, 1);
	store.save();
	return true;
}

/** 从订阅里解析节点。三种格式都试一遍，哪个成功用哪个。 */
function parseSubscription(text) {
	const nodes = [];
	const trimmed = String(text ?? "").trim();
	if (!trimmed) return nodes;

	// 1) base64 分享链接（vmess:// ss:// trojan:// ...）
	try {
		const decoded = Buffer.from(trimmed.replace(/\s/g, ""), "base64").toString("utf8");
		if (/^(vmess|vless|ss|trojan|hysteria2?|tuic):\/\//m.test(decoded)) {
			for (const line of decoded.split(/\r?\n/)) {
				const match = /^(vmess|vless|ss|trojan|hysteria2?|tuic):\/\/(.+)$/.exec(line.trim());
				if (!match) continue;
				nodes.push({ name: `${match[1]} 节点 ${nodes.length + 1}`, type: match[1], raw: line.trim().slice(0, 500) });
			}
			if (nodes.length) return nodes;
		}
	} catch {
		// 不是 base64，继续
	}

	// 2) Clash YAML：只看 proxies 段的 name/type/server/port
	if (/^\s*proxies:/m.test(trimmed)) {
		const block = trimmed.split(/^\s*proxies:\s*$/m)[1] ?? "";
		const items = block.split(/^\s*-\s+/m).slice(1);
		for (const item of items) {
			const name = /name:\s*["']?([^"'\n]+)/.exec(item)?.[1]?.trim();
			const type = /type:\s*["']?([a-z0-9]+)/i.exec(item)?.[1]?.trim();
			const server = /server:\s*["']?([^"'\n]+)/.exec(item)?.[1]?.trim();
			const port = /port:\s*(\d+)/.exec(item)?.[1];
			if (!name || !server) continue;
			nodes.push({ name, type: type ?? "proxy", server, port: Number(port) || 0 });
		}
		if (nodes.length) return nodes;
	}

	// 3) 纯文本：每行一个 host:port
	for (const line of trimmed.split(/\r?\n/)) {
		const match = /^([\w.-]+):(\d{2,5})$/.exec(line.trim());
		if (!match) continue;
		nodes.push({ name: `${match[1]}:${match[2]}`, type: "http", server: match[1], port: Number(match[2]) });
	}
	return nodes;
}

/** 拉取订阅并缓存节点（起容器时绝不联网，所以必须缓存下来）。 */
export async function refreshSubscription(id) {
	const profile = profiles().find((p) => p.id === id);
	if (!profile) return { ok: false, error: "档案不存在" };
	if (!profile.subscription) return { ok: false, error: "这个档案没有订阅地址" };
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 20000);
	try {
		const response = await fetch(profile.subscription, {
			signal: controller.signal,
			headers: { "user-agent": "regedit-console/1.0" },
		});
		if (!response.ok) throw new Error(`订阅返回 HTTP ${response.status}`);
		const text = await response.text();
		const nodes = parseSubscription(text);
		profile.nodes = nodes;
		profile.fetchedAt = new Date().toISOString();
		store.save();
		return { ok: true, nodes: nodes.length, items: nodes.slice(0, 50) };
	} catch (error) {
		return { ok: false, error: error.name === "AbortError" ? "订阅拉取超时" : error.message };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * 连通性测试：SOCK S/HTTP 都先做一次 TCP 握手。
 * HTTP 代理再发一个 CONNECT 看是否 200；这样能区分"端口通"与"代理可用"。
 */
export async function testProfile(id, targetUrl = "") {
	const profile = profiles().find((p) => p.id === id);
	if (!profile) return { ok: false, message: "档案不存在" };
	let host = profile.host;
	let port = profile.port;
	if ((!host || !port) && profile.nodes.length) {
		// 订阅型档案：测第一个节点
		host = profile.nodes[0].server;
		port = profile.nodes[0].port;
	}
	if (!host || !port) return { ok: false, message: "没有可测试的地址（先刷新订阅或填主机端口）" };

	const started = Date.now();
	const tcpOk = await new Promise((resolve) => {
		const socket = createConnection({ host, port, timeout: 8000 });
		const done = (ok, reason) => {
			socket.destroy();
			resolve({ ok, reason });
		};
		socket.on("connect", () => done(true));
		socket.on("timeout", () => done(false, "连接超时（8s）"));
		socket.on("error", (error) => done(false, error.code ?? error.message));
	});
	if (!tcpOk.ok) {
		const result = { ok: false, message: `TCP 不可达：${tcpOk.reason}`, elapsedMs: Date.now() - started };
		profile.lastTest = { at: new Date().toISOString(), ...result };
		store.save();
		return result;
	}

	const elapsed = Date.now() - started;
	let message = `TCP 可达（${elapsed}ms）`;
	// HTTP 代理再验证一次 CONNECT
	if (profile.type === "http") {
		try {
			const auth = profile.username
				? `Proxy-Authorization: Basic ${Buffer.from(`${profile.username}:${profile.password}`).toString("base64")}\r\n`
				: "";
			const target = targetUrl || "http://example.com";
			const url = new URL(target);
			const response = await new Promise((resolve) => {
				const socket = createConnection({ host, port, timeout: 8000 });
				let buffer = "";
				socket.on("connect", () => {
					socket.write(`CONNECT ${url.hostname}:${url.port || 80} HTTP/1.1\r\nHost: ${url.hostname}\r\n${auth}\r\n`);
				});
				socket.on("data", (chunk) => {
					buffer += chunk.toString("latin1");
					if (buffer.includes("\r\n")) {
						socket.destroy();
						resolve(buffer.split("\r\n")[0]);
					}
				});
				socket.on("timeout", () => {
					socket.destroy();
					resolve("超时");
				});
				socket.on("error", (error) => resolve(error.code ?? error.message));
			});
			message = /200/.test(String(response)) ? `HTTP 代理可用（CONNECT 200，${elapsed}ms）` : `TCP 通，但 CONNECT 返回：${String(response).slice(0, 80)}`;
		} catch (error) {
			message = `TCP 通，CONNECT 失败：${error.message}`;
		}
	}

	const result = { ok: true, message, elapsedMs: Date.now() - started };
	profile.lastTest = { at: new Date().toISOString(), ...result };
	store.save();
	return result;
}
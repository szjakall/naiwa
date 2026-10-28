/**
 * 通知渠道：Webhook / 邮件（SMTP）。
 *
 * 只做两件事：存配置、真发一条测试。触发点目前接在"守门拦截""任务完成"上，
 * 因为这两件事才是无人值守时真的需要叫人的。
 */

import { store } from "./store.mjs";

const KINDS = {
	webhook: { label: "Webhook", hint: "POST 一个 JSON 到指定地址（钉钉/飞书/自建均可）" },
	email: { label: "邮件", hint: "通过 SMTP 发送纯文本邮件" },
};

const DEFAULT_TRIGGERS = { gate_block: true, task_done: false, device_offline: true };

function notify() {
	if (!store.state.notify) store.state.notify = { channels: [], history: [], triggers: {} };
	const state = store.state.notify;
	if (!Array.isArray(state.channels)) state.channels = [];
	if (!Array.isArray(state.history)) state.history = [];
	if (!state.triggers || typeof state.triggers !== "object") state.triggers = {};
	// 逐个补默认值：只在"整段缺失"时初始化会被空对象绕过（`{}` 也是 object），
	// 结果所有触发点都读成 false，通知永远不发。
	for (const [id, enabled] of Object.entries(DEFAULT_TRIGGERS)) {
		if (state.triggers[id] === undefined) state.triggers[id] = enabled;
	}
	return state;
}

export const TRIGGERS = [
	{ id: "gate_block", label: "守门拦截时", hint: "AI 审批判定 BLOCK" },
	{ id: "task_done", label: "任务完成时", hint: "任务跑完一轮" },
	{ id: "device_offline", label: "设备离线时", hint: "设备断开或判为无响应" },
];

export function state() {
	const n = notify();
	return {
		kinds: Object.entries(KINDS).map(([id, meta]) => ({ id, ...meta })),
		triggers: TRIGGERS.map((t) => ({ ...t, enabled: n.triggers[t.id] === true })),
		channels: n.channels.map((c) => ({
			...c,
			// SMTP 口令 / Webhook token 不出口
			password: c.password ? "••••••••" : "",
			url: c.url && /token=|key=/i.test(c.url) ? `${c.url.split(/[?&]/)[0]}?…` : c.url,
		})),
		history: n.history.slice(0, 30),
	};
}

export function upsertChannel(input) {
	const n = notify();
	const id = String(input.id ?? "").trim() || `nc${Date.now().toString(36)}`;
	const existing = n.channels.find((c) => c.id === id);
	const kind = KINDS[input.kind] ? input.kind : "webhook";
	const channel = {
		id,
		kind,
		name: String(input.name ?? "").trim() || "未命名渠道",
		enabled: input.enabled === undefined ? existing?.enabled !== false : input.enabled === true,
		url: String(input.url ?? "").trim(),
		emailTo: String(input.emailTo ?? "").trim(),
		smtpHost: String(input.smtpHost ?? "").trim(),
		smtpPort: Number(input.smtpPort ?? 0) || 0,
		smtpUser: String(input.smtpUser ?? "").trim(),
		password: input.password === "••••••••" ? existing?.password ?? "" : String(input.password ?? ""),
		secure: input.secure === true,
		at: existing?.at ?? new Date().toISOString(),
		lastTest: existing?.lastTest ?? null,
	};
	if (kind === "webhook" && !channel.url) throw new Error("Webhook 需要填地址");
	if (kind === "email" && (!channel.emailTo || !channel.smtpHost)) throw new Error("邮件需要填 SMTP 主机与收件人");
	if (existing) Object.assign(existing, channel);
	else n.channels.push(channel);
	store.save();
	return { ok: true };
}

export function deleteChannel(id) {
	const n = notify();
	const index = n.channels.findIndex((c) => c.id === id);
	if (index < 0) return false;
	n.channels.splice(index, 1);
	store.save();
	return true;
}

export function setTrigger(id, enabled) {
	const n = notify();
	if (!TRIGGERS.some((t) => t.id === id)) return { ok: false, error: "未知触发点" };
	n.triggers[id] = enabled === true;
	store.save();
	return { ok: true };
}

/** 发一条 webhook。 */
async function sendWebhook(channel, title, body) {
	const started = Date.now();
	// 用 node:http/https 而不是 fetch：需要拿到状态码，且不想受 fetch 默认超时影响
	const url = new URL(channel.url);
	const transport = url.protocol === "https:" ? await import("node:https") : await import("node:http");
	const payload = JSON.stringify({
		msgtype: "text",
		text: { content: `[regedit] ${title}\n${body}` },
		// 通用字段，非钉钉/飞书的服务端直接读这两个
		title,
		body,
		at: new Date().toISOString(),
	});
	return new Promise((resolve) => {
		const request = transport.request(
			{
				protocol: url.protocol,
				hostname: url.hostname,
				port: url.port || (url.protocol === "https:" ? 443 : 80),
				path: `${url.pathname}${url.search}`,
				method: "POST",
				headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
				timeout: 10000,
			},
			(response) => {
				let data = "";
				response.on("data", (chunk) => {
					data += chunk;
				});
				response.on("end", () => {
					resolve({
						ok: response.statusCode >= 200 && response.statusCode < 300,
						message: `HTTP ${response.statusCode}（${Date.now() - started}ms）`,
						detail: data.slice(0, 300),
					});
				});
			},
		);
		request.on("timeout", () => {
			request.destroy();
			resolve({ ok: false, message: "请求超时（10s）" });
		});
		request.on("error", (error) => resolve({ ok: false, message: error.message }));
		request.write(payload);
		request.end();
	});
}

/**
 * 发一封纯文本邮件。
 *
 * 自己实现 SMTP 而不是引入 nodemailer：只用四个命令（EHLO / AUTH LOGIN /
 * MAIL / RCPT / DATA），一个 60 行的状态机足够，还能保持零依赖。
 *
 * 关键点：SMTP 的多行响应是 `250-XXX` 续行 + `250 XXX` 结束行，只在分隔符为
 * 空格时才推进状态；否则会把一次 250 当成好几步，把流程走乱。
 */
async function sendEmail(channel, title, body) {
	const net = await import("node:net");
	const tls = await import("node:tls");
	const started = Date.now();
	const port = channel.smtpPort || (channel.secure ? 465 : 25);
	const host = channel.smtpHost;
	const sender = channel.smtpUser || "regedit@localhost";

	return new Promise((resolve) => {
		let settled = false;
		const finish = (result) => {
			if (settled) return;
			settled = true;
			try {
				socket.destroy();
			} catch {
				/* 忽略 */
			}
			resolve(result);
		};

		const socket = channel.secure
			? tls.connect({ host, port, timeout: 15000 }, null)
			: net.connect({ host, port, timeout: 15000 }, null);

		socket.setEncoding("latin1");
		socket.on("timeout", () => finish({ ok: false, message: "SMTP 超时（15s）" }));
		socket.on("error", (error) => finish({ ok: false, message: error.message }));

		// 0=等问候 1=等EHLO 2=等AUTH用户名 3=等AUTH密码 4=等MAIL 5=等RCPT 6=等DATA 7=等正文 8=等QUIT
		let step = 0;
		const send = (line) => socket.write(`${line}\r\n`);

		socket.on("data", (chunk) => {
			const lines = chunk.split("\r\n").filter(Boolean);
			for (const line of lines) {
				const code = Number(line.slice(0, 3));
				// 续行（250-）不推进状态
				if (line.length > 3 && line[3] === "-") continue;
				if (code >= 400) return finish({ ok: false, message: `SMTP ${line.slice(0, 120)}` });

				if (step === 0) {
					step = 1;
					send("EHLO regedit");
				} else if (step === 1) {
					if (channel.smtpUser) {
						step = 2;
						send("AUTH LOGIN");
					} else {
						step = 4;
						send(`MAIL FROM:<${sender}>`);
					}
				} else if (step === 2) {
					step = 3;
					send(Buffer.from(channel.smtpUser).toString("base64"));
				} else if (step === 3) {
					step = 4;
					send(Buffer.from(channel.password ?? "").toString("base64"));
				} else if (step === 4) {
					step = 5;
					send(`RCPT TO:<${channel.emailTo}>`);
				} else if (step === 5) {
					step = 6;
					send("DATA");
				} else if (step === 6) {
					step = 7;
					const message = [
						`Subject: =?UTF-8?B?${Buffer.from(`[regedit] ${title}`, "utf8").toString("base64")}?=`,
						`From: <${sender}>`,
						`To: <${channel.emailTo}>`,
						"MIME-Version: 1.0",
						'Content-Type: text/plain; charset="UTF-8"',
						"",
						body,
						".",
					].join("\r\n");
					send(message);
				} else if (step === 7) {
					step = 8;
					send("QUIT");
				} else {
					return finish({ ok: true, message: `已发送（${Date.now() - started}ms）` });
				}
			}
		});
	});
}

/** 真发一条测试消息。 */
export async function testChannel(id) {
	const n = notify();
	const channel = n.channels.find((c) => c.id === id);
	if (!channel) return { ok: false, message: "渠道不存在" };
	const title = "通知测试";
	const body = `这是一条来自 regedit 的测试通知。\n渠道：${channel.name}\n时间：${new Date().toLocaleString("zh-CN")}`;
	let result;
	try {
		result = channel.kind === "email" ? await sendEmail(channel, title, body) : await sendWebhook(channel, title, body);
	} catch (error) {
		result = { ok: false, message: error.message };
	}
	channel.lastTest = { at: new Date().toISOString(), ...result };
	record({ channel: channel.name, kind: channel.kind, title, ok: result.ok, message: result.message });
	return result;
}

function record(entry) {
	const n = notify();
	n.history.unshift({ id: `nh${Date.now().toString(36)}`, at: new Date().toISOString(), ...entry });
	if (n.history.length > 100) n.history.splice(100);
	store.save();
}

/** 触发点命中时调用；没有渠道或渠道关闭就静默跳过。 */
export async function fire(trigger, title, body) {
	const n = notify();
	if (n.triggers[trigger] !== true) return { sent: 0 };
	const targets = n.channels.filter((c) => c.enabled !== false);
	let sent = 0;
	for (const channel of targets) {
		try {
			const result = channel.kind === "email" ? await sendEmail(channel, title, body) : await sendWebhook(channel, title, body);
			record({ channel: channel.name, kind: channel.kind, title, ok: result.ok, message: result.message, trigger });
			if (result.ok) sent += 1;
		} catch (error) {
			record({ channel: channel.name, kind: channel.kind, title, ok: false, message: error.message, trigger });
		}
	}
	return { sent };
}
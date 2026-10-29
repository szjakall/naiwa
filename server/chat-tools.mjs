/**
 * 对话可调用的工具。
 *
 * 为什么需要：纯聊天模型对"对 baidu.com 做 whois 探测"只会回一段命令让你自己敲——
 * 因为它没有手。控制台本身就是那双手（有资产库、任务引擎、报告），所以把项目能力
 * 包成工具交给模型，它才能真的查、真的记、真的出报告。
 *
 * 取舍：只暴露**只读 + 低破坏性**的能力。发起侦察走守门（review 模式会进审批队列），
 * 不会因为一句"扫一下这个段"就悄悄开跑。
 */

import { lookup as dnsLookup, resolve4, resolveMx, resolveNs, resolveTxt } from "node:dns/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { connect } from "node:net";
import { ARTIFACT_DIR } from "./config.mjs";
import { gateway } from "./droid.mjs";
import { guard } from "./gatekeeper.mjs";
import { addFinding, createTask, normalizeTarget, trafficEntry } from "./recon.mjs";
import { generateReport } from "./reports.mjs";
import { store } from "./store.mjs";
import { isEnabled } from "./tools.mjs";

const MAX_RESULT_CHARS = 4000;

function trim(text) {
	const value = typeof text === "string" ? text : JSON.stringify(text, null, 2);
	return value.length > MAX_RESULT_CHARS ? `${value.slice(0, MAX_RESULT_CHARS)}\n…（结果过长已截断）` : value;
}

function severityRank(sev) {
	return { critical: 0, high: 1, medium: 2, low: 3 }[sev] ?? 9;
}

/** 只读 WHOIS：连 43 端口读全文。零依赖，不引 whois 库。 */
function whoisQuery(domain, server = "whois.verisign-grs.com", timeoutMs = 12000) {
	return new Promise((resolve, reject) => {
		const socket = connect(43, server);
		let data = "";
		const done = (error) => {
			socket.removeAllListeners();
			socket.destroy();
			if (error) reject(error);
			else resolve(data);
		};
		const timer = setTimeout(() => done(new Error(`whois 超时（${timeoutMs}ms）`)), timeoutMs);
		socket.setEncoding("utf8");
		socket.on("connect", () => socket.write(`${domain}\r\n`));
		socket.on("data", (chunk) => {
			data += chunk;
			// 有些服务器 8KB 就断，先收着；超长直接截断防止内存打爆
			if (data.length > 200_000) {
				clearTimeout(timer);
				done();
			}
		});
		socket.on("end", () => {
			clearTimeout(timer);
			done();
		});
		socket.on("error", (error) => {
			clearTimeout(timer);
			done(error);
		});
	});
}

/** 不同 TLD 的 whois 服务器不一样，常见几个写死，其余交给 verisign 兜底。 */
function whoisServerFor(domain) {
	const tld = String(domain).split(".").pop()?.toLowerCase();
	return (
		{
			com: "whois.verisign-grs.com",
			net: "whois.verisign-grs.com",
			org: "whois.pir.org",
			cn: "whois.cnnic.cn",
			io: "whois.nic.io",
			me: "whois.nic.me",
			dev: "whois.nic.google",
			app: "whois.nic.google",
		}[tld] ?? "whois.iana.org"
	);
}

export const CHAT_TOOLS = [
	{
		type: "function",
		function: {
			name: "project_overview",
			description: "查看当前项目的整体情况：任务、资产、待处理漏洞数量与等级分布。回答'现在有什么'时先用它。",
			parameters: { type: "object", properties: {}, required: [] },
		},
	},
	{
		type: "function",
		function: {
			name: "list_tasks",
			description: "列出评估任务（标题、目标、状态、发现数）。",
			parameters: {
				type: "object",
				properties: { limit: { type: "integer", description: "最多返回几条，默认 20" } },
				required: [],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "list_assets",
			description: "列出已登记的资产（域名/IP/URL、状态、开放端口等）。",
			parameters: {
				type: "object",
				properties: {
					kind: { type: "string", description: "按类型过滤：domain / ip / url" },
					limit: { type: "integer", description: "默认 30" },
				},
				required: [],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "list_findings",
			description: "列出漏洞（标题、等级、目标、状态）。写报告或做风险判断时用它挑出具体条目。",
			parameters: {
				type: "object",
				properties: {
					severity: { type: "string", description: "critical / high / medium / low" },
					status: { type: "string", description: "open / confirmed / fixed / false-positive 等" },
					taskId: { type: "string", description: "只看某个任务的发现" },
					limit: { type: "integer", description: "默认 30" },
				},
				required: [],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "whois_lookup",
			description: "对域名做真实 WHOIS 查询（连 43 端口）。可以查注册商、注册/到期时间、NS、状态。",
			parameters: {
				type: "object",
				properties: { domain: { type: "string", description: "域名，如 baidu.com" } },
				required: ["domain"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "dns_lookup",
			description: "查 DNS：A / MX / NS / TXT / PTR 或任意记录的解析结果。",
			parameters: {
				type: "object",
				properties: {
					target: { type: "string", description: "域名或 IP" },
					record: { type: "string", description: "A / MX / NS / TXT / PTR，默认 A" },
				},
				required: ["target"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "create_recon_task",
			description:
				"发起一次真实的只读侦察任务（会跑 DNS、抓首屏、读响应头与 TLS、探测通用暴露点，并写入任务/资产/漏洞）。受守门约束，人工审批模式下会排队等批准。",
			parameters: {
				type: "object",
				properties: {
					title: { type: "string", description: "任务名，如 baidu.com 暴露面初查" },
					targets: { type: "array", items: { type: "string" }, description: "目标清单（域名或 URL）" },
				},
				required: ["title", "targets"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "record_finding",
			description:
				"把一条**已确认**的漏洞落库（进发现页 / 报告）。只在有真实证据时用；仅凭版本号猜测的不要记。每个漏洞调用一次。",
			parameters: {
				type: "object",
				properties: {
					title: { type: "string", description: "漏洞名/类型，如「未授权访问 Actuator env」" },
					severity: { type: "string", description: "critical / high / medium / low" },
					target: { type: "string", description: "受影响目标（域名或 URL）" },
					summary: { type: "string", description: "一句话说明影响" },
					evidence: { type: "string", description: "真实证据原文：请求/响应片段、命令输出，不要改写" },
					recommendation: { type: "string", description: "修复建议" },
					taskId: { type: "string", description: "关联任务 id（可选）" },
					assetId: { type: "string", description: "关联资产 id（可选）" },
				},
				required: ["title", "severity", "target", "summary"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "generate_report",
			description: "生成 Markdown 报告。传 findingIds 只写选中的漏洞；只传 taskId 写整个任务；都不传写全部未关闭发现。",
			parameters: {
				type: "object",
				properties: {
					title: { type: "string", description: "报告标题" },
					taskId: { type: "string" },
					findingIds: { type: "array", items: { type: "string" }, description: "要写进报告的漏洞 id" },
				},
				required: [],
			},
		},
	},
	// ------------------------------------------------ 安卓设备（和「安卓设备」页同一个网关）
	{
		type: "function",
		function: {
			name: "list_devices",
			description: "列出已接入的安卓设备（名称、机型、Android 版本、是否 root、在线/无响应/离线）。动设备前先用它确认接哪台。",
			parameters: { type: "object", properties: {}, required: [] },
		},
	},
	{
		type: "function",
		function: {
			name: "device_exec",
			description:
				"在安卓设备上执行一条 shell 命令并拿回 stdout/stderr/退出码（可在已 root 设备上 asRoot=true 用 su）。受守门约束，人工审批模式下会排队。只读排查优先：id、getprop、pm list packages、cat /data/... 下的配置。",
			parameters: {
				type: "object",
				properties: {
					cmd: { type: "string", description: "要执行的命令" },
					asRoot: { type: "boolean", description: "是否用 su 提权执行，默认 false" },
					deviceId: { type: "string", description: "设备 id；不传时用会话绑定的设备或唯一在线设备" },
					timeoutMs: { type: "integer", description: "超时毫秒，默认 30000" },
				},
				required: ["cmd"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "device_screencap",
			description: "给安卓设备截一张屏，PNG 落到控制台产物目录并返回下载地址（模型拿不到像素，只需把地址给操作员）。",
			parameters: {
				type: "object",
				properties: { deviceId: { type: "string", description: "不传时用会话绑定的设备" } },
				required: [],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "device_logcat",
			description: "读安卓设备最近 N 行 logcat，可按关键字过滤（如包名、异常类名）。",
			parameters: {
				type: "object",
				properties: {
					lines: { type: "integer", description: "行数，默认 200，上限 2000" },
					filter: { type: "string", description: "关键字过滤" },
					deviceId: { type: "string" },
				},
				required: [],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "device_pull",
			description: "从安卓设备拉一个文件到控制台产物目录（不把二进制塞进上下文），返回落盘路径与大小。",
			parameters: {
				type: "object",
				properties: {
					path: { type: "string", description: "设备上的绝对路径" },
					deviceId: { type: "string" },
				},
				required: ["path"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "device_packages",
			description: "列出安卓设备上已安装的第三方应用包名，用于确定要分析/调试的目标应用。",
			parameters: {
				type: "object",
				properties: {
					all: { type: "boolean", description: "true 时连系统应用一起列，默认只列第三方" },
					deviceId: { type: "string" },
				},
				required: [],
			},
		},
	},
];

/** 工具实现。返回 { ok, summary, data } —— summary 给模型看，data 给界面展开。 */
// ---------------------------------------------------------------- 设备选择

/**
 * 会话要能"直接对着手机说话"，所以设备解析顺序是：
 * 显式 deviceId → 会话绑定的设备 → 唯一在线设备。多台在线且没绑定时明确要求指定，
 * 而不是随便挑一台——把命令发错设备比报错难查得多。
 */
function resolveDevice(ctx = {}, explicitId) {
	const devices = gateway.devices();
	const wanted = String(explicitId || ctx.deviceId || "").trim();
	if (wanted) {
		const hit = devices.find((item) => item.id === wanted || item.deviceId === wanted);
		if (!hit) return { error: `设备 ${wanted} 不在注册表里（先到「安卓设备」页确认设备 id）` };
		if (hit.liveness === "offline") return { error: `设备「${hit.name}」当前离线：让手机端重开 APK 建立反连` };
		return { device: hit };
	}
	const usable = devices.filter((item) => item.liveness !== "offline");
	if (usable.length === 1) return { device: usable[0] };
	if (usable.length === 0) {
		return {
			error:
				"没有可用的安卓设备：先在「安卓设备 → 连接令牌」建一个令牌，用 regedit-droid APK 填地址和令牌拨进来（心跳进来就会出现在在线设备里）",
		};
	}
	return {
		error: `当前有 ${usable.length} 台设备在线（${usable
			.map((item) => `${item.name}(${item.id})`)
			.join("、")}），请在调用时指定 deviceId，或到对话页把会话绑定到其中一台`,
	};
}

function deviceLabel(device) {
	const flags = [`Android ${device.androidVersion ?? "?"}`];
	if (device.model) flags.unshift(device.model);
	if (device.rooted) flags.push("root");
	return `${device.name}（${flags.join(" · ")}）`;
}

/** 把对话上下文折成 trafficEntry 认的形状：流量要按项目 / 公司 / 会话归账。 */
function ctxTask(ctx = {}) {
	return { id: ctx.taskId ?? null, companyId: ctx.companyId ?? null, conversationId: ctx.conversationId ?? null };
}

/** 设备产物（截屏/pcap/拉回来的文件）统一落 artifacts，只把可下载地址交给调用方。 */
function saveArtifact(prefix, ext, bytes) {
	const name = `${prefix}-${Date.now()}.${ext}`;
	writeFileSync(join(ARTIFACT_DIR, name), bytes);
	return { name, url: `/api/android/artifacts/${name}`, size: bytes.length };
}

export async function runChatTool(name, args = {}, ctx = {}) {
	switch (name) {
		case "project_overview": {
			const open = (store.state.findings ?? []).filter((f) => f.status !== "closed");
			const bySeverity = {};
			for (const f of open) bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
			const task = ctx.taskId ? (store.state.tasks ?? []).find((t) => t.id === ctx.taskId) : null;
			const devices = gateway.devices();
			const data = {
				tasks: (store.state.tasks ?? []).length,
				running: (store.state.tasks ?? []).filter((t) => t.status === "running").length,
				assets: (store.state.assets ?? []).length,
				openFindings: open.length,
				bySeverity,
				reports: (store.state.reports ?? []).length,
				traffic: (store.state.traffic ?? []).length,
				companies: (store.state.companies ?? []).length,
				devices: devices.length,
				devicesOnline: devices.filter((d) => d.liveness === "online").length,
				...(task ? { project: { id: task.id, title: task.title, status: task.status, stage: task.stage, scope: task.scope } } : {}),
			};
			return { ok: true, summary: trim(data), data };
		}
		case "list_tasks": {
			const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
			const items = (store.state.tasks ?? []).slice(0, limit).map((t) => ({
				id: t.id,
				title: t.title,
				status: t.status,
				targets: (t.scope ?? []).length,
				findings: (store.state.findings ?? []).filter((f) => f.taskId === t.id).length,
				createdAt: t.createdAt,
			}));
			return { ok: true, summary: trim(items.length ? items : "（还没有任务）"), data: items };
		}
		case "list_assets": {
			const limit = Math.min(Math.max(Number(args.limit) || 30, 1), 100);
			let items = store.state.assets ?? [];
			if (args.kind) items = items.filter((a) => a.kind === args.kind);
			const data = items.slice(0, limit).map((a) => ({
				id: a.id,
				kind: a.kind,
				value: a.value ?? a.host ?? a.url,
				status: a.status,
				title: a.title,
			}));
			return { ok: true, summary: trim(data.length ? data : "（没有匹配的资产）"), data };
		}
		case "list_findings": {
			const limit = Math.min(Math.max(Number(args.limit) || 30, 1), 100);
			let items = (store.state.findings ?? []).filter((f) => f.status !== "closed");
			if (args.severity) items = items.filter((f) => f.severity === args.severity);
			if (args.status) items = items.filter((f) => f.status === args.status);
			if (args.taskId) items = items.filter((f) => f.taskId === args.taskId);
			items = [...items].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
			const data = items.slice(0, limit).map((f) => ({
				id: f.id,
				title: f.title,
				severity: f.severity,
				target: f.target,
				status: f.status,
				taskId: f.taskId,
			}));
			return { ok: true, summary: trim(data.length ? data : "（没有匹配的漏洞）"), data };
		}
		case "whois_lookup": {
			const domain = String(args.domain ?? "").trim().toLowerCase();
			if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return { ok: false, summary: `域名不合法：${domain}` };
			const server = whoisServerFor(domain);
			const started = Date.now();
			try {
				const raw = await whoisQuery(domain, server);
				const ms = Date.now() - started;
				// 对话发起的查询同样是出网动作：记一条流量，否则「流量」页会漏掉整段对话取证。
				store.addTraffic(
					trafficEntry(ctxTask(ctx), {
						kind: "whois",
						method: "WHOIS",
						url: `whois://${server}/${domain}`,
						status: raw.trim() ? 200 : 0,
						ms,
						bytes: raw.length,
						note: raw.trim() ? "对话 Agent" : "无返回",
					}),
				);
				if (!raw.trim()) return { ok: false, summary: `${server} 没有返回内容` };
				// 只留关键行，避免把整段原始 whois 塞进模型上下文
				const keys = /^(Domain Name|Registrar|Registrar WHOIS Server|Creation Date|Registry Expiry Date|Updated Date|Domain Status|Name Server|DNSSEC|Registrant Organization|Registrant Country):/i;
				const picked = raw
					.split(/\r?\n/)
					.map((line) => line.trim())
					.filter((line) => keys.test(line));
				return {
					ok: true,
					summary: trim(`WHOIS ${domain}（${server}）\n${picked.length ? picked.join("\n") : raw.slice(0, 1200)}`),
					data: { domain, server, bytes: raw.length },
				};
			} catch (error) {
				store.addTraffic(
					trafficEntry(ctxTask(ctx), {
						kind: "whois",
						method: "WHOIS",
						url: `whois://${server}/${domain}`,
						status: 0,
						ms: Date.now() - started,
						bytes: 0,
						note: error.message,
					}),
				);
				return { ok: false, summary: `WHOIS 查询失败：${error.message}` };
			}
		}
		case "dns_lookup": {
			const target = String(args.target ?? "").trim();
			if (!target) return { ok: false, summary: "缺少 target" };
			const record = String(args.record ?? "A").toUpperCase();
			const started = Date.now();
			try {
				let value;
				if (record === "A") value = await resolve4(target);
				else if (record === "MX") value = await resolveMx(target);
				else if (record === "NS") value = await resolveNs(target);
				else if (record === "TXT") value = await resolveTxt(target);
				else if (record === "PTR") value = await dnsLookup(target);
				else value = await dnsLookup(target);
				store.addTraffic(
					trafficEntry(ctxTask(ctx), {
						kind: "dns",
						method: record,
						url: `dns://${target}`,
						status: 200,
						ms: Date.now() - started,
						bytes: JSON.stringify(value).length,
						note: "对话 Agent",
					}),
				);
				return { ok: true, summary: trim(`${record} ${target}\n${JSON.stringify(value, null, 2)}`), data: { target, record, value } };
			} catch (error) {
				store.addTraffic(
					trafficEntry(ctxTask(ctx), {
						kind: "dns",
						method: record,
						url: `dns://${target}`,
						status: 0,
						ms: Date.now() - started,
						bytes: 0,
						note: `${error.code ?? error.message}`,
					}),
				);
				return { ok: false, summary: `${record} 查询失败：${error.code ?? error.message}` };
			}
		}
		case "create_recon_task": {
			const title = String(args.title ?? "").trim() || "对话发起的侦察";
			// createTask 的 scope 要的是"一行一个目标的字符串"，它自己会 split 再规范化。
			// 早先这里传了 normalizeTarget 之后的对象数组，被 String() 成 "[object Object]"，
			// 于是任务永远 0 个目标——模型看到的就是"创建失败"。
			const rawTargets = (Array.isArray(args.targets) ? args.targets : [])
				.map((item) => String(item ?? "").trim())
				.filter(Boolean);
			const parsed = rawTargets.map(normalizeTarget).filter(Boolean);
			if (!parsed.length) {
				return { ok: false, summary: `没有可识别的目标：${rawTargets.join(", ") || "(空)"}（需要域名或 http(s) URL）` };
			}
			// 会话已经绑了项目就往这个项目里加目标，而不是每说一句就开一个新任务：
			// 一个客户一次评估应该是一个项目，资产与流量才不会散在十几个任务里。
			const bound = ctx.taskId ? (store.state.tasks ?? []).find((entry) => entry.id === ctx.taskId) : null;
			let task;
			let merged = 0;
			if (bound) {
				task = bound;
				const known = new Set((task.targets ?? []).map((item) => item.input));
				for (const target of parsed) {
					if (known.has(target.input)) continue;
					task.targets.push(target);
					known.add(target.input);
					merged += 1;
				}
				if (merged) {
					task.scope = task.targets.map((item) => item.input);
					task.stats = { ...(task.stats ?? {}), targets: task.targets.length };
					store.pushTaskEvent(task, "info", `对话追加 ${merged} 个目标（共 ${task.targets.length} 个）`);
					store.save();
				}
			} else {
				task = createTask({
					title,
					scope: parsed.map((item) => item.input).join("\n"),
					companyId: ctx.companyId ?? null,
					conversationId: ctx.conversationId ?? null,
				});
			}
			if (task.targets.length === 0) {
				return { ok: false, summary: "目标解析后为空（需要域名或 http(s) URL）" };
			}
			// 走守门：和界面上点「新建任务」是同一条路径，review 模式下会进审批队列。
			// 注意 guard() 返回的是 { kind }，不是 { allowed/decision }——按错字段判断会把
			// "已排队"误报成"被拒绝"（线上就是这么误伤的）。
			const gate = await guard({
				scope: "recon",
				source: "对话 Agent",
				target: title,
				command: `对以下目标发起只读 GET 侦察：\n${parsed.map((item) => item.input).join("\n")}`,
				action: { kind: "reconTask", taskId: task.id },
			});
			if (gate.kind === "pending") {
				return {
					ok: true,
					summary:
						`任务 ${task.id}「${title}」已创建（${task.targets.length} 个目标），处于**待审批**状态：` +
						`当前是人工审批模式，需操作员在「守门」页批准后才会开始侦察。审批单号 ${gate.approvalId}。` +
						`这不是失败——任务已经挂在任务列表里，等批准即可。`,
					data: { taskId: task.id, approvalId: gate.approvalId, gate: "pending" },
				};
			}
			if (gate.kind === "block") {
				return {
					ok: false,
					summary: `任务 ${task.id} 已创建，但守门员拦下了执行：${gate.reason || "未给出理由"}。可以调整目标范围或改走人工审批。`,
					data: { taskId: task.id, gate: "block" },
				};
			}
			if (gate.kind === "failed") {
				return {
					ok: true,
					summary: `守门判定失败（${gate.error}），按既定策略放行，任务 ${task.id} 已开始侦察。`,
					data: { taskId: task.id, gate: "failed" },
				};
			}
			if (gate.kind === "bypass") {
				// "任务引擎"这一类守门没启用时走这里。要说清楚是"没启用拦截"，
				// 否则模型看到状态 queued 会误判成"在等人工审批"。
				return {
					ok: true,
					summary: `任务 ${task.id}「${title}」已开始侦察（${task.targets.length} 个目标）。守门的「任务引擎」类别未启用，所以未做审批判定。完成后可用 list_findings 查看产出。`,
					data: { taskId: task.id, gate: "bypass" },
				};
			}
			// allow：守门判定通过后由 runner 启动
			return {
				ok: true,
				summary: `任务 ${task.id}「${title}」已通过守门并开始侦察（${task.targets.length} 个目标）。完成后可用 list_findings 查看产出。`,
				data: { taskId: task.id, gate: gate.kind },
			};
		}
		case "record_finding": {
			const title = String(args.title ?? "").trim();
			const target = String(args.target ?? "").trim();
			if (!title || !target) return { ok: false, summary: "title 与 target 必填" };
			const severity = ["critical", "high", "medium", "low"].includes(args.severity) ? args.severity : "medium";
			// 与任务引擎共用 addFinding：同标题同目标自动去重，只累加 occurrences
			const record = addFinding(null, {
				title,
				severity,
				target,
				summary: String(args.summary ?? "").trim(),
				evidence: String(args.evidence ?? "").trim(),
				recommendation: String(args.recommendation ?? "").trim(),
				source: "agent",
			});
			// addFinding 只认 task，这里补上 taskId/assetId
			if (args.taskId) record.taskId = String(args.taskId);
			if (args.assetId) record.assetId = String(args.assetId);
			// 归属跟着会话走：从对话记录下来的漏洞也要能被公司/项目筛出来。
			if (!record.companyId && ctx.companyId) record.companyId = ctx.companyId;
			if (!record.taskId && ctx.taskId) record.taskId = ctx.taskId;
			if (!record.conversationId && ctx.conversationId) record.conversationId = ctx.conversationId;
			store.save();
			return {
				ok: true,
				summary: `已落库 ${record.id}：${title}（${severity}）@ ${target}${record.occurrences > 1 ? `，第 ${record.occurrences} 次出现` : ""}`,
				data: { id: record.id, occurrences: record.occurrences },
			};
		}
		case "generate_report": {
			const result = generateReport({
				title: args.title,
				taskId: args.taskId,
				findingIds: args.findingIds,
			});
			return {
				ok: true,
				summary: `报告已生成：${result.report.title}（${result.report.id}，${result.report.findings} 条发现 / ${result.report.assets} 个资产，${result.report.size} 字节）`,
				data: result.report,
			};
		}
		// ------------------------------------------------ 安卓设备
		case "list_devices": {
			const devices = gateway.devices();
			if (!devices.length) {
				return {
					ok: true,
					summary:
						"还没有设备接入。「安卓设备 → 连接令牌」新建令牌，用 regedit-droid APK 填 `主机:端口` 与令牌；心跳进来后就会出现在列表里。",
					data: [],
				};
			}
			const data = devices.map((device) => ({
				id: device.id,
				name: device.name,
				deviceId: device.deviceId,
				model: device.model,
				androidVersion: device.androidVersion,
				rooted: device.rooted === true,
				liveness: device.liveness,
				bound: ctx.deviceId ? device.id === ctx.deviceId || device.deviceId === ctx.deviceId : false,
			}));
			return {
				ok: true,
				summary: trim(
					data.map(
						(item) =>
							`${item.bound ? "* " : "- "}${item.name}｜${item.model ?? "?"}｜Android ${item.androidVersion ?? "?"}${item.rooted ? "｜root" : ""}｜${item.liveness}｜id=${item.id}`,
					).join("\n"),
				),
				data,
			};
		}
		case "device_exec": {
			if (!isEnabled("device_exec")) return { ok: false, summary: "工具「设备命令」已停用（工具页开启后再试）" };
			const cmd = String(args.cmd ?? "").trim();
			if (!cmd) return { ok: false, summary: "cmd 为空" };
			const picked = resolveDevice(ctx, args.deviceId);
			if (picked.error) return { ok: false, summary: picked.error };
			const device = picked.device;
			const asRoot = args.asRoot === true;
			const timeoutMs = Math.min(Math.max(Number(args.timeoutMs) || 30_000, 5_000), 300_000);
			const gate = await guard({
				scope: "deviceExec",
				source: "对话 Agent",
				target: deviceLabel(device),
				command: cmd,
				action: { kind: "deviceExec", deviceId: device.deviceId, cmd, asRoot, timeoutMs },
			});
			if (gate.kind === "pending") {
				return {
					ok: true,
					summary: `已进入人工审批队列（审批单 ${gate.approvalId}）：当前是人工审批模式，操作员在「守门」页放行后才真正在 ${device.name} 上执行。排队不是失败。`,
					data: { approvalId: gate.approvalId, device: device.name },
				};
			}
			if (gate.kind === "block") {
				return { ok: false, summary: `守门员拦下了这条命令：${gate.reason || "未给出理由"}` };
			}
			const result = gate.result ?? {};
			// 设备侧把失败原因放 stderr（见 CHANGELOG #19），这里必须回退读它。
			const stdout = String(result.stdout ?? "").trim();
			const stderr = String(result.stderr ?? result.error ?? "").trim();
			const body = [stdout, stderr && `[stderr] ${stderr}`].filter(Boolean).join("\n") || "(无输出)";
			return {
				ok: result.ok !== false,
				summary: trim(`$ ${cmd}${asRoot ? "（root）" : ""} → exit ${result.code ?? result.exitCode ?? "?"}\n${body}`),
				data: { device: device.name, code: result.code ?? result.exitCode ?? null, stdout: stdout.slice(0, 8000), stderr: stderr.slice(0, 4000) },
			};
		}
		case "device_screencap": {
			if (!isEnabled("device_screen")) return { ok: false, summary: "工具「设备截屏」已停用" };
			const picked = resolveDevice(ctx, args.deviceId);
			if (picked.error) return { ok: false, summary: picked.error };
			const result = await gateway.screencap(picked.device.deviceId);
			if (!result.ok) return { ok: false, summary: `截屏失败：${result.error ?? "设备没有返回图像"}` };
			const saved = saveArtifact(`chat-screen-${picked.device.id}`, "png", result.bytes ?? Buffer.alloc(0));
			return {
				ok: true,
				summary: `已截屏 ${picked.device.name}，PNG ${saved.size} 字节，下载地址 ${saved.url}（把它给操作员看即可）`,
				data: saved,
			};
		}
		case "device_logcat": {
			if (!isEnabled("device_exec")) return { ok: false, summary: "工具「设备命令」已停用" };
			const picked = resolveDevice(ctx, args.deviceId);
			if (picked.error) return { ok: false, summary: picked.error };
			const lines = Math.min(Math.max(Number(args.lines) || 200, 20), 2000);
			const result = await gateway.logcat(picked.device.deviceId, lines, args.filter ? String(args.filter) : undefined);
			const text = String(result.stdout ?? "").trim();
			return {
				ok: result.ok !== false,
				summary: trim(`logcat ${picked.device.name}（最近 ${lines} 行）\n${text || result.error || "(无输出)"}`),
				data: { device: picked.device.name, lines },
			};
		}
		case "device_pull": {
			if (!isEnabled("device_file")) return { ok: false, summary: "工具「设备文件」已停用" };
			const path = String(args.path ?? "").trim();
			if (!path) return { ok: false, summary: "path 为空" };
			const picked = resolveDevice(ctx, args.deviceId);
			if (picked.error) return { ok: false, summary: picked.error };
			const result = await gateway.pull(picked.device.deviceId, path);
			if (!result.ok) return { ok: false, summary: `拉取失败：${result.error ?? result.stderr ?? "设备没有返回内容"}` };
			const bytes = result.bytes ?? Buffer.alloc(0);
			const filename = path.split("/").pop() || "file.bin";
			const safe = filename.replace(/[^\w.\-]/g, "_").slice(0, 60) || "file.bin";
			const saved = saveArtifact(`chat-pull-${safe}`, "bin", bytes);
			return {
				ok: true,
				summary: `已从 ${picked.device.name} 拉取 ${path}（${saved.size} 字节），落盘下载地址 ${saved.url}`,
				data: { ...saved, path, device: picked.device.name },
			};
		}
		case "device_packages": {
			if (!isEnabled("device_exec")) return { ok: false, summary: "工具「设备命令」已停用" };
			const picked = resolveDevice(ctx, args.deviceId);
			if (picked.error) return { ok: false, summary: picked.error };
			const result = await gateway.packages(picked.device.deviceId, args.all !== true, true);
			const text = String(result.stdout ?? "").trim();
			return {
				ok: result.ok !== false,
				summary: trim(`已安装应用（${picked.device.name}）\n${text || result.error || "(无输出)"}`),
				data: { device: picked.device.name, count: text ? text.split(/\r?\n/).length : 0 },
			};
		}
		default:
			return { ok: false, summary: `未知工具：${name}` };
	}
}
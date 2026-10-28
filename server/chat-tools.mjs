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
import { connect } from "node:net";
import { store } from "./store.mjs";
import { addFinding, createTask, normalizeTarget } from "./recon.mjs";
import { generateReport } from "./reports.mjs";
import { guard } from "./gatekeeper.mjs";

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
];

/** 工具实现。返回 { ok, summary, data } —— summary 给模型看，data 给界面展开。 */
export async function runChatTool(name, args = {}) {
	switch (name) {
		case "project_overview": {
			const open = (store.state.findings ?? []).filter((f) => f.status !== "closed");
			const bySeverity = {};
			for (const f of open) bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
			const data = {
				tasks: (store.state.tasks ?? []).length,
				running: (store.state.tasks ?? []).filter((t) => t.status === "running").length,
				assets: (store.state.assets ?? []).length,
				openFindings: open.length,
				bySeverity,
				reports: (store.state.reports ?? []).length,
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
			try {
				const raw = await whoisQuery(domain, server);
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
				return { ok: false, summary: `WHOIS 查询失败：${error.message}` };
			}
		}
		case "dns_lookup": {
			const target = String(args.target ?? "").trim();
			if (!target) return { ok: false, summary: "缺少 target" };
			const record = String(args.record ?? "A").toUpperCase();
			try {
				let value;
				if (record === "A") value = await resolve4(target);
				else if (record === "MX") value = await resolveMx(target);
				else if (record === "NS") value = await resolveNs(target);
				else if (record === "TXT") value = await resolveTxt(target);
				else if (record === "PTR") value = await dnsLookup(target);
				else value = await dnsLookup(target);
				return { ok: true, summary: trim(`${record} ${target}\n${JSON.stringify(value, null, 2)}`), data: { target, record, value } };
			} catch (error) {
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
			const task = createTask({ title, scope: parsed.map((item) => item.input).join("\n") });
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
		default:
			return { ok: false, summary: `未知工具：${name}` };
	}
}
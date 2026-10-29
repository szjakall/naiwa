/**
 * 任务引擎：把"目标范围"跑成"资产 + 发现"，也就是基础框架里
 * 任务 → 探索 → 资产 → 漏洞 这条主链。
 *
 * 设计取舍：
 * - 不做端口扫描、不猜口令、不爆破路径。所有请求都是只读 GET，路径清单写死
 *   且保守（robots、security.txt、几个通用暴露点），因为它面对的是**已授权**
 *   的目标，误伤比漏报更贵。
 * - 单目标串行 + 固定间隔，避免把对方打疼，也让日志可读。
 * - 每一步都写任务事件与流量流水，报告可以逐条引用。
 * - 引擎不依赖大模型：没有配置 LLM 时它照样出结论，配了 LLM 只是让叙述更好。
 */

import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { readSettings } from "./config.mjs";
import { store } from "./store.mjs";

const activeRuns = new Map();

// ---------------------------------------------------------------- HTTP

function fetchOnce(url, options) {
	const { timeoutMs, headers, insecureTls } = options;
	return new Promise((resolve) => {
		let parsed;
		try {
			parsed = new URL(url);
		} catch {
			resolve({ error: `URL 非法：${url}` });
			return;
		}
		const isHttps = parsed.protocol === "https:";
		const transport = isHttps ? httpsRequest : httpRequest;
		const started = Date.now();
		let settled = false;
		let timer = null;

		const finish = (payload) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			resolve({ ...payload, ms: Date.now() - started });
		};
		const fail = (message) => finish({ error: message });

		const req = transport(
			{
				protocol: parsed.protocol,
				hostname: parsed.hostname,
				port: parsed.port || (isHttps ? 443 : 80),
				path: `${parsed.pathname}${parsed.search}`,
				method: "GET",
				headers: { host: parsed.host, ...headers },
				// 评估环境常见自签证书：不做信任校验，但把证书信息照实记下来。
				...(isHttps ? { rejectUnauthorized: !insecureTls } : {}),
				servername: parsed.hostname,
			},
			(res) => {
				const chunks = [];
				let size = 0;
				let tls = null;
				if (isHttps) {
					try {
						const cert = res.socket.getPeerCertificate();
						if (cert && cert.subject) {
							tls = {
								subject: cert.subject?.CN ?? "",
								issuer: cert.issuer?.O ?? cert.issuer?.CN ?? "",
								validFrom: cert.valid_from ?? "",
								validTo: cert.valid_to ?? "",
								altNames: cert.subjectaltname ?? "",
								protocol: res.socket.getProtocol?.() ?? "",
							};
						}
					} catch {
						/* 拿不到证书就留空 */
					}
				}
				const snapshot = (truncated) => ({
					status: res.statusCode,
					headers: res.headers,
					body: Buffer.concat(chunks).toString("utf8"),
					truncated,
					tls,
				});
				res.on("data", (chunk) => {
					size += chunk.length;
					if (size <= options.bodyLimit) chunks.push(chunk);
					// 超过正文上限就断开：我们只要判定用的头部信息。
					else res.destroy();
				});
				res.on("end", () => finish(snapshot(size > options.bodyLimit)));
				res.on("error", (error) => fail(error.message));
				// destroy 之后不一定有 end/error：兜底给个截断的结果，别让任务卡住。
				res.on("close", () => finish(snapshot(true)));
			},
		);

		timer = setTimeout(() => {
			req.destroy(new Error(`请求超时（${timeoutMs}ms）`));
		}, timeoutMs);
		req.on("error", (error) => {
			// 超时是预期分支：给出可读原因，不要把 ECONNRESET 直接抛给操作员。
			if (/请求超时/.test(error.message)) fail(error.message);
			else fail(error.code ? `${error.code} ${error.message}` : error.message);
		});
		req.end();
	});
}

// ---------------------------------------------------------------- 流量素材

/**
 * 只保留有分析价值的头，且单个值截断。
 *
 * 目的是业务建模（推参数与响应结构），不是做完整抓包存档：把 Authorization
 * 原样存进状态文档会让凭据躺在磁盘上，这里显式排除认证类头。
 */
const HEADER_ALLOW = [
	"content-type",
	"accept",
	"accept-language",
	"user-agent",
	"server",
	"x-powered-by",
	"cache-control",
	"set-cookie",
	"location",
	"allow",
	"www-authenticate",
	"access-control-allow-origin",
];

function pickHeaders(headers) {
	const out = {};
	if (!headers || typeof headers !== "object") return out;
	for (const name of HEADER_ALLOW) {
		const value = headers[name];
		if (value === undefined) continue;
		const text = Array.isArray(value) ? value.join(" | ") : String(value);
		out[name] = text.slice(0, 300);
	}
	return out;
}

/** 正文摘录：JSON 留完整结构所需的部分，HTML 只留开头用于判类型。 */
function previewBody(body, contentType) {
	if (!body) return "";
	const text = String(body);
	const isJson = /json/i.test(contentType) || /^\s*[[{]/.test(text);
	const limit = isJson ? 4096 : 512;
	return text.slice(0, limit);
}

/**
 * 流量记录的统一入口。
 *
 * 每条流量都要带 taskId / companyId / conversationId / kind 四件套：
 * 界面上「按任务看」「按公司看」「只看设备抓包」都靠它们分桶，
 * 缺一个就会出现"请求明明发生了却查不到"。
 */
export function trafficEntry(task, entry = {}) {
	return {
		id: store.nextId("tr"),
		at: new Date().toISOString(),
		kind: "http",
		taskId: task?.id ?? null,
		companyId: task?.companyId ?? null,
		conversationId: task?.conversationId ?? null,
		method: "GET",
		url: "",
		status: 0,
		ms: 0,
		bytes: 0,
		note: "",
		...entry,
	};
}

/** 跟随跳转的 GET；同时把每一跳都记进流量，报告里能还原链路。 */
async function fetchWithRedirects(url, options, task) {
	let current = url;
	const chain = [];
	for (let hop = 0; hop < 6; hop += 1) {
		const response = await fetchOnce(current, options);
		chain.push({ url: current, status: response.status ?? 0 });
		if (response.error) {
			store.addTraffic(
				trafficEntry(task, {
					method: "GET",
					url: current,
					status: 0,
					ms: response.ms ?? 0,
					bytes: 0,
					note: response.error,
				}),
			);
			return { ...response, finalUrl: current, chain };
		}
		store.addTraffic(
			trafficEntry(task, {
				method: "GET",
				url: current,
				status: response.status,
				ms: response.ms,
				bytes: response.body ? Buffer.byteLength(response.body) : 0,
				note: response.headers?.server ?? "",
				// 业务建模要用到的原始素材：只留摘录，避免把状态文档撑爆。
				requestHeaders: pickHeaders(options.headers),
				responseHeaders: pickHeaders(response.headers),
				contentType: String(response.headers?.["content-type"] ?? ""),
				bodyPreview: previewBody(response.body, String(response.headers?.["content-type"] ?? "")),
			}),
		);
		const location = response.headers?.location;
		if (response.status >= 300 && response.status < 400 && location) {
			current = new URL(location, current).toString();
			continue;
		}
		return { ...response, finalUrl: current, chain };
	}
	return { error: "跳转次数过多" };
}

// ---------------------------------------------------------------- 指纹

const TECH_RULES = [
	{ name: "WordPress", test: (r) => /wp-content|wp-includes/.test(r.body) },
	{ name: "Next.js", test: (r) => /__NEXT_DATA__|\/_next\//.test(r.body) },
	{ name: "Nuxt", test: (r) => /__NUXT__|\/_nuxt\//.test(r.body) },
	{ name: "React", test: (r) => /data-reactroot|react\.production/.test(r.body) },
	{ name: "Vue", test: (r) => /data-v-[0-9a-f]{6,}|vue(\.runtime)?(\.min)?\.js/.test(r.body) },
	{ name: "jQuery", test: (r) => /jquery[.-][\d.]+(\.min)?\.js/i.test(r.body) },
	{ name: "Bootstrap", test: (r) => /bootstrap(\.min)?\.(css|js)/i.test(r.body) },
	{ name: "Nginx", test: (r) => /nginx/i.test(r.headers?.server ?? "") },
	{ name: "Apache", test: (r) => /apache/i.test(r.headers?.server ?? "") },
	{ name: "IIS", test: (r) => /microsoft-iis/i.test(r.headers?.server ?? "") },
	{ name: "Tomcat", test: (r) => /tomcat|coyote/i.test(r.headers?.server ?? "") },
	{ name: "Spring", test: (r) => /whitelabel error page|spring/i.test(r.body) },
	{ name: "PHP", test: (r) => /php/i.test(r.headers?.["x-powered-by"] ?? "") },
	{ name: "ASP.NET", test: (r) => /asp\.net/i.test(r.headers?.["x-powered-by"] ?? "") },
	{ name: "Cloudflare", test: (r) => /cloudflare/i.test(r.headers?.server ?? "") || Boolean(r.headers?.["cf-ray"]) },
	{ name: "Shiro", test: (r) => /rememberme=deleteme/i.test(r.headers?.["set-cookie"] ?? "") },
];

function detectTech(response) {
	return TECH_RULES.filter((rule) => {
		try {
			return rule.test(response);
		} catch {
			return false;
		}
	}).map((rule) => rule.name);
}

function titleOf(body) {
	const match = /<title[^>]*>([\s\S]{0,200}?)<\/title>/i.exec(body ?? "");
	return match ? match[1].replace(/\s+/g, " ").trim() : "";
}

// ---------------------------------------------------------------- 资产/漏洞

function upsertAsset(task, asset) {
	const state = store.state;
	let record = state.assets.find((entry) => entry.type === asset.type && entry.value === asset.value);
	const now = new Date().toISOString();
	if (record) {
		Object.assign(record, {
			...(asset.title !== undefined ? { title: asset.title } : {}),
			...(asset.ip ? { ip: asset.ip } : {}),
			...(asset.port ? { port: asset.port } : {}),
			...(asset.tech?.length ? { tech: [...new Set([...(record.tech ?? []), ...asset.tech])] } : {}),
			lastSeen: now,
			// 归属保留首次发现它的任务，只记最近一次触达的任务，免得资产在任务间来回跳。
			...(task?.id ? { lastTaskId: task.id } : {}),
			// 公司归属同理只补不清：资产先挂在别的客户名下时，不会被后一个任务抢走。
			...(!record.companyId && task?.companyId ? { companyId: task.companyId } : {}),
			...(!record.conversationId && task?.conversationId ? { conversationId: task.conversationId } : {}),
		});
	} else {
		record = {
			id: store.nextId("as"),
			type: asset.type,
			value: asset.value,
			title: asset.title ?? "",
			ip: asset.ip ?? "",
			port: asset.port ?? null,
			tech: asset.tech ?? [],
			status: "open",
			taskId: task?.id ?? null,
			companyId: task?.companyId ?? null,
			conversationId: task?.conversationId ?? null,
			firstSeen: now,
			lastSeen: now,
			notes: [],
		};
		state.assets.push(record);
	}
	store.save();
	return record;
}

function addFinding(task, finding) {
	const state = store.state;
	// 同一目标同一标题只留一条，避免每次跑任务都灌一堆重复。
	const exists = state.findings.find(
		(entry) => entry.title === finding.title && entry.target === finding.target && entry.status === "open",
	);
	if (exists) {
		exists.lastSeen = new Date().toISOString();
		exists.occurrences = (exists.occurrences ?? 1) + 1;
		// 后到的公司归属只在原记录没归属时补上，避免同一漏洞在两个客户之间跳。
		if (!exists.companyId && task?.companyId) exists.companyId = task.companyId;
		store.save();
		return exists;
	}
	const record = {
		id: store.nextId("fd"),
		title: finding.title,
		severity: finding.severity,
		target: finding.target,
		summary: finding.summary,
		evidence: finding.evidence ?? "",
		recommendation: finding.recommendation ?? "",
		source: finding.source ?? "recon",
		taskId: task?.id ?? null,
		companyId: task?.companyId ?? null,
		conversationId: task?.conversationId ?? null,
		status: "open",
		createdAt: new Date().toISOString(),
		lastSeen: new Date().toISOString(),
		occurrences: 1,
	};
	state.findings.push(record);
	store.save();
	return record;
}

export { addFinding, upsertAsset };

// ---------------------------------------------------------------- 检查项

const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

function checkHeaders(task, url, response) {
	const headers = response.headers ?? {};
	const findings = [];
	const missing = [];
	for (const [name, label] of [
		["strict-transport-security", "HSTS"],
		["content-security-policy", "CSP"],
		["x-frame-options", "X-Frame-Options"],
		["referrer-policy", "Referrer-Policy"],
	]) {
		if (!headers[name]) missing.push(label);
	}
	if (missing.length) {
		findings.push({
			severity: "low",
			title: "缺少安全响应头",
			target: url,
			summary: `响应头缺少：${missing.join("、")}`,
			evidence: `GET ${url} → ${response.status}\n缺少：${missing.join(", ")}`,
			recommendation: "在网关或应用层统一补齐安全响应头，HSTS 建议 max-age 至少 6 个月。",
		});
	}

	const banner = [headers.server, headers["x-powered-by"], headers["x-aspnet-version"]]
		.filter(Boolean)
		.join(" / ");
	if (banner) {
		findings.push({
			severity: "low",
			title: "响应头泄露服务端版本",
			target: url,
			summary: banner,
			evidence: `Server: ${headers.server ?? "-"}\nX-Powered-By: ${headers["x-powered-by"] ?? "-"}`,
			recommendation: "关闭或改写版本号标识，减少被精确匹配指纹的机会。",
		});
	}

	const cookies = headers["set-cookie"];
	if (cookies) {
		const list = Array.isArray(cookies) ? cookies : [cookies];
		const weak = list.filter((cookie) => !/;\s*secure/i.test(cookie) || !/;\s*httponly/i.test(cookie));
		if (weak.length) {
			findings.push({
				severity: "medium",
				title: "Cookie 缺少 Secure/HttpOnly",
				target: url,
				summary: weak.map((cookie) => cookie.split("=")[0]).join("、"),
				evidence: weak.slice(0, 3).join("\n"),
				recommendation: "会话类 Cookie 一律加 Secure、HttpOnly，按需补 SameSite=Lax/Strict。",
			});
		}
	}

	if (response.status >= 200 && response.status < 300 && /index of \//i.test(response.body ?? "")) {
		findings.push({
			severity: "medium",
			title: "目录列表暴露",
			target: url,
			summary: "响应体呈现 Apache/Nginx 风格目录索引",
			evidence: (response.body ?? "").slice(0, 300),
			recommendation: "关闭 autoindex，或对目录加认证。",
		});
	}

	return findings;
}

/** CORS：反射 Origin 或通配且允许凭据，都是真问题。 */
async function checkCors(url, options, task) {
	const response = await fetchOnce(url, { ...options, headers: { ...options.headers, origin: "https://regedit.invalid" } });
	if (response.error) return null;
	const allowOrigin = response.headers?.["access-control-allow-origin"];
	const allowCredentials = response.headers?.["access-control-allow-credentials"];
	if (!allowOrigin) return null;
	if (allowOrigin === "https://regedit.invalid" || (allowOrigin === "*" && allowCredentials === "true")) {
		return {
			severity: allowCredentials === "true" ? "high" : "medium",
			title: "CORS 允许任意来源",
			target: url,
			summary: `Access-Control-Allow-Origin: ${allowOrigin}${allowCredentials === "true" ? "，且允许携带凭据" : ""}`,
			evidence: `Origin: https://regedit.invalid\nAccess-Control-Allow-Origin: ${allowOrigin}\nAccess-Control-Allow-Credentials: ${allowCredentials ?? "-"}`,
			recommendation: "用白名单校验 Origin，不要反射请求头；带凭据时禁止使用 *。",
		};
	}
	return null;
}

const PATH_PROBES = [
	{
		path: "/.git/config",
		severity: "high",
		title: "Git 仓库配置可读",
		match: (body) => /\[core\]/.test(body) && /repositoryformatversion/i.test(body),
		recommendation: "删除站点下的 .git 目录，或在网关层禁掉 /.(git|svn|hg)/。",
	},
	{
		path: "/.env",
		severity: "critical",
		title: "环境变量文件可读",
		match: (body) => /(^|\n)[A-Z0-9_]{3,}=.+/.test(body) && /(APP_KEY|DB_|SECRET|PASSWORD|TOKEN)/i.test(body),
		recommendation: "把 .env 移出 Web 根目录，立即轮换其中全部凭据。",
	},
	{
		path: "/.svn/entries",
		severity: "medium",
		title: "SVN 元数据可读",
		match: (body) => body.length > 0 && body.length < 4000 && !/<html/i.test(body),
		recommendation: "禁用对隐藏目录的访问，或删除 .svn。",
	},
	{
		path: "/server-status",
		severity: "medium",
		title: "Apache server-status 暴露",
		match: (body) => /Apache Server Status|Server Status/i.test(body),
		recommendation: "限制 server-status 只允许 127.0.0.1 访问。",
	},
	{
		path: "/actuator/env",
		severity: "high",
		title: "Spring Actuator 环境变量暴露",
		match: (body) => /propertySources|activeProfiles/.test(body),
		recommendation: "关闭或鉴权 actuator 端点，至少不要暴露 env/heapdump。",
	},
];

async function probePaths(task, baseUrl, options) {
	const settings = readSettings().recon;
	const results = [];
	for (const probe of PATH_PROBES) {
		if (!settings.paths.includes(probe.path)) continue;
		if (task && activeRuns.get(task.id)?.aborted) return results;
		const url = new URL(probe.path, baseUrl).toString();
		const response = await fetchOnce(url, { ...options, bodyLimit: 64 * 1024 });
		store.addTraffic(
			trafficEntry(task, {
				method: "GET",
				url,
				status: response.status ?? 0,
				ms: response.ms ?? 0,
				bytes: response.body?.length ?? 0,
				note: `探针 ${probe.path}`,
				requestHeaders: pickHeaders(options.headers),
				responseHeaders: pickHeaders(response.headers),
				contentType: String(response.headers?.["content-type"] ?? ""),
				bodyPreview: previewBody(response.body ?? "", String(response.headers?.["content-type"] ?? "")),
				probe: true,
			}),
		);
		if (response.error || response.status !== 200) continue;
		if (probe.match(response.body ?? "")) {
			results.push({
				severity: probe.severity,
				title: probe.title,
				target: url,
				summary: `${url} 直接返回了可判定内容`,
				evidence: `GET ${url} → 200\n${(response.body ?? "").slice(0, 400)}`,
				recommendation: probe.recommendation,
			});
		}
	}
	return results;
}

// ---------------------------------------------------------------- 任务

export function normalizeTarget(input) {
	const trimmed = String(input ?? "").trim();
	if (!trimmed) return null;
	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
	try {
		const url = new URL(withScheme);
		if (!["http:", "https:"].includes(url.protocol)) return null;
		return {
			input: trimmed,
			host: url.hostname,
			baseUrl: `${url.protocol}//${url.host}`,
			path: url.pathname === "/" ? "/" : url.pathname,
		};
	} catch {
		return null;
	}
}

export function createTask({ title, scope, companyId = null, conversationId = null }) {
	const targets = String(scope ?? "")
		.split(/[\s,]+/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map(normalizeTarget)
		.filter(Boolean);
	const settings = readSettings().recon;
	const limited = targets.slice(0, settings.maxTargets);
	const task = {
		id: store.nextId("tk"),
		title: String(title || "").trim() || `评估任务 ${new Date().toLocaleString("zh-CN")}`,
		scope: limited.map((target) => target.input),
		targets: limited,
		status: "queued",
		stage: "待命",
		// 项目归属：公司决定交付给谁，会话决定这个项目是从哪次对话长出来的。
		// 两个字段一路带到资产、发现与流量，界面才能按公司/会话把数据串起来。
		companyId: companyId || null,
		conversationId: conversationId || null,
		createdAt: new Date().toISOString(),
		startedAt: null,
		finishedAt: null,
		events: [],
		stats: { targets: limited.length, assets: 0, findings: 0, requests: 0 },
		summary: "",
		skipped: String(scope ?? "")
			.split(/[\s,]+/)
			.filter(Boolean).length - limited.length,
	};
	// 没有可识别目标时不要入库：调用方会回 400，落一条空任务只会让列表变脏。
	// （这里踩过坑：先入库后校验，被拒绝的请求在 state.json 里留下了孤儿任务。）
	if (limited.length > 0) {
		store.state.tasks.unshift(task);
		store.save();
	}
	return task;
}

export function startTask(task) {
	if (!task) return { ok: false, error: "任务不存在" };
	if (activeRuns.has(task.id)) return { ok: false, error: "任务正在运行" };
	activeRuns.set(task.id, { aborted: false });
	task.status = "running";
	task.startedAt = new Date().toISOString();
	task.finishedAt = null;
	task.events = [];
	store.pushTaskEvent(task, "info", `开始评估，共 ${task.targets.length} 个目标`);
	void runTask(task).catch((error) => {
		task.status = "failed";
		task.finishedAt = new Date().toISOString();
		store.pushTaskEvent(task, "error", `任务异常终止：${error.message}`);
		store.log("error", `任务 ${task.id} 异常：${error.message}`);
	}).finally(() => {
		activeRuns.delete(task.id);
	});
	return { ok: true };
}

export function stopTask(task) {
	const run = activeRuns.get(task?.id);
	if (!run) return { ok: false, error: "任务没有在运行" };
	run.aborted = true;
	store.pushTaskEvent(task, "warn", "收到停止指令，正在收尾");
	return { ok: true };
}

export function isRunning(taskId) {
	return activeRuns.has(taskId);
}

async function runTask(task) {
	const settings = readSettings().recon;
	const options = {
		timeoutMs: settings.timeoutMs,
		bodyLimit: 256 * 1024,
		insecureTls: true,
		headers: {
			"user-agent": settings.userAgent,
			accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
			"accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
			connection: "close",
		},
	};

	let stopped = false;
	for (const [index, target] of task.targets.entries()) {
		if (activeRuns.get(task.id)?.aborted) {
			stopped = true;
			break;
		}
		task.stage = `目标 ${index + 1}/${task.targets.length}：${target.host}`;
		store.pushTaskEvent(task, "step", `▶ ${target.baseUrl}`);

		// 1) 解析
		let ip = "";
		let dnsError = "";
		const dnsStarted = Date.now();
		try {
			const record = await lookup(target.host);
			ip = record.address;
			store.pushTaskEvent(task, "info", `DNS：${target.host} → ${ip}`);
			upsertAsset(task, { type: "ip", value: ip, title: target.host });
		} catch (error) {
			dnsError = error.code ?? error.message;
			store.pushTaskEvent(task, "warn", `DNS 解析失败：${dnsError}（继续按域名尝试）`);
		}
		// DNS 也是一次真实的出网动作，记进流量：解析失败时它是"目标为什么不可达"的第一条证据。
		store.addTraffic(
			trafficEntry(task, {
				kind: "dns",
				method: "DNS",
				url: `dns://${target.host}`,
				status: ip ? 200 : 0,
				ms: Date.now() - dnsStarted,
				bytes: 0,
				note: ip || dnsError || "DNS 查询",
			}),
		);

		// 2) 首屏
		const response = await fetchWithRedirects(target.baseUrl, options, task);
		if (response.error) {
			store.pushTaskEvent(task, "error", `请求失败：${response.error}`);
			addFinding(task, {
				severity: "info",
				title: "目标当前不可达",
				target: target.baseUrl,
				summary: response.error,
				evidence: `GET ${target.baseUrl}\n${response.error}`,
				recommendation: "确认目标是否在线、是否只在内网可达，以及评估网络是否需要代理。",
			});
			continue;
		}
		task.stats.requests += 1;
		const finalUrl = response.finalUrl ?? target.baseUrl;
		const title = titleOf(response.body);
		const tech = detectTech(response);
		store.pushTaskEvent(
			task,
			"info",
			`HTTP ${response.status} · ${title || "无标题"}${tech.length ? ` · ${tech.join("/")}` : ""}`,
		);
		if (response.chain?.length > 1) {
			store.pushTaskEvent(task, "info", `跳转链：${response.chain.map((hop) => hop.status).join(" → ")}`);
		}

		// 3) 资产
		upsertAsset(task, {
			type: "domain",
			value: target.host,
			title,
			ip,
			tech,
		});
		upsertAsset(task, {
			type: "url",
			value: finalUrl,
			title,
			ip,
			tech,
		});
		task.stats.assets = store.state.assets.filter((asset) => asset.taskId === task.id).length;

		// 4) 判定
		const findings = [];
		findings.push(...checkHeaders(task, finalUrl, response));
		const corsFinding = await checkCors(finalUrl, options, task);
		if (corsFinding) findings.push(corsFinding);

		if (finalUrl.startsWith("http://")) {
			findings.push({
				severity: "medium",
				title: "站点以明文 HTTP 提供服务",
				target: finalUrl,
				summary: "未跳转到 HTTPS",
				evidence: `GET ${target.baseUrl} → ${response.status}，最终地址 ${finalUrl}`,
				recommendation: "全站 301 到 HTTPS，并补 HSTS。",
			});
		}

		if (response.tls) {
			const expiry = Date.parse(response.tls.validTo);
			if (Number.isFinite(expiry) && expiry < Date.now()) {
				findings.push({
					severity: "medium",
					title: "TLS 证书已过期",
					target: finalUrl,
					summary: `证书有效期至 ${response.tls.validTo}`,
					evidence: JSON.stringify(response.tls, null, 2),
					recommendation: "更换证书，并建立到期提醒。",
				});
			}
		}

		task.stage = `暴露面探测：${target.host}`;
		const probes = await probePaths(task, finalUrl, options);
		findings.push(...probes);

		for (const finding of findings) {
			addFinding(task, finding);
			store.pushTaskEvent(task, finding.severity === "info" ? "info" : "found", `[${finding.severity}] ${finding.title}`);
		}

		task.stats.findings = store.state.findings.filter((finding) => finding.taskId === task.id).length;
		store.save();
		// 间隔，别把目标打疼。
		await new Promise((resolve) => setTimeout(resolve, settings.delayMs));
	}

	task.status = stopped ? "stopped" : "done";
	task.stage = stopped ? "已停止" : "完成";
	task.finishedAt = new Date().toISOString();
	const taskFindings = store.state.findings.filter((finding) => finding.taskId === task.id);
	const bySeverity = taskFindings.reduce((acc, finding) => {
		acc[finding.severity] = (acc[finding.severity] ?? 0) + 1;
		return acc;
	}, {});
	task.summary = Object.entries(bySeverity)
		.sort((a, b) => (SEVERITY_ORDER[a[0]] ?? 9) - (SEVERITY_ORDER[b[0]] ?? 9))
		.map(([severity, count]) => `${severity} ${count}`)
		.join(" / ") || "无发现";
	store.pushTaskEvent(task, "info", `任务${stopped ? "已停止" : "完成"}：${taskFindings.length} 条发现，${task.stats.requests} 次请求`);
	store.log("info", `任务 ${task.id} ${stopped ? "已停止" : "完成"}：${task.title}`);
	store.save();
}
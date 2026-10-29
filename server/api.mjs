/**
 * REST 路由表。所有 /api/* 请求都进 handleApi，由它做鉴权与分发。
 *
 * 约定：
 * - 除 /api/auth/* 与 /api/bootstrap 外，一律要求会话；
 * - 路由用 "/api/x/:id/y" 的写法，params 由匹配器填；
 * - 处理器返回 void，响应自己写（有些接口要流式返回文件）。
 */

import { networkInterfaces } from "node:os";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ARTIFACT_DIR, ROOT, VERSION, readSettings, writeSettings } from "./config.mjs";
import { store } from "./store.mjs";
import {
	checkPasswordPolicy,
	createUser,
	findUser,
	hasUser,
	hashPassword,
	requireAuth,
	sessionFromRequest,
	sessions,
	setPassword,
	verifyPassword,
} from "./auth.mjs";
import { readJson, readRaw, sendError, sendJson, sendText } from "./http.mjs";
import { analyzeApk } from "./apk.mjs";
import { createTask, isRunning, startTask, stopTask, trafficEntry } from "./recon.mjs";
import { appendTimeline, isOpen, isSeverityMismatch, normalizeStatus } from "./findings-model.mjs";
import { generateReport } from "./reports.mjs";
import { listSkills, readSkill } from "./skills.mjs";
import {
	addEdge,
	addNode,
	clearGraph,
	deleteEdge,
	deleteNode,
	frontier,
	getNode,
	listActivity,
	seedFromExisting,
	snapshot,
	updateNode,
} from "./exploration.mjs";
import {
	addDoc,
	deleteDoc,
	getDoc,
	listDocs,
	reindex,
	search as knowledgeSearch,
	setCategory,
	stats as knowledgeStats,
} from "./knowledge.mjs";
import { GROUPS as toolGroups, isEnabled as isToolEnabled, listTools, recordCall as recordToolCall, setEnabled, stats as toolStats, toolForPath } from "./tools.mjs";
import {
	activateProfile,
	deleteProfile,
	listAgents,
	getAgent,
	upsertAgent,
	deleteAgent,
	llmState,
	resetPool,
	setRole,
	testProfile,
	upsertProfile,
} from "./agents.mjs";
import {
	assignRole,
	deleteRole,
	listRoles,
	listUsers,
	me as rbacMe,
	permissionCatalogue,
	hasPermission,
	stats as rbacStats,
	upsertRole,
} from "./rbac.mjs";
import { deleteServer as deleteMcpServer, listServers as listMcpServers, testServer as testMcpServer, upsertServer as upsertMcpServer } from "./mcp.mjs";
import {
	clearPocs,
	deletePoc,
	getPoc,
	importFromUrl as importPocsFromUrl,
	importTemplates,
	listPocs,
	seedExamples as seedPocExamples,
	stats as pocStats,
} from "./pocs.mjs";
import { history as intelHistory, listPlatforms as listIntelPlatforms, query as intelQuery, savePlatform as saveIntelPlatform, verify as verifyIntel } from "./intel.mjs";
import {
	addKey as addWebSearchKey,
	extract as webExtract,
	removeKey as removeWebSearchKey,
	search as webSearch,
	setEnabled as setWebSearchEnabled,
	state as webSearchState,
} from "./websearch.mjs";
import {
	deleteProfile as deleteProxyProfile,
	listProfiles as listProxyProfiles,
	refreshSubscription as refreshProxySubscription,
	testProfile as testProxyProfile,
	upsertProfile as upsertProxyProfile,
} from "./proxies.mjs";
import {
	deleteChannel as deleteNotifyChannel,
	setTrigger as setNotifyTrigger,
	state as notifyState,
	testChannel as testNotifyChannel,
	upsertChannel as upsertNotifyChannel,
} from "./notify.mjs";
import {
	archiveConversation,
	abortTurn,
	createConversation,
	deleteConversation,
	getConversation,
	isTurnRunning,
	listConversations,
	patchConversation,
	renameConversation,
	sendMessage as sendChatMessage,
	sendMessageStream,
	setGoal,
	stats as chatStats,
} from "./chat.mjs";
import {
	SECTION_LABELS,
	assignCompany,
	companyDetail,
	deleteCompany,
	deleteTemplate,
	getReportSettings,
	listCompanies,
	listTemplates,
	reattribute,
	saveReportSettings,
	upsertCompany,
	upsertTemplate,
} from "./org.mjs";
import {
	GUARD_SCOPES,
	MODE_HINTS,
	MODE_LABELS,
	MODES,
	approve,
	deleteDecision,
	decisionStats,
	getApproval,
	guard,
	healthSnapshot,
	listApprovals,
	queryDecisions,
	readConfig as readGateConfig,
	registerRunner,
	reject,
	resolveEndpoint as resolveGateEndpoint,
	testJudge,
	writeConfig as writeGateConfig,
} from "./gatekeeper.mjs";
import {
	createToken,
	deleteDevice,
	deleteToken,
	gateway,
	getDevice,
	listDevices,
	listTokens,
	renameDevice,
} from "./droid.mjs";

// 守门员执行动作时回调到这里：gatekeeper 不反向依赖设备网关。
registerRunner(async (action) => {
	if (action.kind === "deviceExec") {
		return gateway.exec(action.deviceId, action.cmd, { asRoot: action.asRoot, timeoutMs: action.timeoutMs });
	}
	if (action.kind === "devicePush") {
		return gateway.push(action.deviceId, action.path, Buffer.from(action.base64, "base64"), action.mode);
	}
	if (action.kind === "reconTask") {
		const task = store.state.tasks.find((entry) => entry.id === action.taskId);
		if (!task) return { ok: false, error: "任务不存在" };
		return startTask(task);
	}
	return { ok: false, error: `未知动作：${action.kind}` };
});

const routes = [];

function on(method, pattern, handler, options = {}) {
	routes.push({ method, parts: pattern.split("/").filter(Boolean), handler, public: options.public === true });
}

function match(method, pathname) {
	const parts = pathname.split("/").filter(Boolean);
	for (const route of routes) {
		if (route.method !== method) continue;
		if (route.parts.length !== parts.length) continue;
		const params = {};
		let ok = true;
		for (let i = 0; i < route.parts.length; i += 1) {
			const expected = route.parts[i];
			if (expected.startsWith(":")) params[expected.slice(1)] = decodeURIComponent(parts[i]);
			else if (expected !== parts[i]) {
				ok = false;
				break;
			}
		}
		if (ok) return { route, params };
	}
	return null;
}

// ---------------------------------------------------------------- 登录限速

const loginAttempts = new Map();

function loginBlocked(ip) {
	const entry = loginAttempts.get(ip);
	if (!entry) return false;
	if (Date.now() - entry.at > 10 * 60_000) {
		loginAttempts.delete(ip);
		return false;
	}
	return entry.count >= 8;
}

function noteLoginFailure(ip) {
	const entry = loginAttempts.get(ip) ?? { count: 0, at: Date.now() };
	entry.count += 1;
	entry.at = Date.now();
	loginAttempts.set(ip, entry);
}

function clientIp(req) {
	return req.socket.remoteAddress ?? "unknown";
}

// ---------------------------------------------------------------- 基础

on(
	"GET",
	"/api/bootstrap",
	async ({ res, req }) => {
		const { session } = sessionFromRequest(req);
		const settings = readSettings();
		sendJson(res, 200, {
			version: VERSION,
			firstRun: !hasUser(),
			authenticated: Boolean(session),
			user: session?.user ?? null,
			site: settings.site,
			// 未登录时只给品牌信息，别把配置面暴露给扫描器。
			...(session
				? {
						llm: { enabled: settings.llm.enabled, model: settings.llm.model, baseUrl: settings.llm.baseUrl },
						android: { autostart: settings.android.autostart },
						stats: {
							tasks: store.state.tasks.length,
							running: store.state.tasks.filter((task) => task.status === "running").length,
							assets: store.state.assets.length,
							findings: store.state.findings.filter((finding) => isOpen(finding)).length,
							devices: store.state.droid.devices.length,
							pending: decisionStats().pending,
							traffic: (store.state.traffic ?? []).length,
						},
					}
				: {}),
		});
	},
	{ public: true },
);

on(
	"POST",
	"/api/auth/setup",
	async ({ req, res }) => {
		if (hasUser()) return sendError(res, 400, "控制台已经初始化，请直接登录");
		const body = await readJson(req);
		const problem = checkPasswordPolicy(body.password);
		if (problem) return sendError(res, 400, problem);
		const operator = String(body.operator ?? "").trim().slice(0, 40);
		const user = createUser("admin", body.password);
		const settings = readSettings();
		settings.auth.initialized = true;
		settings.site.operator = operator || "操作员";
		writeSettings(settings);
		const token = sessions.create(user);
		store.log("info", `控制台初始化完成，操作员：${settings.site.operator}`);
		sendJson(res, 200, { token, user: user.name, operator: settings.site.operator });
	},
	{ public: true },
);

on(
	"POST",
	"/api/auth/login",
	async ({ req, res }) => {
		const ip = clientIp(req);
		if (loginBlocked(ip)) return sendError(res, 429, "尝试次数过多，请 10 分钟后再试");
		const body = await readJson(req);
		const user = findUser(String(body.user ?? "admin"));
		if (!user || !verifyPassword(String(body.password ?? ""), user.hash)) {
			noteLoginFailure(ip);
			return sendError(res, 401, "账号或口令错误");
		}
		loginAttempts.delete(ip);
		const token = sessions.create(user);
		store.log("info", `登录成功：${user.name}`);
		sendJson(res, 200, { token, user: user.name });
	},
	{ public: true },
);

on("POST", "/api/auth/logout", async ({ req, res }) => {
	const { token } = sessionFromRequest(req);
	sessions.drop(token);
	sendJson(res, 200, { ok: true });
});

on("POST", "/api/auth/password", async ({ req, res, session }) => {
	const body = await readJson(req);
	const user = store.state.users.find((entry) => entry.name === session.user);
	if (!user) return sendError(res, 400, "用户不存在");
	if (!verifyPassword(String(body.current ?? ""), user.hash)) return sendError(res, 400, "当前口令不正确");
	const problem = checkPasswordPolicy(body.next);
	if (problem) return sendError(res, 400, problem);
	setPassword(user, body.next);
	sessions.dropUser(user.id);
	store.log("info", "控制台口令已更新");
	sendJson(res, 200, { ok: true });
});

// ---------------------------------------------------------------- 总览

on("GET", "/api/overview", async ({ res }) => {
	const state = store.state;
	const open = state.findings.filter((finding) => isOpen(finding));
	const bySeverity = open.reduce((acc, finding) => {
		acc[finding.severity] = (acc[finding.severity] ?? 0) + 1;
		return acc;
	}, {});
	sendJson(res, 200, {
		stats: {
			tasks: state.tasks.length,
			running: state.tasks.filter((task) => task.status === "running").length,
			assets: state.assets.length,
			findings: open.length,
			reports: state.reports.length,
			devices: state.droid.devices.length,
			online: gateway.devices().filter((device) => device.liveness === "online").length,
			pendingApprovals: decisionStats().pending,
		},
		bySeverity,
		gate: decisionStats(),
		recentTasks: state.tasks.slice(0, 6),
		recentFindings: [...open].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, 8),
		trafficSeries: state.traffic.slice(-24).map((item) => ({ at: item.at, status: item.status, ms: item.ms })),
	});
});

// ---------------------------------------------------------------- 任务

on("GET", "/api/tasks", async ({ res }) => {
	const companies = new Map((store.state.companies ?? []).map((company) => [company.id, company.name]));
	sendJson(
		res,
		200,
		store.state.tasks.map((task) => ({
			...task,
			running: isRunning(task.id),
			findings: store.state.findings.filter((finding) => finding.taskId === task.id).length,
			assets: store.state.assets.filter((asset) => asset.taskId === task.id || asset.lastTaskId === task.id).length,
			traffic: (store.state.traffic ?? []).filter((item) => item.taskId === task.id).length,
			companyName: task.companyId ? (companies.get(task.companyId) ?? "") : "",
		})),
	);
});

on("POST", "/api/tasks", async ({ req, res }) => {
	const body = await readJson(req);
	const platform = body.platform === "android" ? "android" : "web";
	const task = createTask({
		title: body.title,
		scope: body.scope,
		companyId: body.companyId ?? null,
		conversationId: body.conversationId ?? null,
		platform,
		appPackage: body.appPackage ?? "",
	});
	// 站点项目必须有目标；移动端项目的目标是 App/设备，允许空范围。
	if (platform !== "android" && task.targets.length === 0) return sendError(res, 400, "范围内没有可识别的目标（需要域名或 URL）");
	if (platform === "android" && !task.appPackage && !String(body.title ?? "").trim()) {
		return sendError(res, 400, "移动端项目需要一个名称或包名");
	}
	store.log("info", `创建${platform === "android" ? "移动端" : ""}项目：${task.title}（${task.targets.length} 个目标）`);
	if (body.autorun !== false) {
		// 任务引擎默认不守门（每个 GET 都判定会把一次侦察拖成几十次模型往返）；
		// 打开「任务引擎」这一类后，按"一次任务一次判定"处理。
		const gate = await guard({
			scope: "recon",
			source: "任务引擎",
			target: task.title,
			command: `对以下目标发起只读 GET 侦察：\n${(task.scope ?? []).join("\n")}`,
			action: { kind: "reconTask", taskId: task.id },
		});
		if (gate.kind === "pending") {
			return sendJson(res, 202, { task, pending: true, approvalId: gate.approvalId, mode: gate.mode });
		}
		if (gate.kind === "block") {
			return sendJson(res, 200, { task, blocked: true, reason: gate.reason, error: gate.message });
		}
	}
	sendJson(res, 200, { task });
});

on("GET", "/api/tasks/:id", async ({ res, params }) => {
	const task = store.state.tasks.find((entry) => entry.id === params.id);
	if (!task) return sendError(res, 404, "任务不存在");
	const findings = store.state.findings.filter((finding) => finding.taskId === task.id);
	const traffic = store.state.traffic.filter((item) => item.taskId === task.id).slice(-60);
	// 项目详情要把"这个任务产出的资产"一起给：任务页的资产数是它自己的，不是全站资产数。
	const assets = store.state.assets.filter((asset) => asset.taskId === task.id || asset.lastTaskId === task.id);
	const conversation = task.conversationId ? (store.state.conversations ?? []).find((c) => c.id === task.conversationId) : null;
	sendJson(res, 200, {
		task: { ...task, running: isRunning(task.id) },
		findings,
		traffic,
		assets,
		conversation: conversation ? { id: conversation.id, title: conversation.title } : null,
		company: task.companyId ? (store.state.companies ?? []).find((c) => c.id === task.companyId) ?? null : null,
	});
});

on("POST", "/api/tasks/:id/run", async ({ res, params }) => {
	const task = store.state.tasks.find((entry) => entry.id === params.id);
	if (!task) return sendError(res, 404, "任务不存在");
	const gate = await guard({
		scope: "recon",
		source: "任务引擎",
		target: task.title,
		command: `对以下目标发起只读 GET 侦察：\n${(task.scope ?? []).join("\n")}`,
		action: { kind: "reconTask", taskId: task.id },
	});
	if (gate.kind === "pending") return sendJson(res, 202, { pending: true, approvalId: gate.approvalId, mode: gate.mode });
	if (gate.kind === "block") return sendJson(res, 200, { blocked: true, reason: gate.reason, error: gate.message });
	const result = gate.result ?? {};
	if (result.ok === false) return sendError(res, 409, result.error ?? "任务未能启动");
	sendJson(res, 200, { ok: true });
});

on("POST", "/api/tasks/:id/stop", async ({ res, params }) => {
	const task = store.state.tasks.find((entry) => entry.id === params.id);
	if (!task) return sendError(res, 404, "任务不存在");
	const result = stopTask(task);
	if (!result.ok) return sendError(res, 409, result.error);
	sendJson(res, 200, { ok: true });
});

on("DELETE", "/api/tasks/:id", async ({ res, params }) => {
	const index = store.state.tasks.findIndex((entry) => entry.id === params.id);
	if (index < 0) return sendError(res, 404, "任务不存在");
	store.state.tasks.splice(index, 1);
	store.save();
	sendJson(res, 200, { ok: true });
});

on("PATCH", "/api/tasks/:id", async ({ req, res, params }) => {
	const task = store.state.tasks.find((entry) => entry.id === params.id);
	if (!task) return sendError(res, 404, "任务不存在");
	const body = await readJson(req);
	if (body.title !== undefined) task.title = String(body.title).slice(0, 120) || task.title;
	// 归属可以事后补：项目跑完才发现该挂到某个客户名下是常态。
	if (body.companyId !== undefined) {
		const companyId = String(body.companyId ?? "").trim();
		if (companyId && !(store.state.companies ?? []).some((company) => company.id === companyId)) {
			return sendError(res, 400, "公司不存在");
		}
		task.companyId = companyId || null;
		// 项目改归属时，跟着它产生的资产/发现/流量一起改——否则界面上公司下面挂不住数据。
		for (const asset of store.state.assets) {
			if (asset.taskId === task.id) asset.companyId = task.companyId;
		}
		for (const finding of store.state.findings) {
			if (finding.taskId === task.id) finding.companyId = task.companyId;
		}
		for (const item of store.state.traffic ?? []) {
			if (item.taskId === task.id) item.companyId = task.companyId;
		}
	}
	if (body.note !== undefined) store.pushTaskEvent(task, "info", String(body.note).slice(0, 300));
	// 项目也可以绑设备：会话没绑时，对话里的设备工具就用项目绑的这台。
	if (body.deviceId !== undefined) task.deviceId = String(body.deviceId ?? "").trim() || null;
	store.save();
	sendJson(res, 200, { ok: true, task });
});

// ---------------------------------------------------------------- 资产 / 漏洞

on("GET", "/api/assets", async ({ res, query }) => {
	const companyId = query.get("companyId");
	const taskId = query.get("taskId");
	const kind = query.get("kind");
	let items = store.state.assets ?? [];
	if (companyId) items = items.filter((asset) => asset.companyId === companyId);
	if (taskId) items = items.filter((asset) => asset.taskId === taskId || asset.lastTaskId === taskId);
	if (kind && kind !== "all") items = items.filter((asset) => asset.type === kind);
	sendJson(res, 200, items);
});

on("PATCH", "/api/assets/:id", async ({ req, res, params }) => {
	const asset = store.state.assets.find((entry) => entry.id === params.id);
	if (!asset) return sendError(res, 404, "资产不存在");
	const body = await readJson(req);
	if (body.status) asset.status = String(body.status);
	if (body.note) asset.notes.push({ at: new Date().toISOString(), text: String(body.note).slice(0, 2000) });
	if (body.tags) asset.tags = body.tags.map((tag) => String(tag).slice(0, 30));
	store.save();
	sendJson(res, 200, asset);
});

on("DELETE", "/api/assets/:id", async ({ res, params }) => {
	const index = store.state.assets.findIndex((entry) => entry.id === params.id);
	if (index < 0) return sendError(res, 404, "资产不存在");
	store.state.assets.splice(index, 1);
	store.save();
	sendJson(res, 200, { ok: true });
});

on("GET", "/api/findings", async ({ res, query }) => {
	let items = store.state.findings ?? [];
	const taskId = query.get("taskId");
	const companyId = query.get("companyId");
	const platform = query.get("platform");
	const status = query.get("status");
	if (taskId) items = items.filter((finding) => finding.taskId === taskId);
	if (companyId) items = items.filter((finding) => finding.companyId === companyId);
	if (platform && platform !== "all") items = items.filter((finding) => (finding.platform ?? "web") === platform);
	if (status && status !== "all") items = items.filter((finding) => normalizeStatus(finding.status) === status);
	sendJson(res, 200, items);
});

on("PATCH", "/api/findings/:id", async ({ req, res, params }) => {
	const finding = store.state.findings.find((entry) => entry.id === params.id);
	if (!finding) return sendError(res, 404, "发现不存在");
	const body = await readJson(req);
	const before = normalizeStatus(finding.status);
	// 状态流转：只认四态（pending / confirmed / false-positive / fixed），旧写法自动映射。
	// 每次流转写进处理时间线，报告末尾按时间还原，谁改的、为什么改都留得住。
	if (body.status !== undefined) {
		const next = normalizeStatus(body.status);
		if (next !== before) {
			appendTimeline(finding, {
				author: "operator",
				text: body.note ? String(body.note).slice(0, 500) : "状态变更",
				from: before,
				to: next,
			});
		}
		finding.status = next;
	}
	if (body.severity) finding.severity = String(body.severity);
	// CVSS 与向量：运营者可以给"未评分"的远程判定补分；等级不一致会在报告里标出来。
	if (body.cvss !== undefined) {
		const score = Number(body.cvss);
		finding.cvss = body.cvss === null || body.cvss === "" || !Number.isFinite(score) ? null : Math.min(Math.max(score, 0), 10);
	}
	if (body.cvssVector !== undefined) finding.cvssVector = String(body.cvssVector ?? "").slice(0, 200);
	// 复现材料可以事后补：操作员拿到更完整的包，直接贴进来覆盖。
	for (const key of ["repro", "requestPkt", "responsePkt", "recommendation", "category", "appPackage", "appVersion", "title"]) {
		if (body[key] !== undefined) finding[key] = String(body[key] ?? "").slice(0, key.endsWith("Pkt") ? 24 * 1024 : 8000);
	}
	if (body.references !== undefined) {
		finding.references = Array.isArray(body.references)
			? body.references.map((item) => String(item).slice(0, 300)).filter(Boolean).slice(0, 20)
			: [];
	}
	if (body.note) {
		finding.notes = [...(finding.notes ?? []), { at: new Date().toISOString(), text: String(body.note).slice(0, 2000) }];
		appendTimeline(finding, { author: "operator", text: String(body.note).slice(0, 500) });
	}
	if (body.status === undefined && body.severity && body.note) {
		appendTimeline(finding, { author: "operator", text: `等级调整为 ${body.severity}` });
	}
	store.save();
	sendJson(res, 200, finding);
});

on("DELETE", "/api/findings/:id", async ({ res, params }) => {
	const index = store.state.findings.findIndex((entry) => entry.id === params.id);
	if (index < 0) return sendError(res, 404, "发现不存在");
	store.state.findings.splice(index, 1);
	store.save();
	sendJson(res, 200, { ok: true });
});

// ---------------------------------------------------------------- 报告

on("GET", "/api/reports", async ({ res }) => {
	sendJson(res, 200, store.state.reports);
});

on("POST", "/api/reports", async ({ req, res }) => {
	const body = await readJson(req);
	const result = generateReport({ taskId: body.taskId, title: body.title, findingIds: body.findingIds });
	sendJson(res, 200, result);
});

on("GET", "/api/reports/:id/raw", async ({ res, params }) => {
	const report = store.state.reports.find((entry) => entry.id === params.id);
	if (!report) return sendError(res, 404, "报告不存在");
	try {
		const text = readFileSync(report.file, "utf8");
		sendText(res, 200, text, "text/markdown; charset=utf-8");
	} catch {
		// 报告文件被手工删掉了：用当前数据重建一份，别让页面 500。
		const rebuilt = generateReport({ taskId: report.taskId, title: report.title });
		sendText(res, 200, readFileSync(rebuilt.report.file, "utf8"), "text/markdown; charset=utf-8");
	}
});

on("DELETE", "/api/reports/:id", async ({ res, params }) => {
	const index = store.state.reports.findIndex((entry) => entry.id === params.id);
	if (index < 0) return sendError(res, 404, "报告不存在");
	store.state.reports.splice(index, 1);
	store.save();
	sendJson(res, 200, { ok: true });
});

// ---------------------------------------------------------------- 技能 / 流量 / 日志

on("GET", "/api/skills", async ({ res, query }) => {
	const { skills, dirs } = listSkills(query.get("force") === "1");
	// 外部目录只显示最后两段，别把本机绝对路径送到浏览器。
	const label = (dir) => {
		const normalized = dir.replaceAll("\\", "/");
		if (normalized.startsWith(ROOT.replaceAll("\\", "/"))) return `.${normalized.slice(ROOT.length)}`;
		return normalized.split("/").filter(Boolean).slice(-2).join("/");
	};
	sendJson(res, 200, { skills, sources: dirs.map(label) });
});

on("GET", "/api/skills/:id", async ({ res, params }) => {
	const skill = readSkill(params.id);
	if (!skill) return sendError(res, 404, "技能不存在");
	sendJson(res, 200, skill);
});

on("GET", "/api/traffic", async ({ res, query }) => {
	const limit = Math.min(Number(query.get("limit") ?? 200) || 200, 1000);
	const taskId = query.get("taskId");
	const companyId = query.get("companyId");
	const conversationId = query.get("conversationId");
	const kind = query.get("kind");
	const keyword = String(query.get("q") ?? "").trim().toLowerCase();
	let items = store.state.traffic ?? [];
	if (taskId) items = items.filter((item) => item.taskId === taskId);
	if (companyId) items = items.filter((item) => item.companyId === companyId);
	if (conversationId) items = items.filter((item) => item.conversationId === conversationId);
	if (kind && kind !== "all") items = items.filter((item) => (item.kind ?? "http") === kind);
	if (keyword) items = items.filter((item) => `${item.url ?? ""} ${item.note ?? ""} ${item.method ?? ""}`.toLowerCase().includes(keyword));
	sendJson(res, 200, items.slice(-limit).reverse());
});

on("GET", "/api/logs", async ({ res, query }) => {
	const limit = Math.min(Number(query.get("limit") ?? 300) || 300, 2000);
	sendJson(res, 200, [...store.state.logs].reverse().slice(0, limit));
});

// ---------------------------------------------------------------- 设置

on("GET", "/api/settings", async ({ res }) => {
	const settings = readSettings();
	// 口令哈希与 API Key 不出服务端：只回填"是否已配置"。
	sendJson(res, 200, {
		...settings,
		llm: { ...settings.llm, apiKey: settings.llm.apiKey ? "••••••••" : "" },
	});
});

on("PUT", "/api/settings", async ({ req, res }) => {
	const body = await readJson(req);
	const settings = readSettings();
	for (const key of ["site", "recon", "llm", "mcp", "android", "skills", "chat"]) {
		if (body[key] === undefined) continue;
		if (key === "llm" && body.llm?.apiKey === "••••••••") {
			const { apiKey, ...rest } = body.llm;
			settings.llm = { ...settings.llm, ...rest };
			continue;
		}
		settings[key] = { ...settings[key], ...body[key] };
	}
	writeSettings(settings);
	store.log("info", "设置已更新");
	sendJson(res, 200, { ok: true, settings: { ...settings, llm: { ...settings.llm, apiKey: "" } } });
});

on("GET", "/api/system", async ({ res }) => {
	const memory = process.memoryUsage();
	sendJson(res, 200, {
		version: VERSION,
		node: process.version,
		platform: `${process.platform} ${process.arch}`,
		uptime: Math.round(process.uptime()),
		memoryMB: Math.round(memory.rss / 1048576),
		dataDir: ARTIFACT_DIR.replace(ROOT, "."),
		sessions: sessions.size,
		listen: gateway.listenInfo(),
	});
});

// ---------------------------------------------------------------- 守门（AI 审批）

on("GET", "/api/gatekeeper", async ({ res }) => {
	const config = readGateConfig();
	const endpoint = resolveGateEndpoint();
	sendJson(res, 200, {
		// API Key 不出服务端：只回填"是否已配置"的掩码。
		config: { ...config, model: { ...config.model, apiKey: config.model.apiKey ? "••••••••" : "" } },
		// 端点只回模型与来源，apiKey 绝不出服务端。
		endpoint: endpoint ? { modelId: endpoint.modelId, from: endpoint.from, fallback: endpoint.fallback, baseUrl: endpoint.baseUrl } : null,
		health: healthSnapshot(),
		stats: decisionStats(),
		modes: MODES.map((id) => ({ id, label: MODE_LABELS[id], hint: MODE_HINTS[id] })),
		scopes: Object.entries(GUARD_SCOPES).map(([id, meta]) => ({
			id,
			label: meta.label,
			hint: meta.hint,
			tool: meta.tool,
		})),
	});
});

on("PUT", "/api/gatekeeper", async ({ req, res }) => {
	const body = await readJson(req);
	const patch = {};
	for (const key of ["mode", "timeoutMs", "concurrency", "guard", "model"]) {
		if (body[key] !== undefined) patch[key] = body[key];
	}
	// 掩码表示"不改动"：前端从不回传明文 Key。
	if (patch.model && patch.model.apiKey === "••••••••") {
		const { apiKey, ...rest } = patch.model;
		patch.model = rest;
	}
	// 切到 AI 审批却没有端点，是唯一比"停下来"更糟的结局：直接拒绝，不静默降级。
	if (patch.mode === "ai") {
		const candidate = { ...readGateConfig(), ...patch };
		const llm = readSettings().llm ?? {};
		const hasOwn = candidate.model?.baseUrl && candidate.model?.modelId;
		const hasFallback = llm.enabled && llm.baseUrl && llm.model;
		if (!hasOwn && !hasFallback) {
			return sendError(res, 400, "切到 AI 审批前请先配置判定端点（守门模型，或启用「大模型」）");
		}
	}
	const config = writeGateConfig(patch);
	store.log("info", `守门设置已更新：模式 ${MODE_LABELS[config.mode]}`);
	sendJson(res, 200, { ok: true, config, endpoint: resolveGateEndpoint() });
});

on("POST", "/api/gatekeeper/test", async ({ res }) => {
	sendJson(res, 200, await testJudge());
});

on("GET", "/api/gatekeeper/decisions", async ({ res, query }) => {
	const filter = {
		decision: query.get("decision") ?? undefined,
		approval: query.get("approval") ?? undefined,
		tool: query.get("tool") ?? undefined,
		search: query.get("search") ?? undefined,
	};
	const page = Number(query.get("page") ?? 1) || 1;
	const pageSize = Number(query.get("pageSize") ?? 50) || 50;
	sendJson(res, 200, { ...queryDecisions(filter, page, pageSize), stats: decisionStats() });
});

on("DELETE", "/api/gatekeeper/decisions/:id", async ({ res, params }) => {
	if (!deleteDecision(params.id)) return sendError(res, 404, "记录不存在");
	sendJson(res, 200, { ok: true });
});

on("GET", "/api/gatekeeper/approvals", async ({ res, query }) => {
	sendJson(res, 200, listApprovals(query.get("status") ?? "pending"));
});

on("GET", "/api/gatekeeper/approvals/:id", async ({ res, params }) => {
	const item = getApproval(params.id);
	if (!item) return sendError(res, 404, "审批项不存在");
	sendJson(res, 200, item);
});

on("POST", "/api/gatekeeper/approvals/:id/approve", async ({ res, params, session }) => {
	const result = await approve(params.id, session?.user ?? "operator");
	if (!result.ok) return sendError(res, 409, result.error);
	sendJson(res, 200, { ok: true, approval: result.approval, result: result.result });
});

on("POST", "/api/gatekeeper/approvals/:id/reject", async ({ req, res, params, session }) => {
	const body = await readJson(req).catch(() => ({}));
	const result = reject(params.id, session?.user ?? "operator", body.reason ? String(body.reason).slice(0, 200) : undefined);
	if (!result.ok) return sendError(res, 409, result.error);
	sendJson(res, 200, { ok: true, approval: result.approval });
});

// ---------------------------------------------------------------- 安卓模式

function lanIps() {
	const out = [];
	for (const [name, addresses] of Object.entries(networkInterfaces())) {
		for (const address of addresses ?? []) {
			if (address.family === "IPv4" && !address.internal) out.push(address.address);
		}
		void name;
	}
	return out;
}

function deviceOr404(res, id) {
	const device = getDevice(id);
	if (!device) {
		sendError(res, 404, "设备不存在");
		return null;
	}
	return device;
}

on("GET", "/api/android/state", async ({ req, res }) => {
	const settings = readSettings();
	const listen = gateway.listenInfo();
	const proto = req.headers["x-forwarded-proto"] === "https" ? "wss" : "ws";
	const host = req.headers.host ?? "localhost";
	sendJson(res, 200, {
		listen,
		listenConfig: { host: settings.android.listenHost, port: settings.android.listenPort },
		lanIps: lanIps(),
		// 没启用独立监听时，设备就拨控制台自己的地址。
		consoleUrl: `${proto}://${host}/ws/droid`,
		tokens: listTokens(),
		devices: gateway.devices(),
		tunnels: gateway.listTunnels(),
	});
});

on("POST", "/api/android/tokens", async ({ req, res }) => {
	const body = await readJson(req);
	sendJson(res, 200, { token: createToken(body.label) });
});

on("DELETE", "/api/android/tokens/:id", async ({ res, params }) => {
	const result = deleteToken(params.id);
	if (!result.ok) return sendError(res, 404, result.error);
	sendJson(res, 200, { ok: true });
});

on("POST", "/api/android/listen", async ({ req, res }) => {
	const body = await readJson(req);
	const host = String(body.host ?? "0.0.0.0");
	const port = Number(body.port ?? 9944);
	if (!Number.isInteger(port) || port < 1 || port > 65535) return sendError(res, 400, "端口不合法");
	const outcome = await gateway.listen(host, port);
	if (!outcome.ok) return sendError(res, 400, outcome.error ?? "监听失败");
	const settings = readSettings();
	settings.android.listenHost = host;
	settings.android.listenPort = port;
	writeSettings(settings);
	sendJson(res, 200, outcome);
});

on("POST", "/api/android/listen/stop", async ({ res }) => {
	gateway.stopListener();
	store.log("info", "设备反连监听已停止");
	sendJson(res, 200, { ok: true });
});

on("PATCH", "/api/android/devices/:id", async ({ req, res, params }) => {
	const body = await readJson(req);
	const result = renameDevice(params.id, body.name);
	if (!result.ok) return sendError(res, 400, result.error);
	sendJson(res, 200, { ok: true });
});

on("DELETE", "/api/android/devices/:id", async ({ res, params }) => {
	const result = deleteDevice(params.id);
	if (!result.ok) return sendError(res, 404, result.error);
	sendJson(res, 200, { ok: true });
});

on("POST", "/api/android/devices/:id/exec", async ({ req, res, params }) => {
	const device = deviceOr404(res, params.id);
	if (!device) return;
	const body = await readJson(req);
	const cmd = String(body.cmd ?? "").trim();
	if (!cmd) return sendError(res, 400, "命令为空");
	const timeoutMs = Math.min(Number(body.timeoutMs ?? 30_000) || 30_000, 300_000);
	const gate = await guard({
		scope: "deviceExec",
		source: "安卓工作台 · 控制台",
		target: `${device.name}（${device.model} · Android ${device.androidVersion}${device.rooted ? " · root" : ""}）`,
		command: cmd,
		action: { kind: "deviceExec", deviceId: device.deviceId, cmd, asRoot: body.asRoot === true, timeoutMs },
	});
	if (gate.kind === "pending") {
		return sendJson(res, 202, { pending: true, approvalId: gate.approvalId, mode: gate.mode, cmd });
	}
	if (gate.kind === "block") {
		store.log("warn", `守门拦截设备命令：${cmd.slice(0, 80)}`);
		return sendJson(res, 200, { ok: false, blocked: true, reason: gate.reason, error: gate.message, gate: "block" });
	}
	store.log("info", `设备命令 ${device.name}：${cmd.slice(0, 120)}`);
	sendJson(res, 200, { ...gate.result, gate: gate.kind, gateError: gate.kind === "failed" ? gate.error : undefined });
});

on("POST", "/api/android/devices/:id/ls", async ({ req, res, params }) => {
	const device = deviceOr404(res, params.id);
	if (!device) return;
	const body = await readJson(req);
	const result = await gateway.ls(device.deviceId, body.path, body.asRoot === true);
	sendJson(res, 200, result);
});

on("POST", "/api/android/devices/:id/pull", async ({ req, res, params }) => {
	const device = deviceOr404(res, params.id);
	if (!device) return;
	const body = await readJson(req);
	const path = String(body.path ?? "").trim();
	if (!path) return sendError(res, 400, "路径为空");
	const result = await gateway.pull(device.deviceId, path);
	if (!result.ok) return sendError(res, 400, result.error ?? result.stderr ?? "拉取失败");
	const bytes = result.bytes ?? Buffer.alloc(0);
	const filename = path.split("/").pop() || "file.bin";

	// 小文件直接 base64 回传（一次往返，前端立刻能存）。
	// 大文件走落盘 + 下载链接：base64 会把体积放大 1.33 倍，49MB 的 jar 变成 65MB
	// 的 JSON，浏览器标签页会先被拖死。落盘后前端用 <a download> 拿，内存恒定。
	const INLINE_LIMIT = 4 * 1024 * 1024;
	if (bytes.length <= INLINE_LIMIT) {
		return sendJson(res, 200, {
			ok: true,
			path,
			size: bytes.length,
			base64: bytes.toString("base64"),
			filename,
		});
	}
	const safe = filename.replace(/[^\w.\-]/g, "_").slice(0, 80) || "file.bin";
	const stored = `pull-${Date.now()}-${safe}`;
	// 与 pcap 一样落在 artifacts 根目录：下载端点只认单层文件名，
	// 放进子目录会 404（踩过一次）。
	writeFileSync(join(ARTIFACT_DIR, stored), bytes);
	store.log("info", `设备文件落盘：${device.name} ${path}（${(bytes.length / 1048576).toFixed(1)}MB）`);
	sendJson(res, 200, {
		ok: true,
		path,
		size: bytes.length,
		filename,
		file: `/api/android/artifacts/${stored}`,
	});
});

on("POST", "/api/android/devices/:id/push", async ({ req, res, params }) => {
	const device = deviceOr404(res, params.id);
	if (!device) return;
	const body = await readJson(req, 256 * 1024 * 1024);
	const path = String(body.path ?? "").trim();
	if (!path) return sendError(res, 400, "目标路径为空");
	let bytes;
	try {
		bytes = Buffer.from(String(body.base64 ?? ""), "base64");
	} catch {
		return sendError(res, 400, "base64 内容不合法");
	}
	if (bytes.length === 0) return sendError(res, 400, "文件内容为空");
	const gate = await guard({
		scope: "fileTransfer",
		source: "安卓工作台 · 文件推送",
		target: `${device.name}（${device.model}）`,
		command: `push ${bytes.length} bytes → ${path}`,
		action: { kind: "devicePush", deviceId: device.deviceId, path, base64: bytes.toString("base64"), mode: body.mode },
	});
	if (gate.kind === "pending") {
		return sendJson(res, 202, { pending: true, approvalId: gate.approvalId, mode: gate.mode, path, size: bytes.length });
	}
	if (gate.kind === "block") {
		return sendJson(res, 200, { ok: false, blocked: true, reason: gate.reason, error: gate.message, gate: "block" });
	}
	store.log("info", `推送文件到 ${device.name}：${path}（${bytes.length} 字节）`);
	sendJson(res, 200, { ...gate.result, gate: gate.kind, gateError: gate.kind === "failed" ? gate.error : undefined });
});

on("POST", "/api/android/devices/:id/screencap", async ({ res, params }) => {
	const device = deviceOr404(res, params.id);
	if (!device) return;
	const result = await gateway.screencap(device.deviceId);
	if (!result.ok) return sendError(res, 400, result.error ?? "截屏失败");
	const bytes = result.bytes ?? Buffer.alloc(0);
	sendJson(res, 200, { ok: true, size: bytes.length, base64: bytes.toString("base64") });
});

on("POST", "/api/android/devices/:id/logcat", async ({ req, res, params }) => {
	const device = deviceOr404(res, params.id);
	if (!device) return;
	const body = await readJson(req);
	const lines = Math.min(Number(body.lines ?? 200) || 200, 5000);
	const result = await gateway.logcat(device.deviceId, lines, body.filter ? String(body.filter) : undefined);
	sendJson(res, 200, {
		ok: result.ok,
		error: result.error,
		text: result.stdout ?? "",
	});
});

on("POST", "/api/android/devices/:id/packages", async ({ req, res, params }) => {
	const device = deviceOr404(res, params.id);
	if (!device) return;
	const body = await readJson(req);
	const result = await gateway.packages(device.deviceId, body.thirdPartyOnly !== false, true);
	sendJson(res, 200, { ok: result.ok, error: result.error, text: result.stdout ?? "" });
});

on("POST", "/api/android/devices/:id/capture", async ({ req, res, params }) => {
	const device = deviceOr404(res, params.id);
	if (!device) return;
	const body = await readJson(req);
	const action = String(body.action ?? "status");
	if (action === "start") {
		const result = await gateway.captureStart(device.deviceId, body.iface ?? "any", Number(body.seconds ?? 30));
		// 抓包也是一次"出网"动作：在流量页留一行，操作员才知道这台机器上到底有没有在收包。
		store.addTraffic(
			trafficEntry(null, {
				kind: "device",
				method: "PCAP",
				url: `device://${device.name}/capture`,
				status: result.ok === false ? 0 : 200,
				ms: 0,
				bytes: 0,
				note: result.ok === false ? String(result.error ?? "抓包启动失败") : `开始抓包 ${body.iface ?? "any"} / ${Number(body.seconds ?? 30)}s`,
				deviceId: device.id,
			}),
		);
		return sendJson(res, 200, result);
	}
	if (action === "stop") {
		const result = await gateway.captureStop(device.deviceId);
		if (result.ok && result.bytes && result.bytes.length) {
			// pcap 落盘到证据目录，前端再走下载接口取。
			const name = `capture-${device.id}-${Date.now()}.pcap`;
			const file = join(ARTIFACT_DIR, name);
			writeFileSync(file, result.bytes);
			store.addTraffic(
				trafficEntry(null, {
					kind: "device",
					method: "PCAP",
					url: `/api/android/artifacts/${name}`,
					status: 200,
					ms: 0,
					bytes: result.bytes.length,
					note: `${device.name} 抓包落盘（${(result.bytes.length / 1024).toFixed(1)}KB）`,
					deviceId: device.id,
				}),
			);
			return sendJson(res, 200, { ok: true, file: `/api/android/artifacts/${name}`, size: result.bytes.length });
		}
		store.addTraffic(
			trafficEntry(null, {
				kind: "device",
				method: "PCAP",
				url: `device://${device.name}/capture`,
				status: 0,
				note: `抓包停止但没拿到数据：${result.error ?? "设备没有返回 pcap"}`,
				deviceId: device.id,
			}),
		);
		return sendJson(res, 200, result);
	}
	const result = await gateway.captureStatus(device.deviceId);
	sendJson(res, 200, { ok: result.ok, error: result.error, text: result.stdout ?? "" });
});

on("GET", "/api/android/artifacts/:name", async ({ res, params }) => {
	// 只允许取产物目录下的单层文件名，杜绝 ../ 穿越。
	const name = params.name.replace(/[^\w.-]/g, "");
	const file = join(ARTIFACT_DIR, name);
	try {
		const bytes = readFileSync(file);
		// 按扩展名给类型：pcap 与从设备拉回来的任意文件走同一个下载端点。
		const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
		const types = {
			pcap: "application/vnd.tcpdump.pcap",
			png: "image/png",
			jpg: "image/jpeg",
			json: "application/json",
			txt: "text/plain; charset=utf-8",
			log: "text/plain; charset=utf-8",
			apk: "application/vnd.android.package-archive",
			zip: "application/zip",
			jar: "application/java-archive",
			db: "application/octet-stream",
		};
		res.writeHead(200, {
			"content-type": types[ext] ?? "application/octet-stream",
			"content-length": bytes.length,
			"content-disposition": `attachment; filename="${name}"`,
			"cache-control": "no-store",
		});
		res.end(bytes);
	} catch {
		sendError(res, 404, "文件不存在");
	}
});

on("POST", "/api/android/devices/:id/tunnel", async ({ req, res, params }) => {
	const device = deviceOr404(res, params.id);
	if (!device) return;
	const body = await readJson(req);
	const host = String(body.host ?? "127.0.0.1");
	const port = Number(body.port ?? 27042);
	if (!Number.isInteger(port)) return sendError(res, 400, "端口不合法");
	const result = await gateway.openTunnel(device.deviceId, host, port);
	if (!result.ok) return sendError(res, 400, result.error ?? "隧道打开失败");
	store.log("info", `TCP 隧道 ${device.name} → ${host}:${port}（本机 ${result.port}）`);
	sendJson(res, 200, result);
});

on("DELETE", "/api/android/tunnels/:tunnelId", async ({ res, params }) => {
	const ok = gateway.closeTunnel(params.tunnelId);
	if (!ok) return sendError(res, 404, "隧道不存在");
	sendJson(res, 200, { ok: true });
});

/** frida 脚本推送：脚本内容落设备 /data/local/tmp，返回可执行的命令。 */
on("POST", "/api/android/devices/:id/frida", async ({ req, res, params }) => {
	const device = deviceOr404(res, params.id);
	if (!device) return;
	const body = await readJson(req);
	const action = String(body.action ?? "push");
	const target = `${device.name}（${device.model}）`;

	if (action === "push") {
		const content = String(body.content ?? "");
		if (!content.trim()) return sendError(res, 400, "脚本内容为空");
		const name = String(body.name ?? `regedit-${Date.now()}.js`).replace(/[^\w.-]/g, "");
		const remote = `/data/local/tmp/${name}`;
		const gate = await guard({
			scope: "frida",
			source: "安卓工作台 · Frida 脚本",
			target,
			command: `push frida script → ${remote}（${Buffer.byteLength(content)} 字节）`,
			action: { kind: "devicePush", deviceId: device.deviceId, path: remote, base64: Buffer.from(content, "utf8").toString("base64"), mode: "0644" },
		});
		if (gate.kind === "pending") return sendJson(res, 202, { pending: true, approvalId: gate.approvalId, mode: gate.mode, path: remote });
		if (gate.kind === "block") return sendJson(res, 200, { ok: false, blocked: true, reason: gate.reason, error: gate.message, gate: "block" });
		if (!gate.result?.ok) return sendError(res, 400, gate.result?.error ?? "推送失败");
		return sendJson(res, 200, {
			ok: true,
			path: remote,
			gate: gate.kind,
			hint: `设备上可用：frida -U -f <包名> -l ${remote}（需设备侧有 frida CLI），或经隧道从主机连 frida-server`,
		});
	}

	if (action === "server") {
		// frida-server 是个前台进程：用 nohup 丢到后台，立刻返回。
		const path = String(body.path ?? "/data/local/tmp/frida-server");
		const asRoot = body.asRoot !== false;
		const cmd = `if [ -x ${path} ]; then nohup ${path} >/dev/null 2>&1 & echo started; else echo "not executable: ${path}"; fi`;
		const gate = await guard({
			scope: "frida",
			source: "安卓工作台 · frida-server",
			target,
			command: `启动 frida-server：${path}${asRoot ? "（root）" : ""}`,
			action: { kind: "deviceExec", deviceId: device.deviceId, cmd, asRoot, timeoutMs: 20_000 },
		});
		if (gate.kind === "pending") return sendJson(res, 202, { pending: true, approvalId: gate.approvalId, mode: gate.mode });
		if (gate.kind === "block") return sendJson(res, 200, { ok: false, blocked: true, reason: gate.reason, error: gate.message, gate: "block" });
		return sendJson(res, 200, {
			ok: gate.result?.ok,
			gate: gate.kind,
			text: gate.result?.stdout ?? gate.result?.error ?? "",
		});
	}

	return sendError(res, 400, "未知动作");
});

/** 常用 frida 脚本模板：少写两行模板，多留时间看结果。 */
on("GET", "/api/android/frida/templates", async ({ res }) => {
	sendJson(res, 200, [
		{
			name: "ssl-pinning-bypass.js",
			title: "SSL Pinning 绕过（OkHttp / 原生证书校验）",
			content: `// regedit · SSL Pinning 绕过：Turnip/OkHttp/TrustManager 三处一起打
Java.perform(function () {
  try {
    var Pinner = Java.use('okhttp3.CertificatePinner');
    Pinner.check.overload('java.lang.String', 'java.util.List').implementation = function () {
      console.log('[regedit] CertificatePinner.check bypassed: ' + arguments[0]);
    };
  } catch (e) { console.log('[regedit] okhttp3.CertificatePinner not found'); }

  try {
    var X509 = Java.use('javax.net.ssl.X509TrustManager');
    var TrustManager = Java.registerClass({
      name: 'com.regedit.TrustAll',
      implements: [X509],
      methods: {
        checkClientTrusted: function () {},
        checkServerTrusted: function () {},
        getAcceptedIssuers: function () { return []; }
      }
    });
    var SSLContext = Java.use('javax.net.ssl.SSLContext');
    SSLContext.init.overload('[Ljavax.net.ssl.KeyManager;', '[Ljavax.net.ssl.TrustManager;', 'java.security.SecureRandom')
      .implementation = function (km, tm, sr) {
        this.init(km, [TrustManager.$new()], sr);
      };
  } catch (e) { console.log('[regedit] TrustManager hook failed: ' + e); }
});
`,
		},
		{
			name: "root-detection-bypass.js",
			title: "Root / 模拟器检测绕过（常见判定点）",
			content: `// regedit · 把最常见的 root/模拟器判定点改成"干净"
Java.perform(function () {
  var checks = [
    ['android.os.Build', 'TAGS', 'release-keys'],
    ['android.os.Build', 'FINGERPRINT', 'google/redfin/redfin:11/RQ3A.211001.001/7641976:user/release-keys']
  ];
  checks.forEach(function (item) {
    try {
      var clazz = Java.use(item[0]);
      var field = clazz[item[1]];
      if (field && field.value !== undefined) {
        Object.defineProperty(field, 'value', { get: function () { return item[2]; } });
        console.log('[regedit] patched ' + item[0] + '.' + item[1]);
      }
    } catch (e) { console.log('[regedit] skip ' + item[0] + ' ' + e); }
  });

  try {
    var File = Java.use('java.io.File');
    var banned = ['/system/app/Superuser.apk', '/sbin/su', '/system/bin/su', '/system/xbin/su', '/data/local/xbin/su'];
    File.exists.implementation = function () {
      var path = this.getAbsolutePath();
      if (banned.indexOf(path) >= 0) { console.log('[regedit] File.exists fake: ' + path); return false; }
      return this.exists();
    };
  } catch (e) { console.log('[regedit] File.exists hook failed: ' + e); }
});
`,
		},
		{
			name: "trace-crypto.js",
			title: "抓签名/加密入口（String + MessageDigest + Cipher）",
			content: `// regedit · 观察签名与加密调用，定位请求参数是怎么算出来的
Java.perform(function () {
  try {
    var MD = Java.use('java.security.MessageDigest');
    MD.digest.overload('[B').implementation = function (input) {
      var out = this.digest(input);
      console.log('[regedit] digest alg=' + this.getAlgorithm() + ' in=' + bytesToHex(input).slice(0, 160) + ' out=' + bytesToHex(out));
      return out;
    };
  } catch (e) { console.log('[regedit] MessageDigest hook failed: ' + e); }

  try {
    var Cipher = Java.use('javax.crypto.Cipher');
    Cipher.doFinal.overload('[B').implementation = function (input) {
      var out = this.doFinal(input);
      console.log('[regedit] cipher=' + this.getAlgorithm() + ' in=' + bytesToHex(input).slice(0, 160));
      return out;
    };
  } catch (e) { console.log('[regedit] Cipher hook failed: ' + e); }

  function bytesToHex(bytes) {
    if (!bytes) return '';
    var out = '';
    for (var i = 0; i < Math.min(bytes.length, 64); i++) {
      out += ('0' + (bytes[i] & 0xff).toString(16)).slice(-2);
    }
    return out;
  }
});
`,
		},
	]);
});

// ---------------------------------------------------------------- APK 分析

on("GET", "/api/android/apk", async ({ res }) => {
	sendJson(
		res,
		200,
		store.state.apk.map((item) => ({
			id: item.id,
			name: item.name,
			size: item.size,
			sha256: item.sha256,
			at: item.at,
			package: item.result?.package ?? null,
			findings: item.result?.findings?.length ?? 0,
		})),
	);
});

on("POST", "/api/android/apk", async ({ req, res, query }) => {
	const bytes = await readRaw(req);
	if (bytes.length === 0) return sendError(res, 400, "上传内容为空");
	const name = String(query.get("name") ?? "app.apk").replace(/[^\w.\-() ]/g, "").slice(0, 80) || "app.apk";
	let result;
	try {
		result = analyzeApk(bytes, name);
	} catch (error) {
		return sendError(res, 400, `解析失败：${error.message}`);
	}
	const file = join(ARTIFACT_DIR, "apk", `${Date.now()}-${name}`);
	writeFileSync(file, bytes);
	const record = {
		id: store.nextId("ap"),
		name,
		size: bytes.length,
		sha256: result.sha256,
		at: result.analyzedAt,
		file,
		result,
	};
	store.state.apk.unshift(record);
	// APK 的结论也进漏洞库，和远程评估的发现并列可见。
	for (const finding of result.findings) {
		store.state.findings.push({
			id: store.nextId("fd"),
			title: `APK · ${finding.title}`,
			severity: finding.severity,
			target: `${name}${result.package ? ` (${result.package})` : ""}`,
			summary: finding.detail.slice(0, 200),
			evidence: finding.detail,
			recommendation: "按条目修复后重新出包，并在测试机上复核。",
			source: "apk",
			taskId: null,
			status: "open",
			createdAt: new Date().toISOString(),
			lastSeen: new Date().toISOString(),
			occurrences: 1,
		});
	}
	store.save();
	store.log("info", `APK 分析完成：${name}（${result.findings.length} 条发现）`);
	sendJson(res, 200, record);
});

on("GET", "/api/android/apk/:id", async ({ res, params }) => {
	const record = store.state.apk.find((item) => item.id === params.id);
	if (!record) return sendError(res, 404, "分析记录不存在");
	sendJson(res, 200, record);
});

on("DELETE", "/api/android/apk/:id", async ({ res, params }) => {
	const index = store.state.apk.findIndex((item) => item.id === params.id);
	if (index < 0) return sendError(res, 404, "分析记录不存在");
	store.state.apk.splice(index, 1);
	store.save();
	sendJson(res, 200, { ok: true });
});

// ---------------------------------------------------------------- 新增模块：探索图 / 知识库 / 工具 / Agent / 模型 / 权限 / MCP / POC / 测绘 / 搜索 / 代理 / 通知 / 对话 / 公司

// ---- 探索图
on("GET", "/api/exploration/graph", async ({ res, query }) => {
	sendJson(res, 200, snapshot(query.get("taskId") ?? undefined));
});

on("GET", "/api/exploration/frontier", async ({ res, query }) => {
	sendJson(res, 200, { items: frontier(query.get("taskId") ?? undefined) });
});

on("GET", "/api/exploration/activity", async ({ res, query }) => {
	sendJson(res, 200, { items: listActivity(Math.min(Number(query.get("limit") ?? 100) || 100, 500)) });
});

on("POST", "/api/exploration/nodes", async ({ req, res }) => {
	const body = await readJson(req);
	const result = addNode(body);
	sendJson(res, 200, result);
});

on("POST", "/api/exploration/intents", async ({ req, res }) => {
	const body = await readJson(req);
	const result = addNode({ ...body, kind: "intent" });
	sendJson(res, 200, result);
});

on("GET", "/api/exploration/nodes/:id", async ({ res, params }) => {
	const node = getNode(params.id);
	if (!node) return sendError(res, 404, "节点不存在");
	sendJson(res, 200, node);
});

on("PATCH", "/api/exploration/nodes/:id", async ({ req, res, params }) => {
	const body = await readJson(req);
	const node = updateNode(params.id, body);
	if (!node) return sendError(res, 404, "节点不存在");
	sendJson(res, 200, node);
});

on("DELETE", "/api/exploration/nodes/:id", async ({ res, params }) => {
	if (!deleteNode(params.id)) return sendError(res, 404, "节点不存在");
	sendJson(res, 200, { ok: true });
});

on("POST", "/api/exploration/edges", async ({ req, res }) => {
	const body = await readJson(req);
	sendJson(res, 200, addEdge(body));
});

on("DELETE", "/api/exploration/edges/:id", async ({ res, params }) => {
	if (!deleteEdge(params.id)) return sendError(res, 404, "边不存在");
	sendJson(res, 200, { ok: true });
});

on("POST", "/api/exploration/seed", async ({ req, res }) => {
	const body = await readJson(req).catch(() => ({}));
	sendJson(res, 200, seedFromExisting(body.taskId));
});

on("DELETE", "/api/exploration/graph", async ({ res }) => {
	sendJson(res, 200, clearGraph());
});

on("GET", "/api/exploration/tokens", async ({ res }) => {
	// 与模型池同一份统计：探索阶段烧掉的 token 是最关心的成本项
	sendJson(res, 200, { pool: llmState().pool, chat: chatStats(), knowledge: knowledgeStats() });
});

// ---- 知识库
on("GET", "/api/knowledge", async ({ res }) => {
	sendJson(res, 200, { docs: listDocs(), stats: knowledgeStats() });
});

on("POST", "/api/knowledge/upload", async ({ req, res }) => {
	const body = await readJson(req, 8 * 1024 * 1024);
	const result = addDoc({
		title: body.title,
		content: body.content,
		category: body.category,
		source: body.source ?? "manual",
	});
	sendJson(res, 200, result);
});

on("GET", "/api/knowledge/search", async ({ res, query }) => {
	const q = query.get("q") ?? "";
	if (!q.trim()) return sendJson(res, 200, { items: [], total: 0, terms: [] });
	sendJson(
		res,
		200,
		knowledgeSearch(q, { category: query.get("category") ?? "all", limit: Number(query.get("limit") ?? 20) }),
	);
});

on("GET", "/api/knowledge/categories", async ({ res }) => {
	sendJson(res, 200, knowledgeStats());
});

on("POST", "/api/knowledge/reindex", async ({ res }) => {
	sendJson(res, 200, reindex());
});

on("GET", "/api/knowledge/doc/:id", async ({ res, params }) => {
	const doc = getDoc(params.id);
	if (!doc) return sendError(res, 404, "文档不存在");
	sendJson(res, 200, doc);
});

on("PATCH", "/api/knowledge/doc/:id", async ({ req, res, params }) => {
	const body = await readJson(req);
	const doc = setCategory(params.id, body.category);
	if (!doc) return sendError(res, 404, "文档不存在");
	sendJson(res, 200, doc);
});

on("DELETE", "/api/knowledge/doc/:id", async ({ res, params }) => {
	if (!deleteDoc(params.id)) return sendError(res, 404, "文档不存在");
	sendJson(res, 200, { ok: true });
});

// ---- 工具
on("GET", "/api/tools", async ({ res }) => {
	sendJson(res, 200, { tools: listTools(), groups: toolGroups, stats: toolStats() });
});

on("PUT", "/api/tools/:id", async ({ req, res, params }) => {
	const body = await readJson(req);
	const result = setEnabled(params.id, body.enabled === true);
	if (!result.ok) return sendError(res, 404, result.error);
	sendJson(res, 200, result);
});

// ---- Agent
on("GET", "/api/agents", async ({ res }) => {
	sendJson(res, 200, { agents: listAgents(), tools: listTools().map((t) => ({ id: t.id, name: t.name, enabled: t.enabled })) });
});

on("GET", "/api/agents/:key", async ({ res, params }) => {
	const agent = getAgent(params.key);
	if (!agent) return sendError(res, 404, "Agent 不存在");
	sendJson(res, 200, agent);
});

on("POST", "/api/agents", async ({ req, res }) => {
	const body = await readJson(req);
	sendJson(res, 200, upsertAgent(body));
});

on("DELETE", "/api/agents/:key", async ({ res, params }) => {
	if (!deleteAgent(params.key)) return sendError(res, 404, "Agent 不存在");
	sendJson(res, 200, { ok: true });
});

// ---- 模型
on("GET", "/api/llm", async ({ res }) => {
	sendJson(res, 200, llmState());
});

on("POST", "/api/llm/profiles", async ({ req, res }) => {
	const body = await readJson(req);
	sendJson(res, 200, upsertProfile(body));
});

on("PUT", "/api/llm/profiles/active", async ({ req, res }) => {
	const body = await readJson(req);
	const result = activateProfile(body.id);
	if (!result.ok) return sendError(res, 404, result.error);
	sendJson(res, 200, result);
});

on("DELETE", "/api/llm/profiles/:id", async ({ res, params }) => {
	if (!deleteProfile(params.id)) return sendError(res, 404, "档案不存在");
	sendJson(res, 200, { ok: true });
});

on("PUT", "/api/llm/roles/:role", async ({ req, res, params }) => {
	const body = await readJson(req);
	const result = setRole(params.role, body.profileId ?? null);
	if (!result.ok) return sendError(res, 400, result.error);
	sendJson(res, 200, result);
});

on("POST", "/api/llm/test/:id", async ({ res, params }) => {
	sendJson(res, 200, await testProfile(params.id));
});

on("POST", "/api/llm/pool/reset", async ({ res }) => {
	sendJson(res, 200, resetPool());
});

// ---- 权限
on("GET", "/api/rbac/me", async ({ res, session }) => {
	sendJson(res, 200, rbacMe(session.user));
});

on("GET", "/api/rbac/metadata", async ({ res }) => {
	sendJson(res, 200, { catalogue: permissionCatalogue(), roles: listRoles(), stats: rbacStats() });
});

on("GET", "/api/rbac/roles", async ({ res }) => {
	sendJson(res, 200, { roles: listRoles(), catalogue: permissionCatalogue() });
});

on("POST", "/api/rbac/roles", async ({ req, res }) => {
	const body = await readJson(req);
	sendJson(res, 200, upsertRole(body));
});

on("DELETE", "/api/rbac/roles/:id", async ({ res, params }) => {
	const result = deleteRole(params.id);
	if (!result.ok) return sendError(res, 400, result.error);
	sendJson(res, 200, result);
});

on("GET", "/api/rbac/users", async ({ res }) => {
	sendJson(res, 200, { users: listUsers(), roles: listRoles() });
});

on("PUT", "/api/rbac/users/:name", async ({ req, res, params }) => {
	const body = await readJson(req);
	const result = assignRole(params.name, body.roleId);
	if (!result.ok) return sendError(res, 400, result.error);
	sendJson(res, 200, result);
});

// ---- MCP
on("GET", "/api/mcp", async ({ res }) => {
	sendJson(res, 200, { servers: listMcpServers() });
});

on("POST", "/api/mcp", async ({ req, res }) => {
	const body = await readJson(req);
	sendJson(res, 200, upsertMcpServer(body));
});

on("POST", "/api/mcp/stats", async ({ res }) => {
	sendJson(res, 200, { servers: listMcpServers().length, enabled: listMcpServers().filter((s) => s.enabled).length });
});

on("DELETE", "/api/mcp/:id", async ({ res, params }) => {
	if (!deleteMcpServer(params.id)) return sendError(res, 404, "服务器不存在");
	sendJson(res, 200, { ok: true });
});

on("POST", "/api/mcp/:id/test", async ({ res, params }) => {
	sendJson(res, 200, await testMcpServer(params.id));
});

// ---- POC
on("GET", "/api/pocs", async ({ res, query }) => {
	sendJson(res, 200, {
		items: listPocs({
			severity: query.get("severity") || undefined,
			tag: query.get("tag") || undefined,
			search: query.get("search") || undefined,
		}),
		stats: pocStats(),
	});
});

on("GET", "/api/pocs/:id", async ({ res, params }) => {
	const poc = getPoc(params.id);
	if (!poc) return sendError(res, 404, "POC 不存在");
	sendJson(res, 200, poc);
});

on("POST", "/api/pocs/import", async ({ req, res }) => {
	const body = await readJson(req, 20 * 1024 * 1024);
	if (body.url) return sendJson(res, 200, await importPocsFromUrl(body.url));
	sendJson(res, 200, importTemplates(body.text, body.source ?? "manual"));
});

on("POST", "/api/pocs/seed", async ({ res }) => {
	sendJson(res, 200, seedPocExamples());
});

on("DELETE", "/api/pocs/:id", async ({ res, params }) => {
	if (!deletePoc(params.id)) return sendError(res, 404, "POC 不存在");
	sendJson(res, 200, { ok: true });
});

on("DELETE", "/api/pocs", async ({ res }) => {
	sendJson(res, 200, clearPocs());
});

// ---- 资产测绘
on("GET", "/api/intel", async ({ res }) => {
	sendJson(res, 200, { platforms: listIntelPlatforms(), history: intelHistory() });
});

on("PUT", "/api/intel/:id", async ({ req, res, params }) => {
	const body = await readJson(req);
	const result = saveIntelPlatform(params.id, body);
	if (!result.ok) return sendError(res, 400, result.error);
	sendJson(res, 200, result);
});

on("POST", "/api/intel/:id/verify", async ({ res, params }) => {
	sendJson(res, 200, await verifyIntel(params.id));
});

on("POST", "/api/intel/:id/query", async ({ req, res, params }) => {
	const body = await readJson(req);
	const q = String(body.query ?? "").trim();
	if (!q) return sendError(res, 400, "查询语句为空");
	sendJson(res, 200, await intelQuery(params.id, q, { size: body.size }));
});

// ---- Web 搜索
on("GET", "/api/websearch", async ({ res }) => {
	sendJson(res, 200, webSearchState());
});

on("PUT", "/api/websearch", async ({ req, res }) => {
	const body = await readJson(req);
	if (body.enabled !== undefined) setWebSearchEnabled(body.enabled === true);
	if (body.key) addWebSearchKey(body.key);
	sendJson(res, 200, webSearchState());
});

on("DELETE", "/api/websearch/keys/:id", async ({ res, params }) => {
	if (!removeWebSearchKey(params.id)) return sendError(res, 404, "密钥不存在");
	sendJson(res, 200, webSearchState());
});

on("POST", "/api/websearch/search", async ({ req, res }) => {
	const body = await readJson(req);
	const q = String(body.query ?? "").trim();
	if (!q) return sendError(res, 400, "查询为空");
	sendJson(res, 200, await webSearch(q, { limit: body.limit, deep: body.deep }));
});

on("POST", "/api/websearch/extract", async ({ req, res }) => {
	const body = await readJson(req);
	const url = String(body.url ?? "").trim();
	if (!/^https?:\/\//i.test(url)) return sendError(res, 400, "URL 必须是 http(s)");
	sendJson(res, 200, await webExtract(url));
});

// ---- 代理
on("GET", "/api/proxies", async ({ res }) => {
	sendJson(res, 200, { items: listProxyProfiles() });
});

on("POST", "/api/proxies", async ({ req, res }) => {
	const body = await readJson(req);
	sendJson(res, 200, upsertProxyProfile(body));
});

on("DELETE", "/api/proxies/:id", async ({ res, params }) => {
	if (!deleteProxyProfile(params.id)) return sendError(res, 404, "档案不存在");
	sendJson(res, 200, { ok: true });
});

on("POST", "/api/proxies/:id/test", async ({ req, res, params }) => {
	const body = await readJson(req).catch(() => ({}));
	sendJson(res, 200, await testProxyProfile(params.id, body.targetUrl));
});

on("POST", "/api/proxies/:id/refresh", async ({ res, params }) => {
	sendJson(res, 200, await refreshProxySubscription(params.id));
});

// ---- 通知
on("GET", "/api/notify", async ({ res }) => {
	sendJson(res, 200, notifyState());
});

on("POST", "/api/notify/channels", async ({ req, res }) => {
	const body = await readJson(req);
	sendJson(res, 200, upsertNotifyChannel(body));
});

on("DELETE", "/api/notify/channels/:id", async ({ res, params }) => {
	if (!deleteNotifyChannel(params.id)) return sendError(res, 404, "渠道不存在");
	sendJson(res, 200, { ok: true });
});

on("POST", "/api/notify/channels/:id/test", async ({ res, params }) => {
	sendJson(res, 200, await testNotifyChannel(params.id));
});

on("PUT", "/api/notify/triggers/:id", async ({ req, res, params }) => {
	const body = await readJson(req);
	const result = setNotifyTrigger(params.id, body.enabled === true);
	if (!result.ok) return sendError(res, 400, result.error);
	sendJson(res, 200, result);
});

// ---- 对话
on("GET", "/api/chat", async ({ res }) => {
	sendJson(res, 200, { conversations: listConversations(), stats: chatStats() });
});

on("POST", "/api/chat", async ({ req, res }) => {
	const body = await readJson(req);
	sendJson(res, 200, { conversation: createConversation(body.title, body.systemPrompt) });
});

on("GET", "/api/chat/:id", async ({ res, params }) => {
	const conversation = getConversation(params.id);
	if (!conversation) return sendError(res, 404, "会话不存在");
	const task = conversation.taskId ? (store.state.tasks ?? []).find((entry) => entry.id === conversation.taskId) : null;
	sendJson(res, 200, {
		...conversation,
		running: isTurnRunning(conversation.id),
		// 会话页要在顶部画"项目条"、右下角画"设备选择"和"实时流量"，
		// 一次带上，省三个串行请求。
		project: task
			? {
					id: task.id,
					title: task.title,
					status: task.status,
					stage: task.stage,
					platform: task.platform ?? "web",
					appPackage: task.appPackage ?? "",
					running: isRunning(task.id),
					scope: task.scope ?? [],
					stats: task.stats ?? {},
					findings: store.state.findings.filter((finding) => finding.taskId === task.id).length,
					assets: store.state.assets.filter((asset) => asset.taskId === task.id || asset.lastTaskId === task.id).length,
					traffic: (store.state.traffic ?? []).filter((item) => item.taskId === task.id).length,
				}
			: null,
		companies: (store.state.companies ?? []).map((company) => ({ id: company.id, name: company.name })),
		devices: gateway.devices().map((device) => ({
			id: device.id,
			name: device.name,
			model: device.model,
			liveness: device.liveness,
			rooted: device.rooted === true,
		})),
	});
});

on("POST", "/api/chat/:id/messages", async ({ req, res, params }) => {
	const body = await readJson(req);
	sendJson(res, 200, await sendChatMessage(params.id, body.content, { temperature: body.temperature, maxTokens: body.maxTokens }));
});

on("PATCH", "/api/chat/:id", async ({ req, res, params }) => {
	const body = await readJson(req);
	// 项目/设备/公司绑定走 patchConversation；其余字段维持原来的单分支语义。
	if (body.taskId !== undefined || body.deviceId !== undefined || body.companyId !== undefined || body.mode !== undefined) {
		const patched = patchConversation(params.id, {
			...(body.taskId !== undefined ? { taskId: body.taskId } : {}),
			...(body.deviceId !== undefined ? { deviceId: body.deviceId } : {}),
			...(body.companyId !== undefined ? { companyId: body.companyId } : {}),
			...(body.mode !== undefined ? { mode: body.mode } : {}),
		});
		if (!patched) return sendError(res, 404, "会话不存在");
		if (patched.error) return sendError(res, 400, patched.error);
		return sendJson(res, 200, patched);
	}
	const conversation = body.archived !== undefined
		? archiveConversation(params.id, body.archived === true)
		: body.goal !== undefined
			? setGoal(params.id, body.goal)
			: body.title
				? renameConversation(params.id, body.title)
				: null;
	if (!conversation) return sendError(res, 404, "会话不存在");
	sendJson(res, 200, conversation);
});

on("DELETE", "/api/chat/:id", async ({ res, params }) => {
	if (!deleteConversation(params.id)) return sendError(res, 404, "会话不存在");
	sendJson(res, 200, { ok: true });
});

// ---- 对话：流式发送 / 停止 / 增量取消息
//
// 为什么单独一套流式接口：模型一轮要跑十几秒到一分钟，普通 JSON 接口在结束前
// 什么都不返回，浏览器只能转圈；而且失败时要整页刷新才看得到结果。
// 这里用 SSE 把"用户消息已入库 / 建了项目 / 第几轮 / 工具跑完 / 最终结果"逐步推回去。
on("POST", "/api/chat/:id/messages/stream", async ({ req, res, params }) => {
	const conversation = getConversation(params.id);
	if (!conversation) return sendError(res, 404, "会话不存在");
	const body = await readJson(req);
	res.writeHead(200, {
		"content-type": "text/event-stream; charset=utf-8",
		"cache-control": "no-store",
		connection: "keep-alive",
		// nginx 反代默认缓冲 SSE，必须显式关掉，否则事件会攒到结束才一次性到达。
		"x-accel-buffering": "no",
	});
	let closed = false;
	const write = (type, payload) => {
		if (closed || res.writableEnded) return;
		try {
			res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
		} catch {
			closed = true;
		}
	};
	const controller = new AbortController();
	const heartbeat = setInterval(() => {
		if (closed || res.writableEnded) return;
		try {
			res.write(": ping\n\n");
		} catch {
			closed = true;
		}
	}, 15000);
	req.on("close", () => {
		closed = true;
		controller.abort();
	});
	try {
		await sendMessageStream(params.id, body.content, {
			temperature: body.temperature,
			maxTokens: body.maxTokens,
			abortController: controller,
			onEvent: (event) => write(event.type ?? "status", event),
		});
	} catch (error) {
		// 客户端主动断开时 AbortError 是预期分支，不再回写。
		if (!closed) write("error", { message: error?.message ?? String(error) });
	} finally {
		clearInterval(heartbeat);
		if (!res.writableEnded) res.end();
	}
});

on("POST", "/api/chat/:id/abort", async ({ res, params }) => {
	const result = abortTurn(params.id);
	sendJson(res, result.ok ? 200 : 409, result);
});

on("GET", "/api/chat/:id/messages", async ({ res, params, query }) => {
	const conversation = getConversation(params.id);
	if (!conversation) return sendError(res, 404, "会话不存在");
	const total = conversation.messages.length;
	const since = Math.max(Number(query.get("since") ?? 0) || 0, 0);
	sendJson(res, 200, {
		messages: conversation.messages.slice(Math.min(since, total)),
		total,
		running: isTurnRunning(params.id),
		updatedAt: conversation.updatedAt,
	});
});

// ---- 公司 / 报告配置
on("GET", "/api/companies", async ({ res }) => {
	sendJson(res, 200, { items: listCompanies() });
});

on("POST", "/api/companies", async ({ req, res }) => {
	const body = await readJson(req);
	sendJson(res, 200, upsertCompany(body));
});

on("GET", "/api/companies/:id", async ({ res, params }) => {
	const detail = companyDetail(params.id);
	if (!detail) return sendError(res, 404, "公司不存在");
	sendJson(res, 200, detail);
});

on("DELETE", "/api/companies/:id", async ({ res, params }) => {
	const result = deleteCompany(params.id);
	if (!result.ok) return sendError(res, 400, result.error);
	sendJson(res, 200, result);
});

on("POST", "/api/companies/reattribute", async ({ req, res }) => {
	const body = await readJson(req);
	sendJson(res, 200, reattribute(body));
});

on("PUT", "/api/companies/assign/:kind/:id", async ({ req, res, params }) => {
	const body = await readJson(req);
	const result = assignCompany(params.kind, params.id, body.companyId ?? null);
	if (!result.ok) return sendError(res, 400, result.error);
	sendJson(res, 200, result);
});

on("GET", "/api/report-settings", async ({ res }) => {
	sendJson(res, 200, getReportSettings());
});

on("PUT", "/api/report-settings", async ({ req, res }) => {
	const body = await readJson(req);
	const result = saveReportSettings(body);
	if (!result.ok) return sendError(res, 400, result.error);
	sendJson(res, 200, result);
});

on("GET", "/api/report-templates", async ({ res }) => {
	sendJson(res, 200, { items: listTemplates(), sections: SECTION_LABELS });
});

on("POST", "/api/report-templates", async ({ req, res }) => {
	const body = await readJson(req);
	const result = upsertTemplate(body);
	if (!result.ok) return sendError(res, 400, result.error);
	sendJson(res, 200, result);
});

on("DELETE", "/api/report-templates/:id", async ({ res, params }) => {
	const result = deleteTemplate(params.id);
	if (!result.ok) return sendError(res, 400, result.error);
	sendJson(res, 200, result);
});

// ---------------------------------------------------------------- 出口

export async function handleApi(req, res, url) {
	const found = match(req.method, url.pathname);
	if (!found) return false;
	const { route, params } = found;

	let session = null;
	if (!route.public) {
		session = requireAuth(req, res);
		if (!session) return true;

		// 工具开关：关掉的工具对应接口直接 403。藏按钮是假的，接口拒才是真的。
		const toolId = toolForPath(url.pathname);
		if (toolId && !isToolEnabled(toolId)) {
			sendError(res, 403, `工具「${toolId}」已停用（设置 → 工具）`);
			return true;
		}
		// 角色权限：没有对应权限也拒。owner 兜底，避免把自己锁在门外。
		if (toolId && !hasPermission(session.user, toolId)) {
			sendError(res, 403, `当前角色没有「${toolId}」权限（设置 → 权限）`);
			return true;
		}
		// 只有真正归属某个工具时才计数：没命中的路径（如 /api/overview）不该记，
		// 否则 tools 里会出现一个 `null` 键把统计搅乱。
		if (toolId) recordToolCall(toolId);
	}

	try {
		await route.handler({ req, res, params, query: url.searchParams, session, url });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!res.headersSent) sendError(res, 400, message);
		else res.end();
	}
	return true;
}

export { hashPassword };
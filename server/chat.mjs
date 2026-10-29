/**
 * 对话：多轮会话 + 真实模型调用。
 *
 * 不做流式：控制台是单操作员工具，一次问答 10 秒内完成，流式带来的复杂度
 * （SSE 重连、半截消息落库）大于收益。要流式的话前端自己轮询即可。
 *
 * 会话内容会落库，且**不清理**——审计需要。体积靠单条消息上限控制。
 */

import { randomUUID } from "node:crypto";
import { readSettings } from "./config.mjs";
import { store } from "./store.mjs";
import { contextWindowOf, normalizeUsage, profileForRole, recordLlmCall } from "./agents.mjs";
import { CHAT_TOOLS, runChatTool } from "./chat-tools.mjs";
import { guard } from "./gatekeeper.mjs";
import { gateway } from "./droid.mjs";
import { isOpen, normalizeStatus } from "./findings-model.mjs";
import { createTask, normalizeTarget, startTask } from "./recon.mjs";

const MAX_MESSAGES = 200;
const MAX_CONTENT = 12000;

/**
 * 系统提示词。
 *
 * 结构照作业平台的"主 agent"来：**观察 → 记录 → 操舵**，而不是"什么都自己干"。
 * 两条最容易出错的地方写在最前面：模型有手（别教用户敲命令）、确认即落库
 * （只写在回复里的漏洞等于没记，进不了发现页和报告）。
 */
const AGENT_PROMPT = `你是 regedit 安全评估控制台的"主 agent"，是操作员的接口。你的职责分三块：

1. **观察**：回答进展类问题时，先用 project_overview / list_tasks / list_assets / list_findings
   查真实数据，再回答。不要凭印象说"大概有几个"。

2. **记录（最容易漏）**：凡是已经验证确认的漏洞，**立即逐条调用 record_finding 落库**——
   一个漏洞一次调用，填 title（漏洞名）、severity、target、summary（入口/参数/影响）。
   还要尽量带上 **repro（复现步骤，编号逐条）** 与 **requestPkt / responsePkt（原始请求/响应报文）**：
   报告里的「复现步骤」和「原始数据包」两节就取这两个字段，缺了报告就是空的。
   有把握时给 cvss（0-10）；没把握就留空，会标"未评分"，不要瞎填。
   只有落库的漏洞才会进入漏洞页、探索图和报告；**写在回复里但没记录 = 白做**。
   记录前先用 list_findings 看已有的，避免重复。
   严禁把"仅凭版本号/CVE 匹配""看起来像可利用"的猜测当成已确认漏洞上报。

3. **工具纪律（上一轮踩过的坑）**：
   - 子域枚举用 **enumerate_subdomains**（一次调用返回一张表），**不要**用几十次 dns_lookup 一个个查；
   - 同一个目标/同一条记录只查一次，别重复调；
   - 一轮里最多 8 个工具调用；拿到能下判断的信息就停下来回答，不要"再查一个"查到没轮次；
   - 每轮工具结果回来后先在心里回答"这够不够下结论"，够了就直接写结论。

4. **操舵**：用户想立刻测某个目标 → 调 create_recon_task 发起只读侦察（受守门约束，
   人工审批模式下会排队，**排队不是失败**，如实说明审批单号即可）；
   想要交付物 → 调 generate_report，可只选中的漏洞。

5. **项目**：每次对话会自动绑定一个评估项目（任务），从你这句话里识别到的目标已经
   建好并开始跑。之后的侦察、资产、发现、流量都记在这个项目下——不要另起新任务，
   要加目标就调 create_recon_task，它会把目标并进当前项目。

6. **设备**：需要看手机时先 list_devices 确认在线设备，再 device_exec / device_screencap /
   device_logcat / device_pull / device_packages。设备命令受守门约束（人工审批模式下排队，
   排队不是失败）。命令要一条一条来，别把整段脚本塞进一次调用。只读排查优先。

通用要求：
- 你有工具，能真查。需要 WHOIS、DNS、项目数据时直接调用，**不要**教用户去敲命令、
  也不要声称自己无法联网。
- 只对用户已获授权的目标动手。没给目标就问清楚，不要自己编。
- 用人话简洁回复"做了什么、得到什么"，不要罗列一堆过程。`;

/** 把项目现状压缩成一段上下文喂给模型，省得它每轮都先调一次工具。 */
function projectContext(conversation) {
	const tasks = store.state.tasks ?? [];
	const assets = store.state.assets ?? [];
	const findings = (store.state.findings ?? []).filter((f) => isOpen(f));
	const bySeverity = {};
	for (const f of findings) bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
	// 绑定了项目就按项目切片：模型关心的是"这个项目现在什么样"，
	// 全局数字会把别的客户的数据混进来。
	const task = conversation?.taskId ? tasks.find((entry) => entry.id === conversation.taskId) : null;
	const scopedFindings = task ? findings.filter((f) => f.taskId === task.id) : findings;
	const scopedAssets = task ? assets.filter((a) => a.taskId === task.id || a.lastTaskId === task.id) : assets;
	const scopedTraffic = task ? (store.state.traffic ?? []).filter((t) => t.taskId === task.id) : [];
	const lines = [
		"当前项目概况：",
		task
			? `- 当前项目：${task.id}「${task.title}」${task.status}${task.stage ? ` / ${task.stage}` : ""}（目标 ${(task.targets ?? []).length} 个）`
			: "- 当前还没有绑定项目（这次对话里识别到目标会自动建一个）",
		`- 任务 ${tasks.length} 个（运行中 ${tasks.filter((t) => t.status === "running").length}）`,
		`- 资产 ${scopedAssets.length} 个`,
		`- 待处理漏洞 ${scopedFindings.length} 条${scopedFindings.length ? `（${Object.entries(bySeverity).map(([k, v]) => `${k} ${v}`).join(" / ")}）` : ""}`,
		`- 已有报告 ${(store.state.reports ?? []).length} 份`,
	];
	if (task) lines.push(`- 本项目流量 ${scopedTraffic.length} 条（最近：${scopedTraffic.slice(-3).map((t) => `${t.method} ${t.url} → ${t.status}`).join("；") || "暂无"}）`);
	if (tasks.length) {
		lines.push("最近任务：" + tasks.slice(0, 5).map((t) => `${t.id}「${t.title}」${t.status}`).join("；"));
	}
	const devices = gatewayDevices();
	if (devices.length) {
		lines.push(
			"安卓设备：" +
				devices
					.map((d) => `${d.name}（${d.model ?? "?"}/${d.liveness}${conversation?.deviceId && d.id === conversation.deviceId ? "/本会话绑定" : ""}）`)
					.join("、"),
		);
	}
	return lines.join("\n");
}

/** 设备列表：带在线/冻结状态的运行时视图，而不是注册表里的静态记录。 */
function gatewayDevices() {
	try {
		return gateway.devices();
	} catch {
		return [];
	}
}

function conversations() {
	if (!Array.isArray(store.state.conversations)) store.state.conversations = [];
	return store.state.conversations;
}

/** 正在跑的轮次：会话 id → AbortController。「停止」按钮与客户端断开都靠它。 */
const activeTurns = new Map();

export function abortTurn(id) {
	const controller = activeTurns.get(id);
	if (!controller) return { ok: false, error: "这条会话没有正在进行的回复" };
	controller.abort();
	return { ok: true };
}

export function isTurnRunning(id) {
	return activeTurns.has(id);
}

export function listConversations({ archived = false } = {}) {
	return conversations()
		.filter((c) => (archived ? c.archived === true : c.archived !== true))
		.map((c) => ({
			id: c.id,
			title: c.title,
			at: c.at,
			updatedAt: c.updatedAt,
			messageCount: c.messages.length,
			taskId: c.taskId ?? null,
			deviceId: c.deviceId ?? null,
			preview: c.messages.length ? String(c.messages[c.messages.length - 1].content).slice(0, 80) : "",
		}))
		.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export function getConversation(id) {
	return conversations().find((c) => c.id === id) ?? null;
}

export function createConversation(title = "新对话", systemPrompt = "") {
	const conversation = {
		id: `cv${randomUUID().slice(0, 10)}`,
		title: String(title || "新对话").slice(0, 120),
		systemPrompt: String(systemPrompt ?? "").slice(0, 8000),
		goal: "",
		// 会话形态：web = 站点评估；android = 移动端评估（目标是 App/设备）。
		mode: "web",
		// 项目（任务）绑定：对话不是漂浮的聊天框，它长在一个评估项目上。
		taskId: null,
		// 设备绑定：这台会话默认操作哪台安卓设备（多设备时必须选）。
		deviceId: null,
		// 公司归属：决定这个项目/资产/发现交付给谁。
		companyId: null,
		messages: [],
		at: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		archived: false,
	};
	conversations().unshift(conversation);
	store.save();
	return conversation;
}

export function renameConversation(id, title) {
	const conversation = getConversation(id);
	if (!conversation) return null;
	conversation.title = String(title).slice(0, 120);
	store.save();
	return conversation;
}

/** 会话目标：对应原版的 {{.Goal}}，决定这个 agent 往哪使劲。 */
export function setGoal(id, goal) {
	const conversation = getConversation(id);
	if (!conversation) return null;
	conversation.goal = String(goal ?? "").slice(0, 600);
	store.save();
	return conversation;
}

/** 绑定项目 / 设备 / 公司：一次改一个，返回更新后的会话。 */
export function patchConversation(id, patch = {}) {
	const conversation = getConversation(id);
	if (!conversation) return null;
	if (patch.taskId !== undefined) {
		const taskId = String(patch.taskId ?? "").trim();
		if (taskId && !(store.state.tasks ?? []).some((task) => task.id === taskId)) return { error: "项目（任务）不存在" };
		conversation.taskId = taskId || null;
	}
	if (patch.deviceId !== undefined) conversation.deviceId = String(patch.deviceId ?? "").trim() || null;
	// 会话形态：web / android。切到 android 时若当前项目是站点项目，不动它（历史留着），
	// 新项目会按移动端建；这样同一会话里 Web 与 App 的结论不会串。
	if (patch.mode !== undefined) conversation.mode = patch.mode === "android" ? "android" : "web";
	if (patch.companyId !== undefined) {
		const companyId = String(patch.companyId ?? "").trim();
		if (companyId && !(store.state.companies ?? []).some((company) => company.id === companyId)) return { error: "公司不存在" };
		conversation.companyId = companyId || null;
	}
	conversation.updatedAt = new Date().toISOString();
	store.save();
	return conversation;
}

// ---------------------------------------------------------------- 自动建项目

/**
 * 从一句话里认出"要测哪些目标"。
 *
 * 保守做法：TLD 白名单 + 排除邮箱 + 去重 + 最多 8 个。宁可漏（模型还能显式调
 * create_recon_task），也不要把一段散文里的每个单词都当域名建出十个空项目。
 */
const TLD_ALLOW = new Set(
	"com net org cn io me dev app co ai info biz cc tv xyz top site online tech cloud shop vip edu gov mil int eu us uk jp kr hk tw sg ru de fr nl ca au".split(" "),
);

export function detectTargets(text) {
	const raw = String(text ?? "");
	const out = [];
	const seen = new Set();
	const push = (token) => {
		const cleaned = String(token ?? "").replace(/[.,;:]+$/, "");
		if (!cleaned || seen.has(cleaned.toLowerCase())) return;
		if (!normalizeTarget(cleaned)) return;
		seen.add(cleaned.toLowerCase());
		out.push(cleaned);
	};
	// 1) IPv4（可带端口 / 路径 / 协议）：渗透目标经常只有 IP，不能只认域名。
	for (const match of raw.match(/(?:https?:\/\/)?\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?(?:\/[^\s，。；、）)\]】"'<>]*)?/g) ?? []) {
		push(match);
	}
	// 2) 域名 / URL：TLD 白名单挡掉 "Android.Manifest" 这类误判。
	const found = raw.match(/(?:https?:\/\/)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.){1,4}[a-z]{2,24}(?::\d{1,5})?(?:\/[^\s，。；、）)\]】"'<>]*)?/gi) ?? [];
	for (const token of found) {
		// 邮箱里的 @ 前后不是目标：a@b.com 会被上面匹配到 b.com
		const at = raw.indexOf(token);
		if (at > 0 && raw[at - 1] === "@") continue;
		const host = token.replace(/^https?:\/\//i, "").split(/[/:?#]/)[0].toLowerCase();
		if (!TLD_ALLOW.has(host.split(".").pop())) continue;
		push(token);
	}
	return out.slice(0, 8);
}

function titleFor(text, target) {
	const firstLine = String(text ?? "").trim().split(/\r?\n/)[0] ?? "";
	const clean = firstLine.replace(/\s+/g, " ").slice(0, 40);
	return clean || `${target} 评估`;
}

/**
 * 对话开场自动建项目并开跑。
 *
 * 这就是"跟原来项目一样"的行为：说一句"对 example.com 做评估"，会话立刻有一个
 * 项目（任务）在跑，资产与流量随即出现；而不是要用户再点一次「任务 → 新建」。
 * 关掉它的开关在设置里（chat.autoProject）。
 */
async function ensureProject(conversation, text) {
	if (readSettings().chat?.autoProject === false) return null;
	const bound = conversation.taskId ? (store.state.tasks ?? []).find((task) => task.id === conversation.taskId) : null;
	if (bound) return { task: bound, created: false, note: "" };
	// 安卓会话：项目是"某个 App"，不是站点。包名从话里认，认不到就留空等补。
	if (conversation.mode === "android") {
		const pkg = detectAppPackage(text);
		if (!pkg && !/(android|安卓|app|apk|手机|设备)/i.test(text)) return null;
		const task = createTask({
			title: titleFor(text, pkg || "安卓 App"),
			scope: "",
			platform: "android",
			appPackage: pkg ?? "",
			companyId: conversation.companyId ?? null,
			conversationId: conversation.id,
		});
		conversation.taskId = task.id;
		store.save();
		// 移动端项目没有站点请求，直接"跑完"进入等待取证状态；不需要过守门（没发出任何网络动作）。
		startTask(task);
		store.log("info", `对话自动创建移动端项目 ${task.id}${pkg ? `（${pkg}）` : ""}`);
		return {
			task,
			created: true,
			note: `已自动创建移动端项目 ${task.id}「${task.title}」${pkg ? `（包名 ${pkg}）` : ""}。移动端项目不发站点侦察：用设备工具取证，或到「安卓设备 → APK 分析」出静态结论。`,
			gate: "mobile",
		};
	}
	const targets = detectTargets(text);
	if (!targets.length) return null;
	const task = createTask({
		title: titleFor(text, targets[0]),
		scope: targets.join("\n"),
		companyId: conversation.companyId ?? null,
		conversationId: conversation.id,
	});
	if (!task.targets.length) return null;
	conversation.taskId = task.id;
	store.save();
	const gate = await guard({
		scope: "recon",
		source: "对话 Agent · 自动建项目",
		target: task.title,
		command: `对以下目标发起只读 GET 侦察：\n${task.scope.join("\n")}`,
		action: { kind: "reconTask", taskId: task.id },
	});
	const note =
		gate.kind === "pending"
			? `已自动创建项目 ${task.id}「${task.title}」（${task.targets.length} 个目标），当前是人工审批模式，需在「守门」页批准后开跑（审批单 ${gate.approvalId}）。`
			: gate.kind === "block"
				? `已自动创建项目 ${task.id}「${task.title}」，但守门员拦下了执行：${gate.reason || "未给出理由"}。`
				: `已自动创建项目 ${task.id}「${task.title}」并开始侦察（${task.targets.length} 个目标）。`;
	store.log("info", note);
	return { task, created: true, note, gate: gate.kind };
}

/** 从话里认安卓包名：com.example.app / cn.foo.bar。 */
export function detectAppPackage(text) {
	const match = String(text ?? "").match(/\b[a-z][a-z0-9_]*(?:\.[a-z0-9_]+){2,}\b/);
	return match ? match[0] : null;
}

export function archiveConversation(id, archived = true) {
	const conversation = getConversation(id);
	if (!conversation) return null;
	conversation.archived = archived === true;
	store.save();
	return conversation;
}

export function deleteConversation(id) {
	const list = conversations();
	const index = list.findIndex((c) => c.id === id);
	if (index < 0) return false;
	list.splice(index, 1);
	store.save();
	return true;
}

/**
 * 发一条消息并取回复。
 *
 * 角色默认用 executor；如果配了 agents 里的角色绑定，就按绑定走。
 * 没配端点时明确报错，而不是假装回答——这一点比"能用"更重要。
 */
export async function sendMessage(id, content, options = {}) {
	const conversation = getConversation(id);
	if (!conversation) throw new Error("会话不存在");
	const text = String(content ?? "").trim();
	if (!text) throw new Error("消息为空");
	if (conversation.messages.length >= MAX_MESSAGES) throw new Error("这条会话消息太多，开一条新的吧");

	const profile = profileForRole(options.role ?? "executor");
	if (!profile) {
		throw new Error("没有可用的模型端点：请到「设置 → 模型」添加一个档案并激活");
	}
	// 进度事件：流式接口用它在工具刚跑完时就推给浏览器；非流式接口拿到的是 noop。
	const emit = typeof options.onEvent === "function" ? options.onEvent : () => {};

	conversation.messages.push({ role: "user", content: text.slice(0, MAX_CONTENT), at: new Date().toISOString() });
	conversation.updatedAt = new Date().toISOString();
	// 首条消息自动成为标题，省一次命名
	if (conversation.title === "新对话" && conversation.messages.length === 1) {
		conversation.title = text.slice(0, 40);
	}
	store.save();
	// 先把"用户消息已入库"推回去：前端可以立刻把它画出来，而不是等整轮跑完。
	emit({ type: "user", message: conversation.messages[conversation.messages.length - 1], title: conversation.title });

	const messages = [];
	// 先看这句话里有没有目标：有就立刻建项目并开跑（和"原来那套"一样的开场行为）。
	// 这一步放在调用模型之前，所以哪怕模型最终一句话没说，项目、流量、资产也已经落了。
	const project = await ensureProject(conversation, text);
	if (project?.task) {
		emit({
			type: "project",
			project: { id: project.task.id, title: project.task.title, status: project.task.status, created: project.created },
			note: project.note ?? "",
		});
	}
	const projectBlock = project?.note ? `\n\n${project.note}` : "";
	// 会话形态决定"目标长什么样"：站点会话看域名/URL，安卓会话看包名与设备。
	const modeBlock =
		conversation.mode === "android"
			? `\n\n本会话形态：安卓（App）评估。目标是一个 App，不是站点。
- 先用 list_devices 确认设备，再 device_packages 找目标包名；包名/版本写进漏洞记录（platform=android + appPackage/appVersion）。
- 设备命令一条一条来；截屏、logcat、拉文件都可以用，命令走守门（排队不是失败）。
- 没有设备时，也可以让操作员到「安卓设备 → APK 分析」上传 APK 出静态结论。`
			: "";
	const goalBlock = conversation.goal ? `\n\n当前任务目标：${conversation.goal}` : "";
	messages.push({
		role: "system",
		content: `${AGENT_PROMPT}${goalBlock}${modeBlock}${projectBlock}\n\n${conversation.systemPrompt ? `补充要求：${conversation.systemPrompt}\n\n` : ""}${projectContext(conversation)}`,
	});

	// 输入侧预算：上下文窗口减去留给输出的部分，超出就从最旧的一轮开始丢。
	// 原版用"上下文窗口 K"作为压缩阈值，这里沿用同一口径——不裁剪的话长会话
	// 会直接被服务商按 400 拒掉，操作员只看到一句看不懂的报错。
	const window = contextWindowOf(profile);
	const reserveOut = Math.min(Math.max(Number(profile.maxTokens) || 2048, 256), 32768);
	// 预算不能超过窗口本身：早先写成 Math.max(window - reserveOut, 1000)，
	// 配上 1K 窗口时预算反而被抬到 1000，等于没算输出预留。
	const inputBudget = Math.max(Math.min(window - reserveOut, window), 256);

	// 粗略估 token。**必须偏保守**：宁可多裁两条，也不要因为低估而超窗被服务商整条拒掉。
	// 实测中文约 0.65 token/字，英文约 0.25 token/字，这里按 1/1.8 折算再留每轮固定开销。
	const estimateOne = (text) => Math.ceil(String(text ?? "").length / 1.8) + 8;
	const estimate = (list) => list.reduce((sum, m) => sum + estimateOne(m.content), 0);

	const history = conversation.messages
		.filter((m) => !m.error)
		.map((m) => ({ role: m.role, content: m.content }));
	let trimmed = 0;
	let kept = history.slice();
	while (kept.length > 1 && estimate([...messages, ...kept]) > inputBudget) {
		kept = kept.slice(1);
		trimmed += 1;
	}
	// 单条消息就超预算时按字符硬截，否则它会永远裁不掉（只剩 1 条时循环已退出）
	if (kept.length === 1) {
		const budgetChars = Math.max(Math.floor(inputBudget * 1.6) - 40, 200);
		if (kept[0].content.length > budgetChars) {
			kept[0] = { ...kept[0], content: `${kept[0].content.slice(0, budgetChars)}\n\n（本条过长已截断）` };
			trimmed += 1;
		}
	}
	if (trimmed > 0 && kept.length > 0) {
		// 裁过就明说，避免模型"失忆"却没人知道为什么
		const dropped = history.length - kept.length;
		if (dropped > 0) {
			kept[0] = {
				...kept[0],
				content: `（此前 ${dropped} 条历史因超出上下文窗口已省略）\n\n${kept[0].content}`,
			};
		}
	}
	messages.push(...kept);

	const started = Date.now();
	// 流式接口会传进来一个可被客户端断开的 controller：浏览器一关，上游请求跟着断。
	const controller = options.abortController ?? new AbortController();
	activeTurns.set(conversation.id, controller);
	const timer = setTimeout(() => controller.abort(), 180000);
	const toolsEnabled = options.tools !== false;
	let usageTotal = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedTokens: 0, reasoningTokens: 0 };
	const toolTrace = [];

	const callOnce = async (payloadMessages, withTools) => {
		const response = await fetch(`${profile.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(profile.apiKey ? { authorization: `Bearer ${profile.apiKey}` } : {}),
			},
			body: JSON.stringify({
				model: profile.modelId,
				messages: payloadMessages,
				temperature: options.temperature ?? 0.3,
				// 推理型模型会把 max_tokens 先花在 reasoning_content 上。给 2048 时
				// 思考就耗尽预算，content 直接是空字符串——界面上就是一条空气泡。
				// 所以默认给足；档案里配了最大输出就以档案为准。
				max_tokens: Math.min(Number(options.maxTokens ?? profile.maxTokens ?? 8192) || 8192, 32768),
				...(profile.reasoningEffort ? { reasoning_effort: profile.reasoningEffort } : {}),
				...(withTools ? { tools: CHAT_TOOLS, tool_choice: "auto" } : {}),
			}),
			signal: controller.signal,
		});
		return response;
	};

	try {
		let response = await callOnce(messages, toolsEnabled);
		// 有的端点不支持 tools 字段（直接 400）。退回纯聊天，并明确告诉操作员，
		// 否则他会疑惑"为什么模型不去查"。
		let toolsActive = toolsEnabled;
		if (!response.ok) {
			const body = await response.clone().text().catch(() => "");
			if (toolsActive && response.status >= 400 && response.status < 500 && /tool/i.test(body)) {
				toolsActive = false;
				response = await callOnce(messages, false);
			}
		}
		if (!response.ok) {
			const body = await response.text().catch(() => "");
			recordLlmCall({ ok: false });
			// 把失败也记进会话，否则刷新后看不到"这里曾经失败过"
			conversation.messages.push({
				role: "assistant",
				content: `（调用失败：HTTP ${response.status}）${body.slice(0, 300)}`,
				at: new Date().toISOString(),
				error: true,
			});
			store.save();
			throw new Error(`模型返回 ${response.status}：${body.slice(0, 200)}`);
		}

		let data = await response.json();
		// 工具循环：模型要工具就执行、把结果喂回去，直到它给出最终答复。
		//
		// 上一版的坑：模型一句"枚举子域"会连续调 30 次 dns_lookup，6 轮上限被工具轮次吃光，
		// 循环在"还要再查"的地方退出，于是只剩一段推理、没有结论。
		// 现在的约束：
		//   - 同一调用（同名同参）只执行一次，重复的直接回放上次结果；
		//   - 每轮最多执行 8 个工具、整轮最多 24 个，超了就进入"强制收尾"；
		//   - 无论如何最后都会再要一次**不带工具**的答复，保证有结论。
		const executed = new Map();
		const MAX_CALLS_PER_TURN = 24;
		const MAX_CALLS_PER_ROUND = 8;
		const MAX_ROUNDS = 5;
		let executedCount = 0;
		let budgetHit = false;

		for (let round = 0; round < MAX_ROUNDS; round += 1) {
			const choice = data?.choices?.[0] ?? {};
			const calls = choice.message?.tool_calls ?? [];
			const roundUsage = normalizeUsage(data?.usage);
			usageTotal = {
				inputTokens: usageTotal.inputTokens + roundUsage.inputTokens,
				outputTokens: usageTotal.outputTokens + roundUsage.outputTokens,
				totalTokens: usageTotal.totalTokens + roundUsage.totalTokens,
				cachedTokens: usageTotal.cachedTokens + roundUsage.cachedTokens,
				reasoningTokens: usageTotal.reasoningTokens + roundUsage.reasoningTokens,
			};
			if (!calls.length) break;
			// 每轮开始就推一条状态：浏览器上能看到"第 2 轮 · 准备执行 8 个工具"，
			// 而不是盯着一个不动的"回复中…"。
			emit({ type: "round", round: round + 1, calls: calls.length, models: `${profile.modelId}` });

			// 回填模型这一轮的"我要调工具"，否则下一轮上下文不合法
			messages.push({ role: "assistant", content: choice.message?.content ?? "", tool_calls: calls });
			const roundCalls = calls.slice(0, MAX_CALLS_PER_ROUND);
			const skipped = calls.length - roundCalls.length;
			for (const call of roundCalls) {
				let args = {};
				try {
					args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
				} catch {
					args = {};
				}
				const name = call.function?.name;
				// 同参重复调用：直接回放上次结果，并明确告诉模型"这条已经查过"，
				// 避免它把轮次浪费在重复 DNS 查询上。
				const key = `${name}:${JSON.stringify(args)}`;
				if (executed.has(key)) {
					const cached = executed.get(key);
					toolTrace.push({ name, args, ok: cached.ok, summary: `（本轮已调用过，结果同上）${cached.summary}`, repeat: true });
					emit({ type: "tool", name, args, ok: cached.ok, summary: `（已调用过，结果同上）${cached.summary}`, repeat: true });
					messages.push({
						role: "tool",
						tool_call_id: call.id,
						content: `（这条调用本轮已经执行过，结果不变）\n${cached.summary}`,
					});
					continue;
				}
				// 工具开跑前先推一条"正在执行"：DNS/WHOIS/设备命令可能要几秒，
				// 这段时间界面必须有反馈。
				emit({ type: "tool-start", name, args });
				let result;
				try {
					// 设备优先级：会话绑定 > 项目绑定；都没有就让工具自己挑唯一在线设备。
					const projectTask = conversation.taskId ? (store.state.tasks ?? []).find((task) => task.id === conversation.taskId) : null;
					result = await runChatTool(name, args, {
						conversationId: conversation.id,
						taskId: conversation.taskId ?? null,
						companyId: conversation.companyId ?? null,
						deviceId: conversation.deviceId ?? projectTask?.deviceId ?? null,
						platform: conversation.mode === "android" ? "android" : "web",
						appPackage: projectTask?.appPackage ?? "",
					});
				} catch (error) {
					result = { ok: false, summary: `工具执行失败：${error.message}` };
				}
				executedCount += 1;
				const summary = String(result.summary ?? "").slice(0, 600);
				executed.set(key, { ok: result.ok !== false, summary });
				toolTrace.push({ name, args, ok: result.ok !== false, summary });
				emit({ type: "tool", name, args, ok: result.ok !== false, summary });
				messages.push({
					role: "tool",
					tool_call_id: call.id,
					content: String(result.summary ?? "").slice(0, 6000),
				});
				if (executedCount >= MAX_CALLS_PER_TURN) {
					budgetHit = true;
					break;
				}
			}
			if (skipped > 0) {
				emit({ type: "status", text: `本轮 ${calls.length} 个调用，只执行了前 ${roundCalls.length} 个` });
				messages.push({
					role: "system",
					content: `本轮只执行了前 ${roundCalls.length} 个工具调用（另有 ${skipped} 个未执行）。请先基于已有结果推进，不要一次给太多调用。`,
				});
			}
			if (budgetHit) {
				emit({ type: "status", text: "工具额度用尽，要求模型直接给结论" });
				messages.push({
					role: "system",
					content: "工具调用额度已用尽。现在**不要再调用工具**，直接用现有结果给出结论：已确认的事实、仍未验证的部分、下一步建议。",
				});
				break;
			}

			const next = await callOnce(messages, true);
			if (!next.ok) {
				const body = await next.text().catch(() => "");
				throw new Error(`工具轮次调用失败 ${next.status}：${body.slice(0, 200)}`);
			}
			data = await next.json();
		}

		// 收尾：只要模型最后一轮还在要工具（或者正文为空），就再要一次**不带工具**的答复。
		// 这是"必须有结论"的兜底——上一轮就是死在这一步没有兜底。
		const lastChoice = data?.choices?.[0] ?? {};
		const lastCalls = lastChoice.message?.tool_calls ?? [];
		const lastContent = String(lastChoice.message?.content ?? "").trim();
		if (toolsActive && (lastCalls.length > 0 || !lastContent)) {
			emit({ type: "status", text: "收尾：要求模型给结论（不再调用工具）" });
			messages.push({
				role: "system",
				content:
					"现在必须收尾：不要再调用任何工具，用一句话到几段话直接回答操作员——" +
					"已经查到了什么、发现了什么、下一步建议做什么。不要再输出工具调用。",
			});
			try {
				const closing = await callOnce(messages, false);
				if (closing.ok) {
					const closingData = await closing.json();
					const closingUsage = normalizeUsage(closingData?.usage);
					usageTotal = {
						inputTokens: usageTotal.inputTokens + closingUsage.inputTokens,
						outputTokens: usageTotal.outputTokens + closingUsage.outputTokens,
						totalTokens: usageTotal.totalTokens + closingUsage.totalTokens,
						cachedTokens: usageTotal.cachedTokens + closingUsage.cachedTokens,
						reasoningTokens: usageTotal.reasoningTokens + closingUsage.reasoningTokens,
					};
					const closingChoice = closingData?.choices?.[0];
					if (closingChoice) data = closingData;
				}
			} catch {
				// 收尾失败不致命：下面还有"用工具结果拼一条"的兜底。
			}
		}

		const choice = data?.choices?.[0] ?? {};
		const message = choice.message ?? {};
		const usage = usageTotal;
		const finish = String(choice.finish_reason ?? "");
		const content = String(message.content ?? "");
		const reasoning = String(message.reasoning_content ?? message.reasoning ?? "");
		const reasoningTokens = usage.reasoningTokens;

		// 正文为空时不能就存个空字符串：分几种情况给出人话，否则用户只看到一条空白气泡。
		let reply = content;
		let note;
		if (!reply.trim()) {
			if (toolTrace.length) {
				// 工具真的跑过：把"做了什么"结构化地摆出来，这比一段模型推理有用得多。
				reply = summarizeToolTrace(toolTrace, budgetHit);
				note = "模型没有给出文字结论，以下是本轮实际执行的工具与结果摘要";
			} else if (reasoning.trim()) {
				reply = reasoning;
				note = "模型只产出了推理过程，没有给出最终答复（已把推理内容显示出来）";
			} else if (finish === "length") {
				note = "模型输出被 max_tokens 截断，没有产出正文 —— 到「设置 → 模型」把「最大输出」调大，或换个非推理模型";
			} else {
				note = `模型返回了空内容（finish_reason=${finish || "未知"}）`;
			}
		} else if (finish === "length") {
			note = "输出被 max_tokens 截断";
		}
		if (trimmed > 0 && !note) note = `已省略 ${trimmed} 条超窗历史`;
		if (!toolsActive) note = note ?? "该端点不支持工具调用，本次只做了纯对话";

		conversation.messages.push({
			role: "assistant",
			content: reply.slice(0, MAX_CONTENT),
			at: new Date().toISOString(),
			model: profile.modelId,
			...(conversation.taskId ? { projectId: conversation.taskId } : {}),
			...(project?.note ? { projectNote: project.note } : {}),
			// 输入 / 输出分开记：只存总量分不清"上下文太长"还是"模型啰嗦"
			inputTokens: usage.inputTokens,
			outputTokens: usage.outputTokens,
			tokens: usage.totalTokens,
			cachedTokens: usage.cachedTokens,
			finishReason: finish,
			reasoningTokens,
			...(toolTrace.length ? { toolCalls: toolTrace } : {}),
			...(trimmed > 0 ? { trimmedMessages: trimmed } : {}),
			...(note ? { note } : {}),
			...(note && !content.trim() ? { error: true } : {}),
		});
		conversation.updatedAt = new Date().toISOString();
		store.save();
		recordLlmCall({ ok: true, tokens: usage.totalTokens, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
		return {
			ok: true,
			reply,
			model: profile.modelId,
			elapsedMs: Date.now() - started,
			inputTokens: usage.inputTokens,
			outputTokens: usage.outputTokens,
			tokens: usage.totalTokens,
			cachedTokens: usage.cachedTokens,
			finishReason: finish,
			reasoningTokens,
			contextWindow: window,
			trimmed,
			tools: toolTrace,
			...(project?.task ? { project: { id: project.task.id, title: project.task.title, status: project.task.status, created: project.created } } : {}),
			...(note ? { note } : {}),
			conversation: { id: conversation.id, title: conversation.title, taskId: conversation.taskId ?? null },
		};
	} catch (error) {
		if (error.name === "AbortError") throw new Error("模型调用超时（180s）");
		throw error;
	} finally {
		clearTimeout(timer);
		activeTurns.delete(conversation.id);
	}
}

/** 强制收尾也失败时，用工具调用记录拼一条可读的结果，绝不留空气泡。 */
function summarizeToolTrace(trace, budgetHit) {
	const counts = new Map();
	for (const item of trace) counts.set(item.name, (counts.get(item.name) ?? 0) + 1);
	const lines = [
		budgetHit ? "本轮工具调用额度用尽，模型没来得及总结。实际执行了：" : "模型没有给出文字结论，实际执行了：",
		"",
		`合计 ${trace.length} 次调用：${[...counts.entries()].map(([name, count]) => `${name}×${count}`).join("、") || "—"}`,
		"",
	];
	for (const item of trace.slice(-12)) {
		lines.push(`- ${item.name}${item.ok === false ? "（失败）" : ""}：${String(item.summary ?? "").replace(/\s+/g, " ").slice(0, 160)}`);
	}
	lines.push("", "下一步：让我「把结果整理成结论并生成报告」，或直接看「流量」「漏洞」页。");
	return lines.join("\n");
}

/**
 * 流式版本：与 sendMessage 共用同一套逻辑，区别只是把进度通过 onEvent 推出去。
 * 浏览器拿到的是"用户消息已入库 / 建了项目 / 第几轮 / 某个工具跑完 / 收尾 / 最终结果"，
 * 所以不需要等整轮跑完才看到东西，也不需要切页面刷新。
 */
export async function sendMessageStream(id, content, options = {}) {
	const emit = typeof options.onEvent === "function" ? options.onEvent : () => {};
	try {
		const result = await sendMessage(id, content, { ...options, onEvent: emit });
		emit({ type: "done", result });
		return result;
	} catch (error) {
		emit({ type: "error", message: error?.message ?? String(error) });
		throw error;
	}
}

export function stats() {
	const list = conversations();
	return {
		conversations: list.length,
		messages: list.reduce((sum, c) => sum + c.messages.length, 0),
		archived: list.filter((c) => c.archived === true).length,
	};
}
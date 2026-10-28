/**
 * 工具注册表：把平台的能力列成一张表，可逐项开关，并记录调用次数。
 *
 * 与"权限"的区别：权限管的是**人**（哪个角色能用什么），工具管的是**能力**
 * （这台机器上某项功能是否挂载）。关掉一个工具后，对应接口直接返回 403，
 * 不是只把按钮藏起来——藏按钮是假的，接口拒才是真的。
 */

import { store } from "./store.mjs";

/** 内置工具目录。api 前缀用于在网关层做拦截匹配。 */
export const CATALOG = [
	// 侦察与评估
	{ id: "recon", group: "评估", name: "任务侦察引擎", desc: "对目标发起只读 GET 侦察，产出资产与发现", api: ["/api/tasks"] },
	{ id: "recon_live", group: "评估", name: "实时探测", desc: "单次 URL 探测（DNS/响应头/TLS）", api: [] },
	{ id: "asset_scan", group: "评估", name: "资产测绘", desc: "FOFA / Quake / Hunter 公网测绘查询", api: ["/api/intel"] },
	{ id: "web_search", group: "评估", name: "Web 搜索", desc: "公网搜索与页面正文抓取", api: ["/api/websearch"] },

	// 移动端
	{ id: "device_exec", group: "移动端", name: "设备命令", desc: "在安卓/iOS 设备上执行 shell", api: ["/api/android/devices", "/api/ios/devices"] },
	{ id: "device_file", group: "移动端", name: "设备文件", desc: "向设备推送 / 从设备拉取文件", api: [] },
	{ id: "device_screen", group: "移动端", name: "设备截屏", desc: "读取设备屏幕", api: [] },
	{ id: "device_capture", group: "移动端", name: "设备抓包", desc: "tcpdump / rvictl 抓包并回传", api: [] },
	{ id: "device_frida", group: "移动端", name: "Frida 动态调试", desc: "起 frida-server、推脚本、开隧道", api: [] },
	{ id: "apk_analyze", group: "移动端", name: "APK 静态分析", desc: "解 ZIP/AXML/DEX 输出结论", api: ["/api/android/apk"] },

	// 知识与产出
	{ id: "knowledge", group: "知识", name: "知识库", desc: "文档分块与本地检索", api: ["/api/knowledge"] },
	{ id: "report", group: "产出", name: "报告生成", desc: "汇总资产/发现/流水为 Markdown", api: ["/api/reports"] },
	{ id: "poc", group: "产出", name: "POC 库", desc: "Nuclei 模板导入与检索", api: ["/api/pocs"] },

	// 管控
	{ id: "gate", group: "管控", name: "守门与审批", desc: "AI 判定 / 人工审批队列", api: ["/api/gatekeeper"] },
	{ id: "explore", group: "管控", name: "探索图", desc: "节点、意图、前沿与活动流", api: ["/api/exploration"] },
	{ id: "chat", group: "管控", name: "对话", desc: "与大模型的多轮对话", api: ["/api/chat"] },
];

export const GROUPS = ["评估", "移动端", "知识", "产出", "管控"];

function tools() {
	if (!store.state.tools || typeof store.state.tools !== "object") store.state.tools = {};
	// 早期版本会把 toolForPath 返回的 null 当成工具 id 记进去，留下一个 `null` 键
	// 和一堆无主调用计数。读到就清掉。
	if (Object.prototype.hasOwnProperty.call(store.state.tools, "null")) delete store.state.tools.null;
	return store.state.tools;
}

function entry(id) {
	const state = tools();
	if (!state[id]) state[id] = { enabled: true, calls: 0, lastUsedAt: null };
	return state[id];
}

export function listTools() {
	return CATALOG.map((meta) => {
		const state = entry(meta.id);
		return { ...meta, enabled: state.enabled !== false, calls: state.calls ?? 0, lastUsedAt: state.lastUsedAt ?? null };
	});
}

export function setEnabled(id, enabled) {
	if (!CATALOG.some((t) => t.id === id)) return { ok: false, error: "工具不存在" };
	const state = entry(id);
	state.enabled = enabled === true;
	store.save();
	store.log("info", `工具「${id}」已${state.enabled ? "启用" : "停用"}`);
	return { ok: true, tool: listTools().find((t) => t.id === id) };
}

export function isEnabled(id) {
	return entry(id).enabled !== false;
}

export function recordCall(id) {
	const state = entry(id);
	state.calls = (state.calls ?? 0) + 1;
	state.lastUsedAt = new Date().toISOString();
	store.save();
}

/**
 * 找出某个 API 路径归属的工具。用于网关层拦截。
 * 返回命中的工具 id，没有命中返回 null（不拦）。
 *
 * 设备接口必须按**子路径**细分：早期把 `/api/android/devices` 整段都算作
 * `device_exec`，结果关掉「设备命令」会连带把截屏、拉文件、抓包一起禁掉——
 * 操作员看到的就是"截屏按钮点了没反应"。现在一项动作一个工具。
 */
const ROUTE_RULES = [
	{ tool: "device_screen", re: /^\/api\/(android|ios)\/devices\/[^/]+\/screencap$/ },
	{ tool: "device_file", re: /^\/api\/(android|ios)\/devices\/[^/]+\/(push|pull|ls)$/ },
	{ tool: "device_capture", re: /^\/api\/(android|ios)\/devices\/[^/]+\/capture$/ },
	{ tool: "device_frida", re: /^\/api\/(android|ios)\/devices\/[^/]+\/(frida|tunnel)$/ },
	{ tool: "device_exec", re: /^\/api\/(android|ios)\/devices\/[^/]+\/exec$/ },
	{ tool: "device_exec", re: /^\/api\/(android|ios)\/devices(\/[^/]+)?$/ },
	{ tool: "apk_analyze", re: /^\/api\/android\/apk/ },
	{ tool: "knowledge", re: /^\/api\/knowledge/ },
	{ tool: "report", re: /^\/api\/reports/ },
	{ tool: "poc", re: /^\/api\/pocs/ },
	{ tool: "gate", re: /^\/api\/gatekeeper/ },
	{ tool: "explore", re: /^\/api\/exploration/ },
	{ tool: "chat", re: /^\/api\/chat/ },
	{ tool: "asset_scan", re: /^\/api\/intel/ },
	{ tool: "web_search", re: /^\/api\/websearch/ },
	{ tool: "recon", re: /^\/api\/tasks/ },
];

export function toolForPath(pathname) {
	for (const rule of ROUTE_RULES) {
		if (rule.re.test(pathname)) return rule.tool;
	}
	return null;
}

export function stats() {
	const list = listTools();
	return {
		total: list.length,
		enabled: list.filter((t) => t.enabled).length,
		calls: list.reduce((sum, t) => sum + t.calls, 0),
		byGroup: list.reduce((acc, t) => {
			acc[t.group] = (acc[t.group] ?? 0) + 1;
			return acc;
		}, {}),
	};
}
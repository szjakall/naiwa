/**
 * 探索图：把一次评估画成持续生长的图。
 *
 * 不是"任务列表"，而是把一次评估看成一棵持续生长的图：
 *   目标(goal) → 意图(intent) → 事实(fact) → 发现(finding)
 * 每个节点都是人/agent 写下的一条观察，边表示"由什么推出什么"。
 *
 * 三条来自原实现的设计约束：
 *
 * 1. **前沿（frontier）是图的入口**：只有 state=open 且没人认领的 intent 才算
 *    "下一步可以做的事"。没有前沿就说明这一轮没什么可推进的，这是正常状态，
 *    不该硬凑（原文档原话："本轮 0 个意图仍是完全正常的结果"）。
 * 2. **不重复记账**：同一事实换个措辞再写一遍会让图谱膨胀、让规划者误以为
 *    有新进展。写入时按 title 归一化去重。
 * 3. **意图要挂资产**：一个意图必须说清"针对哪个资产"，否则它无法被执行，
 *    只会变成一条空想的待办。
 */

import { randomUUID } from "node:crypto";
import { store } from "./store.mjs";

export const NODE_KINDS = {
	goal: { label: "目标", tone: "info", hint: "任务拆出来的可探索子目标" },
	intent: { label: "意图", tone: "warn", hint: "一个待验证的探索方向（挂在资产上）" },
	fact: { label: "事实", tone: "muted", hint: "一次观察得到的客观事实" },
	finding: { label: "发现", tone: "danger", hint: "可复现的漏洞或风险" },
	asset: { label: "资产", tone: "ok", hint: "实际接触过的站点/接口/主机" },
};

const EDGE_TYPES = {
	leads_to: "推出",
	exploits: "利用",
	discovered_on: "发现于",
	depends_on: "依赖",
	enables: "使之可行",
};

function graph() {
	if (!store.state.exploration) {
		store.state.exploration = { nodes: [], edges: [], activity: [] };
	}
	const g = store.state.exploration;
	if (!Array.isArray(g.nodes)) g.nodes = [];
	if (!Array.isArray(g.edges)) g.edges = [];
	if (!Array.isArray(g.activity)) g.activity = [];
	return g;
}

/** 标题归一化：去空白、去标点、小写，用于去重。 */
function normalize(title) {
	return String(title ?? "")
		.toLowerCase()
		.replace(/[\s\u3000]+/g, "")
		.replace(/[，。、；：！？.,;:!?（）()【】\[\]"'`]/g, "")
		.slice(0, 120);
}

function logActivity(type, text, meta) {
	const g = graph();
	g.activity.push({
		id: `ev${randomUUID().slice(0, 8)}`,
		at: new Date().toISOString(),
		type,
		text,
		...(meta ? { meta } : {}),
	});
	// 活动流是"最近发生了什么"，留 500 条足够回看，不必永久保存。
	if (g.activity.length > 500) g.activity.splice(0, g.activity.length - 500);
	store.save();
}

export function listActivity(limit = 100) {
	return graph().activity.slice(-limit).reverse();
}

export function listNodes(filter = {}) {
	let nodes = graph().nodes;
	if (filter.kind) nodes = nodes.filter((n) => n.kind === filter.kind);
	if (filter.taskId) nodes = nodes.filter((n) => n.taskId === filter.taskId);
	if (filter.state) nodes = nodes.filter((n) => n.state === filter.state);
	if (filter.search) {
		const needle = String(filter.search).toLowerCase();
		nodes = nodes.filter(
			(n) => `${n.title} ${n.detail}`.toLowerCase().includes(needle),
		);
	}
	return [...nodes].map((n) => ({ ...n })).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function getNode(id) {
	const node = graph().nodes.find((n) => n.id === id);
	if (!node) return null;
	const g = graph();
	return {
		...node,
		edges: g.edges.filter((e) => e.from === id || e.to === id),
		// 邻居节点，供"点开一个节点看它连着什么"用
		neighbors: g.edges
			.filter((e) => e.from === id || e.to === id)
			.map((e) => {
				const otherId = e.from === id ? e.to : e.from;
				return g.nodes.find((n) => n.id === otherId);
			})
			.filter(Boolean),
	};
}

/** 写入一个节点。同 kind + 同归一化标题视为重复，直接返回既有节点。 */
export function addNode(input, options = {}) {
	const kind = String(input.kind ?? "fact");
	if (!NODE_KINDS[kind]) throw new Error(`未知的节点类型：${kind}`);
	const title = String(input.title ?? "").trim();
	if (!title) throw new Error("节点标题不能为空");

	const g = graph();
	const key = normalize(title);
	const existing = g.nodes.find((n) => n.kind === kind && normalize(n.title) === key);
	if (existing && options.allowDuplicate !== true) {
		// 重复事实不新增，但把"又被观察到一次"记下来——频率本身是信号。
		existing.seenCount = (existing.seenCount ?? 1) + 1;
		existing.lastSeenAt = new Date().toISOString();
		store.save();
		return { node: existing, duplicate: true };
	}

	const node = {
		id: `en${randomUUID().slice(0, 10)}`,
		kind,
		title: title.slice(0, 200),
		detail: String(input.detail ?? "").slice(0, 4000),
		state: String(input.state ?? (kind === "intent" ? "open" : "done")),
		priority: Number.isFinite(Number(input.priority)) ? Number(input.priority) : 3,
		assetId: input.assetId ?? null,
		intentId: input.intentId ?? null,
		taskId: input.taskId ?? null,
		origin: String(input.origin ?? "manual"),
		owner: String(input.owner ?? ""),
		createdAt: new Date().toISOString(),
		lastSeenAt: new Date().toISOString(),
		seenCount: 1,
	};
	g.nodes.push(node);

	// 允许"写入时就连线"，省一次往返
	for (const edge of input.edges ?? []) {
		if (!edge?.to) continue;
		g.edges.push({
			id: `ee${randomUUID().slice(0, 8)}`,
			from: node.id,
			to: String(edge.to),
			type: EDGE_TYPES[edge.type] ? edge.type : "leads_to",
			label: String(edge.label ?? ""),
		});
	}
	store.save();
	logActivity("node", `新增${NODE_KINDS[kind].label}：${node.title}`, { nodeId: node.id, kind });
	return { node, duplicate: false };
}

export function updateNode(id, patch) {
	const node = graph().nodes.find((n) => n.id === id);
	if (!node) return null;
	for (const field of ["title", "detail", "state", "priority", "owner"]) {
		if (patch[field] !== undefined) {
			node[field] = field === "priority" ? Number(patch.priority) : String(patch[field]);
		}
	}
	node.updatedAt = new Date().toISOString();
	store.save();
	logActivity("update", `更新${NODE_KINDS[node.kind].label}：${node.title}`, { nodeId: node.id });
	return node;
}

export function deleteNode(id) {
	const g = graph();
	const index = g.nodes.findIndex((n) => n.id === id);
	if (index < 0) return false;
	const [removed] = g.nodes.splice(index, 1);
	// 边必须一起清，否则图里会留下指向空节点的悬空边
	g.edges = g.edges.filter((e) => e.from !== id && e.to !== id);
	store.save();
	logActivity("delete", `删除${NODE_KINDS[removed.kind].label}：${removed.title}`);
	return true;
}

export function addEdge({ from, to, type = "leads_to", label = "" }) {
	const g = graph();
	if (!g.nodes.some((n) => n.id === from) || !g.nodes.some((n) => n.id === to)) {
		throw new Error("边的两端必须是已存在的节点");
	}
	// 同一对节点同一类型只留一条
	if (g.edges.some((e) => e.from === from && e.to === to && e.type === type)) {
		return { ok: true, duplicate: true };
	}
	g.edges.push({ id: `ee${randomUUID().slice(0, 8)}`, from, to, type, label: String(label).slice(0, 120) });
	store.save();
	return { ok: true, duplicate: false };
}

export function deleteEdge(id) {
	const g = graph();
	const index = g.edges.findIndex((e) => e.id === id);
	if (index < 0) return false;
	g.edges.splice(index, 1);
	store.save();
	return true;
}

/**
 * 前沿：可以被执行的探索方向。
 *
 * 定义得比"所有 open 意图"严格一点：必须挂在资产上（assetId 非空），
 * 否则这条意图无法被真正执行，列出来只会让人误以为有活干。
 */
export function frontier(taskId) {
	const nodes = graph().nodes;
	const open = nodes.filter(
		(n) => n.kind === "intent" && n.state === "open" && (!taskId || n.taskId === taskId),
	);
	return open
		.map((intent) => ({
			...intent,
			executable: Boolean(intent.assetId),
			asset: intent.assetId ? nodes.find((n) => n.id === intent.assetId) ?? null : null,
		}))
		.sort((a, b) => a.priority - b.priority || (a.createdAt < b.createdAt ? 1 : -1));
}

/** 图 + 统计，给可视化用。 */
export function snapshot(taskId) {
	const g = graph();
	// 必须返回副本：之前直接返回 g.nodes / g.edges 的引用，调用方拿着快照
	// 期间只要有人删节点，快照会跟着变（自己把自己改短了），排序与计数都会错。
	const nodes = (taskId ? g.nodes.filter((n) => n.taskId === taskId) : g.nodes).map((n) => ({ ...n }));
	const ids = new Set(nodes.map((n) => n.id));
	const edges = g.edges.filter((e) => ids.has(e.from) && ids.has(e.to)).map((e) => ({ ...e }));
	const byKind = {};
	for (const node of nodes) byKind[node.kind] = (byKind[node.kind] ?? 0) + 1;
	return {
		nodes,
		edges,
		kinds: NODE_KINDS,
		edgeTypes: EDGE_TYPES,
		stats: {
			nodes: nodes.length,
			edges: edges.length,
			byKind,
			frontier: frontier(taskId).length,
			duplicates: nodes.reduce((sum, n) => sum + Math.max(0, (n.seenCount ?? 1) - 1), 0),
		},
	};
}

/** 从已产生的资产/发现自动回填节点——让图一开始就不是空的。 */
export function seedFromExisting(taskId) {
	let created = 0;
	const assets = store.state.assets.filter((a) => (taskId ? a.taskId === taskId || a.lastTaskId === taskId : true));
	for (const asset of assets.slice(0, 60)) {
		const result = addNode(
			{
				kind: "asset",
				title: asset.value,
				detail: `${asset.type}${asset.ip ? ` · ${asset.ip}` : ""}${asset.title ? ` · ${asset.title}` : ""}`,
				taskId: asset.taskId,
				origin: "asset",
			},
			{ allowDuplicate: true },
		);
		if (!result.duplicate) created += 1;
	}
	const findings = store.state.findings.filter((f) => (taskId ? f.taskId === taskId : true));
	for (const finding of findings.slice(0, 60)) {
		const result = addNode(
			{
				kind: "finding",
				title: finding.title,
				detail: finding.summary ?? finding.evidence?.slice(0, 500) ?? "",
				taskId: finding.taskId,
				origin: "finding",
			},
			{ allowDuplicate: true },
		);
		if (!result.duplicate) created += 1;
	}
	return { ok: true, created };
}

export function clearGraph() {
	store.state.exploration = { nodes: [], edges: [], activity: [] };
	store.save();
	return { ok: true };
}
/**
 * 业务状态存储：一个 JSON 文档 + 防抖落盘。
 *
 * 为什么不上数据库：控制台是单进程单操作员的工具，状态量在几十 MB 以内，
 * JSON 足够；换成 sqlite 会引入编译产物，破坏"解压即跑"的目标。
 * 代价是所有写入都在内存里，落盘靠 250ms 防抖——崩溃最多丢最后一次抖动窗口。
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { STATE_FILE } from "./config.mjs";

const LIMITS = {
	logs: 3000,
	traffic: 5000,
	taskEvents: 1200,
};

function emptyState() {
	return {
		version: 1,
		users: [],
		tasks: [],
		assets: [],
		findings: [],
		reports: [],
		traffic: [],
		logs: [],
		apk: [],
		// 守门设置 + 判定流水 + 人工审批队列（见 gatekeeper.mjs）
		gatekeeper: null,
		gateDecisions: [],
		approvals: [],
		// 探索图：节点 / 边 / 活动流（exploration.mjs）
		exploration: null,
		// 知识库（knowledge.mjs）
		knowledge: null,
		// 工具开关与调用统计（tools.mjs）
		tools: {},
		// Agent 定义与模型档案（agents.mjs）
		agents: [],
		llm: null,
		// 权限（rbac.mjs）
		rbac: null,
		// MCP 服务器（mcp.mjs）
		mcpServers: [],
		// POC 库（pocs.mjs）
		pocs: [],
		// 资产测绘平台（intel.mjs）
		intel: null,
		// Web 搜索（websearch.mjs）
		webSearch: null,
		// 代理档案（proxies.mjs）
		proxies: [],
		// 通知渠道（notify.mjs）
		notify: null,
		// 对话（chat.mjs）
		conversations: [],
		// 公司与报告配置（org.mjs）
		companies: [],
		reportSettings: null,
		reportTemplates: [],
		droid: {
			tokens: [],
			devices: [],
			listen: null,
		},
		seq: 0,
	};
}

/** 把旧版本 / 手改过的状态补齐，避免每个读取点都写防御代码。 */
function normalize(state) {
	const base = emptyState();
	const out = { ...base, ...state };
	out.droid = { ...base.droid, ...(state.droid ?? {}) };
	for (const key of [
		"users",
		"tasks",
		"assets",
		"findings",
		"reports",
		"traffic",
		"logs",
		"apk",
		"gateDecisions",
		"approvals",
		"agents",
		"mcpServers",
		"pocs",
		"proxies",
		"conversations",
		"companies",
		"reportTemplates",
	]) {
		if (!Array.isArray(out[key])) out[key] = [];
	}
	if (!Array.isArray(out.droid.tokens)) out.droid.tokens = [];
	if (!Array.isArray(out.droid.devices)) out.droid.devices = [];
	return out;
}

export class Store {
	/** @type {ReturnType<typeof emptyState>} */
	state;
	#timer = null;
	#dirty = false;
	#logSeq = 0;

	constructor() {
		this.state = existsSync(STATE_FILE) ? normalize(this.#load()) : emptyState();
	}

	#load() {
		try {
			return JSON.parse(readFileSync(STATE_FILE, "utf8"));
		} catch {
			return emptyState();
		}
	}

	/** 下一个自增序号，用于人类可读的短 id（t1 / a12 / f7）。 */
	nextId(prefix) {
		this.state.seq = (this.state.seq ?? 0) + 1;
		return `${prefix}${this.state.seq.toString(36)}`;
	}

	/** 防抖落盘：先写临时文件再 rename，断电不会留下半个 JSON。 */
	save() {
		this.#dirty = true;
		if (this.#timer) return;
		this.#timer = setTimeout(() => {
			this.#timer = null;
			this.flush();
		}, 250);
		this.#timer.unref?.();
	}

	flush() {
		if (!this.#dirty) return;
		this.#dirty = false;
		const tmp = `${STATE_FILE}.tmp`;
		try {
			writeFileSync(tmp, JSON.stringify(this.state), "utf8");
			renameSync(tmp, STATE_FILE);
		} catch (error) {
			// 落盘失败不该打断业务，但要让它出现在审计日志里。
			this.log("error", `状态落盘失败：${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/** 审计日志：同时进内存队列和 stdout。 */
	log(level, message, meta) {
		this.#logSeq += 1;
		const entry = {
			id: `l${Date.now().toString(36)}${this.#logSeq.toString(36)}`,
			at: new Date().toISOString(),
			level,
			message,
			...(meta ? { meta } : {}),
		};
		this.state.logs.push(entry);
		if (this.state.logs.length > LIMITS.logs) this.state.logs.splice(0, this.state.logs.length - LIMITS.logs);
		const line = `[${entry.at}] ${level.toUpperCase()} ${message}`;
		if (level === "error") console.error(line);
		else console.log(line);
		this.save();
		return entry;
	}

	/** 任务事件流：任务详情页轮询它，看到的就是这一步在做什么。 */
	pushTaskEvent(task, level, text) {
		task.events.push({ at: new Date().toISOString(), level, text });
		if (task.events.length > LIMITS.taskEvents) {
			task.events.splice(0, task.events.length - LIMITS.taskEvents);
		}
		this.save();
	}

	/** 流量记录：抓到的每一条 HTTP 交互都留一行，报告里可以直接引用。 */
	addTraffic(entry) {
		this.state.traffic.push(entry);
		if (this.state.traffic.length > LIMITS.traffic) {
			this.state.traffic.splice(0, this.state.traffic.length - LIMITS.traffic);
		}
		this.save();
	}
}

export const store = new Store();
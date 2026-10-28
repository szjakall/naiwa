/**
 * POC 库：导入 Nuclei 模板并建索引供检索。
 *
 * 只解析 YAML 里**做索引必需**的字段（id / info.name / severity / tags /
 * description / 请求类型），不是完整的 YAML 解析器——完整解析一个模板要几百行，
 * 而我们只需要"找到它、看它、复制它的路径"。原始文本原样保存，可下载。
 */

import { createHash } from "node:crypto";
import { store } from "./store.mjs";

const SEVERITIES = ["critical", "high", "medium", "low", "info", "unknown"];

function pocs() {
	if (!Array.isArray(store.state.pocs)) store.state.pocs = [];
	return store.state.pocs;
}

/**
 * 从一段 Nuclei YAML 里抠出索引字段。
 * 用逐行扫描而不是引入 YAML 库：模板结构固定，行匹配足够且不怕畸形输入。
 */
function parseTemplate(text, fallbackName) {
	const lines = String(text).replace(/\r\n/g, "\n").split("\n");
	const info = {};
	let id = "";
	let inInfo = false;
	let currentBlock = "";

	for (const raw of lines) {
		const line = raw.replace(/\t/g, "  ");
		if (/^id:\s*/.test(line)) {
			id = line.replace(/^id:\s*/, "").replace(/^["']|["']$/g, "").trim();
			continue;
		}
		if (/^info:\s*$/.test(line)) {
			inInfo = true;
			currentBlock = "";
			continue;
		}
		if (inInfo) {
			// 顶层缩进（0 或 2 空格且非 info 子键）说明 info 段结束
			if (/^\S/.test(line) && line.trim() !== "") {
				inInfo = false;
			} else {
				const field = /^\s+(name|author|severity|description|tags|reference):\s*(.*)$/.exec(line);
				if (field) {
					currentBlock = field[1];
					info[currentBlock] = field[2].replace(/^["']|["']$/g, "").trim();
					continue;
				}
				const blockItem = /^\s+-\s*(.*)$/.exec(line);
				if (blockItem && currentBlock) {
					info[currentBlock] = `${info[currentBlock] ?? ""} ${blockItem[1]}`.trim();
					continue;
				}
				// 多行 description（`description: |`）
				if (/^\s{4,}\S/.test(line) && currentBlock === "description") {
					info.description = `${info.description ?? ""} ${line.trim()}`.trim();
				}
			}
		}
	}

	// 请求类型：模板里出现哪些协议块
	const protocols = [];
	for (const name of ["http", "dns", "tcp", "network", "file", "headless", "ssl", "websocket", "whois", "code", "javascript"]) {
		if (new RegExp(`^${name}:`, "m").test(text)) protocols.push(name);
	}

	return {
		id: id || fallbackName || "unknown",
		name: info.name || id || fallbackName || "未命名模板",
		author: info.author || "",
		severity: SEVERITIES.includes(String(info.severity).toLowerCase()) ? String(info.severity).toLowerCase() : "unknown",
		description: (info.description || "").slice(0, 600),
		tags: String(info.tags ?? "")
			.split(/[,\s]+/)
			.map((t) => t.trim())
			.filter(Boolean),
		protocols,
	};
}

export function listPocs(filter = {}) {
	let list = pocs();
	if (filter.severity) list = list.filter((p) => p.severity === filter.severity);
	if (filter.tag) list = list.filter((p) => p.tags.includes(filter.tag));
	if (filter.search) {
		const needle = String(filter.search).toLowerCase();
		list = list.filter(
			(p) =>
				`${p.name} ${p.id} ${p.description} ${p.tags.join(" ")}`.toLowerCase().includes(needle),
		);
	}
	return [...list].sort((a, b) => (a.addedAt < b.addedAt ? 1 : -1));
}

export function getPoc(id) {
	return pocs().find((p) => p.id === id) ?? null;
}

/** 导入一批模板。text 里可以是单个模板，也可以是 `---` 分隔的多文档。 */
export function importTemplates(text, source = "manual") {
	const documents = String(text)
		.split(/^---\s*$/m)
		.map((d) => d.trim())
		.filter((d) => d.length > 20);
	if (documents.length === 0) throw new Error("没有可解析的模板（空内容或格式不对）");

	const list = pocs();
	let added = 0;
	let merged = 0;
	for (const document of documents) {
		let parsed;
		try {
			parsed = parseTemplate(document, "");
		} catch {
			continue;
		}
		if (!parsed.id || parsed.id === "unknown") continue;
		const hash = createHash("sha256").update(document).digest("hex").slice(0, 16);
		const existing = list.find((p) => p.id === parsed.id);
		if (existing) {
			// 同 id 覆盖：Nuclei 的约定就是 id 唯一
			Object.assign(existing, parsed, { hash, content: document.slice(0, 20000), source, addedAt: new Date().toISOString() });
			merged += 1;
			continue;
		}
		list.push({
			...parsed,
			hash,
			content: document.slice(0, 20000),
			source,
			addedAt: new Date().toISOString(),
		});
		added += 1;
	}
	store.save();
	store.log("info", `POC 导入：新增 ${added}，更新 ${merged}（来源 ${source}）`);
	return { ok: true, added, merged, total: documents.length };
}

/** 从订阅地址拉一批模板。 */
export async function importFromUrl(url) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 30000);
	try {
		const response = await fetch(url, { signal: controller.signal, headers: { "user-agent": "regedit-poc/1.0" } });
		if (!response.ok) throw new Error(`订阅返回 HTTP ${response.status}`);
		const text = await response.text();
		return importTemplates(text, `订阅 ${new URL(url).hostname}`);
	} finally {
		clearTimeout(timer);
	}
}

export function deletePoc(id) {
	const list = pocs();
	const index = list.findIndex((p) => p.id === id);
	if (index < 0) return false;
	list.splice(index, 1);
	store.save();
	return true;
}

export function clearPocs() {
	const count = pocs().length;
	store.state.pocs = [];
	store.save();
	return { ok: true, removed: count };
}

export function stats() {
	const list = pocs();
	const bySeverity = {};
	const tags = {};
	for (const poc of list) {
		bySeverity[poc.severity] = (bySeverity[poc.severity] ?? 0) + 1;
		for (const tag of poc.tags) tags[tag] = (tags[tag] ?? 0) + 1;
	}
	return {
		total: list.length,
		bySeverity,
		topTags: Object.entries(tags)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 20)
			.map(([tag, count]) => ({ tag, count })),
	};
}

/** 内置几条示例模板，让新装的控制台不是空库。 */
export function seedExamples() {
	const samples = [
		`id: git-config-exposure
info:
  name: Git 配置泄露
  author: regedit
  severity: high
  description: 站点根目录下的 .git/config 可匿名读取，可据此还原源码。
  tags: git,exposure,config
http:
  - method: GET
    path:
      - "{{BaseURL}}/.git/config"
    matchers:
      - type: word
        words:
          - "[core]"
          - "repositoryformatversion"`,
		`id: spring-actuator-env
info:
  name: Spring Actuator 环境变量暴露
  author: regedit
  severity: high
  description: actuator/env 端点未鉴权，泄露数据源凭据与配置。
  tags: spring,actuator,exposure
http:
  - method: GET
    path:
      - "{{BaseURL}}/actuator/env"
    matchers:
      - type: word
        words:
          - "propertySources"
          - "activeProfiles"`,
		`id: android-debuggable
info:
  name: Android 应用可调试
  author: regedit
  severity: high
  description: 清单中 android:debuggable="true"，任意调试工具可附加进程。
  tags: android,mobile,misconfig
file:
  - extensions:
      - all
    matchers:
      - type: word
        words:
          - "android:debuggable=\\"true\\""`,
	];
	for (const sample of samples) {
		try {
			importTemplates(sample, "内置示例");
		} catch {
			// 单条失败不影响其它
		}
	}
	return { ok: true };
}
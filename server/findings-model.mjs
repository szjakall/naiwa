/**
 * 漏洞模型：等级、CVSS、状态与时间线的唯一口径。
 *
 * 为什么单独抽一层：判定标准（等级 ↔ CVSS 的对应、什么算"还开着"）如果散在
 * 报告、界面、对话工具和数据写入四个地方，迟早会互相打架——报告写"高危"、
 * 页面按"未处理"统计、工具又按 `status !== "closed"` 过滤，三个数对不上。
 *
 * 这里的口径对齐原版（Full-Chain-Sentinel）：
 *   - 等级由 CVSS 基础分决定：>=9 严重 / >=7 高危 / >=4 中危 / >0 低危 / 0 信息；
 *   - 记录同时保留五级标签与分数，两者不一致时**显式标出来**，而不是悄悄信任其中一个；
 *   - 状态四态：待确认 / 已确认 / 误报 / 已修复（老数据的 open/closed 自动映射）。
 */

export const SEVERITIES = ["critical", "high", "medium", "low", "info"];

export const SEVERITY_LABELS = {
	critical: "严重",
	high: "高危",
	medium: "中危",
	low: "低危",
	info: "信息",
};

/** 状态词汇：新记录用这四个；open/closed 是 1.0/1.1 早期数据的写法，读的时候映射过来。 */
export const STATUSES = ["pending", "confirmed", "false-positive", "fixed"];

export const STATUS_LABELS = {
	pending: "待确认",
	confirmed: "已确认",
	"false-positive": "误报",
	fixed: "已修复",
	open: "待确认",
	closed: "已修复",
};

const LEGACY_STATUS = { open: "pending", closed: "fixed" };

export function normalizeStatus(status) {
	const value = String(status ?? "").trim();
	if (STATUSES.includes(value)) return value;
	if (LEGACY_STATUS[value]) return LEGACY_STATUS[value];
	return "pending";
}

/** "还开着"= 需要继续跟的：待确认与已确认。误报/已修复不算。 */
export function isOpen(finding) {
	const status = normalizeStatus(finding?.status);
	return status === "pending" || status === "confirmed";
}

/** CVSS 基础分 → 五级。分数缺失时返回 null（表示"未评分"，不是"信息"）。 */
export function severityForCvss(cvss) {
	const score = Number(cvss);
	if (!Number.isFinite(score) || score <= 0) return Number.isFinite(score) && score === 0 ? "info" : null;
	if (score >= 9) return "critical";
	if (score >= 7) return "high";
	if (score >= 4) return "medium";
	return "low";
}

/** 记录上的五级标签与它自己的分数不一致——报告和界面都要说出来。 */
export function isSeverityMismatch(severity, cvss) {
	const expected = severityForCvss(cvss);
	if (!expected) return false;
	return expected !== severity;
}

export function severityRank(severity) {
	const index = SEVERITIES.indexOf(String(severity ?? ""));
	return index < 0 ? SEVERITIES.length : index;
}

/** 未评分时给一个"这一档的参考分"，只用于展示，不写回记录。 */
export function suggestedCvss(severity) {
	return { critical: 9.5, high: 8.0, medium: 5.5, low: 3.0, info: 0 }[severity] ?? null;
}

/** 处理时间线：状态流转与操作员备注都进这里，报告末尾按时间还原。 */
export function appendTimeline(finding, entry) {
	if (!Array.isArray(finding.timeline)) finding.timeline = [];
	const last = finding.timeline[finding.timeline.length - 1];
	// 连续重复的一条不再重复记（界面上的"改状态"可能被连点两下）。
	if (last && last.text === entry.text && last.from === entry.from && last.to === entry.to) return finding.timeline;
	finding.timeline.push({
		at: new Date().toISOString(),
		author: entry.author ?? "operator",
		text: String(entry.text ?? "").slice(0, 2000),
		...(entry.from ? { from: entry.from } : {}),
		...(entry.to ? { to: entry.to } : {}),
	});
	return finding.timeline;
}

/** 报告/界面共用的"等级 + 分数"一行文字：未评分时说清楚是没评，不是 0 分。 */
export function ratingText(finding) {
	const label = SEVERITY_LABELS[finding.severity] ?? finding.severity ?? "未分级";
	const score = Number(finding.cvss);
	const scored = Number.isFinite(score) && score > 0 ? ` · CVSS ${score.toFixed(1)}` : " · CVSS 未评分";
	const vector = finding.cvssVector ? ` · ${finding.cvssVector}` : "";
	const mismatch =
		Number.isFinite(score) && score >= 0 && isSeverityMismatch(finding.severity, score)
			? ` · 注意：分数落在 ${SEVERITY_LABELS[severityForCvss(score)] ?? "?"} 档，与标签不一致`
			: "";
	return `${label}（${finding.severity ?? "-"}）${scored}${vector}${mismatch}`;
}

/** 漏洞编号：项目前缀 + 四位序号，例如 EXAMPLE-0007。 */
export function vulnLabel(prefix, number) {
	const slug = String(prefix ?? "")
		.trim()
		.toUpperCase()
		.replace(/[^A-Z0-9\u4e00-\u9fa5]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 16);
	return `${slug || "VULN"}-${String(number).padStart(4, "0")}`;
}

/**
 * 老数据迁移：1.0/1.1 的记录只有 title/severity/status("open"/"closed")，
 * 没有编号、CVSS、平台、时间线。启动时补齐，避免界面上一半字段是 undefined、
 * 报告里出现 "CVSS NaN" 这种脏东西。
 *
 * 只补不覆盖：已经有 label/时间线的记录原样保留。
 */
export function migrateFindings(state) {
	if (!Array.isArray(state.findings)) return false;
	let changed = false;
	const counters = new Map();
	for (const finding of state.findings) {
		const status = normalizeStatus(finding.status);
		if (finding.status !== status) {
			finding.status = status;
			changed = true;
		}
		if (!Array.isArray(finding.timeline)) {
			finding.timeline = [
				{
					at: finding.createdAt ?? new Date().toISOString(),
					author: "system",
					text: "历史记录（升级时迁移，无操作人信息）",
				},
			];
			changed = true;
		}
		if (!finding.label) {
			const task = (state.tasks ?? []).find((entry) => entry.id === finding.taskId);
			const prefix = labelPrefixFor(task);
			const next = (counters.get(prefix) ?? 0) + 1;
			counters.set(prefix, next);
			finding.label = vulnLabel(prefix, next);
			changed = true;
		}
		if (finding.cvss === undefined) {
			finding.cvss = null;
			changed = true;
		}
		if (finding.platform === undefined) {
			finding.platform = "web";
			changed = true;
		}
		if (!Array.isArray(finding.references)) {
			finding.references = [];
			changed = true;
		}
	}
	return changed;
}

/**
 * 编号前缀：优先用项目的主机名（example.com → EXAMPLE，127.0.0.1 → 127-0-0-1），
 * 其次包名末段，最后才是标题。
 *
 * 为什么不用任务标题：标题常是"对 example.com 做暴露面评估，并看看…"这种整句话，
 * 截出来会变成 "对-EXAMPLE-COM-0001"，发给客户很难看。
 */
export function labelPrefixFor(task) {
	if (!task) return "VULN";
	const first = (task.scope ?? [])[0];
	if (first) {
		try {
			const host = new URL(String(first).includes("://") ? String(first) : `https://${String(first)}`).hostname;
			// IPv4 用整串（127-0-0-1），域名用第一段（example.com → EXAMPLE）。
			if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host;
			const parts = host.split(".").filter(Boolean);
			if (parts.length >= 2) return parts[0] === "www" ? (parts[1] ?? parts[0]) : parts[0];
			if (host) return host;
		} catch {
			/* 落回包名/标题 */
		}
	}
	if (task.appPackage) return String(task.appPackage).split(".").pop() ?? "APP";
	return task.title || task.id || "VULN";
}
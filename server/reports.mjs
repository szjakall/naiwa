/**
 * 报告生成：把一次任务的资产与发现整理成 Markdown，落盘到 data/artifacts/reports。
 *
 * 走 Markdown 而不是 docx：零依赖、能被任意工具二次加工、直接进 Git 走评审。
 * 需要正式排版时，用下载下来的 md 再套 Word 模板，比在这里实现 OOXML 实在。
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ARTIFACT_DIR, readSettings } from "./config.mjs";
import { isOpen, isSeverityMismatch, normalizeStatus, severityForCvss, STATUS_LABELS } from "./findings-model.mjs";
import { store } from "./store.mjs";

const SEVERITY_ORDER = ["critical", "high", "medium", "low", "info"];
const SEVERITY_LABEL = {
	critical: "严重",
	high: "高危",
	medium: "中危",
	low: "低危",
	info: "信息",
};

function pad(value) {
	return String(value).padStart(2, "0");
}

function stamp(date = new Date()) {
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function escapeCell(value) {
	return String(value ?? "").replaceAll("|", "\\|").replace(/\r?\n/g, " ");
}

/** 代码围栏：围栏长度比正文里最长的连续反引号多一个，避免正文把围栏提前闭合。 */
function fenced(body, language = "") {
	const text = String(body ?? "");
	const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
	const fence = "`".repeat(Math.max(3, longest + 1));
	return `${fence}${language}\n${text.replace(/\s+$/, "")}\n${fence}`;
}

export function buildMarkdown({ title, task, findings, assets, traffic }) {
	const settings = readSettings();
	const counts = findings.reduce((acc, finding) => {
		acc[finding.severity] = (acc[finding.severity] ?? 0) + 1;
		return acc;
	}, {});
	const lines = [];
	lines.push(`# ${title}`);
	lines.push("");
	lines.push(`> 由 ${settings.site?.name ?? "regedit"} 生成 · ${stamp()} · 仅供参考，结论需人工复核`);
	lines.push("");
	lines.push("## 1. 评估范围");
	lines.push("");
	if (task) {
		lines.push(`- 任务：${task.title}（${task.id}）`);
		lines.push(`- 状态：${task.status}　开始：${task.startedAt ?? "-"}　结束：${task.finishedAt ?? "-"}`);
		lines.push(`- 目标：${(task.scope ?? []).join("、") || "-"}`);
	} else {
		lines.push("- 范围：全部未关闭发现");
	}
	lines.push(`- 操作员：${settings.site?.operator || settings.site?.name || "regedit"}`);
	lines.push("");

	lines.push("## 2. 结果概览");
	lines.push("");
	lines.push("| 等级 | 数量 |");
	lines.push("| --- | --- |");
	for (const severity of SEVERITY_ORDER) {
		lines.push(`| ${SEVERITY_LABEL[severity]}（${severity}） | ${counts[severity] ?? 0} |`);
	}
	lines.push(`| 合计 | ${findings.length} |`);
	lines.push("");
	// 分数与标签的可信度：报告读者必须先知道有多少条没评分、有多少条自相矛盾。
	const unscored = findings.filter((finding) => !(Number(finding.cvss) > 0)).length;
	const mismatched = findings.filter(
		(finding) => Number(finding.cvss) > 0 && isSeverityMismatch(finding.severity, Number(finding.cvss)),
	).length;
	const qualifiers = [
		...(unscored ? [`未评分 ${unscored} 条`] : []),
		...(mismatched ? [`等级与 CVSS 不一致 ${mismatched} 条`] : []),
	];
	if (qualifiers.length) {
		lines.push(`- 其中：${qualifiers.join("，")}`);
		lines.push("");
	}

	lines.push("## 3. 资产清单");
	lines.push("");
	if (assets.length === 0) {
		lines.push("_无_");
	} else {
		lines.push("| 类型 | 标识 | IP | 标题 | 技术栈 | 首次发现 |");
		lines.push("| --- | --- | --- | --- | --- | --- |");
		for (const asset of assets) {
			lines.push(
				`| ${asset.type} | ${escapeCell(asset.value)} | ${escapeCell(asset.ip || "-")} | ${escapeCell(asset.title || "-")} | ${escapeCell((asset.tech ?? []).join(" / ") || "-")} | ${asset.firstSeen?.slice(0, 10) ?? "-"} |`,
			);
		}
	}
	lines.push("");

	lines.push("## 4. 发现详情");
	lines.push("");
	if (findings.length === 0) {
		lines.push("_本次未产生发现_");
	} else {
		const sorted = [...findings].sort(
			(a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
		);
		sorted.forEach((finding, index) => {
			const label = finding.label ? ` ${finding.label}` : "";
			lines.push(`### 4.${index + 1} [${SEVERITY_LABEL[finding.severity] ?? finding.severity}]${label} ${finding.title}`);
			lines.push("");
			// 等级 / 分数 / 状态一行说清；分数没评就写"未评分"，不假装是 0 分。
			const score = Number(finding.cvss);
			const scored = Number.isFinite(score) && score > 0 ? `CVSS ${score.toFixed(1)}` : "CVSS 未评分";
			const vector = finding.cvssVector ? ` · ${finding.cvssVector}` : "";
			lines.push(`- 等级：${SEVERITY_LABEL[finding.severity] ?? finding.severity}（${finding.severity}）· ${scored}${vector}`);
			lines.push(`- 状态：${STATUS_LABELS[normalizeStatus(finding.status)] ?? finding.status}`);
			lines.push(`- 目标：${finding.target}`);
			if (finding.category) lines.push(`- 类型：${finding.category}`);
			if ((finding.platform ?? "web") === "android") {
				lines.push(
					`- 平台：安卓（App）${finding.appPackage ? ` · 包名 \`${finding.appPackage}\`` : ""}${finding.appVersion ? ` · 版本 ${finding.appVersion}` : ""}`,
				);
			}
			lines.push(`- 来源：${finding.source === "apk" ? "APK 静态分析" : finding.source === "agent" ? "对话 Agent" : "远程评估"}`);
			if (finding.conversationId) lines.push(`- 会话：${finding.conversationId}`);
			if (finding.assetId) lines.push(`- 关联资产：${finding.assetId}`);
			if (finding.createdAt) lines.push(`- 提交时间：${finding.createdAt}`);
			if (finding.lastSeen) lines.push(`- 最近更新：${finding.lastSeen}`);
			if (Number.isFinite(score) && score > 0 && isSeverityMismatch(finding.severity, score)) {
				const expected = SEVERITY_LABEL[severityForCvss(score)] ?? "?";
				lines.push(`- 注意：等级与 CVSS 不一致（${score.toFixed(1)} 对应 ${expected} 档）`);
			}
			lines.push("");
			if (finding.summary) {
				lines.push("**漏洞详情**");
				lines.push("");
				lines.push(String(finding.summary).trim());
				lines.push("");
			}
			// 原始数据包：请求与响应分开贴，缺一段就明确写"未记录"，不糊过去。
			if (finding.requestPkt || finding.responsePkt) {
				lines.push("**原始数据包**");
				lines.push("");
				if (finding.requestPkt) {
					lines.push("请求：");
					lines.push("");
					lines.push(fenced(String(finding.requestPkt), "http"));
					lines.push("");
				}
				if (finding.responsePkt) {
					lines.push("响应：");
					lines.push("");
					lines.push(fenced(String(finding.responsePkt), "http"));
					lines.push("");
				}
			} else if (finding.evidence) {
				// 老记录没有分包字段时退回证据原文，报告不会因此空一节。
				lines.push("**原始数据包**");
				lines.push("");
				lines.push(fenced(String(finding.evidence).slice(0, 4000), "http"));
				lines.push("");
			}
			if (finding.repro) {
				lines.push("**复现步骤**");
				lines.push("");
				lines.push(String(finding.repro).trim());
				lines.push("");
			}
			if (finding.evidence && finding.requestPkt) {
				lines.push("**证据**");
				lines.push("");
				lines.push(fenced(String(finding.evidence).slice(0, 4000)));
				lines.push("");
			}
			if (finding.recommendation) {
				lines.push("**修复建议**");
				lines.push("");
				lines.push(String(finding.recommendation).trim());
				lines.push("");
			}
			if (Array.isArray(finding.references) && finding.references.length) {
				lines.push("**参考**");
				lines.push("");
				for (const item of finding.references) lines.push(`- ${item}`);
				lines.push("");
			}
			if (Array.isArray(finding.timeline) && finding.timeline.length) {
				lines.push("**处理时间线**");
				lines.push("");
				for (const note of finding.timeline) {
					const who = note.author === "operator" ? "操作员" : note.author === "agent" ? "代理" : "系统";
					const move = note.from && note.to ? `（${note.from} → ${note.to}）` : "";
					lines.push(`- ${note.at?.slice(0, 19).replace("T", " ") ?? "-"} · ${who}：${note.text}${move}`);
				}
				lines.push("");
			}
		});
	}

	if (traffic && traffic.length) {
		lines.push("## 5. 请求流水（节选）");
		lines.push("");
		lines.push("| 时间 | 方法 | 地址 | 状态 | 耗时(ms) |");
		lines.push("| --- | --- | --- | --- | --- |");
		for (const item of traffic.slice(0, 80)) {
			lines.push(
				`| ${item.at?.slice(11, 19) ?? "-"} | ${item.method} | ${escapeCell(item.url)} | ${item.status} | ${item.ms ?? "-"} |`,
			);
		}
		lines.push("");
	}

	lines.push("---");
	lines.push("");
	lines.push("本报告由 regedit 自动汇总，仅覆盖在授权范围内主动观察到的现象；未发现的项不等于不存在。");
	return lines.join("\n");
}

/**
 * 生成报告。三种取材方式，按优先级：
 *   1. findingIds —— 操作员在页面上勾选的漏洞（最常用：只想把高危写进报告）
 *   2. taskId     —— 某个任务下的全部漏洞
 *   3. 都不给     —— 全部未关闭的漏洞
 * 资产按"这些漏洞所属的资产"取，没挂资产的漏洞不会把整库资产拖进来。
 */
export function generateReport({ taskId, title, findingIds }) {
	const task = taskId ? store.state.tasks.find((entry) => entry.id === taskId) : null;
	const picked = Array.isArray(findingIds) ? findingIds.filter(Boolean) : [];

	let findings;
	if (picked.length > 0) {
		const wanted = new Set(picked);
		// 勾选优先：即便同时传了 taskId，也只写勾中的那几条，避免"以为只写了高危，
		// 结果把整个任务的所有漏洞都写进去"。
		findings = store.state.findings.filter((finding) => wanted.has(finding.id));
	} else {
		findings = store.state.findings.filter((finding) =>
			taskId ? finding.taskId === taskId : isOpen(finding),
		);
	}

	const assetIds = new Set(findings.map((finding) => finding.assetId).filter(Boolean));
	let assets;
	if (picked.length > 0) {
		assets = store.state.assets.filter((asset) => assetIds.has(asset.id));
	} else {
		assets = store.state.assets.filter((asset) =>
			taskId ? asset.taskId === taskId || assetIds.has(asset.id) : true,
		);
	}
	// 勾选模式下没有任务，就不要把"某个任务"的流水硬塞进来
	const traffic = !picked.length && taskId ? store.state.traffic.filter((item) => item.taskId === taskId) : [];
	const reportTitle =
		String(title || "").trim() ||
		(task ? `${task.title} 评估报告` : picked.length ? `选定漏洞评估报告 ${stamp()}` : `评估报告 ${stamp()}`);

	const markdown = buildMarkdown({ title: reportTitle, task, findings, assets, traffic });
	const id = store.nextId("rp");
	const file = join(ARTIFACT_DIR, "reports", `${id}.md`);
	writeFileSync(file, markdown, "utf8");

	const report = {
		id,
		title: reportTitle,
		taskId: task?.id ?? null,
		// 记下取材方式，报告列表里能看出"这份是按勾选生成的"
		mode: picked.length ? "selected" : taskId ? "task" : "open",
		findingIds: picked.length ? picked : undefined,
		findings: findings.length,
		assets: assets.length,
		file,
		size: Buffer.byteLength(markdown),
		createdAt: new Date().toISOString(),
	};
	store.state.reports.unshift(report);
	store.save();
	store.log("info", `生成报告：${reportTitle}（${id}，${findings.length} 条发现）`);
	return { ok: true, report };
}
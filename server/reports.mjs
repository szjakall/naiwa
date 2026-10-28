/**
 * 报告生成：把一次任务的资产与发现整理成 Markdown，落盘到 data/artifacts/reports。
 *
 * 走 Markdown 而不是 docx：零依赖、能被任意工具二次加工、直接进 Git 走评审。
 * 需要正式排版时，用下载下来的 md 再套 Word 模板，比在这里实现 OOXML 实在。
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ARTIFACT_DIR, readSettings } from "./config.mjs";
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
			lines.push(`### 4.${index + 1} [${SEVERITY_LABEL[finding.severity] ?? finding.severity}] ${finding.title}`);
			lines.push("");
			lines.push(`- 位置：${finding.target}`);
			lines.push(`- 来源：${finding.source === "apk" ? "APK 静态分析" : "远程评估"}　状态：${finding.status}`);
			if (finding.summary) lines.push(`- 摘要：${finding.summary}`);
			lines.push("");
			if (finding.evidence) {
				lines.push("**证据**");
				lines.push("");
				lines.push("```text");
				lines.push(String(finding.evidence).slice(0, 4000));
				lines.push("```");
				lines.push("");
			}
			if (finding.recommendation) {
				lines.push(`**修复建议**：${finding.recommendation}`);
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

export function generateReport({ taskId, title }) {
	const task = taskId ? store.state.tasks.find((entry) => entry.id === taskId) : null;
	const findings = store.state.findings.filter((finding) =>
		taskId ? finding.taskId === taskId : finding.status !== "closed",
	);
	const assetIds = new Set(findings.map((finding) => finding.assetId).filter(Boolean));
	const assets = store.state.assets.filter((asset) =>
		taskId ? asset.taskId === taskId || assetIds.has(asset.id) : true,
	);
	const traffic = store.state.traffic.filter((item) => (taskId ? item.taskId === taskId : false));
	const reportTitle = String(title || "").trim() || (task ? `${task.title} 评估报告` : `评估报告 ${stamp()}`);

	const markdown = buildMarkdown({ title: reportTitle, task, findings, assets, traffic });
	const id = store.nextId("rp");
	const file = join(ARTIFACT_DIR, "reports", `${id}.md`);
	writeFileSync(file, markdown, "utf8");

	const report = {
		id,
		title: reportTitle,
		taskId: task?.id ?? null,
		findings: findings.length,
		assets: assets.length,
		file,
		size: Buffer.byteLength(markdown),
		createdAt: new Date().toISOString(),
	};
	store.state.reports.unshift(report);
	store.save();
	store.log("info", `生成报告：${reportTitle}（${id}）`);
	return { ok: true, report };
}
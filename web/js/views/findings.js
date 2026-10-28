/**
 * 漏洞：任务命中与 APK 静态分析的结论都汇到这里。
 * 列表按等级排序，点开看证据原文——报告里的每一段都取自这里的字段。
 */

import { icon } from "../icons.js";
import {
	api,
	confirmDialog,
	html,
	mount,
	openOverlay,
	raw,
	relTime,
	renderMarkdown,
	severityChip,
	SEVERITIES,
	statusChip,
	toast,
	toNode,
} from "../core.js";
import { card, emptyState, inlineError, loading, severityBar } from "../ui.js";

const SEVERITY_FILTERS = [
	{ id: "all", label: "全部等级" },
	{ id: "critical", label: "严重" },
	{ id: "high", label: "高危" },
	{ id: "medium", label: "中危" },
	{ id: "low", label: "低危" },
	{ id: "info", label: "信息" },
];

export default {
	title: "漏洞",
	subtitle: "远程评估与 APK 静态分析的验证结论",

	async render(root, ctx) {
		mount(root, loading());
		let findings = [];
		try {
			findings = await api.get("/api/findings");
		} catch (error) {
			mount(root, inlineError(error.message));
			return;
		}

		const actions = toNode(html`<button class="btn ghost small" id="export">导出 Markdown</button>`);
		ctx.setHeader("漏洞", `未关闭 ${findings.filter((item) => item.status === "open").length} 条`, actions);

		let severity = "all";
		let status = "open";
		let keyword = "";

		actions.querySelector("#export").addEventListener("click", () => {
			const rows = findings.filter((item) => item.status === "open");
			const lines = ["# 漏洞清单", "", `导出时间：${new Date().toLocaleString("zh-CN")}`, ""];
			for (const finding of rows) {
				lines.push(`## [${SEVERITIES[finding.severity]?.label ?? finding.severity}] ${finding.title}`);
				lines.push("");
				lines.push(`- 位置：${finding.target}`);
				lines.push(`- 来源：${finding.source === "apk" ? "APK 静态分析" : "远程评估"}`);
				lines.push(`- 摘要：${finding.summary}`);
				lines.push("");
				if (finding.evidence) {
					lines.push("```text");
					lines.push(finding.evidence);
					lines.push("```");
					lines.push("");
				}
				if (finding.recommendation) lines.push(`建议：${finding.recommendation}`, "");
			}
			const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
			const url = URL.createObjectURL(blob);
			const link = document.createElement("a");
			link.href = url;
			link.download = `regedit-findings-${Date.now()}.md`;
			link.click();
			setTimeout(() => URL.revokeObjectURL(url), 2000);
			toast("已导出未关闭的发现", "success");
		});

		const openDetail = (finding) => {
			const overlay = openOverlay(
				html`
					<div class="overlay-head">
						${severityChip(finding.severity)}
						<h3 style="margin:0">${finding.title}</h3>
						<div class="spacer"></div>
						<button class="btn-icon" data-close>${raw(icon("x", { size: 16 }))}</button>
					</div>
					<div class="overlay-body">
						<dl class="kv">
							<dt>位置</dt><dd>${finding.target}</dd>
							<dt>来源</dt><dd>${finding.source === "apk" ? "APK 静态分析" : "远程评估"}</dd>
							<dt>状态</dt><dd>${statusChip(finding.status)}</dd>
							<dt>首次发现</dt><dd>${relTime(finding.createdAt)}（累计 ${finding.occurrences ?? 1} 次）</dd>
						</dl>
						<div class="apk-section">
							<h4>摘要</h4>
							<p class="dim small" style="margin:0">${finding.summary}</p>
						</div>
						${finding.evidence
							? html`<div class="apk-section">
									<h4>证据</h4>
									<pre class="md-code" style="max-height:280px;overflow:auto;padding:12px;border-radius:9px;background:#070b10;border:1px solid var(--line-soft);white-space:pre-wrap">${finding.evidence}</pre>
								</div>`
							: ""}
						${finding.recommendation
							? html`<div class="apk-section">
									<h4>修复建议</h4>
									<div class="md">${raw(renderMarkdown(finding.recommendation))}</div>
								</div>`
							: ""}
					</div>
					<div class="overlay-foot">
						<button class="btn danger small" data-del>删除</button>
						<div class="spacer"></div>
						<button class="btn ghost" data-close>关闭</button>
						${finding.status === "open"
							? html`<button class="btn primary" data-close-status>标记已处理</button>`
							: html`<button class="btn ghost" data-reopen>重新打开</button>`}
					</div>
				`,
				{ wide: true },
			);

			overlay.panel.querySelector("[data-close-status]")?.addEventListener("click", async () => {
				await api.patch(`/api/findings/${finding.id}`, { status: "closed" });
				overlay.close();
				ctx.reload();
			});
			overlay.panel.querySelector("[data-reopen]")?.addEventListener("click", async () => {
				await api.patch(`/api/findings/${finding.id}`, { status: "open" });
				overlay.close();
				ctx.reload();
			});
			overlay.panel.querySelector("[data-del]").addEventListener("click", async () => {
				const ok = await confirmDialog({
					title: "删除发现",
					message: "证据会一并删除，已生成的报告不受影响。",
					confirmText: "删除",
					danger: true,
				});
				if (!ok) return;
				await api.del(`/api/findings/${finding.id}`);
				overlay.close();
				ctx.reload();
			});
		};

		const paint = () => {
			const visible = findings
				.filter((finding) => (severity === "all" ? true : finding.severity === severity))
				.filter((finding) => (status === "all" ? true : finding.status === status))
				.filter((finding) => {
					if (!keyword) return true;
					return `${finding.title} ${finding.target} ${finding.summary}`.toLowerCase().includes(keyword.toLowerCase());
				})
				.sort((a, b) => (SEVERITIES[a.severity]?.order ?? 9) - (SEVERITIES[b.severity]?.order ?? 9));

			const counts = findings.reduce((acc, finding) => {
				if (finding.status === "open") acc[finding.severity] = (acc[finding.severity] ?? 0) + 1;
				return acc;
			}, {});

			const body = visible.length
				? html`<div class="table-wrap">
						<table>
							<thead>
								<tr>
									<th class="nowrap">等级</th>
									<th>发现</th>
									<th class="nowrap">来源</th>
									<th class="nowrap">状态</th>
									<th class="nowrap">时间</th>
								</tr>
							</thead>
							<tbody>
								${visible.map(
									(finding) => html`<tr data-id="${finding.id}" style="cursor:pointer">
										<td>${severityChip(finding.severity)}</td>
										<td>
											<div class="dim">${finding.title}</div>
											<div class="tiny muted break">${finding.target}</div>
										</td>
										<td class="nowrap tiny ${finding.source === "apk" ? "mono" : ""}">
											${finding.source === "apk" ? "APK" : "远程"}
										</td>
										<td>${statusChip(finding.status)}</td>
										<td class="nowrap tiny muted">${relTime(finding.createdAt)}</td>
									</tr>`,
								)}
							</tbody>
						</table>
					</div>`
				: emptyState({
						iconName: "shield",
						title: "没有符合条件的发现",
						description: "发现来自两处：任务引擎的远程判定，以及「安卓设备 → APK 分析」的静态结论。",
					});

			mount(
				root,
				html`
					<div class="page-section row">
						<div class="tabs">
							${SEVERITY_FILTERS.map(
								(item) =>
									html`<button class="tab ${item.id === severity ? "active" : ""}" data-sev="${item.id}">${item.label}</button>`,
							)}
						</div>
						<div class="spacer"></div>
						<select id="status" style="max-width:140px">
							<option value="open" selected="${status === "open"}">未处理</option>
							<option value="closed" selected="${status === "closed"}">已处理</option>
							<option value="all" selected="${status === "all"}">全部状态</option>
						</select>
						<input id="search" placeholder="搜索标题 / 目标" style="max-width:240px" value="${keyword}" />
					</div>
					${card({ body: html`<div class="mb-12">${severityBar(counts)}</div>${body}`, tight: true })}
				`,
			);

			root.querySelectorAll("[data-sev]").forEach((node) =>
				node.addEventListener("click", () => {
					severity = node.dataset.sev;
					paint();
				}),
			);
			const select = root.querySelector("#status");
			select.value = status;
			select.addEventListener("change", () => {
				status = select.value;
				paint();
			});
			const search = root.querySelector("#search");
			search.addEventListener("input", () => {
				keyword = search.value.trim();
				const position = search.selectionStart;
				paint();
				const next = root.querySelector("#search");
				next.focus();
				next.setSelectionRange(position, position);
			});
			root.querySelectorAll("[data-id]").forEach((node) =>
				node.addEventListener("click", () => {
					const finding = findings.find((entry) => entry.id === node.dataset.id);
					if (finding) openDetail(finding);
				}),
			);
		};
		paint();
	},
};
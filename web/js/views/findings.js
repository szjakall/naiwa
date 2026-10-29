/**
 * 漏洞：远程判定、对话 Agent 与 APK 静态分析的结论都汇到这里。
 *
 * 口径对齐原版：一条记录要有**编号、等级 + CVSS、状态、目标、类型、平台、来源、
 * 漏洞详情、原始请求/响应包、复现步骤、证据、修复建议、参考、处理时间线**。
 * 缺哪一项，报告里就会少一节——所以界面把每一项都摆出来，也允许运营者补。
 */

import { icon } from "../icons.js";
import {
	api,
	confirmDialog,
	copyText,
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

const STATUS_LABEL = {
	pending: "待确认",
	confirmed: "已确认",
	"false-positive": "误报",
	fixed: "已修复",
	open: "待确认",
	closed: "已修复",
};

const STATUS_TONE = {
	pending: "warn",
	confirmed: "info",
	"false-positive": "muted",
	fixed: "ok",
};

const PLATFORM_LABEL = { web: "Web", android: "安卓" };

function norm(status) {
	const value = String(status ?? "");
	if (value === "open") return "pending";
	if (value === "closed") return "fixed";
	return STATUS_LABEL[value] ? value : "pending";
}

function isOpen(finding) {
	const status = norm(finding.status);
	return status === "pending" || status === "confirmed";
}

function statusTag(finding) {
	const status = norm(finding.status);
	return html`<span class="chip chip-${STATUS_TONE[status] ?? "muted"}">${STATUS_LABEL[status]}</span>`;
}

/** 等级 + 分数：未评分就说未评分；分数与标签打架时明说。 */
function rating(finding) {
	const score = Number(finding.cvss);
	const hasScore = Number.isFinite(score) && score > 0;
	const expected = !hasScore ? null : score >= 9 ? "critical" : score >= 7 ? "high" : score >= 4 ? "medium" : "low";
	const mismatch = expected && expected !== finding.severity;
	return html`${severityChip(finding.severity)}
		<span class="tiny muted mono">${hasScore ? `CVSS ${score.toFixed(1)}` : "CVSS 未评分"}</span>
		${mismatch ? html`<span class="chip chip-warn" title="等级与分数不一致">分数落在 ${SEVERITIES[expected]?.label ?? expected} 档</span>` : ""}`;
}

/** 报文块：带"复制"按钮；没有记录时给一句明确的缺失说明，而不是空白。 */
function packetBlock(label, text) {
	if (!text) {
		return html`<div class="apk-section">
			<h4>${label}</h4>
			<div class="tiny muted">未记录（远程判定会自动带；对话提交需要在 record_finding 里填 ${label === "请求包" ? "requestPkt" : "responsePkt"}）。</div>
		</div>`;
	}
	return html`<div class="apk-section">
		<div class="row" style="align-items:center;gap:8px">
			<h4 style="margin:0">${label}</h4>
			<span class="spacer"></span>
			<button class="btn ghost small" data-copy="${label}">复制</button>
		</div>
		<pre class="md-code" data-packet="${label}" style="max-height:260px;overflow:auto;padding:12px;border-radius:9px;background:#070b10;border:1px solid var(--line-soft);white-space:pre-wrap">${text}</pre>
	</div>`;
}

export default {
	title: "漏洞",
	subtitle: "远程评估、对话 Agent 与 APK 静态分析的验证结论（含复现材料）",

	async render(root, ctx) {
		mount(root, loading());
		let findings = [];
		try {
			findings = await api.get("/api/findings");
		} catch (error) {
			mount(root, inlineError(error.message));
			return;
		}
		// `#/findings?taskId=tk6`：从项目页点"看漏洞"进来只看这个项目的。
		const taskFilter = ctx.query?.get("taskId") ?? "";
		if (taskFilter) findings = findings.filter((finding) => finding.taskId === taskFilter);

		const actions = toNode(html`<button class="btn ghost small" id="export">导出 Markdown</button>`);
		const openCount = findings.filter((item) => isOpen(item)).length;
		ctx.setHeader("漏洞", `未关闭 ${openCount} 条`, actions);

		let severity = "all";
		let status = "open";
		let platform = "all";
		let keyword = "";

		const exportRows = () => {
			const rows = findings.filter((item) => isOpen(item));
			const lines = ["# 漏洞清单", "", `导出时间：${new Date().toLocaleString("zh-CN")}`, "", `共 ${rows.length} 条`, ""];
			for (const finding of rows) {
				const score = Number(finding.cvss);
				const scored = Number.isFinite(score) && score > 0 ? `CVSS ${score.toFixed(1)}` : "CVSS 未评分";
				lines.push(`## [${SEVERITIES[finding.severity]?.label ?? finding.severity}] ${finding.label ? `${finding.label} ` : ""}${finding.title}`);
				lines.push("");
				lines.push(`- 等级：${SEVERITIES[finding.severity]?.label ?? finding.severity}（${finding.severity}）· ${scored}${finding.cvssVector ? ` · ${finding.cvssVector}` : ""}`);
				lines.push(`- 状态：${STATUS_LABEL[norm(finding.status)]}`);
				lines.push(`- 目标：${finding.target}`);
				if (finding.category) lines.push(`- 类型：${finding.category}`);
				if ((finding.platform ?? "web") === "android") {
					lines.push(`- 平台：安卓${finding.appPackage ? ` · 包名 ${finding.appPackage}` : ""}${finding.appVersion ? ` · 版本 ${finding.appVersion}` : ""}`);
				}
				lines.push(`- 来源：${finding.source === "apk" ? "APK 静态分析" : finding.source === "agent" ? "对话 Agent" : "远程评估"}`);
				lines.push("");
				if (finding.summary) lines.push("**漏洞详情**", "", finding.summary, "");
				if (finding.requestPkt) lines.push("**请求包**", "", "```http", finding.requestPkt, "```", "");
				if (finding.responsePkt) lines.push("**响应包**", "", "```http", finding.responsePkt, "```", "");
				if (finding.repro) lines.push("**复现步骤**", "", finding.repro, "");
				if (finding.evidence) lines.push("**证据**", "", "```text", finding.evidence, "```", "");
				if (finding.recommendation) lines.push("**修复建议**", "", finding.recommendation, "");
				if (Array.isArray(finding.references) && finding.references.length) {
					lines.push("**参考**", "", ...finding.references.map((item) => `- ${item}`), "");
				}
			}
			const blob = new Blob([`${lines.join("\n")}\n`], { type: "text/markdown;charset=utf-8" });
			const url = URL.createObjectURL(blob);
			const link = document.createElement("a");
			link.href = url;
			link.download = `regedit-findings-${Date.now()}.md`;
			link.click();
			setTimeout(() => URL.revokeObjectURL(url), 2000);
			toast(`已导出 ${rows.length} 条未关闭漏洞`, "success");
		};
		actions.querySelector("#export").addEventListener("click", exportRows);

		const changeStatus = async (finding, next, note) => {
			try {
				await api.patch(`/api/findings/${finding.id}`, { status: next, ...(note ? { note } : {}) });
				toast(`已标记为${STATUS_LABEL[next]}`, "success");
				ctx.reload();
			} catch (error) {
				toast(error.message, "error");
			}
		};

		const openDetail = (finding) => {
			const timeline = Array.isArray(finding.timeline) ? finding.timeline : [];
			const overlay = openOverlay(
				html`
					<div class="overlay-head">
						${severityChip(finding.severity)}
						<h3 style="margin:0">${finding.title}</h3>
						${finding.label ? html`<span class="chip chip-muted mono">${finding.label}</span>` : ""}
						<div class="spacer"></div>
						<button class="btn-icon" data-close>${raw(icon("x", { size: 16 }))}</button>
					</div>
					<div class="overlay-body">
						<dl class="kv">
							<dt>等级</dt><dd>${rating(finding)}</dd>
							<dt>状态</dt><dd>${statusTag(finding)}</dd>
							<dt>目标</dt><dd class="break">${finding.target}</dd>
							<dt>类型</dt><dd>${finding.category || "—"}</dd>
							<dt>平台</dt>
							<dd>
								${PLATFORM_LABEL[finding.platform ?? "web"] ?? finding.platform}
								${(finding.platform ?? "web") === "android" && finding.appPackage ? html` · <span class="mono">${finding.appPackage}</span>` : ""}
								${finding.appVersion ? html` · v${finding.appVersion}` : ""}
							</dd>
							<dt>来源</dt>
							<dd>${finding.source === "apk" ? "APK 静态分析" : finding.source === "agent" ? "对话 Agent" : "远程评估"}</dd>
							${finding.taskId ? html`<dt>项目</dt><dd><a class="link" href="#/tasks/${finding.taskId}">${finding.taskId}</a></dd>` : ""}
							${finding.conversationId ? html`<dt>会话</dt><dd><a class="link" href="#/chat/${finding.conversationId}">${finding.conversationId}</a></dd>` : ""}
							<dt>时间</dt><dd class="tiny">首次 ${relTime(finding.createdAt)} · 最近 ${relTime(finding.lastSeen)}（累计 ${finding.occurrences ?? 1} 次）</dd>
						</dl>

						${finding.summary
							? html`<div class="apk-section"><h4>漏洞详情</h4><p class="dim small" style="margin:0;white-space:pre-wrap">${finding.summary}</p></div>`
							: ""}
						${packetBlock("请求包", finding.requestPkt)}
						${packetBlock("响应包", finding.responsePkt)}
						${finding.repro
							? html`<div class="apk-section"><h4>复现步骤</h4>
									<pre class="md-code" style="max-height:220px;overflow:auto;padding:12px;border-radius:9px;background:#070b10;border:1px solid var(--line-soft);white-space:pre-wrap">${finding.repro}</pre>
								</div>`
							: html`<div class="apk-section"><h4>复现步骤</h4><div class="tiny muted">未填写。报告的「复现步骤」一节会缺失。</div></div>`}
						${finding.evidence
							? html`<div class="apk-section"><h4>证据</h4>
									<pre class="md-code" style="max-height:240px;overflow:auto;padding:12px;border-radius:9px;background:#070b10;border:1px solid var(--line-soft);white-space:pre-wrap">${finding.evidence}</pre>
								</div>`
							: ""}
						${finding.recommendation
							? html`<div class="apk-section"><h4>修复建议</h4><div class="md">${raw(renderMarkdown(finding.recommendation))}</div></div>`
							: ""}
						${Array.isArray(finding.references) && finding.references.length
							? html`<div class="apk-section"><h4>参考</h4>
									<ul class="small" style="margin:0;padding-left:18px">
										${finding.references.map((item) => html`<li class="break">${item}</li>`)}
									</ul>
								</div>`
							: ""}
						${timeline.length
							? html`<div class="apk-section"><h4>处理时间线</h4>
									<div class="small muted">
										${timeline.map(
											(note) => html`<div class="tiny">
												${String(note.at ?? "").slice(0, 19).replace("T", " ")} ·
												${note.author === "operator" ? "操作员" : note.author === "agent" ? "代理" : "系统"}
												：${note.text}${note.from && note.to ? `（${STATUS_LABEL[note.from] ?? note.from} → ${STATUS_LABEL[note.to] ?? note.to}）` : ""}
											</div>`,
										)}
									</div>
								</div>`
							: ""}

						<div class="apk-section">
							<h4>评分与备注</h4>
							<div class="row" style="gap:8px;flex-wrap:wrap;align-items:flex-end">
								<label class="field" style="margin:0;max-width:150px">
									<span>等级</span>
									<select id="edit-severity">
										${Object.entries(SEVERITIES).map(
											([id, meta]) => html`<option value="${id}" ${finding.severity === id ? "selected" : ""}>${meta.label}</option>`,
										)}
									</select>
								</label>
								<label class="field" style="margin:0;max-width:120px">
									<span>CVSS（0-10）</span>
									<input id="edit-cvss" type="number" min="0" max="10" step="0.1" value="${Number(finding.cvss) > 0 ? Number(finding.cvss) : ""}" placeholder="未评分" />
								</label>
								<label class="field" style="margin:0;flex:1;min-width:200px">
									<span>备注（会进时间线）</span>
									<input id="edit-note" placeholder="例如：复测仍存在 / 业务方已确认" />
								</label>
								<button class="btn ghost small" data-save-rating>保存</button>
							</div>
						</div>
					</div>
					<div class="overlay-foot">
						<button class="btn danger small" data-del>删除</button>
						<div class="spacer"></div>
						${norm(finding.status) !== "confirmed" ? html`<button class="btn ghost" data-status="confirmed">标记已确认</button>` : ""}
						${norm(finding.status) !== "false-positive" ? html`<button class="btn ghost" data-status="false-positive">标记误报</button>` : ""}
						${norm(finding.status) !== "fixed" ? html`<button class="btn primary" data-status="fixed">标记已修复</button>` : ""}
						${!isOpen(finding) ? html`<button class="btn ghost" data-status="pending">重新打开</button>` : ""}
						<button class="btn ghost" data-close>关闭</button>
					</div>
				`,
				{ wide: true },
			);

			// 报文复制：单独处理，避免和"复制整段证据"混淆。
			overlay.panel.querySelectorAll("[data-copy]").forEach((button) =>
				button.addEventListener("click", () => {
					const label = button.dataset.copy;
					const text = label === "请求包" ? finding.requestPkt : finding.responsePkt;
					copyText(text ?? "");
				}),
			);

			overlay.panel.querySelectorAll("[data-status]").forEach((button) =>
				button.addEventListener("click", async () => {
					await changeStatus(finding, button.dataset.status);
					overlay.close();
				}),
			);

			overlay.panel.querySelector("[data-save-rating]").addEventListener("click", async () => {
				const nextSeverity = overlay.panel.querySelector("#edit-severity").value;
				const cvssRaw = overlay.panel.querySelector("#edit-cvss").value.trim();
				const note = overlay.panel.querySelector("#edit-note").value.trim();
				try {
					await api.patch(`/api/findings/${finding.id}`, {
						severity: nextSeverity,
						...(cvssRaw === "" ? { cvss: null } : { cvss: Number(cvssRaw) }),
						...(note ? { note } : {}),
					});
					toast("已保存评分", "success");
					overlay.close();
					ctx.reload();
				} catch (error) {
					toast(error.message, "error");
				}
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
				.filter((finding) => {
					if (status === "all") return true;
					if (status === "open") return isOpen(finding);
					return norm(finding.status) === status;
				})
				.filter((finding) => (platform === "all" ? true : (finding.platform ?? "web") === platform))
				.filter((finding) => {
					if (!keyword) return true;
					return `${finding.title} ${finding.label ?? ""} ${finding.target} ${finding.summary ?? ""} ${finding.category ?? ""}`
						.toLowerCase()
						.includes(keyword.toLowerCase());
				})
				.sort((a, b) => (SEVERITIES[a.severity]?.order ?? 9) - (SEVERITIES[b.severity]?.order ?? 9));

			const counts = findings.reduce((acc, finding) => {
				if (isOpen(finding)) acc[finding.severity] = (acc[finding.severity] ?? 0) + 1;
				return acc;
			}, {});

			const body = visible.length
				? html`<div class="table-wrap">
						<table>
							<thead>
								<tr>
									<th class="nowrap">等级</th>
									<th class="nowrap">编号</th>
									<th>发现</th>
									<th class="nowrap">类型</th>
									<th class="nowrap">平台</th>
									<th class="nowrap">状态</th>
									<th class="nowrap">时间</th>
								</tr>
							</thead>
							<tbody>
								${visible.map(
									(finding) => html`<tr data-id="${finding.id}" style="cursor:pointer">
										<td class="nowrap">${severityChip(finding.severity)}</td>
										<td class="nowrap tiny mono muted">${finding.label ?? "—"}</td>
										<td>
											<div class="dim">${finding.title}</div>
											<div class="tiny muted break">${finding.target}</div>
											<div class="row tiny muted" style="gap:8px;flex-wrap:wrap">
												${finding.repro ? html`<span class="chip chip-ok tiny">含复现</span>` : html`<span class="chip chip-muted tiny">缺复现</span>`}
												${finding.requestPkt ? html`<span class="chip chip-muted tiny">含请求包</span>` : ""}
												${Number(finding.cvss) > 0 ? html`<span class="chip chip-muted tiny mono">CVSS ${Number(finding.cvss).toFixed(1)}</span>` : ""}
											</div>
										</td>
										<td class="nowrap tiny">${finding.category || "—"}</td>
										<td class="nowrap tiny">${PLATFORM_LABEL[finding.platform ?? "web"] ?? finding.platform}</td>
										<td>${statusTag(finding)}</td>
										<td class="nowrap tiny muted">${relTime(finding.createdAt)}</td>
									</tr>`,
								)}
							</tbody>
						</table>
					</div>`
				: emptyState({
						iconName: "shield",
						title: "没有符合条件的发现",
						description: "发现来自三处：任务引擎的远程判定、对话 Agent 的提交、以及「安卓设备 → APK 分析」的静态结论。",
					});

			mount(
				root,
				html`
					<div class="page-section row" style="flex-wrap:wrap;gap:10px">
						<div class="tabs">
							${SEVERITY_FILTERS.map(
								(item) =>
									html`<button class="tab ${item.id === severity ? "active" : ""}" data-sev="${item.id}">${item.label}</button>`,
							)}
						</div>
						<select id="status" style="max-width:150px">
							${[
								["open", "未关闭"],
								["pending", "待确认"],
								["confirmed", "已确认"],
								["false-positive", "误报"],
								["fixed", "已修复"],
								["all", "全部状态"],
							].map(([id, label]) => html`<option value="${id}" ${id === status ? "selected" : ""}>${label}</option>`)}
						</select>
						<select id="platform" style="max-width:120px">
							${[
								["all", "全部平台"],
								["web", "Web"],
								["android", "安卓"],
							].map(([id, label]) => html`<option value="${id}" ${id === platform ? "selected" : ""}>${label}</option>`)}
						</select>
						<input id="search" placeholder="搜索标题 / 编号 / 目标" style="max-width:240px" value="${keyword}" />
						<div class="spacer"></div>
						<span class="tiny muted">${visible.length} / ${findings.length}</span>
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
			select.addEventListener("change", () => {
				status = select.value;
				paint();
			});
			const platformSelect = root.querySelector("#platform");
			platformSelect.addEventListener("change", () => {
				platform = platformSelect.value;
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
/**
 * 审计日志：谁在什么时候做了什么。会话、任务、设备、报告都落在这里。
 * 这是"会话即审计"的落地形态：过程可回放，不依赖模型自述。
 */

import { icon } from "../icons.js";
import { api, fmtTime, html, mount, raw, toNode } from "../core.js";
import { card, emptyState, inlineError, loading } from "../ui.js";

const LEVELS = [
	{ id: "all", label: "全部" },
	{ id: "info", label: "信息" },
	{ id: "warn", label: "警告" },
	{ id: "error", label: "错误" },
];

export default {
	title: "审计日志",
	subtitle: "控制台内的全部操作留痕",

	async render(root, ctx) {
		mount(root, loading());
		let logs = [];
		try {
			logs = await api.get("/api/logs?limit=500");
		} catch (error) {
			mount(root, inlineError(error.message));
			return;
		}

		const actions = toNode(html`<button class="btn ghost small" id="refresh">${raw(icon("refresh", { size: 15 }))}刷新</button>`);
		ctx.setHeader("审计日志", `最近 ${logs.length} 条`, actions);
		actions.querySelector("#refresh").addEventListener("click", () => ctx.reload());

		let level = "all";
		let keyword = "";

		const paint = () => {
			const visible = logs
				.filter((entry) => level === "all" || entry.level === level)
				.filter((entry) => !keyword || entry.message.toLowerCase().includes(keyword.toLowerCase()));

			const body = visible.length
				? html`<div class="table-wrap" style="max-height:70vh">
						<table>
							<thead>
								<tr><th class="nowrap">时间</th><th class="nowrap">级别</th><th>内容</th></tr>
							</thead>
							<tbody>
								${visible.map(
									(entry) => html`<tr>
										<td class="nowrap mono tiny">${fmtTime(entry.at)}</td>
										<td class="nowrap">
											<span class="chip ${entry.level === "error" ? "chip-danger" : entry.level === "warn" ? "chip-warn" : "chip-muted"}">
												${entry.level}
											</span>
										</td>
										<td class="break small">${entry.message}</td>
									</tr>`,
								)}
							</tbody>
						</table>
					</div>`
				: emptyState({ iconName: "logs", title: "没有符合条件的日志", description: "操作、任务、设备事件都会写到这里。" });

			mount(
				root,
				html`
					<div class="page-section row">
						<div class="tabs">
							${LEVELS.map(
								(item) =>
									html`<button class="tab ${item.id === level ? "active" : ""}" data-level="${item.id}">
										${item.label}
									</button>`,
							)}
						</div>
						<div class="spacer"></div>
						<input id="search" placeholder="搜索日志" style="max-width:260px" value="${keyword}" />
					</div>
					${card({ body, tight: true })}
				`,
			);

			root.querySelectorAll("[data-level]").forEach((node) =>
				node.addEventListener("click", () => {
					level = node.dataset.level;
					paint();
				}),
			);
			const search = root.querySelector("#search");
			search.addEventListener("input", () => {
				keyword = search.value.trim();
				const position = search.selectionStart;
				paint();
				const next = root.querySelector("#search");
				next.focus();
				next.setSelectionRange(position, position);
			});
		};
		paint();
	},
};
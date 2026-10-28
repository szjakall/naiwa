/**
 * 总览：一眼看到"现在有什么任务在跑、资产多大、还剩多少没处理的发现、几台设备在线"。
 * 只读页面，所有动作都跳去对应模块完成，避免在首页堆出一堆重复入口。
 */

import { icon } from "../icons.js";
import { api, html, mount, raw, relTime, severityChip, statusChip, toNode } from "../core.js";
import { card, emptyState, inlineError, loading, severityBar, severityLegend, statCard } from "../ui.js";

export default {
	title: "总览",
	subtitle: "任务、资产与发现的当前状态",

	async render(root, ctx) {
		mount(root, loading());

		const actions = toNode(html`
			<div class="row">
				<button class="btn ghost small" id="quick-report">生成报告</button>
				<button class="btn primary small" id="quick-task">${raw(icon("plus", { size: 15 }))}新建任务</button>
			</div>
		`);
		ctx.setHeader("总览", "任务、资产与发现的当前状态", actions);
		actions.querySelector("#quick-task").addEventListener("click", () => ctx.go("#/tasks/new"));
		actions.querySelector("#quick-report").addEventListener("click", () => ctx.go("#/reports"));

		let data;
		try {
			data = await api.get("/api/overview");
		} catch (error) {
			mount(root, inlineError(error.message));
			return;
		}

		const { stats, bySeverity, recentTasks, recentFindings } = data;
		const tasksTable = recentTasks.length
			? html`<div class="table-wrap">
					<table>
						<thead>
							<tr><th>任务</th><th class="nowrap">状态</th><th class="nowrap">发现</th><th class="nowrap">时间</th></tr>
						</thead>
						<tbody>
							${recentTasks.map(
								(task) => html`<tr data-task="${task.id}" style="cursor:pointer">
									<td>
										<div class="dim">${task.title}</div>
										<div class="tiny muted break">${(task.scope ?? []).join("，") || "无目标"}</div>
									</td>
									<td>${statusChip(task.status)}</td>
									<td class="mono">${task.findings ?? 0}</td>
									<td class="nowrap tiny muted">${relTime(task.createdAt)}</td>
								</tr>`,
							)}
						</tbody>
					</table>
				</div>`
			: emptyState({
					iconName: "tasks",
					title: "还没有任务",
					description: "新建一个任务，填入授权范围内的域名或 URL，recon 会自动落资产与发现。",
				});

		const findingsList = recentFindings.length
			? html`<div class="table-wrap">
					<table>
						<thead>
							<tr><th>发现</th><th class="nowrap">等级</th><th class="nowrap">时间</th></tr>
						</thead>
						<tbody>
							${recentFindings.map(
								(finding) => html`<tr data-finding="${finding.id}" style="cursor:pointer">
									<td>
										<div class="dim">${finding.title}</div>
										<div class="tiny muted break">${finding.target}</div>
									</td>
									<td>${severityChip(finding.severity)}</td>
									<td class="nowrap tiny muted">${relTime(finding.createdAt)}</td>
								</tr>`,
							)}
						</tbody>
					</table>
				</div>`
			: emptyState({ iconName: "shield", title: "暂无未关闭的发现", description: "任务跑完后，命中的问题会出现在这里。" });

		mount(
			root,
			html`
				<div class="grid grid-4 page-section">
					${statCard({ label: "任务", value: stats.tasks, foot: `${stats.running} 个在跑`, iconName: "tasks" })}
					${statCard({ label: "资产", value: stats.assets, foot: "域名 / IP / URL", iconName: "assets" })}
					${statCard({ label: "未关闭发现", value: stats.findings, foot: `${stats.reports} 份报告`, iconName: "findings" })}
					${statCard({ label: "安卓设备", value: stats.online, foot: `共登记 ${stats.devices} 台`, iconName: "android" })}
				</div>

				<div class="split page-section">
					${card({
						title: "最近任务",
						sub: "点击进入详情",
						actions: html`<button class="btn ghost small" id="all-tasks">全部</button>`,
						body: tasksTable,
						tight: true,
					})}
					<div class="grid" style="gap:14px">
						${card({
							title: "风险分布",
							sub: "未关闭发现",
							body: html`
								${severityBar(bySeverity)}
								<div class="mt-12">${severityLegend(bySeverity)}</div>
							`,
						})}
						${card({
							title: "最近发现",
							actions: html`<button class="btn ghost small" id="all-findings">全部</button>`,
							body: findingsList,
							tight: true,
						})}
					</div>
				</div>
			`,
		);

		root.querySelectorAll("[data-task]").forEach((node) =>
			node.addEventListener("click", () => ctx.go(`#/tasks/${node.dataset.task}`)),
		);
		root.querySelectorAll("[data-finding]").forEach((node) =>
			node.addEventListener("click", () => ctx.go("#/findings")),
		);
		root.querySelector("#all-tasks").addEventListener("click", () => ctx.go("#/tasks"));
		root.querySelector("#all-findings").addEventListener("click", () => ctx.go("#/findings"));
	},
};
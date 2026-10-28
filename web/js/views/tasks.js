/**
 * 任务：基础框架的主链入口。
 * 列表页负责创建/启停，详情页负责看事件流、命中的发现与报告出口。
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
	severityChip,
	statusChip,
	toast,
	toNode,
} from "../core.js";
import { card, emptyState, inlineError, loading, severityBar, statCard } from "../ui.js";

const STATUS_FILTERS = [
	{ id: "all", label: "全部" },
	{ id: "running", label: "进行中" },
	{ id: "done", label: "已完成" },
];

export default {
	title: "任务",
	subtitle: "从目标范围到资产与发现的自动评估",

	async render(root, ctx) {
		if (ctx.param && ctx.param !== "new") return renderDetail(root, ctx, ctx.param);
		const dispose = await renderList(root, ctx);
		if (ctx.param === "new") openCreateDialog(ctx);
		return dispose;
	},
};

// ---------------------------------------------------------------- 列表

async function renderList(root, ctx) {
	mount(root, loading());
	let tasks = [];
	try {
		tasks = await api.get("/api/tasks");
	} catch (error) {
		mount(root, inlineError(error.message));
		return null;
	}

	const actions = toNode(html`<button class="btn primary small" id="new-task">
		${raw(icon("plus", { size: 15 }))}新建任务
	</button>`);
	ctx.setHeader("任务", `共 ${tasks.length} 个任务`, actions);
	actions.querySelector("#new-task").addEventListener("click", () => openCreateDialog(ctx));

	let filter = "all";
	const paint = () => {
		const visible = tasks.filter((task) => filter === "all" || task.status === filter);
		const body = visible.length
			? html`<div class="table-wrap">
					<table>
						<thead>
							<tr>
								<th>任务</th>
								<th class="nowrap">状态</th>
								<th class="nowrap">目标</th>
								<th class="nowrap">发现</th>
								<th class="nowrap">创建时间</th>
								<th class="nowrap"></th>
							</tr>
						</thead>
						<tbody>
							${visible.map(
								(task) => html`<tr>
									<td>
										<div class="dim">${task.title}</div>
										<div class="tiny muted break">${(task.scope ?? []).join("，") || "无目标"}</div>
									</td>
									<td>${statusChip(task.status)}</td>
									<td class="mono">${(task.targets ?? []).length}</td>
									<td class="mono">${task.findings ?? 0}</td>
									<td class="nowrap tiny muted">${relTime(task.createdAt)}</td>
									<td class="nowrap center">
										<button class="btn ghost small" data-open="${task.id}">详情</button>
										${task.status === "running"
											? html`<button class="btn ghost small" data-stop="${task.id}">停止</button>`
											: html`<button class="btn ghost small" data-run="${task.id}">运行</button>`}
										<button class="btn-icon danger" data-del="${task.id}" title="删除任务">
											${raw(icon("trash", { size: 16 }))}
										</button>
									</td>
								</tr>`,
							)}
						</tbody>
					</table>
				</div>`
			: emptyState({
					iconName: "tasks",
					title: "没有符合条件的任务",
					description: "任务引擎只对授权范围内的目标发只读请求：抓首屏、读响应头、看几个通用暴露点。",
				});

		mount(
			root,
			html`
				<div class="page-section">
					<div class="tabs">
						${STATUS_FILTERS.map(
							(item) =>
								html`<button class="tab ${item.id === filter ? "active" : ""}" data-filter="${item.id}">
									${item.label}
									${item.id === "all" ? ` ${tasks.length}` : ""}
								</button>`,
						)}
					</div>
				</div>
				${card({ body, tight: true })}
			`,
		);

		root.querySelectorAll("[data-filter]").forEach((node) =>
			node.addEventListener("click", () => {
				filter = node.dataset.filter;
				paint();
			}),
		);
		root.querySelectorAll("[data-open]").forEach((node) =>
			node.addEventListener("click", () => ctx.go(`#/tasks/${node.dataset.open}`)),
		);
		root.querySelectorAll("[data-run]").forEach((node) =>
			node.addEventListener("click", async () => {
				node.disabled = true;
				try {
					await api.post(`/api/tasks/${node.dataset.run}/run`, {});
					toast("任务已启动", "success");
					ctx.reload();
				} catch (error) {
					toast(error.message, "error");
					node.disabled = false;
				}
			}),
		);
		root.querySelectorAll("[data-stop]").forEach((node) =>
			node.addEventListener("click", async () => {
				try {
					await api.post(`/api/tasks/${node.dataset.stop}/stop`, {});
					toast("已发送停止指令", "info");
				} catch (error) {
					toast(error.message, "error");
				}
			}),
		);
		root.querySelectorAll("[data-del]").forEach((node) =>
			node.addEventListener("click", async () => {
				const ok = await confirmDialog({
					title: "删除任务",
					message: "任务记录会被移除，已经产生的资产与发现保留。",
					confirmText: "删除",
					danger: true,
				});
				if (!ok) return;
				try {
					await api.del(`/api/tasks/${node.dataset.del}`);
					tasks = tasks.filter((task) => task.id !== node.dataset.del);
					paint();
					toast("已删除", "success");
				} catch (error) {
					toast(error.message, "error");
				}
			}),
		);
	};
	paint();
	return null;
}

function openCreateDialog(ctx) {
	const overlay = openOverlay(html`
		<div class="overlay-head"><h3>新建评估任务</h3></div>
		<div class="overlay-body">
			<label class="field">
				<span>任务名称</span>
				<input data-title placeholder="例如：官网门户 授权评估" />
			</label>
			<label class="field">
				<span>目标范围</span>
				<textarea data-scope rows="6" placeholder="https://example.com&#10;example.org:8443"></textarea>
				<span class="hint">
					每行一个域名或 URL（最多 32 个）。引擎只发只读 GET：抓首屏、读响应头、TLS 与几个通用暴露点，
					不扫描端口、不猜口令、不爆破路径。
				</span>
			</label>
			<label class="checkbox"><input type="checkbox" data-autorun checked /><span>创建后立即运行</span></label>
		</div>
		<div class="overlay-foot">
			<button class="btn ghost" data-close>取消</button>
			<button class="btn primary" data-create>创建</button>
		</div>
	`);

	overlay.panel.querySelector("[data-title]").focus();
	const submit = async () => {
		const title = overlay.panel.querySelector("[data-title]").value.trim();
		const scope = overlay.panel.querySelector("[data-scope]").value;
		const autorun = overlay.panel.querySelector("[data-autorun]").checked;
		if (!scope.trim()) return toast("至少填一个目标", "error");
		const button = overlay.panel.querySelector("[data-create]");
		button.disabled = true;
		button.textContent = "创建中…";
		try {
			const result = await api.post("/api/tasks", { title, scope, autorun });
			overlay.close();
			if (result.pending) toast("任务已创建，已进入审批队列：到「守门」页批准后开始执行", "info", 6000);
			else if (result.blocked) toast(result.error ?? "守门员拦截了这次任务", "error", 6000);
			else toast("任务已创建", "success");
			ctx.go(`#/tasks/${result.task.id}`);
			if (ctx.param === "new") ctx.reload();
		} catch (error) {
			toast(error.message, "error");
			button.disabled = false;
			button.textContent = "创建";
		}
	};
	overlay.panel.querySelector("[data-create]").addEventListener("click", submit);
	overlay.panel.querySelector("[data-scope]").addEventListener("keydown", (event) => {
		if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submit();
	});
}

// ---------------------------------------------------------------- 详情

async function renderDetail(root, ctx, id) {
	mount(root, loading());

	const reloadActions = (task) => {
		const node = toNode(html`<div class="row">
			<button class="btn ghost small" id="back">${raw(icon("chevron", { size: 15 }))}返回</button>
			${task.status === "running"
				? html`<button class="btn danger small" id="stop">${raw(icon("stop", { size: 14 }))}停止</button>`
				: html`<button class="btn primary small" id="run">${raw(icon("play", { size: 14 }))}运行</button>`}
			<button class="btn ghost small" id="report">生成报告</button>
		</div>`);
		ctx.setHeader(task.title, `${task.status} · ${(task.scope ?? []).join("，")}`, node);
		node.querySelector("#back").addEventListener("click", () => ctx.go("#/tasks"));
		node.querySelector("#run")?.addEventListener("click", async () => {
			try {
				const result = await api.post(`/api/tasks/${id}/run`, {});
				if (result.pending) toast("已进入审批队列：到「守门」页批准后开始执行", "info", 6000);
				else if (result.blocked) toast(result.error ?? "守门员拦截了这次任务", "error");
				else toast("任务已启动", "success");
				ctx.reload();
			} catch (error) {
				toast(error.message, "error");
			}
		});
		node.querySelector("#stop")?.addEventListener("click", async () => {
			try {
				await api.post(`/api/tasks/${id}/stop`, {});
				toast("已发送停止指令", "info");
			} catch (error) {
				toast(error.message, "error");
			}
		});
		node.querySelector("#report").addEventListener("click", async () => {
			try {
				const result = await api.post("/api/reports", { taskId: id });
				toast(`报告已生成：${result.report.title}`, "success");
				ctx.go("#/reports");
			} catch (error) {
				toast(error.message, "error");
			}
		});
	};

	let timer = null;
	let lastEventCount = -1;

	const paint = (data) => {
		const { task, findings, traffic } = data;
		if (!timer) reloadActions(task);

		const counts = findings.reduce((acc, finding) => {
			acc[finding.severity] = (acc[finding.severity] ?? 0) + 1;
			return acc;
		}, {});

		const consoleLines = task.events.length
			? task.events.map(
					(event) => html`<div class="log-line ${event.level}">
						<span class="log-time">${event.at?.slice(11, 19) ?? ""}</span>
						<span class="log-level">${event.level}</span>
						<span class="log-text">${event.text}</span>
					</div>`,
				)
			: html`<div class="muted">还没有事件。点右上角「运行」开始。</div>`;

		mount(
			root,
			html`
				<div class="grid grid-4 page-section">
					${statCard({ label: "状态", value: task.status, foot: task.stage ?? "", iconName: "tasks" })}
					${statCard({ label: "请求数", value: task.stats?.requests ?? 0, foot: "只读 GET", iconName: "traffic" })}
					${statCard({ label: "发现", value: findings.length, foot: task.summary || "—", iconName: "findings" })}
					${statCard({
						label: "耗时",
						value: task.startedAt ? relTime(task.startedAt) : "—",
						foot: task.finishedAt ? `结束于 ${relTime(task.finishedAt)}` : "未开始",
						iconName: "clock",
					})}
				</div>

				<div class="split page-section">
					${card({
						title: "事件流",
						sub: task.status === "running" ? "实时" : "已结束",
						actions: html`<button class="btn ghost small" id="refresh-events">刷新</button>`,
						body: html`<div class="console" id="task-console">${consoleLines}</div>`,
					})}
					<div class="grid" style="gap:14px">
						${card({
							title: "风险分布",
							body: html`<div class="row small muted" style="justify-content:space-between">
								<span>共 ${findings.length} 条</span><span>${task.stats?.assets ?? 0} 个资产</span>
							</div>
							<div class="mt-12">${severityBar(counts)}</div>`,
						})}
						${card({
							title: "命中发现",
							body: findings.length
								? html`<div class="table-wrap" style="max-height:320px">
										<table>
											<tbody>
												${findings.map(
													(finding) => html`<tr>
														<td>
															<div class="dim">${finding.title}</div>
															<div class="tiny muted break">${finding.target}</div>
														</td>
														<td class="nowrap">${severityChip(finding.severity)}</td>
													</tr>`,
												)}
											</tbody>
										</table>
									</div>`
								: emptyState({ iconName: "shield", title: "暂无命中", description: "目标响应越充分，判定越准。" }),
							tight: true,
						})}
						${card({
							title: "最近请求",
							body: traffic.length
								? html`<div class="table-wrap" style="max-height:240px">
										<table>
											<tbody>
												${traffic
													.slice(-14)
													.reverse()
													.map(
														(item) => html`<tr>
															<td class="mono tiny">${item.status}</td>
															<td class="break tiny">${item.url}</td>
															<td class="nowrap tiny muted">${item.ms ?? 0}ms</td>
														</tr>`,
													)}
											</tbody>
										</table>
									</div>`
								: html`<div class="muted small">还没有请求记录。</div>`,
							tight: true,
						})}
					</div>
				</div>
			`,
		);

		const consoleNode = root.querySelector("#task-console");
		if (consoleNode && lastEventCount !== task.events.length) {
			consoleNode.scrollTop = consoleNode.scrollHeight;
			lastEventCount = task.events.length;
		}
		root.querySelector("#refresh-events").addEventListener("click", () => tick());
	};

	const tick = async () => {
		try {
			const data = await api.get(`/api/tasks/${id}`);
			paint(data);
			if (data.task.status === "running" && !timer) {
				timer = setInterval(() => tick(), 1500);
			}
			if (data.task.status !== "running" && timer) {
				clearInterval(timer);
				timer = null;
			}
		} catch (error) {
			if (timer) {
				clearInterval(timer);
				timer = null;
			}
			mount(root, inlineError(error.message));
		}
	};

	await tick();
	return () => {
		if (timer) clearInterval(timer);
	};
}
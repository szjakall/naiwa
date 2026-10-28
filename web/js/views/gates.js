/**
 * 守门（AI 审批）：三档模式切换 + 人工审批队列 + 判定流水。
 *
 * 守门页：模式切换、审批队列与判定流水。几个关键设计：
 * - 守的是设备命令 / 文件写入 / frida 三类真执行面。
 * - review 模式的队列是真的：批准后才执行——
 *   批准动作在服务端跑，前端只轮询结果。
 * - 判定失败一律放行，页面上用横幅提示端点不健康。
 */

import { icon } from "../icons.js";
import {
	api,
	confirmDialog,
	fmtTime,
	html,
	mount,
	openOverlay,
	raw,
	relTime,
	toast,
	toNode,
} from "../core.js";
import { card, emptyState, inlineError, loading } from "../ui.js";

const TABS = [
	{ id: "pending", label: "待审批" },
	{ id: "all", label: "全部" },
	{ id: "allow", label: "放行" },
	{ id: "block", label: "拦截" },
	{ id: "failed", label: "判定失败" },
];

const DECISION_META = {
	allow: { label: "放行", tone: "ok" },
	block: { label: "拦截", tone: "danger" },
	failed: { label: "失败", tone: "warn" },
};

const APPROVAL_META = {
	ai: { label: "AI 审批", tone: "info" },
	human: { label: "人工审批", tone: "warn" },
	auto: { label: "自动执行", tone: "muted" },
};

function decisionChip(decision) {
	const meta = DECISION_META[decision] ?? { label: decision, tone: "muted" };
	return html`<span class="chip chip-${meta.tone}">${meta.label}</span>`;
}

function approvalChip(approval) {
	const meta = APPROVAL_META[approval] ?? { label: approval, tone: "muted" };
	return html`<span class="chip chip-${meta.tone}">${meta.label}</span>`;
}

export default {
	title: "守门",
	subtitle: "AI 审批 · 人工审批队列与判定流水",

	async render(root, ctx) {
		mount(root, loading("读取守门状态…"));

		let state;
		let pending = [];
		let audit = { items: [], total: 0, page: 1, pageSize: 50, stats: null };
		let tab = "pending";
		let search = "";
		let page = 1;
		let pollTimer = null;

		const loadState = async () => {
			state = await api.get("/api/gatekeeper");
		};

		const loadPending = async () => {
			pending = await api.get("/api/gatekeeper/approvals?status=pending");
		};

		const loadAudit = async () => {
			const params = new URLSearchParams({ page: String(page), pageSize: "50" });
			if (tab === "allow" || tab === "block" || tab === "failed") params.set("decision", tab);
			if (search) params.set("search", search);
			audit = await api.get(`/api/gatekeeper/decisions?${params}`);
		};

		try {
			await Promise.all([loadState(), loadPending(), loadAudit()]);
		} catch (error) {
			mount(root, inlineError(error.message));
			return;
		}

		const actions = toNode(html`<button class="btn ghost small" id="refresh">${raw(icon("refresh", { size: 15 }))}刷新</button>`);
		ctx.setHeader("守门", "AI 审批 · 人工审批队列与判定流水", actions);
		actions.querySelector("#refresh").addEventListener("click", () => ctx.reload());

		// ---------------------------------------------------- 模式切换

		const switchMode = async (mode) => {
			try {
				await api.put("/api/gatekeeper", { mode });
				await loadState();
				paint();
				toast(`已切换到「${state.modes.find((item) => item.id === mode)?.label ?? mode}」`, "success");
			} catch (error) {
				toast(error.message, "error");
			}
		};

		// ---------------------------------------------------- 审批

		const detailOverlay = (item) => {
			const overlay = openOverlay(
				html`
					<div class="overlay-head">
						<h3 style="margin:0">待审批动作</h3>
						<div class="spacer"></div>
						<button class="btn-icon" data-close>${raw(icon("x", { size: 16 }))}</button>
					</div>
					<div class="overlay-body">
						<dl class="kv">
							<dt>类别</dt><dd>${item.scope}</dd>
							<dt>目标</dt><dd>${item.target}</dd>
							<dt>来源</dt><dd>${item.source}</dd>
							<dt>提交时间</dt><dd>${fmtTime(item.createdAt)}</dd>
						</dl>
						<div class="apk-section">
							<h4>将要执行的内容</h4>
							<pre class="md-code" style="max-height:300px;overflow:auto;padding:12px;border-radius:9px;background:#070b10;border:1px solid var(--line-soft);white-space:pre-wrap">${item.command}</pre>
						</div>
						<div class="hint-box">
							${raw(icon("alert", { size: 16 }))}
							<span>批准后会立即在设备上执行。拒绝则不会执行，并记一条「人工审批 · 拦截」。</span>
						</div>
					</div>
					<div class="overlay-foot">
						<button class="btn ghost" data-close>关闭</button>
						<button class="btn danger" data-reject>拒绝</button>
						<button class="btn primary" data-approve>批准并执行</button>
					</div>
				`,
				{ wide: true },
			);
			overlay.panel.querySelector("[data-approve]").addEventListener("click", async () => {
				const button = overlay.panel.querySelector("[data-approve]");
				button.disabled = true;
				button.textContent = "执行中…";
				try {
					const result = await api.post(`/api/gatekeeper/approvals/${item.id}/approve`, {});
					overlay.close();
					const out = result.result ?? {};
					toast(
						out.ok === false ? `已批准，但执行失败：${out.error ?? "未知错误"}` : "已批准并执行",
						out.ok === false ? "error" : "success",
					);
					await Promise.all([loadPending(), loadAudit(), loadState()]);
					paint();
				} catch (error) {
					toast(error.message, "error");
					button.disabled = false;
					button.textContent = "批准并执行";
				}
			});
			overlay.panel.querySelector("[data-reject]").addEventListener("click", async () => {
				try {
					await api.post(`/api/gatekeeper/approvals/${item.id}/reject`, { reason: "操作员在审批页拒绝" });
					overlay.close();
					toast("已拒绝", "info");
					await Promise.all([loadPending(), loadAudit(), loadState()]);
					paint();
				} catch (error) {
					toast(error.message, "error");
				}
			});
		};

		const decideQuick = async (id, approveIt) => {
			try {
				if (approveIt) await api.post(`/api/gatekeeper/approvals/${id}/approve`, {});
				else await api.post(`/api/gatekeeper/approvals/${id}/reject`, { reason: "操作员在列表拒绝" });
				toast(approveIt ? "已批准并执行" : "已拒绝", approveIt ? "success" : "info");
				await Promise.all([loadPending(), loadAudit(), loadState()]);
				paint();
			} catch (error) {
				toast(error.message, "error");
			}
		};

		// ---------------------------------------------------- 渲染

		const paint = () => {
			const { config, endpoint, health, stats, modes } = state;
			const statsCards = html`
				<div class="grid grid-4 page-section">
					<div class="stat">
						<div class="stat-label">待审批</div>
						<div class="stat-value">${stats.pending}</div>
						<div class="stat-foot">人工审批模式下排队</div>
					</div>
					<div class="stat">
						<div class="stat-label">24 小时判定</div>
						<div class="stat-value">${stats.last24h}</div>
						<div class="stat-foot">累计 ${stats.total}</div>
					</div>
					<div class="stat">
						<div class="stat-label">拦截率</div>
						<div class="stat-value">${(stats.blockRate * 100).toFixed(0)}%</div>
						<div class="stat-foot">放行 ${stats.byDecision.allow} · 拦截 ${stats.byDecision.block}</div>
					</div>
					<div class="stat">
						<div class="stat-label">平均耗时</div>
						<div class="stat-value">${stats.avgLatencyMs}<span class="small muted"> ms</span></div>
						<div class="stat-foot">判定失败 ${stats.failures} 次</div>
					</div>
				</div>
			`;

			const unhealthy = health.failures > 0 && (health.lastSuccessAt ?? 0) < (health.lastFailureAt ?? 0);
			const banner = unhealthy
				? html`<div class="hint-box" style="border-color:rgba(255,198,92,.34);background:rgba(255,198,92,.08);color:#ffd489">
						${raw(icon("alert", { size: 16 }))}
						<span>守门端点最近判定失败（${health.lastError ?? "未知原因"}），期间的动作按设计全部放行。
						请到「设置 → 守门设置」点一次「测试判定」确认端点。</span>
					</div>`
				: ""

			const modeBar = html`
				<div class="row mb-12" style="gap:10px;flex-wrap:wrap">
					<div class="tabs">
						${modes.map(
							(item) =>
								html`<button class="tab ${config.mode === item.id ? "active" : ""}" data-mode="${item.id}" title="${item.hint}">
									${item.label}
								</button>`,
						)}
					</div>
					<span class="chip ${endpoint ? "chip-ok" : "chip-warn"}">
						${endpoint ? `端点：${endpoint.from} · ${endpoint.modelId}` : "端点：未配置（切 AI 审批会被拒绝）"}
					</span>
					<span class="spacer"></span>
					<span class="tiny muted">${modes.find((item) => item.id === config.mode)?.hint ?? ""}</span>
				</div>
			`;

			const pendingTable = pending.length
				? html`<div class="table-wrap">
						<table>
							<thead>
								<tr>
									<th class="nowrap">提交时间</th>
									<th class="nowrap">类别</th>
									<th>目标</th>
									<th>内容</th>
									<th class="nowrap"></th>
								</tr>
							</thead>
							<tbody>
								${pending.map(
									(item) => html`<tr>
										<td class="nowrap tiny muted">${relTime(item.createdAt)}</td>
										<td class="nowrap"><span class="chip chip-muted">${item.scope}</span></td>
										<td class="tiny">${item.target}</td>
										<td class="break mono tiny">${item.command}</td>
										<td class="nowrap center">
											<button class="btn ghost small" data-detail="${item.id}">查看</button>
											<button class="btn primary small" data-approve="${item.id}">批准</button>
											<button class="btn danger small" data-reject="${item.id}">拒绝</button>
										</td>
									</tr>`,
								)}
							</tbody>
						</table>
					</div>`
				: emptyState({
						iconName: "check",
						title: "没有待审批的动作",
						description:
							config.mode === "review"
								? "设备命令、文件推送、frida 动作都会先排到这里，等你批准才执行。"
								: "当前不是人工审批模式；切到「人工审批」后，执行类动作会先排队。",
					});

			const auditRows = audit.items.length
				? html`<div class="table-wrap" style="max-height:56vh">
						<table>
							<thead>
								<tr>
									<th class="nowrap">时间</th>
									<th class="nowrap">判定</th>
									<th class="nowrap">方式</th>
									<th class="nowrap">类别</th>
									<th>内容</th>
									<th class="nowrap">耗时</th>
								</tr>
							</thead>
							<tbody>
								${audit.items.map(
									(row) => html`<tr data-row="${row.id}" style="cursor:pointer">
										<td class="nowrap tiny mono">${fmtTime(row.at).slice(5)}</td>
										<td class="nowrap">${decisionChip(row.decision)}</td>
										<td class="nowrap">${approvalChip(row.approval)}</td>
										<td class="nowrap tiny muted">${row.tool}</td>
										<td class="break mono tiny">
											${row.command}
											${row.reason ? html`<div class="tiny" style="color:#ff9dae">理由：${row.reason}</div>` : ""}
										</td>
										<td class="nowrap tiny muted">${row.latencyMs}ms</td>
									</tr>`,
								)}
							</tbody>
						</table>
					</div>`
				: emptyState({ iconName: "logs", title: "没有符合条件的判定记录", description: "每次守门判定都会落一条，包括放行的。" });

			const totalPages = Math.max(1, Math.ceil(audit.total / audit.pageSize));
			const pager =
				tab === "pending"
					? ""
					: html`<div class="row mt-12">
							<span class="tiny muted">共 ${audit.total} 条 · 第 ${audit.page}/${totalPages} 页</span>
							<span class="spacer"></span>
							<button class="btn ghost small" data-page="prev" ${audit.page <= 1 ? "disabled" : ""}>上一页</button>
							<button class="btn ghost small" data-page="next" ${audit.page >= totalPages ? "disabled" : ""}>下一页</button>
						</div>`;

			const body = tab === "pending" ? pendingTable : html`${auditRows}${pager}`;

			mount(
				root,
				html`
					${statsCards}
					${banner ? html`<div class="page-section">${banner}</div>` : ""}
					${card({
						title: "执行模式",
						sub: "全局默认，立即生效",
						body: modeBar,
					})}
					<div class="page-section"></div>
					${card({
						title: tab === "pending" ? "待审批队列" : "判定流水",
						sub: tab === "pending" ? `${pending.length} 条等待` : `共 ${audit.total} 条`,
						actions: html`
							<input id="search" placeholder="搜索内容 / 理由 / 目标" style="max-width:220px" value="${search}" />
						`,
						body: html`
							<div class="tabs mb-12">
								${TABS.map(
									(item) =>
										html`<button class="tab ${item.id === tab ? "active" : ""}" data-tab="${item.id}">
											${item.label}${item.id === "pending" && pending.length ? ` ${pending.length}` : ""}
										</button>`,
								)}
							</div>
							${body}
						`,
					})}
				`,
			);

			wire();
		};

		const wire = () => {
			root.querySelectorAll("[data-mode]").forEach((node) =>
				node.addEventListener("click", () => switchMode(node.dataset.mode)),
			);
			root.querySelectorAll("[data-tab]").forEach((node) =>
				node.addEventListener("click", async () => {
					tab = node.dataset.tab;
					page = 1;
					if (tab === "pending") await loadPending();
					else await loadAudit();
					paint();
				}),
			);
			root.querySelectorAll("[data-detail]").forEach((node) =>
				node.addEventListener("click", () => {
					const item = pending.find((entry) => entry.id === node.dataset.detail);
					if (item) detailOverlay(item);
				}),
			);
			root.querySelectorAll("[data-approve]").forEach((node) =>
				node.addEventListener("click", () => decideQuick(node.dataset.approve, true)),
			);
			root.querySelectorAll("[data-reject]").forEach((node) =>
				node.addEventListener("click", () => decideQuick(node.dataset.reject, false)),
			);
			root.querySelectorAll("[data-row]").forEach((node) =>
				node.addEventListener("click", () => {
					const row = audit.items.find((entry) => entry.id === node.dataset.row);
					if (!row) return;
					const overlay = openOverlay(
						html`
							<div class="overlay-head">
								${decisionChip(row.decision)}
								${approvalChip(row.approval)}
								<h3 style="margin:0">判定详情</h3>
								<div class="spacer"></div>
								<button class="btn-icon" data-close>${raw(icon("x", { size: 16 }))}</button>
							</div>
							<div class="overlay-body">
								<dl class="kv">
									<dt>时间</dt><dd>${fmtTime(row.at)}</dd>
									<dt>工具</dt><dd>${row.tool}</dd>
									<dt>目标</dt><dd>${row.target || "—"}</dd>
									<dt>来源</dt><dd>${row.source}</dd>
									<dt>耗时</dt><dd>${row.latencyMs} ms</dd>
									${row.model ? html`<dt>模型</dt><dd>${row.model}${row.modelFrom ? `（${row.modelFrom}）` : ""}</dd>` : ""}
									${row.totalTokens ? html`<dt>Token</dt><dd>${row.inputTokens ?? 0} + ${row.outputTokens ?? 0} = ${row.totalTokens}</dd>` : ""}
								</dl>
								${row.reason ? html`<div class="apk-section"><h4>拦截理由</h4><p class="dim small">${row.reason}</p></div>` : ""}
								${row.error ? html`<div class="apk-section"><h4>失败原因</h4><p class="dim small">${row.error}</p></div>` : ""}
								<div class="apk-section">
									<h4>内容</h4>
									<pre class="md-code" style="max-height:260px;overflow:auto;padding:12px;border-radius:9px;background:#070b10;border:1px solid var(--line-soft);white-space:pre-wrap">${row.command}</pre>
								</div>
							</div>
							<div class="overlay-foot">
								<button class="btn danger small" data-delete>删除记录</button>
								<div class="spacer"></div>
								<button class="btn ghost" data-close>关闭</button>
							</div>
						`,
						{ wide: true },
					);
					overlay.panel.querySelector("[data-delete]").addEventListener("click", async () => {
						const ok = await confirmDialog({
							title: "删除判定记录",
							message: "只删这一条审计记录，不影响其他数据。",
							confirmText: "删除",
							danger: true,
						});
						if (!ok) return;
						try {
							await api.del(`/api/gatekeeper/decisions/${row.id}`);
							overlay.close();
							await loadAudit();
							paint();
						} catch (error) {
							toast(error.message, "error");
						}
					});
				}),
			);
			root.querySelectorAll("[data-page]").forEach((node) =>
				node.addEventListener("click", async () => {
					page = node.dataset.page === "next" ? page + 1 : page - 1;
					await loadAudit();
					paint();
				}),
			);
			const searchNode = root.querySelector("#search");
			if (searchNode) {
				searchNode.addEventListener("input", () => {
					search = searchNode.value.trim();
					clearTimeout(searchNode._timer);
					searchNode._timer = setTimeout(async () => {
						page = 1;
						await loadAudit();
						paint();
					}, 350);
				});
			}
		};

		paint();

		// 待审批队列每 4 秒刷新一次：设备那边可能又提交了新动作。
		pollTimer = setInterval(async () => {
			try {
				const before = pending.length;
				await loadPending();
				if (pending.length !== before || tab === "pending") {
					if (tab === "pending") {
						await loadState();
						paint();
					}
				}
			} catch {
				/* 轮询失败不打断页面 */
			}
		}, 4000);

		return () => clearInterval(pollTimer);
	},
};
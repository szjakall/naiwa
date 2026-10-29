/**
 * 资产：任务跑出来的域名 / IP / URL，按项目合并、按时间累积。
 *
 * 这一页的重点不是"有多少"，而是**这个东西是谁的、从哪个项目出来的**：
 * 泛域名资产动辄几百条，没有公司 / 项目两列就只能在里面翻。点一行能下钻到
 * 它关联的发现与请求流水——报告和复测都要靠这条链。
 */

import { icon } from "../icons.js";
import { api, confirmDialog, html, mount, openOverlay, promptDialog, raw, relTime, severityChip, statusChip, toast, toNode } from "../core.js";
import { card, emptyState, inlineError, loading } from "../ui.js";

const TYPES = [
	{ id: "all", label: "全部" },
	{ id: "domain", label: "域名" },
	{ id: "ip", label: "IP" },
	{ id: "url", label: "URL" },
];

export default {
	title: "资产",
	subtitle: "任务实际接触过的域名、IP 与 URL（按公司 / 项目归属）",

	async render(root, ctx) {
		mount(root, loading());
		let assets = [];
		let tasks = [];
		let companies = [];
		let findings = [];
		try {
			const [assetList, taskList, companyList, findingList] = await Promise.all([
				api.get("/api/assets"),
				api.get("/api/tasks"),
				api.get("/api/companies"),
				api.get("/api/findings"),
			]);
			assets = Array.isArray(assetList) ? assetList : [];
			tasks = Array.isArray(taskList) ? taskList : [];
			companies = Array.isArray(companyList?.items) ? companyList.items : [];
			findings = Array.isArray(findingList) ? findingList : [];
		} catch (error) {
			mount(root, inlineError(error.message));
			return;
		}

		const actions = toNode(html`
			<button class="btn ghost small" id="to-traffic">${raw(icon("traffic", { size: 15 }))}看流量</button>
			<button class="btn ghost small" id="refresh">${raw(icon("refresh", { size: 15 }))}刷新</button>
		`);
		ctx.setHeader("资产", `共 ${assets.length} 个资产`, actions);
		actions.querySelector("#refresh").addEventListener("click", () => ctx.reload());
		actions.querySelector("#to-traffic").addEventListener("click", () => ctx.go("#/traffic"));

		let type = ctx.query?.get("type") ?? "all";
		let companyId = ctx.query?.get("companyId") ?? "";
		let taskId = ctx.query?.get("taskId") ?? "";
		let keyword = "";

		const taskOf = (id) => tasks.find((task) => task.id === id);
		const companyOf = (id) => companies.find((company) => company.id === id);
		const findingsOf = (asset) => findings.filter((finding) => finding.target === asset.value || finding.assetId === asset.id);

		const paint = () => {
			const visible = assets.filter((asset) => {
				if (type !== "all" && asset.type !== type) return false;
				if (companyId && asset.companyId !== companyId) return false;
				if (taskId && asset.taskId !== taskId && asset.lastTaskId !== taskId) return false;
				if (!keyword) return true;
				const haystack = `${asset.value} ${asset.title} ${asset.ip} ${(asset.tech ?? []).join(" ")}`.toLowerCase();
				return haystack.includes(keyword.toLowerCase());
			});

			const body = visible.length
				? html`<div class="table-wrap">
						<table>
							<thead>
								<tr>
									<th class="nowrap">类型</th>
									<th>标识</th>
									<th class="nowrap">公司</th>
									<th class="nowrap">项目</th>
									<th class="nowrap">IP</th>
									<th>标题 / 技术栈</th>
									<th class="nowrap">发现</th>
									<th class="nowrap">状态</th>
									<th class="nowrap">最近发现</th>
									<th></th>
								</tr>
							</thead>
							<tbody>
								${visible.map((asset) => {
									const related = findingsOf(asset);
									return html`<tr class="clickable" data-open="${asset.id}">
										<td class="nowrap"><span class="chip chip-muted">${asset.type}</span></td>
										<td class="break mono">${asset.value}</td>
										<td class="nowrap tiny">
											${asset.companyId
												? html`<a class="link" href="#/assets?companyId=${asset.companyId}" data-keep>${companyOf(asset.companyId)?.name ?? asset.companyId}</a>`
												: html`<span class="muted">未归属</span>`}
										</td>
										<td class="nowrap tiny">
											${asset.taskId
												? html`<a class="link" href="#/tasks/${asset.taskId}" data-keep>${taskOf(asset.taskId)?.title ?? asset.taskId}</a>`
												: html`<span class="muted">—</span>`}
										</td>
										<td class="nowrap mono tiny">${asset.ip || "—"}</td>
										<td>
											<div class="small dim">${asset.title || "—"}</div>
											${(asset.tech ?? []).length
												? html`<div class="permission-list mt-8">
														${asset.tech.map((tech) => html`<span class="permission">${tech}</span>`)}
													</div>`
												: ""}
											${(asset.notes ?? []).length
												? html`<div class="tiny muted mt-8">备注：${asset.notes[asset.notes.length - 1].text}</div>`
												: ""}
										</td>
										<td class="nowrap mono tiny">${related.length ? related.length : "—"}</td>
										<td>${statusChip(asset.status === "closed" ? "closed" : asset.status === "archived" ? "archived" : "open")}</td>
										<td class="nowrap tiny muted">${relTime(asset.lastSeen)}</td>
										<td class="nowrap center">
											<button class="btn-icon" data-note="${asset.id}" title="加备注">${raw(icon("file", { size: 16 }))}</button>
											<button class="btn-icon" data-toggle="${asset.id}" title="切换状态">${raw(icon("check", { size: 16 }))}</button>
											<button class="btn-icon danger" data-del="${asset.id}" title="删除">${raw(icon("trash", { size: 16 }))}</button>
										</td>
									</tr>`;
								})}
							</tbody>
						</table>
					</div>`
				: emptyState({
						iconName: "assets",
						title: keyword || type !== "all" || companyId || taskId ? "没有匹配的资产" : "还没有资产",
						description: "跑一个任务，命中的域名、IP 与 URL 会自动登记在这里，并按公司与项目归属。",
					});

			mount(
				root,
				html`
					<div class="page-section row" style="flex-wrap:wrap;gap:10px">
						<div class="tabs">
							${TYPES.map(
								(item) =>
									html`<button class="tab ${item.id === type ? "active" : ""}" data-type="${item.id}">
										${item.label}
									</button>`,
							)}
						</div>
						<select id="company-filter" style="max-width:220px">
							<option value="">全部公司</option>
							${companies.map(
								(company) =>
									html`<option value="${company.id}" ${company.id === companyId ? "selected" : ""}>${company.name}</option>`,
							)}
						</select>
						<input id="search" placeholder="搜索标识 / 标题 / 技术栈" style="max-width:280px" value="${keyword}" />
						<div class="spacer"></div>
						<span class="tiny muted">${visible.length} / ${assets.length}</span>
					</div>
					${card({ body, tight: true })}
				`,
			);

			root.querySelectorAll("[data-type]").forEach((node) =>
				node.addEventListener("click", () => {
					type = node.dataset.type;
					paint();
				}),
			);
			root.querySelector("#company-filter").addEventListener("change", (event) => {
				companyId = event.target.value;
				// 让地址栏跟着变：刷新后过滤条件还在，也方便把链接发给同事。
				ctx.go(`#/assets${companyId ? `?companyId=${companyId}` : ""}`);
				paint();
			});
			const search = root.querySelector("#search");
			search.addEventListener("change", () => {
				keyword = search.value.trim();
				paint();
			});
			search.addEventListener("keydown", (event) => {
				if (event.key === "Enter") {
					keyword = search.value.trim();
					paint();
				}
			});

			root.querySelectorAll("[data-open]").forEach((node) =>
				node.addEventListener("click", (event) => {
					if (event.target.closest("[data-keep]")) return;
					const asset = assets.find((entry) => entry.id === node.dataset.open);
					if (asset) openDetail(asset, { taskOf, companyOf, findingsOf });
				}),
			);

			root.querySelectorAll("[data-note]").forEach((node) =>
				node.addEventListener("click", async (event) => {
					event.stopPropagation();
					const text = await promptDialog({
						title: "添加备注",
						label: "备注内容",
						placeholder: "例如：测试环境，已确认不在生产范围内",
						confirmText: "保存",
					});
					if (!text) return;
					try {
						const updated = await api.patch(`/api/assets/${node.dataset.note}`, { note: text });
						assets = assets.map((asset) => (asset.id === updated.id ? updated : asset));
						paint();
						toast("备注已保存", "success");
					} catch (error) {
						toast(error.message, "error");
					}
				}),
			);

			root.querySelectorAll("[data-toggle]").forEach((node) =>
				node.addEventListener("click", async (event) => {
					event.stopPropagation();
					const asset = assets.find((entry) => entry.id === node.dataset.toggle);
					if (!asset) return;
					const next = asset.status === "closed" ? "open" : "closed";
					try {
						const updated = await api.patch(`/api/assets/${asset.id}`, { status: next });
						assets = assets.map((entry) => (entry.id === updated.id ? updated : entry));
						paint();
					} catch (error) {
						toast(error.message, "error");
					}
				}),
			);

			root.querySelectorAll("[data-del]").forEach((node) =>
				node.addEventListener("click", async (event) => {
					event.stopPropagation();
					const ok = await confirmDialog({
						title: "删除资产",
						message: "只删除这条资产记录，不影响任务与漏洞。",
						confirmText: "删除",
						danger: true,
					});
					if (!ok) return;
					try {
						await api.del(`/api/assets/${node.dataset.del}`);
						assets = assets.filter((asset) => asset.id !== node.dataset.del);
						paint();
						toast("已删除", "success");
					} catch (error) {
						toast(error.message, "error");
					}
				}),
			);
		};
		paint();
	},
};

/** 资产详情：把"这个资产是谁的、从哪来、有什么问题、走过什么请求"一次摊开。 */
function openDetail(asset, helpers) {
	const related = helpers.findingsOf(asset);
	const task = asset.taskId ? helpers.taskOf(asset.taskId) : null;
	const company = asset.companyId ? helpers.companyOf(asset.companyId) : null;
	const overlay = openOverlay(
		html`
			<div class="overlay-head">
				<h3>${asset.value}</h3>
				<div class="spacer"></div>
				<button class="btn-icon" data-close>✕</button>
			</div>
			<div class="overlay-body">
				<div class="kv">
					<div class="kv-k">类型</div><div class="kv-v">${asset.type}</div>
					<div class="kv-k">公司</div><div class="kv-v">${company?.name ?? "未归属"}</div>
					<div class="kv-k">项目</div>
					<div class="kv-v">${task ? html`<a class="link" href="#/tasks/${task.id}">${task.title}（${task.id}）</a>` : "—"}</div>
					<div class="kv-k">IP</div><div class="kv-v mono">${asset.ip || "—"}</div>
					<div class="kv-k">标题</div><div class="kv-v">${asset.title || "—"}</div>
					<div class="kv-k">技术栈</div><div class="kv-v">${(asset.tech ?? []).join(" / ") || "—"}</div>
					<div class="kv-k">首次 / 最近</div>
					<div class="kv-v tiny">${relTime(asset.firstSeen)} · ${relTime(asset.lastSeen)}</div>
				</div>
				<div class="traffic-cap mt-12">关联漏洞（${related.length}）</div>
				${related.length
					? html`<div class="table-wrap" style="max-height:220px">
							<table>
								<tbody>
									${related.map(
										(finding) => html`<tr>
											<td class="tiny">${finding.title}</td>
											<td class="nowrap">${severityChip(finding.severity)}</td>
											<td class="nowrap tiny muted">${finding.status}</td>
										</tr>`,
									)}
								</tbody>
							</table>
						</div>`
					: html`<div class="tiny muted">暂无关联发现。</div>`}
				<div class="row mt-12" style="gap:10px">
					<a class="btn ghost small" href="#/traffic${asset.taskId ? `?taskId=${asset.taskId}` : ""}">看这个项目的流量</a>
					${company ? html`<a class="btn ghost small" href="#/assets?companyId=${company.id}">看该公司全部资产</a>` : ""}
				</div>
			</div>
			<div class="overlay-foot">
				<button class="btn ghost" data-close>关闭</button>
			</div>
		`,
		{ wide: true },
	);
	overlay.panel.querySelectorAll("a[href^='#/']").forEach((link) =>
		link.addEventListener("click", () => overlay.close()),
	);
}
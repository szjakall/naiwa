/**
 * 资产：任务跑出来的域名 / IP / URL，按项目合并、按时间累积。
 * 这里只做人工维护（备注、状态、删除），新增由任务引擎自动完成。
 */

import { icon } from "../icons.js";
import { api, confirmDialog, html, mount, promptDialog, raw, relTime, statusChip, toast, toNode } from "../core.js";
import { card, emptyState, inlineError, loading } from "../ui.js";

const TYPES = [
	{ id: "all", label: "全部" },
	{ id: "domain", label: "域名" },
	{ id: "ip", label: "IP" },
	{ id: "url", label: "URL" },
];

export default {
	title: "资产",
	subtitle: "任务实际接触过的域名、IP 与 URL",

	async render(root, ctx) {
		mount(root, loading());
		let assets = [];
		try {
			assets = await api.get("/api/assets");
		} catch (error) {
			mount(root, inlineError(error.message));
			return;
		}

		const actions = toNode(html`<button class="btn ghost small" id="refresh">${raw(icon("refresh", { size: 15 }))}刷新</button>`);
		ctx.setHeader("资产", `共 ${assets.length} 个资产`, actions);
		actions.querySelector("#refresh").addEventListener("click", () => ctx.reload());

		let type = "all";
		let keyword = "";

		const paint = () => {
			const visible = assets.filter((asset) => {
				if (type !== "all" && asset.type !== type) return false;
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
									<th class="nowrap">IP</th>
									<th>标题 / 技术栈</th>
									<th class="nowrap">状态</th>
									<th class="nowrap">最近发现</th>
									<th></th>
								</tr>
							</thead>
							<tbody>
								${visible.map(
									(asset) => html`<tr>
										<td class="nowrap"><span class="chip chip-muted">${asset.type}</span></td>
										<td class="break mono">${asset.value}</td>
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
										<td>${statusChip(asset.status === "closed" ? "closed" : asset.status === "archived" ? "archived" : "open")}</td>
										<td class="nowrap tiny muted">${relTime(asset.lastSeen)}</td>
										<td class="nowrap center">
											<button class="btn-icon" data-note="${asset.id}" title="加备注">${raw(icon("file", { size: 16 }))}</button>
											<button class="btn-icon" data-toggle="${asset.id}" title="切换状态">${raw(icon("check", { size: 16 }))}</button>
											<button class="btn-icon danger" data-del="${asset.id}" title="删除">${raw(icon("trash", { size: 16 }))}</button>
										</td>
									</tr>`,
								)}
							</tbody>
						</table>
					</div>`
				: emptyState({
						iconName: "assets",
						title: keyword || type !== "all" ? "没有匹配的资产" : "还没有资产",
						description: "跑一个任务，命中的域名、IP 与 URL 会自动登记在这里。",
					});

			mount(
				root,
				html`
					<div class="page-section row">
						<div class="tabs">
							${TYPES.map(
								(item) =>
									html`<button class="tab ${item.id === type ? "active" : ""}" data-type="${item.id}">
										${item.label}
									</button>`,
							)}
						</div>
						<div class="spacer"></div>
						<input id="search" placeholder="搜索标识 / 标题 / 技术栈" style="max-width:280px" value="${keyword}" />
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
			const search = root.querySelector("#search");
			search.addEventListener("input", (event) => {
				keyword = event.target.value.trim();
				paint();
				const next = root.querySelector("#search");
				next.focus();
				next.setSelectionRange(next.value.length, next.value.length);
			});

			root.querySelectorAll("[data-note]").forEach((node) =>
				node.addEventListener("click", async () => {
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
				node.addEventListener("click", async () => {
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
				node.addEventListener("click", async () => {
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
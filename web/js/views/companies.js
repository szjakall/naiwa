/**
 * 公司（客户维度）：一个控制台服务多个客户时，这是唯一不会串数据的隔离维度。
 * 不建公司时所有数据归"未归属"，行为与之前一致。
 *
 * 展示上按"公司 → 项目 → 资产 → 发现"下钻：只有计数的表格看不出关联，
 * 操作员点进去才是真正的"这家客户交付了什么"。
 */

import { icon } from "../icons.js";
import { api, html, mount, openOverlay, raw, relTime, severityChip, statusChip, toast, toNode } from "../core.js";
import { card, emptyState, inlineError, loading } from "../ui.js";

export default {
	title: "公司",
	subtitle: "客户维度与数据归属（公司 → 项目 → 资产 → 发现）",

	async render(root, ctx) {
		mount(root, loading("读取公司…"));
		let items;
		try {
			items = (await api.get("/api/companies")).items ?? [];
		} catch (error) {
			mount(root, inlineError(error.message));
			return;
		}

		const actions = toNode(html`<button class="btn primary small" id="new-company">${raw(icon("plus", { size: 15 }))}新建公司</button>`);
		ctx.setHeader("公司", `${items.length} 家`, actions);
		actions.querySelector("#new-company").addEventListener("click", () => openForm(null, ctx));

		// 展开态与详情缓存：展开一次就缓存住，避免每次重绘都打接口。
		const expanded = new Set();
		const details = new Map();

		const paint = () => {
			const body = items.length
				? html`<div class="table-wrap">
						<table>
							<thead>
								<tr>
									<th class="nowrap"></th>
									<th>名称</th>
									<th class="nowrap">联系人</th>
									<th class="nowrap">项目</th>
									<th class="nowrap">资产</th>
									<th class="nowrap">发现</th>
									<th class="nowrap">流量</th>
									<th class="nowrap">报告</th>
									<th></th>
								</tr>
							</thead>
							<tbody>
								${items.map((company) => {
									const isOpen = expanded.has(company.id);
									const detail = details.get(company.id);
									return html`<tr class="clickable" data-expand="${company.id}">
											<td class="nowrap center muted">${isOpen ? "▾" : "▸"}</td>
											<td>
												<div class="dim">${company.name}</div>
												${company.note ? html`<div class="tiny muted">${company.note}</div>` : ""}
											</td>
											<td class="nowrap tiny">${company.contact || "—"}</td>
											<td class="mono tiny">
												<a class="link" href="#/tasks?companyId=${company.id}" data-keep>${company.counts.tasks}</a>
											</td>
											<td class="mono tiny">
												<a class="link" href="#/assets?companyId=${company.id}" data-keep>${company.counts.assets}</a>
											</td>
											<td class="mono tiny">${company.counts.findings}</td>
											<td class="mono tiny">
												<a class="link" href="#/traffic?companyId=${company.id}" data-keep>${company.counts.traffic ?? 0}</a>
											</td>
											<td class="mono tiny">${company.counts.reports}</td>
											<td class="nowrap center">
												<button class="btn ghost small" data-edit="${company.id}">编辑</button>
												<button class="btn-icon danger" data-del="${company.id}" title="删除">${raw(icon("trash", { size: 16 }))}</button>
											</td>
										</tr>
										${isOpen
											? html`<tr class="company-detail">
													<td colspan="9">${renderDetail(company, detail)}</td>
												</tr>`
											: ""}`;
								})}
							</tbody>
						</table>
					</div>`
				: emptyState({
						iconName: "layers",
						title: "还没有公司记录",
						description: "建立公司后，可以把项目产生的资产、发现、报告归到具体客户名下；归属是可选的。",
					});

			mount(
				root,
				html`
					<div class="hint-box page-section">
						${raw(icon("alert", { size: 16 }))}
						<span>归属是可选的：不建公司也能正常用，所有数据留在"未归属"。项目（任务）改归属时，它名下的资产 / 发现 / 流量会一起跟着走。</span>
					</div>
					${card({ body, tight: true })}
				`,
			);

			root.querySelectorAll("[data-expand]").forEach((node) =>
				node.addEventListener("click", async (event) => {
					if (event.target.closest("[data-keep]") || event.target.closest("button")) return;
					const id = node.dataset.expand;
					if (expanded.has(id)) {
						expanded.delete(id);
						paint();
						return;
					}
					expanded.add(id);
					paint();
					if (!details.has(id)) {
						try {
							details.set(id, await api.get(`/api/companies/${id}`));
						} catch (error) {
							toast(error.message, "error");
							details.set(id, { error: error.message });
						}
						paint();
					}
				}),
			);

			root.querySelectorAll("[data-edit]").forEach((node) =>
				node.addEventListener("click", (event) => {
					event.stopPropagation();
					openForm(items.find((i) => i.id === node.dataset.edit), ctx);
				}),
			);
			root.querySelectorAll("[data-del]").forEach((node) =>
				node.addEventListener("click", async (event) => {
					event.stopPropagation();
					try {
						await api.del(`/api/companies/${node.dataset.del}`);
						items = items.filter((i) => i.id !== node.dataset.del);
						paint();
						toast("已删除", "success");
					} catch (error) {
						toast(error.message, "error", 6000);
					}
				}),
			);
		};

		paint();
	},
};

function renderDetail(company, detail) {
	if (!detail) return html`<div class="muted tiny">读取中…</div>`;
	if (detail.error) return html`<div class="tiny" style="color:#ff9dae">${detail.error}</div>`;
	const tasks = detail.tasks ?? [];
	const assets = detail.assets ?? [];
	const findings = detail.findings ?? [];
	return html`
		<div class="company-panels">
			<div>
				<div class="traffic-cap">项目（${tasks.length}）</div>
				${tasks.length
					? html`<div class="table-wrap" style="max-height:200px">
							<table>
								<tbody>
									${tasks.map(
										(task) => html`<tr>
											<td class="tiny">
												<a class="link" href="#/tasks/${task.id}">${task.title}</a>
												<div class="tiny muted">${(task.scope ?? []).join("，").slice(0, 60) || "无目标"}</div>
											</td>
											<td class="nowrap">${statusChip(task.status)}</td>
											<td class="nowrap tiny muted">资产 ${task.assets} · 发现 ${task.findings}</td>
										</tr>`,
									)}
								</tbody>
							</table>
						</div>`
					: html`<div class="tiny muted">这家公司还没有项目。到「任务」新建时把归属选成它，或在这里编辑项目归属。</div>`}
			</div>
			<div>
				<div class="traffic-cap">资产（${assets.length}）</div>
				${assets.length
					? html`<div class="table-wrap" style="max-height:200px">
							<table>
								<tbody>
									${assets.slice(0, 12).map(
										(asset) => html`<tr>
											<td class="nowrap"><span class="chip chip-muted">${asset.type}</span></td>
											<td class="tiny mono break">${asset.value}</td>
											<td class="nowrap tiny muted">${relTime(asset.lastSeen)}</td>
										</tr>`,
									)}
								</tbody>
							</table>
						</div>
						${assets.length > 12 ? html`<div class="tiny muted mt-8">仅显示前 12 条，共 ${assets.length} 条</div>` : ""}`
					: html`<div class="tiny muted">还没有挂在这家公司名下的资产。</div>`}
			</div>
			<div>
				<div class="traffic-cap">发现（${findings.length}）</div>
				${findings.length
					? html`<div class="table-wrap" style="max-height:200px">
							<table>
								<tbody>
									${findings.slice(0, 12).map(
										(finding) => html`<tr>
											<td class="tiny">${finding.title}<div class="tiny muted break">${finding.target}</div></td>
											<td class="nowrap">${severityChip(finding.severity)}</td>
										</tr>`,
									)}
								</tbody>
							</table>
						</div>`
					: html`<div class="tiny muted">暂无发现。</div>`}
			</div>
		</div>
	`;
}

function openForm(company, ctx) {
	const overlay = openOverlay(html`
		<div class="overlay-head"><h3>${company ? "编辑公司" : "新建公司"}</h3></div>
		<div class="overlay-body">
			<label class="field">
				<span>名称</span>
				<input data-name value="${company?.name ?? ""}" placeholder="某某科技有限公司" />
			</label>
			<label class="field">
				<span>联系人</span>
				<input data-contact value="${company?.contact ?? ""}" placeholder="张三 / 安全负责人" />
			</label>
			<label class="field mb-0">
				<span>备注</span>
				<textarea data-note rows="3">${company?.note ?? ""}</textarea>
			</label>
		</div>
		<div class="overlay-foot">
			<button class="btn ghost" data-close>取消</button>
			<button class="btn primary" data-save>保存</button>
		</div>
	`);
	overlay.panel.querySelector("[data-name]").focus();
	overlay.panel.querySelector("[data-save]").addEventListener("click", async () => {
		try {
			await api.post("/api/companies", {
				id: company?.id,
				name: overlay.panel.querySelector("[data-name]").value.trim(),
				contact: overlay.panel.querySelector("[data-contact]").value.trim(),
				note: overlay.panel.querySelector("[data-note]").value.trim(),
			});
			overlay.close();
			toast("已保存", "success");
			ctx.reload();
		} catch (error) {
			toast(error.message, "error");
		}
	});
}
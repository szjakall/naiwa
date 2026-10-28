/**
 * 公司（客户维度）：一个控制台服务多个客户时，这是唯一不会串数据的隔离维度。
 * 不建公司时所有数据归"未归属"，行为与之前一致。
 */

import { icon } from "../icons.js";
import { api, fmtTime, html, mount, openOverlay, raw, relTime, toast, toNode } from "../core.js";
import { card, emptyState, inlineError, loading } from "../ui.js";

export default {
	title: "公司",
	subtitle: "客户维度与数据归属",

	async render(root, ctx) {
		mount(root, loading("读取公司…"));
		let items;
		try {
			items = (await api.get("/api/companies")).items;
		} catch (error) {
			mount(root, inlineError(error.message));
			return;
		}

		const actions = toNode(html`<button class="btn primary small" id="new-company">${raw(icon("plus", { size: 15 }))}新建公司</button>`);
		ctx.setHeader("公司", `${items.length} 家`, actions);
		actions.querySelector("#new-company").addEventListener("click", () => openForm(null, ctx));

		const paint = () => {
			const body = items.length
				? html`<div class="table-wrap">
						<table>
							<thead>
								<tr><th>名称</th><th class="nowrap">联系人</th><th class="nowrap">资产</th><th class="nowrap">发现</th><th class="nowrap">报告</th><th class="nowrap">任务</th><th></th></tr>
							</thead>
							<tbody>
								${items.map(
									(company) => html`<tr>
										<td>
											<div class="dim">${company.name}</div>
											${company.note ? html`<div class="tiny muted">${company.note}</div>` : ""}
										</td>
										<td class="nowrap tiny">${company.contact || "—"}</td>
										<td class="mono tiny">${company.counts.assets}</td>
										<td class="mono tiny">${company.counts.findings}</td>
										<td class="mono tiny">${company.counts.reports}</td>
										<td class="mono tiny">${company.counts.tasks}</td>
										<td class="nowrap center">
											<button class="btn ghost small" data-edit="${company.id}">编辑</button>
											<button class="btn-icon danger" data-del="${company.id}" title="删除">${raw(icon("trash", { size: 16 }))}</button>
										</td>
									</tr>`,
								)}
							</tbody>
						</table>
					</div>`
				: emptyState({
						iconName: "layers",
						title: "还没有公司记录",
						description: "建立公司后，可以把任务产生的资产、发现、报告归到具体客户名下，导出时按客户隔离。",
					});

			mount(
				root,
				html`
					<div class="hint-box page-section">
						${raw(icon("alert", { size: 16 }))}
						<span>归属是可选的：不建公司也能正常用，所有数据留在"未归属"。删除公司前需要先把它名下的数据转走或删掉。</span>
					</div>
					${card({ body, tight: true })}
				`,
			);

			root.querySelectorAll("[data-edit]").forEach((node) =>
				node.addEventListener("click", () => openForm(items.find((i) => i.id === node.dataset.edit), ctx)),
			);
			root.querySelectorAll("[data-del]").forEach((node) =>
				node.addEventListener("click", async () => {
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
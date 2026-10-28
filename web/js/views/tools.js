/**
 * 工具：能力开关。关掉后对应接口直接 403（不是藏按钮）。
 */

import { icon } from "../icons.js";
import { api, html, mount, raw, relTime, toast, toNode } from "../core.js";
import { card, emptyState, inlineError, loading } from "../ui.js";

export default {
	title: "工具",
	subtitle: "能力开关与调用统计",

	async render(root, ctx) {
		mount(root, loading("读取工具清单…"));
		let payload;
		try {
			payload = await api.get("/api/tools");
		} catch (error) {
			mount(root, inlineError(error.message));
			return;
		}

		let tools = payload.tools;
		const groups = payload.groups;

		const actions = toNode(html`<span class="chip chip-muted">${payload.stats.enabled}/${payload.stats.total} 已启用 · 调用 ${payload.stats.calls} 次</span>`);
		ctx.setHeader("工具", "能力开关与调用统计", actions);

		const paint = () => {
			const sections = groups.map((group) => {
				const items = tools.filter((t) => t.group === group);
				if (items.length === 0) return "";
				return card({
					title: group,
					sub: `${items.filter((t) => t.enabled).length}/${items.length} 启用`,
					tight: true,
					body: html`<div class="table-wrap">
						<table>
							<tbody>
								${items.map(
									(tool) => html`<tr>
										<td class="nowrap">
											<label class="checkbox">
												<input type="checkbox" data-toggle="${tool.id}" ${tool.enabled ? "checked" : ""} />
											</label>
										</td>
										<td>
											<div class="dim ${tool.enabled ? "" : "muted"}">${tool.name}<span class="tiny muted"> · ${tool.id}</span></div>
											<div class="tiny muted">${tool.desc}</div>
										</td>
										<td class="nowrap mono tiny">${tool.calls}</td>
										<td class="nowrap tiny muted">${tool.lastUsedAt ? relTime(tool.lastUsedAt) : "未使用"}</td>
									</tr>`,
								)}
							</tbody>
						</table>
					</div>`,
				});
			});

			mount(
				root,
				html`
					<div class="hint-box page-section">
						${raw(icon("shield", { size: 16 }))}
						<span>关掉一个工具后，它对应的接口会直接返回 403——不是只把入口藏起来。
						这会影响所有用户；要按人控制请去「权限」。</span>
					</div>
					<div class="grid" style="gap:14px">${sections}</div>
				`,
			);

			root.querySelectorAll("[data-toggle]").forEach((node) =>
				node.addEventListener("change", async () => {
					try {
						const result = await api.put(`/api/tools/${node.dataset.toggle}`, { enabled: node.checked });
						tools = tools.map((t) => (t.id === result.tool.id ? { ...t, ...result.tool } : t));
						toast(`${result.tool.name} 已${result.tool.enabled ? "启用" : "停用"}`, "success");
						paint();
					} catch (error) {
						toast(error.message, "error");
						node.checked = !node.checked;
					}
				}),
			);
		};

		paint();
	},
};
/**
 * 报告：按任务或按"全部未关闭发现"生成 Markdown，可预览、下载、删除。
 * 预览走自带的极简 Markdown 渲染，样式和最终文件一致，省一次下载往返。
 */

import { icon } from "../icons.js";
import { api, html, mount, openOverlay, raw, relTime, renderMarkdown, toast, toNode } from "../core.js";
import { card, emptyState, inlineError, loading } from "../ui.js";

export default {
	title: "报告",
	subtitle: "把一次评估的资产与发现整理成可交付文档",

	async render(root, ctx) {
		mount(root, loading());
		let [reports, tasks] = await Promise.all([api.get("/api/reports"), api.get("/api/tasks")]).catch((error) => {
			mount(root, inlineError(error.message));
			return [[], []];
		});

		const actions = toNode(html`<button class="btn primary small" id="new-report">
			${raw(icon("plus", { size: 15 }))}生成报告
		</button>`);
		ctx.setHeader("报告", `共 ${reports.length} 份`, actions);

		const preview = async (report) => {
			let markdown = "";
			try {
				markdown = await api.text(`/api/reports/${report.id}/raw`);
			} catch (error) {
				return toast(error.message, "error");
			}
			const overlay = openOverlay(
				html`
					<div class="overlay-head">
						<h3 style="margin:0">${report.title}</h3>
						<div class="spacer"></div>
						<button class="btn ghost small" data-download>${raw(icon("download", { size: 15 }))}下载 .md</button>
						<button class="btn-icon" data-close>${raw(icon("x", { size: 16 }))}</button>
					</div>
					<div class="overlay-body"><div class="md">${raw(renderMarkdown(markdown))}</div></div>
				`,
				{ wide: true },
			);
			overlay.panel.querySelector("[data-download]").addEventListener("click", () => {
				const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
				const url = URL.createObjectURL(blob);
				const link = document.createElement("a");
				link.href = url;
				link.download = `${report.title.replace(/[\\/:*?"<>|]/g, "_")}.md`;
				link.click();
				setTimeout(() => URL.revokeObjectURL(url), 2000);
			});
		};

		const openForm = () => {
			const taskOptions = tasks
				.map((task) => `<option value="${task.id}">${task.title}（${task.scope?.length ?? 0} 个目标）</option>`)
				.join("");
			const overlay = openOverlay(html`
				<div class="overlay-head"><h3>生成报告</h3></div>
				<div class="overlay-body">
					<label class="field">
						<span>报告标题</span>
						<input data-title placeholder="留空则用任务名 + 评估报告" />
					</label>
					<label class="field">
						<span>数据范围</span>
						<select data-task>
							<option value="">全部未关闭发现</option>
							${raw(taskOptions)}
						</select>
						<span class="hint">可选某个任务的资产、发现与请求流水；也可以汇总所有未关闭的发现。</span>
					</label>
				</div>
				<div class="overlay-foot">
					<button class="btn ghost" data-close>取消</button>
					<button class="btn primary" data-create>生成</button>
				</div>
			`);
			overlay.panel.querySelector("[data-create]").addEventListener("click", async () => {
				const button = overlay.panel.querySelector("[data-create]");
				button.disabled = true;
				button.textContent = "生成中…";
				try {
					const result = await api.post("/api/reports", {
						title: overlay.panel.querySelector("[data-title]").value.trim(),
						taskId: overlay.panel.querySelector("[data-task]").value || undefined,
					});
					overlay.close();
					toast("报告已生成", "success");
					reports = [result.report, ...reports];
					paint();
				} catch (error) {
					toast(error.message, "error");
					button.disabled = false;
					button.textContent = "生成";
				}
			});
		};

		actions.querySelector("#new-report").addEventListener("click", openForm);

		const paint = () => {
			const body = reports.length
				? html`<div class="table-wrap">
						<table>
							<thead>
								<tr>
									<th>标题</th>
									<th class="nowrap">发现</th>
									<th class="nowrap">资产</th>
									<th class="nowrap">大小</th>
									<th class="nowrap">生成时间</th>
									<th></th>
								</tr>
							</thead>
							<tbody>
								${reports.map(
									(report) => html`<tr>
										<td>
											<div class="dim">${report.title}</div>
											<div class="tiny muted">${report.taskId ? `任务 ${report.taskId}` : "全局汇总"}</div>
										</td>
										<td class="mono">${report.findings}</td>
										<td class="mono">${report.assets}</td>
										<td class="mono tiny">${Math.max(1, Math.round((report.size ?? 0) / 1024))} KB</td>
										<td class="nowrap tiny muted">${relTime(report.createdAt)}</td>
										<td class="nowrap center">
											<button class="btn ghost small" data-preview="${report.id}">预览</button>
											<button class="btn-icon danger" data-del="${report.id}" title="删除">
												${raw(icon("trash", { size: 16 }))}
											</button>
										</td>
									</tr>`,
								)}
							</tbody>
						</table>
					</div>`
				: emptyState({
						iconName: "reports",
						title: "还没有报告",
						description: "跑完一个任务后点「生成报告」，会把资产清单、发现详情与请求流水整理成一份 Markdown。",
						action: html`<button class="btn primary small mt-8" id="empty-create">生成第一份报告</button>`,
					});

			mount(root, card({ body, tight: true }));
			root.querySelector("#empty-create")?.addEventListener("click", openForm);
			root.querySelectorAll("[data-preview]").forEach((node) =>
				node.addEventListener("click", () => {
					const report = reports.find((entry) => entry.id === node.dataset.preview);
					if (report) preview(report);
				}),
			);
			root.querySelectorAll("[data-del]").forEach((node) =>
				node.addEventListener("click", async () => {
					try {
						await api.del(`/api/reports/${node.dataset.del}`);
						reports = reports.filter((report) => report.id !== node.dataset.del);
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
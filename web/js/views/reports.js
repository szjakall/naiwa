/**
 * 报告：按**勾选的漏洞** / 某个任务 / 全部未关闭发现 生成 Markdown，可预览、下载、删除。
 * 预览走自带的极简 Markdown 渲染，样式和最终文件一致，省一次下载往返。
 */

import { icon } from "../icons.js";
import { api, html, mount, openOverlay, raw, relTime, renderMarkdown, toast, toNode } from "../core.js";
import { card, emptyState, inlineError, loading } from "../ui.js";

const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

export default {
	title: "报告",
	subtitle: "把一次评估的资产与发现整理成可交付文档",

	async render(root, ctx) {
		mount(root, loading());
		let [reports, tasks, findings] = await Promise.all([
			api.get("/api/reports"),
			api.get("/api/tasks"),
			api.get("/api/findings").catch(() => []),
		]).catch((error) => {
			mount(root, inlineError(error.message));
			return [[], [], []];
		});
		// 已关闭的不进候选：报告写的是待处理问题
		findings = (findings ?? []).filter((item) => item.status !== "closed");
		tasks = tasks ?? [];

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

			// 漏洞候选按等级排序，方便一眼挑高危
			const sorted = [...findings].sort(
				(a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9),
			);
			const findingRows = sorted.length
				? sorted
						.map(
							(finding) => html`<label class="report-finding">
								<input type="checkbox" data-finding="${finding.id}" />
								<span class="chip sev-${finding.severity}">${finding.severity}</span>
								<span class="report-finding-title">${finding.title}</span>
								<span class="tiny muted nowrap">${finding.target ?? ""}</span>
							</label>`,
						)
				: html`<div class="muted small">没有待处理的漏洞。</div>`;

			const overlay = openOverlay(html`
				<div class="overlay-head"><h3>生成报告</h3></div>
				<div class="overlay-body">
					<label class="field">
						<span>报告标题</span>
						<input data-title placeholder="留空则按取材方式自动命名" />
					</label>
					<label class="field">
						<span>数据范围</span>
						<select data-task>
							<option value="">全部未关闭发现</option>
							${raw(taskOptions)}
						</select>
						<span class="hint">可选某个任务的资产、发现与请求流水；也可以汇总所有未关闭的发现。</span>
					</label>
					<div class="field">
						<div class="row" style="margin-bottom:6px">
							<span>只写选中的漏洞</span>
							<span class="tiny muted">（勾选后优先于上面的"数据范围"）</span>
							<div class="spacer"></div>
							<button class="btn ghost small" data-all>全选</button>
							<button class="btn ghost small" data-high>仅高危以上</button>
							<button class="btn ghost small" data-none>清空</button>
						</div>
						<div class="report-findings">${findingRows}</div>
						<span class="hint">不勾选 = 按上面的范围全部写；勾选 = 只写勾中的这几条，资产也只带它们所属的。</span>
					</div>
				</div>
				<div class="overlay-foot">
					<button class="btn ghost" data-close>取消</button>
					<button class="btn primary" data-create>生成</button>
				</div>
			`, { wide: true });

			const boxes = () => [...overlay.panel.querySelectorAll("[data-finding]")];
			overlay.panel.querySelector("[data-all]").addEventListener("click", () => boxes().forEach((b) => (b.checked = true)));
			overlay.panel.querySelector("[data-none]").addEventListener("click", () => boxes().forEach((b) => (b.checked = false)));
			overlay.panel.querySelector("[data-high]").addEventListener("click", () => {
				for (const box of boxes()) {
					const row = box.closest(".report-finding");
					const sev = row?.querySelector(".chip")?.textContent?.trim();
					box.checked = sev === "critical" || sev === "high";
				}
			});

			overlay.panel.querySelector("[data-create]").addEventListener("click", async () => {
				const button = overlay.panel.querySelector("[data-create]");
				const findingIds = boxes().filter((b) => b.checked).map((b) => b.dataset.finding);
				button.disabled = true;
				button.textContent = "生成中…";
				try {
					const result = await api.post("/api/reports", {
						title: overlay.panel.querySelector("[data-title]").value.trim(),
						// 勾了漏洞就不再传任务范围：服务端以 findingIds 优先
						taskId: findingIds.length ? undefined : overlay.panel.querySelector("[data-task]").value || undefined,
						findingIds: findingIds.length ? findingIds : undefined,
					});
					overlay.close();
					toast(`报告已生成（${result.report.findings} 条发现）`, "success");
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
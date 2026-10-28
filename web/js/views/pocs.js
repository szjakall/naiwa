/**
 * POC 库：导入 Nuclei 模板、检索、看原文。
 * 只做索引与参考，不执行——执行是操作员自己在终端里跑 nuclei 的事。
 */

import { icon } from "../icons.js";
import { api, fmtBytes, html, mount, openOverlay, raw, relTime, severityChip, toast, toNode } from "../core.js";
import { card, emptyState, inlineError, loading } from "../ui.js";

export default {
	title: "POC 库",
	subtitle: "Nuclei 模板导入与检索",

	async render(root, ctx) {
		mount(root, loading("读取 POC 库…"));
		let payload;
		try {
			payload = await api.get("/api/pocs");
		} catch (error) {
			mount(root, inlineError(error.message));
			return;
		}

		let items = payload.items;
		let stats = payload.stats;
		let search = "";
		let severity = "";

		const actions = toNode(html`
			<button class="btn ghost small" id="seed">导入示例</button>
			<button class="btn primary small" id="import">${raw(icon("upload", { size: 15 }))}导入模板</button>
		`);
		ctx.setHeader("POC 库", `${stats.total} 个模板`, actions);

		actions.querySelector("#seed").addEventListener("click", async () => {
			try {
				await api.post("/api/pocs/seed", {});
				toast("已导入示例模板", "success");
				ctx.reload();
			} catch (error) {
				toast(error.message, "error");
			}
		});
		actions.querySelector("#import").addEventListener("click", () => openImport(ctx));

		const paint = async () => {
			const params = new URLSearchParams();
			if (search) params.set("search", search);
			if (severity) params.set("severity", severity);
			const fresh = await api.get(`/api/pocs?${params}`);
			items = fresh.items;
			stats = fresh.stats;

			const body = items.length
				? html`<div class="table-wrap" style="max-height:62vh">
						<table>
							<thead>
								<tr><th class="nowrap">等级</th><th>模板</th><th class="nowrap">标签</th><th class="nowrap">协议</th><th class="nowrap">加入</th></tr>
							</thead>
							<tbody>
								${items.map(
									(poc) => html`<tr data-poc="${poc.id}" style="cursor:pointer">
										<td>${severityChip(poc.severity === "unknown" ? "info" : poc.severity)}</td>
										<td>
											<div class="dim">${poc.name}</div>
											<div class="tiny muted mono">${poc.id}</div>
											${poc.description ? html`<div class="tiny muted" style="margin-top:2px">${poc.description.slice(0, 120)}</div>` : ""}
										</td>
										<td class="nowrap tiny muted">${poc.tags.slice(0, 4).join(" ")}</td>
										<td class="nowrap tiny mono">${poc.protocols.join(",") || "—"}</td>
										<td class="nowrap tiny muted">${relTime(poc.addedAt)}</td>
									</tr>`,
								)}
							</tbody>
						</table>
					</div>`
				: emptyState({
						iconName: "file",
						title: stats.total === 0 ? "POC 库是空的" : "没有匹配的模板",
						description:
							stats.total === 0
								? "粘贴 Nuclei YAML 模板，或填一个订阅地址。也可以先点「导入示例」看看长什么样。"
								: "换个关键词或清除等级过滤试试。",
					});

			mount(
				root,
				html`
					<div class="grid grid-4 page-section">
						${["critical", "high", "medium", "low"].map(
							(level) => html`<div class="stat" style="cursor:pointer" data-filter="${level}">
								<div class="stat-label">${level}</div>
								<div class="stat-value">${stats.bySeverity[level] ?? 0}</div>
							</div>`,
						)}
					</div>
					<div class="page-section row">
						<input id="poc-search" placeholder="搜索 id / 名称 / 描述 / 标签" style="flex:1;min-width:220px" value="${search}" />
						<select id="poc-sev" style="max-width:150px">
							<option value="">全部等级</option>
							${["critical", "high", "medium", "low", "info"].map(
								(level) => html`<option value="${level}" ${severity === level ? "selected" : ""}>${level}</option>`,
							)}
						</select>
					</div>
					${stats.topTags.length
						? html`<div class="page-section row" style="gap:6px">
								<span class="tiny muted">热门标签：</span>
								${stats.topTags.slice(0, 12).map(
									(item) => html`<span class="chip chip-muted" style="cursor:pointer" data-tag="${item.tag}">${item.tag} ${item.count}</span>`,
								)}
							</div>`
						: ""}
					${card({ body, tight: true })}
				`,
			);

			const doSearch = async () => {
				search = root.querySelector("#poc-search").value.trim();
				severity = root.querySelector("#poc-sev").value;
				await paint();
			};
			root.querySelector("#poc-search").addEventListener("keydown", (event) => {
				if (event.key === "Enter") doSearch();
			});
			root.querySelector("#poc-sev").addEventListener("change", doSearch);
			root.querySelectorAll("[data-filter]").forEach((node) =>
				node.addEventListener("click", async () => {
					severity = severity === node.dataset.filter ? "" : node.dataset.filter;
					await paint();
				}),
			);
			root.querySelectorAll("[data-tag]").forEach((node) =>
				node.addEventListener("click", async () => {
					search = node.dataset.tag;
					await paint();
				}),
			);
			root.querySelectorAll("[data-poc]").forEach((node) =>
				node.addEventListener("click", () => openPoc(node.dataset.poc)),
			);
		};

		await paint();
	},
};

function openPoc(id) {
	api
		.get(`/api/pocs/${encodeURIComponent(id)}`)
		.then((poc) => {
			const overlay = openOverlay(
				html`
					<div class="overlay-head">
						${severityChip(poc.severity === "unknown" ? "info" : poc.severity)}
						<h3 style="margin:0">${poc.name}</h3>
						<div class="spacer"></div>
						<button class="btn-icon" data-close>${raw(icon("x", { size: 16 }))}</button>
					</div>
					<div class="overlay-body">
						<dl class="kv">
							<dt>ID</dt><dd>${poc.id}</dd>
							<dt>作者</dt><dd>${poc.author || "—"}</dd>
							<dt>协议</dt><dd>${poc.protocols.join(", ") || "—"}</dd>
							<dt>标签</dt><dd>${poc.tags.join(", ") || "—"}</dd>
							<dt>来源</dt><dd>${poc.source}</dd>
						</dl>
						${poc.description ? html`<div class="apk-section"><h4>说明</h4><p class="dim small">${poc.description}</p></div>` : ""}
						<div class="apk-section">
							<h4>模板原文</h4>
							<pre class="md-code" style="max-height:340px;overflow:auto;padding:12px;border-radius:9px;background:#070b10;border:1px solid var(--line-soft);white-space:pre-wrap">${poc.content}</pre>
						</div>
					</div>
					<div class="overlay-foot">
						<button class="btn danger small" data-del>删除</button>
						<div class="spacer"></div>
						<button class="btn ghost" data-close>关闭</button>
					</div>
				`,
				{ wide: true },
			);
			overlay.panel.querySelector("[data-del]").addEventListener("click", async () => {
				try {
					await api.del(`/api/pocs/${encodeURIComponent(id)}`);
					overlay.close();
					toast("已删除", "success");
				} catch (error) {
					toast(error.message, "error");
				}
			});
		})
		.catch((error) => toast(error.message, "error"));
}

function openImport(ctx) {
	const overlay = openOverlay(html`
		<div class="overlay-head"><h3>导入 POC 模板</h3></div>
		<div class="overlay-body">
			<label class="field">
				<span>粘贴 Nuclei YAML（多份用 --- 分隔）</span>
				<textarea data-text rows="10" placeholder="id: my-poc&#10;info:&#10;  name: 示例&#10;  severity: high"></textarea>
			</label>
			<label class="field">
				<span>或从订阅地址拉取</span>
				<input data-url placeholder="https://example.com/nuclei-templates.zip 或 .yaml" />
				<span class="hint">本地文件请用「选择文件」——浏览器的文件选择不会把内容塞进请求体。</span>
			</label>
			<label class="field">
				<span>选择本地文件</span>
				<input type="file" data-file accept=".yaml,.yml,.txt,application/zip" multiple />
			</label>
		</div>
		<div class="overlay-foot">
			<button class="btn ghost" data-close>取消</button>
			<button class="btn primary" data-import>导入</button>
		</div>
	`, { wide: true });

	const fileInput = overlay.panel.querySelector("[data-file]");
	const textArea = overlay.panel.querySelector("[data-text]");
	fileInput.addEventListener("change", async () => {
		const files = [...(fileInput.files ?? [])];
		if (files.length === 0) return;
		const parts = [];
		for (const file of files) {
			if (/\.(yaml|yml|txt)$/i.test(file.name)) parts.push(await file.text());
		}
		if (parts.length === 0) return toast("只支持 .yaml/.yml/.txt（zip 请用订阅地址）", "error");
		textArea.value = parts.join("\n---\n");
	});

	overlay.panel.querySelector("[data-import]").addEventListener("click", async () => {
		const text = textArea.value.trim();
		const url = overlay.panel.querySelector("[data-url]").value.trim();
		try {
			let result;
			if (url) result = await api.post("/api/pocs/import", { url });
			else if (text) result = await api.post("/api/pocs/import", { text });
			else return toast("没有可导入的内容", "error");
			overlay.close();
			toast(`导入完成：新增 ${result.added ?? 0}，更新 ${result.merged ?? 0}`, "success");
			ctx.reload();
		} catch (error) {
			toast(error.message, "error");
		}
	});
}
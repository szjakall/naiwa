/**
 * 知识库：上传文档 → 自动分块 → 本地检索。
 * 检索结果给命中片段与命中词数，方便判断"是不是真的命中"。
 */

import { icon } from "../icons.js";
import { api, fmtBytes, fmtTime, html, mount, openOverlay, raw, relTime, toast, toNode } from "../core.js";
import { card, emptyState, inlineError, loading } from "../ui.js";

const CATEGORY_LABEL = {
	general: "通用",
	web: "Web 安全",
	mobile: "移动端",
	network: "内网与网络",
	report: "报告与交付",
	custom: "自定义",
};

export default {
	title: "知识库",
	subtitle: "文档分块与本地检索（BM25）",

	async render(root, ctx) {
		mount(root, loading("读取知识库…"));
		let payload;
		try {
			payload = await api.get("/api/knowledge");
		} catch (error) {
			mount(root, inlineError(error.message));
			return;
		}

		let docs = payload.docs;
		const stats = payload.stats;
		let query = "";
		let results = null;
		let category = "all";

		const actions = toNode(html`<button class="btn primary small" id="upload">${raw(icon("plus", { size: 15 }))}添加文档</button>`);
		ctx.setHeader("知识库", `${stats.docs} 篇 · ${stats.chunks} 块 · ${fmtBytes(stats.bytes)}`, actions);
		actions.querySelector("#upload").addEventListener("click", () => openUpload(ctx));

		const paint = () => {
			const searchResults = results
				? results.items.length
					? html`<div class="table-wrap" style="max-height:420px">
							<table>
								<thead>
									<tr><th class="nowrap">得分</th><th>命中片段</th><th class="nowrap">来源</th></tr>
								</thead>
								<tbody>
									${results.items.map(
										(item) => html`<tr>
											<td class="nowrap mono tiny">${item.score}<div class="tiny muted">${item.hits} 词</div></td>
											<td class="break small">${item.text.slice(0, 320)}${item.text.length > 320 ? "…" : ""}</td>
											<td class="nowrap tiny">
												<div class="dim">${item.docTitle}</div>
												<div class="muted">${CATEGORY_LABEL[item.category] ?? item.category} · #${item.index}</div>
											</td>
										</tr>`,
									)}
								</tbody>
							</table>
						</div>`
					: emptyState({ iconName: "search", title: "没有命中", description: `查询「${query}」在知识库里没有匹配片段。试试更短的关键词。` })
				: null;

			const docTable = docs.length
				? html`<div class="table-wrap" style="max-height:420px">
						<table>
							<thead>
								<tr><th>标题</th><th class="nowrap">分类</th><th class="nowrap">块数</th><th class="nowrap">大小</th><th class="nowrap">加入时间</th><th></th></tr>
							</thead>
							<tbody>
								${docs.map(
									(doc) => html`<tr>
										<td class="dim">${doc.title}</td>
										<td class="nowrap"><span class="chip chip-muted">${CATEGORY_LABEL[doc.category] ?? doc.category}</span></td>
										<td class="mono">${doc.chunkCount}</td>
										<td class="nowrap mono tiny">${fmtBytes(doc.size)}</td>
										<td class="nowrap tiny muted">${relTime(doc.at)}</td>
										<td class="nowrap center">
											<button class="btn ghost small" data-view="${doc.id}">查看</button>
											<button class="btn-icon danger" data-del="${doc.id}" title="删除">${raw(icon("trash", { size: 16 }))}</button>
										</td>
									</tr>`,
								)}
							</tbody>
						</table>
					</div>`
				: emptyState({
						iconName: "file",
						title: "知识库还是空的",
						description: "把报告、方法论、常见问题的处理笔记放进来，检索时按关键词找。",
					});

			mount(
				root,
				html`
					<div class="page-section row">
						<input id="kb-query" placeholder="检索知识库，例如：actuator 凭据泄露" style="flex:1;min-width:220px" value="${query}" />
						<select id="kb-category" style="max-width:150px">
							<option value="all">全部分类</option>
							${Object.entries(CATEGORY_LABEL).map(
								([id, label]) => html`<option value="${id}" ${category === id ? "selected" : ""}>${label}</option>`,
							)}
						</select>
						<button class="btn primary small" id="kb-search">检索</button>
						<button class="btn ghost small" id="kb-clear">清除</button>
					</div>
					${searchResults ? card({ title: "检索结果", sub: `${results.total} 条（显示前 ${results.items.length}）`, body: searchResults }) : ""}
					<div class="page-section"></div>
					${card({ title: "文档", sub: `${docs.length} 篇`, body: docTable, tight: true })}
				`,
			);

			const doSearch = async () => {
				const value = root.querySelector("#kb-query").value.trim();
				category = root.querySelector("#kb-category").value;
				if (!value) {
					results = null;
					query = "";
					paint();
					return;
				}
				query = value;
				try {
					results = await api.get(`/api/knowledge/search?q=${encodeURIComponent(value)}&category=${encodeURIComponent(category)}`);
					paint();
				} catch (error) {
					toast(error.message, "error");
				}
			};

			root.querySelector("#kb-search").addEventListener("click", doSearch);
			root.querySelector("#kb-query").addEventListener("keydown", (event) => {
				if (event.key === "Enter") doSearch();
			});
			root.querySelector("#kb-clear").addEventListener("click", () => {
				results = null;
				query = "";
				paint();
			});

			root.querySelectorAll("[data-view]").forEach((node) =>
				node.addEventListener("click", async () => {
					try {
						const doc = await api.get(`/api/knowledge/doc/${node.dataset.view}`);
						const overlay = openOverlay(
							html`
								<div class="overlay-head">
									<h3 style="margin:0">${doc.title}</h3>
									<div class="spacer"></div>
									<button class="btn-icon" data-close>${raw(icon("x", { size: 16 }))}</button>
								</div>
								<div class="overlay-body">
									<div class="row mb-12">
										<span class="chip chip-muted">${CATEGORY_LABEL[doc.category] ?? doc.category}</span>
										<span class="tiny muted">${doc.chunks.length} 块 · ${fmtBytes(doc.size)} · ${fmtTime(doc.at)}</span>
									</div>
									<div class="md" style="max-height:60vh">
										${doc.chunks.map(
											(chunk) => html`<div style="margin-bottom:14px">
												<div class="tiny muted">#${chunk.index}</div>
												<div style="white-space:pre-wrap">${chunk.text}</div>
											</div>`,
										)}
									</div>
								</div>
							`,
							{ wide: true },
						);
						overlay.panel.querySelector("[data-close]").addEventListener("click", () => overlay.close());
					} catch (error) {
						toast(error.message, "error");
					}
				}),
			);

			root.querySelectorAll("[data-del]").forEach((node) =>
				node.addEventListener("click", async () => {
					try {
						await api.del(`/api/knowledge/doc/${node.dataset.del}`);
						docs = docs.filter((d) => d.id !== node.dataset.del);
						results = null;
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

function openUpload(ctx) {
	const overlay = openOverlay(html`
		<div class="overlay-head"><h3>添加文档</h3></div>
		<div class="overlay-body">
			<label class="field">
				<span>标题</span>
				<input data-title placeholder="例如：Spring Actuator 暴露处置手册" />
			</label>
			<label class="field">
				<span>分类</span>
				<select data-category>
					${Object.entries(CATEGORY_LABEL).map(([id, label]) => html`<option value="${id}">${label}</option>`)}
				</select>
			</label>
			<label class="field">
				<span>内容（粘贴文本）</span>
				<textarea data-content rows="10" placeholder="支持 Markdown / 纯文本，会按段落自动分块"></textarea>
			</label>
			<label class="field">
				<span>或选择一个文本文件</span>
				<input type="file" data-file accept=".md,.txt,.json,.log,.yaml,.yml" />
			</label>
		</div>
		<div class="overlay-foot">
			<button class="btn ghost" data-close>取消</button>
			<button class="btn primary" data-save>导入</button>
		</div>
	`);

	const fileInput = overlay.panel.querySelector("[data-file]");
	fileInput.addEventListener("change", async () => {
		const file = fileInput.files?.[0];
		if (!file) return;
		const text = await file.text();
		overlay.panel.querySelector("[data-content]").value = text;
		const titleInput = overlay.panel.querySelector("[data-title]");
		if (!titleInput.value.trim()) titleInput.value = file.name.replace(/\.[^.]+$/, "");
	});

	overlay.panel.querySelector("[data-save]").addEventListener("click", async () => {
		const title = overlay.panel.querySelector("[data-title]").value.trim();
		const category = overlay.panel.querySelector("[data-category]").value;
		const content = overlay.panel.querySelector("[data-content]").value;
		if (!content.trim()) return toast("内容为空", "error");
		try {
			const result = await api.post("/api/knowledge/upload", { title, content, category });
			overlay.close();
			toast(result.duplicate ? "内容已存在，未重复导入" : `已导入，切成 ${result.chunks} 块`, "success");
			ctx.reload();
		} catch (error) {
			toast(error.message, "error");
		}
	});
}
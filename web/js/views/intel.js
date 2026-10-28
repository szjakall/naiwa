/**
 * 情报：资产测绘（FOFA/Quake/Hunter）+ Web 搜索（Tavily），两个标签页。
 * 都是"配好密钥才能用"，没配时给出去哪配的指引，不显示假结果。
 */

import { icon } from "../icons.js";
import { api, fmtTime, html, mount, openOverlay, raw, relTime, toast, toNode } from "../core.js";
import { card, emptyState, inlineError, loading } from "../ui.js";

export default {
	title: "情报",
	subtitle: "公网资产测绘与 Web 搜索",

	async render(root, ctx) {
		mount(root, loading("读取配置…"));
		let intel;
		let web;
		try {
			intel = await api.get("/api/intel");
			web = await api.get("/api/websearch");
		} catch (error) {
			mount(root, inlineError(error.message));
			return;
		}

		let tab = "intel";
		let results = null;
		const actions = toNode(html`<span></span>`);
		ctx.setHeader("情报", "公网资产测绘与 Web 搜索", actions);

		const paint = () => {
			const tabs = html`<div class="tabs mb-12">
				<button class="tab ${tab === "intel" ? "active" : ""}" data-tab="intel">资产测绘</button>
				<button class="tab ${tab === "web" ? "active" : ""}" data-tab="web">Web 搜索</button>
			</div>`;

			const intelPanel = html`
				<div class="grid" style="gap:14px">
					${intel.platforms.map(
						(platform) => html`<div class="card">
							<div class="card-head">
								<h3>${platform.label}</h3>
								<span class="sub">${platform.hint}</span>
								<div class="spacer"></div>
								${platform.available
									? html`<span class="chip chip-ok">可用</span>`
									: platform.enabled
										? html`<span class="chip chip-warn">待验证</span>`
										: html`<span class="chip chip-muted">未启用</span>`}
							</div>
							<div class="card-body">
								<div class="split-even" style="gap:12px">
									<label class="field">
										<span>API Key</span>
										<input data-key="${platform.id}" type="password" placeholder="${platform.hasKey ? platform.keyMask : "未配置"}" value="${platform.hasKey ? "••••••••" : ""}" />
									</label>
									<label class="field">
										<span>Base URL（留空用官方）</span>
										<input data-base="${platform.id}" placeholder="${platform.official}" value="${platform.baseUrl}" />
									</label>
								</div>
								<label class="checkbox mb-12">
									<input type="checkbox" data-enabled="${platform.id}" ${platform.enabled ? "checked" : ""} />
									<span>启用</span>
								</label>
								<div class="row">
									<button class="btn ghost small" data-save="${platform.id}">保存</button>
									<button class="btn ghost small" data-verify="${platform.id}" ${platform.hasKey ? "" : "disabled"}>验证密钥</button>
									${platform.verified ? html`<span class="tiny muted">已验证 ${relTime(platform.verifiedAt)}</span>` : ""}
								</div>
								${platform.available
									? html`<div class="row mt-12">
											<input data-query="${platform.id}" placeholder="查询语句" style="flex:1;min-width:200px" />
											<button class="btn primary small" data-run="${platform.id}">查询</button>
										</div>`
									: ""}
							</div>
						</div>`,
					)}
				</div>
				${intel.history.length
					? card({
							title: "查询流水",
							body: html`<div class="table-wrap" style="max-height:220px">
								<table>
									<tbody>
										${intel.history.slice(0, 20).map(
											(row) => html`<tr>
												<td class="nowrap tiny muted">${fmtTime(row.at).slice(5, 16)}</td>
												<td class="nowrap tiny">${row.platform}</td>
												<td class="break tiny mono">${row.query}</td>
												<td class="nowrap mono tiny">${row.hits}</td>
												<td class="nowrap mono tiny muted">${row.elapsedMs}ms</td>
											</tr>`,
										)}
									</tbody>
								</table>
							</div>`,
						})
					: ""}
			`;

			const webPanel = html`
				<div class="card">
					<div class="card-head">
						<h3>Tavily 搜索</h3>
						<span class="sub">公网搜索与页面抓取</span>
						<div class="spacer"></div>
						${web.available ? html`<span class="chip chip-ok">可用</span>` : html`<span class="chip chip-muted">未配置</span>`}
					</div>
					<div class="card-body">
						<label class="checkbox mb-12">
							<input type="checkbox" id="web-enabled" ${web.enabled ? "checked" : ""} />
							<span>启用 Web 搜索</span>
						</label>
						<div class="row mb-12">
							<input id="web-key" placeholder="粘贴 Tavily API Key" style="flex:1;min-width:200px" />
							<button class="btn ghost small" id="web-add">添加</button>
						</div>
						${web.keys.length
							? html`<div class="permission-list mb-12">
									${web.keys.map(
										(k) => html`<span class="permission">${k.mask} · 用 ${k.uses} 次
											<button class="btn-link" data-del-key="${k.id}" style="margin-left:6px">删</button>
										</span>`,
									)}
								</div>`
							: html`<div class="tiny muted mb-12">还没有密钥。支持多把轮换，按使用次数自动选最少的那把。</div>`}
						<div class="row">
							<input id="web-query" placeholder="搜索关键词" style="flex:1;min-width:200px" />
							<button class="btn primary small" id="web-search" ${web.available ? "" : "disabled"}>搜索</button>
						</div>
					</div>
				</div>
				${web.history.length
					? card({
							title: "搜索流水",
							body: html`<div class="table-wrap" style="max-height:200px">
								<table>
									<tbody>
										${web.history.slice(0, 12).map(
											(row) => html`<tr>
												<td class="nowrap tiny muted">${fmtTime(row.at).slice(5, 16)}</td>
												<td class="break tiny">${row.query}</td>
												<td class="nowrap mono tiny">${row.ok ? row.hits ?? 0 : "失败"}</td>
											</tr>`,
										)}
									</tbody>
								</table>
							</div>`,
						})
					: ""}
			`;

			mount(
				root,
				html`
					${tabs}
					${tab === "intel" ? intelPanel : webPanel}
					${results ? html`<div class="page-section">${card({ title: "查询结果", body: renderResults(results), tight: true })}</div>` : ""}
				`,
			);

			wire();
		};

		const renderResults = (data) => {
			if (data.kind === "intel") {
				if (data.results.length === 0) {
					return emptyState({ iconName: "search", title: "没有命中", description: `查询「${data.query}」没有返回结果。` });
				}
				return html`<div class="table-wrap" style="max-height:48vh">
					<table>
						<thead><tr><th>主机</th><th class="nowrap">IP:端口</th><th>标题</th><th class="nowrap">服务</th></tr></thead>
						<tbody>
							${data.results.map(
								(row) => html`<tr>
									<td class="break tiny mono">${row.host}</td>
									<td class="nowrap mono tiny">${row.ip}:${row.port}</td>
									<td class="tiny">${row.title || "—"}</td>
									<td class="nowrap tiny muted">${row.server || row.protocol || "—"}</td>
								</tr>`,
							)}
						</tbody>
					</table>
				</div>`;
			}
			if (data.kind === "web") {
				if (data.results.length === 0) {
					return emptyState({ iconName: "search", title: "没有结果", description: `查询「${data.query}」没有返回内容。` });
				}
				return html`
					${data.answer ? html`<div class="hint-box mb-12">${raw(icon("spark", { size: 16 }))}<span>${data.answer}</span></div>` : ""}
					<div class="table-wrap" style="max-height:48vh">
						<table>
							<tbody>
								${data.results.map(
									(row) => html`<tr>
										<td>
											<a href="${row.url}" target="_blank" rel="noreferrer" class="dim">${row.title}</a>
											<div class="tiny muted break">${row.url}</div>
											<div class="tiny muted" style="margin-top:4px">${row.content.slice(0, 220)}…</div>
										</td>
										<td class="nowrap mono tiny">${row.score.toFixed(2)}</td>
									</tr>`,
								)}
							</tbody>
						</table>
					</div>`;
			}
			return "";
		};

		const wire = () => {
			root.querySelectorAll("[data-tab]").forEach((node) =>
				node.addEventListener("click", () => {
					tab = node.dataset.tab;
					paint();
				}),
			);

			// 资产测绘
			root.querySelectorAll("[data-save]").forEach((node) =>
				node.addEventListener("click", async () => {
					const id = node.dataset.save;
					try {
						await api.put(`/api/intel/${id}`, {
							key: root.querySelector(`[data-key="${id}"]`).value,
							baseUrl: root.querySelector(`[data-base="${id}"]`).value,
							enabled: root.querySelector(`[data-enabled="${id}"]`).checked,
						});
						toast("已保存（换密钥后需要重新验证）", "success");
						ctx.reload();
					} catch (error) {
						toast(error.message, "error");
					}
				}),
			);
			root.querySelectorAll("[data-verify]").forEach((node) =>
				node.addEventListener("click", async () => {
					node.disabled = true;
					node.textContent = "验证中…";
					try {
						const result = await api.post(`/api/intel/${node.dataset.verify}/verify`, {});
						toast(result.message, result.ok ? "success" : "error", 6000);
						ctx.reload();
					} catch (error) {
						toast(error.message, "error");
						node.disabled = false;
						node.textContent = "验证密钥";
					}
				}),
			);
			root.querySelectorAll("[data-run]").forEach((node) =>
				node.addEventListener("click", async () => {
					const id = node.dataset.run;
					const query = root.querySelector(`[data-query="${id}"]`).value.trim();
					if (!query) return toast("查询语句为空", "error");
					node.disabled = true;
					try {
						const result = await api.post(`/api/intel/${id}/query`, { query });
						results = { kind: "intel", query, results: result.results };
						paint();
						toast(`命中 ${result.results.length} 条（${result.elapsedMs}ms）`, "success");
					} catch (error) {
						toast(error.message, "error", 6000);
					} finally {
						node.disabled = false;
					}
				}),
			);

			// Web 搜索
			const enabledNode = root.querySelector("#web-enabled");
			if (enabledNode) {
				enabledNode.addEventListener("change", async () => {
					try {
						await api.put("/api/websearch", { enabled: enabledNode.checked });
						ctx.reload();
					} catch (error) {
						toast(error.message, "error");
					}
				});
			}
			const addKey = root.querySelector("#web-add");
			if (addKey) {
				addKey.addEventListener("click", async () => {
					const key = root.querySelector("#web-key").value.trim();
					if (!key) return toast("密钥为空", "error");
					try {
						await api.put("/api/websearch", { key });
						toast("已添加", "success");
						ctx.reload();
					} catch (error) {
						toast(error.message, "error");
					}
				});
			}
			root.querySelectorAll("[data-del-key]").forEach((node) =>
				node.addEventListener("click", async () => {
					try {
						await api.del(`/api/websearch/keys/${node.dataset.delKey}`);
						ctx.reload();
					} catch (error) {
						toast(error.message, "error");
					}
				}),
			);
			const searchButton = root.querySelector("#web-search");
			if (searchButton) {
				searchButton.addEventListener("click", async () => {
					const query = root.querySelector("#web-query").value.trim();
					if (!query) return toast("查询为空", "error");
					searchButton.disabled = true;
					try {
						const result = await api.post("/api/websearch/search", { query, limit: 8 });
						results = { kind: "web", query, results: result.results, answer: result.answer };
						paint();
						toast(`返回 ${result.results.length} 条（${result.elapsedMs}ms）`, "success");
					} catch (error) {
						toast(error.message, "error", 6000);
					} finally {
						searchButton.disabled = false;
					}
				});
			}
		};

		paint();
	},
};
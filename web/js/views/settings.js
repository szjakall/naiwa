/**
 * 设置：分组标签页。
 *
 * 为什么从"一页卡片"改成标签：配置面本来就有十几组（站点/引擎/模型/守门/
 * MCP/报告/技能/口令/系统），全部堆在一页要滚很久，改一个字段还得先找到它。
 * 分标签后每组都在固定位置，操作员记得住。
 */

import { icon } from "../icons.js";
import { api, html, mount, openOverlay, raw, toast, toNode } from "../core.js";
import { card, inlineError, loading } from "../ui.js";

const TABS = [
	{ id: "site", label: "站点" },
	{ id: "engine", label: "引擎" },
	{ id: "model", label: "模型" },
	{ id: "mcp", label: "MCP" },
	{ id: "report", label: "报告" },
	{ id: "skills", label: "技能" },
	{ id: "account", label: "账号" },
	{ id: "system", label: "系统" },
];

export default {
	title: "设置",
	subtitle: "站点、引擎与集成配置",

	async render(root, ctx) {
		mount(root, loading("读取配置…"));
		let settings;
		let system;
		let gate;
		let llm;
		let mcp;
		let reportSettings;
		let templates;
		try {
			[settings, system, gate, llm, mcp, reportSettings, templates] = await Promise.all([
				api.get("/api/settings"),
				api.get("/api/system"),
				api.get("/api/gatekeeper"),
				api.get("/api/llm"),
				api.get("/api/mcp"),
				api.get("/api/report-settings"),
				api.get("/api/report-templates"),
			]);
		} catch (error) {
			mount(root, inlineError(error.message));
			return;
		}

		let tab = ctx.param && TABS.some((t) => t.id === ctx.param) ? ctx.param : "site";

		const actions = toNode(html`<button class="btn primary small" id="save">${raw(icon("check", { size: 15 }))}保存当前页</button>`);
		ctx.setHeader("设置", "站点、引擎与集成配置", actions);

		const paint = () => {
			const tabsHtml = html`<div class="tabs mb-12">
				${TABS.map(
					(item) => html`<button class="tab ${item.id === tab ? "active" : ""}" data-tab="${item.id}">${item.label}</button>`,
				)}
			</div>`;

			let body = "";
			if (tab === "site") body = sitePanel(settings);
			else if (tab === "engine") body = enginePanel(settings);
			else if (tab === "model") body = modelPanel(llm);
			else if (tab === "mcp") body = mcpPanel(mcp);
			else if (tab === "report") body = reportPanel(reportSettings, templates);
			else if (tab === "skills") body = skillsPanel(settings);
			else if (tab === "account") body = accountPanel(gate);
			else body = systemPanel(system, gate);

			mount(root, html`${tabsHtml}${body}`);
			wire();
		};

		const wire = () => {
			root.querySelectorAll("[data-tab]").forEach((node) =>
				node.addEventListener("click", () => {
					tab = node.dataset.tab;
					ctx.go(`#/settings/${tab}`);
					paint();
				}),
			);

			// ---- 站点 / 引擎 / 技能：走 /api/settings 合并保存
			const saveSettings = async () => {
				const patch = buildPatch(root);
				try {
					const result = await api.put("/api/settings", patch);
					settings = result.settings;
					toast("设置已保存", "success");
				} catch (error) {
					toast(error.message, "error");
				}
			};

			// ---- 模型
			root.querySelector("#llm-add")?.addEventListener("click", () => openProfileForm(null, llm, ctx));
			root.querySelectorAll("[data-profile-edit]").forEach((node) =>
				node.addEventListener("click", () => {
					openProfileForm(llm.profiles.find((p) => p.id === node.dataset.profileEdit), llm, ctx);
				}),
			);
			root.querySelectorAll("[data-profile-active]").forEach((node) =>
				node.addEventListener("click", async () => {
					try {
						await api.put("/api/llm/profiles/active", { id: node.dataset.profileActive });
						toast("已设为激活档案", "success");
						ctx.reload();
					} catch (error) {
						toast(error.message, "error");
					}
				}),
			);
			root.querySelectorAll("[data-profile-test]").forEach((node) =>
				node.addEventListener("click", async () => {
					const original = node.textContent;
					node.disabled = true;
					node.textContent = "测试中";
					try {
						const result = await api.post(`/api/llm/test/${node.dataset.profileTest}`, {});
						// 失败时把上游原文也显示出来：503 / 401 / 404 的处理方式完全不同
						toast(result.message, result.ok ? "success" : "error", 9000);
						if (!result.ok && result.detail) {
							toast(`上游返回：${result.detail}`, "info", 12000);
						}
					} catch (error) {
						toast(error.message, "error");
					} finally {
						node.disabled = false;
						node.textContent = original;
					}
				}),
			);
			root.querySelectorAll("[data-profile-del]").forEach((node) =>
				node.addEventListener("click", async () => {
					try {
						await api.del(`/api/llm/profiles/${node.dataset.profileDel}`);
						toast("已删除", "success");
						ctx.reload();
					} catch (error) {
						toast(error.message, "error");
					}
				}),
			);
			root.querySelectorAll("[data-role-set]").forEach((node) =>
				node.addEventListener("change", async () => {
					try {
						await api.put(`/api/llm/roles/${node.dataset.roleSet}`, { profileId: node.value || null });
						toast("已更新角色绑定", "success");
					} catch (error) {
						toast(error.message, "error");
					}
				}),
			);

			// ---- MCP
			root.querySelector("#mcp-add")?.addEventListener("click", () => openMcpForm(null, ctx));
			root.querySelectorAll("[data-mcp-edit]").forEach((node) =>
				node.addEventListener("click", () => {
					openMcpForm(mcp.servers.find((s) => s.id === node.dataset.mcpEdit), ctx);
				}),
			);
			root.querySelectorAll("[data-mcp-test]").forEach((node) =>
				node.addEventListener("click", async () => {
					node.disabled = true;
					node.textContent = "测试中";
					try {
						const result = await api.post(`/api/mcp/${node.dataset.mcpTest}/test`, {});
						toast(result.message, result.ok ? "success" : "error", 8000);
						ctx.reload();
					} catch (error) {
						toast(error.message, "error");
						node.disabled = false;
						node.textContent = "测试";
					}
				}),
			);
			root.querySelectorAll("[data-mcp-del]").forEach((node) =>
				node.addEventListener("click", async () => {
					try {
						await api.del(`/api/mcp/${node.dataset.mcpDel}`);
						ctx.reload();
					} catch (error) {
						toast(error.message, "error");
					}
				}),
			);

			// ---- 报告
			root.querySelector("#report-save")?.addEventListener("click", async () => {
				try {
					const result = await api.put("/api/report-settings", {
						issuer: root.querySelector("#rp-issuer").value,
						language: root.querySelector("#rp-language").value,
						level: root.querySelector("#rp-level").value,
						showTraffic: root.querySelector("#rp-traffic").checked,
						showEvidence: root.querySelector("#rp-evidence").checked,
					});
					reportSettings = result.settings;
					toast("报告配置已保存", "success");
				} catch (error) {
					toast(error.message, "error");
				}
			});
			root.querySelectorAll("[data-tpl-edit]").forEach((node) =>
				node.addEventListener("click", () => {
					openTemplateForm(templates.items.find((t) => t.id === node.dataset.tplEdit), templates.sections, ctx);
				}),
			);
			root.querySelectorAll("[data-tpl-del]").forEach((node) =>
				node.addEventListener("click", async () => {
					try {
						await api.del(`/api/report-templates/${node.dataset.tplDel}`);
						toast("已删除", "success");
						ctx.reload();
					} catch (error) {
						toast(error.message, "error");
					}
				}),
			);
			root.querySelector("#tpl-add")?.addEventListener("click", () => openTemplateForm(null, templates.sections, ctx));

			// ---- 账号
			root.querySelector("#pw-form")?.addEventListener("submit", async (event) => {
				event.preventDefault();
				const data = new FormData(event.target);
				if (String(data.get("next")) !== String(data.get("confirm"))) return toast("两次输入的新口令不一致", "error");
				try {
					await api.post("/api/auth/password", { current: data.get("current"), next: data.get("next") });
					event.target.reset();
					toast("口令已更新，请重新登录", "success");
					setTimeout(() => location.reload(), 1200);
				} catch (error) {
					toast(error.message, "error");
				}
			});

			// ---- 守门（仍在账号页里的卡片）
			root.querySelector("#gate-save")?.addEventListener("click", async () => {
				const config = {
					timeoutMs: Number(root.querySelector("#gate-timeout").value) || 15000,
					concurrency: Number(root.querySelector("#gate-concurrency").value) || 0,
					guard: {},
					model: {
						baseUrl: root.querySelector("#gate-base").value.trim(),
						apiKey: root.querySelector("#gate-key").value,
						modelId: root.querySelector("#gate-model").value.trim(),
					},
				};
				for (const box of root.querySelectorAll("[data-scope]")) config.guard[box.dataset.scope] = box.checked;
				try {
					const result = await api.put("/api/gatekeeper", config);
					gate = { ...gate, config: result.config, endpoint: result.endpoint };
					toast("守门配置已保存", "success");
				} catch (error) {
					toast(error.message, "error");
				}
			});
			root.querySelector("#gate-test")?.addEventListener("click", async () => {
				const out = root.querySelector("#gate-test-out");
				out.innerHTML = "<span class='muted small'>判定中…</span>";
				try {
					const result = await api.post("/api/gatekeeper/test", {});
					const r = result.result ?? {};
					out.innerHTML = "";
					const box = document.createElement("div");
					box.className = "hint-box";
					if (!r.ok) {
						box.style.borderColor = "rgba(255,93,120,.34)";
						box.style.background = "rgba(255,93,120,.08)";
						box.style.color = "#ffb3c1";
					}
					const span = document.createElement("span");
					span.textContent = r.message ?? "";
					box.append(span);
					out.append(box);
				} catch (error) {
					out.textContent = error.message;
				}
			});
		};

		actions.querySelector("#save").addEventListener("click", async () => {
			actions.querySelector("#save").disabled = true;
			try {
				if (["site", "engine", "skills"].includes(tab)) {
					const result = await api.put("/api/settings", buildPatch(root));
					settings = result.settings;
					toast("设置已保存", "success");
				} else if (tab === "report") {
					root.querySelector("#report-save")?.click();
				} else if (tab === "account") {
					root.querySelector("#gate-save")?.click();
				} else {
					toast("这一页的每一条都有自己的保存按钮", "info");
				}
			} catch (error) {
				toast(error.message, "error");
			} finally {
				actions.querySelector("#save").disabled = false;
			}
		});

		paint();
	},
};

// ---------------------------------------------------------------- 各标签内容

function sitePanel(settings) {
	return card({
		title: "站点",
		body: html`
			<label class="field">
				<span>产品名</span>
				<input data-k="site.name" value="${settings.site?.name ?? "regedit"}" />
			</label>
			<label class="field">
				<span>副标题</span>
				<input data-k="site.tagline" value="${settings.site?.tagline ?? ""}" />
			</label>
			<label class="field mb-0">
				<span>操作员</span>
				<input data-k="site.operator" value="${settings.site?.operator ?? ""}" />
				<span class="hint">写进报告首页与审计日志。</span>
			</label>
		`,
	});
}

function enginePanel(settings) {
	return card({
		title: "评估引擎",
		sub: "只读 GET，保守清单",
		body: html`
			<div class="split-even" style="gap:12px">
				<label class="field">
					<span>请求超时 (ms)</span>
					<input data-k="recon.timeoutMs" type="number" min="1000" max="60000" value="${settings.recon?.timeoutMs ?? 8000}" />
				</label>
				<label class="field">
					<span>目标间延迟 (ms)</span>
					<input data-k="recon.delayMs" type="number" min="0" max="10000" value="${settings.recon?.delayMs ?? 120}" />
				</label>
				<label class="field">
					<span>单任务目标上限</span>
					<input data-k="recon.maxTargets" type="number" min="1" max="200" value="${settings.recon?.maxTargets ?? 32}" />
				</label>
				<label class="field">
					<span>User-Agent</span>
					<input data-k="recon.userAgent" value="${settings.recon?.userAgent ?? ""}" />
				</label>
			</div>
			<label class="field mb-0">
				<span>暴露面探测路径（每行一条）</span>
				<textarea data-k="recon.paths" rows="6">${(settings.recon?.paths ?? []).join("\n")}</textarea>
				<span class="hint">只对这些路径发只读 GET，命中特征才记发现。删掉某行即不再探测。</span>
			</label>
		`,
	});
}

function modelPanel(llm) {
	const legacyBanner =
		llm.legacy?.configured && llm.effectiveFrom?.id === "legacy"
			? html`<div class="hint-box mb-12">
					${raw(icon("alert", { size: 16 }))}
					<span>正在使用旧版「大模型」配置（${llm.legacy.baseUrl} · ${llm.legacy.modelId}）。
					它没有出现在档案列表里，但会作为兜底生效。建议新建一个档案并激活，这样能按角色分配、也能单独测试。</span>
				</div>`
			: llm.legacy?.configured
				? html`<div class="hint-box mb-12">
						${raw(icon("spark", { size: 16 }))}
						<span>检测到旧版配置（${llm.legacy.baseUrl} · ${llm.legacy.modelId}），当前已由档案接管。旧值仅作兜底。</span>
					</div>`
				: "";

	const profileRows = llm.profiles.length
		? html`<div class="table-wrap">
				<table>
					<thead><tr><th>档案</th><th class="nowrap">模型</th><th class="nowrap">状态</th><th></th></tr></thead>
					<tbody>
						${llm.profiles.map(
							(profile) => html`<tr>
								<td>
									<div class="dim">${profile.name}</div>
									<div class="tiny muted break">${profile.baseUrl}</div>
								</td>
								<td class="nowrap mono tiny">${profile.modelId}</td>
								<td class="nowrap">
									${profile.active ? html`<span class="chip chip-ok">激活</span>` : ""}
									${profile.usedBy.length ? html`<span class="chip chip-muted">${profile.usedBy.join("/")}</span>` : ""}
								</td>
								<td class="nowrap center">
									<button class="btn ghost small" data-profile-test="${profile.id}">测试</button>
									${profile.active ? "" : html`<button class="btn ghost small" data-profile-active="${profile.id}">激活</button>`}
									<button class="btn ghost small" data-profile-edit="${profile.id}">编辑</button>
									<button class="btn-icon danger" data-profile-del="${profile.id}" title="删除">${raw(icon("trash", { size: 16 }))}</button>
								</td>
							</tr>`,
						)}
					</tbody>
				</table>
			</div>`
		: html`<div class="muted small">
				还没有模型档案。加一个 OpenAI 兼容端点就能用对话与 AI 审批。
				${llm.legacy?.configured
					? html`<div class="mt-8">旧配置已配置但还没迁移成档案，可以点下面「测旧配置」，或直接新建一个。</div>`
					: ""}
			</div>`;

	const roleRows = llm.roles
		.map(
			(role) => html`<tr>
				<td class="nowrap dim">${role.label}</td>
				<td class="tiny muted">${role.hint}</td>
				<td class="nowrap">
					<select data-role-set="${role.id}" style="max-width:200px">
						<option value="">跟随激活档案</option>
						${llm.profiles.map(
							(profile) => html`<option value="${profile.id}" ${role.profileId === profile.id ? "selected" : ""}>${profile.name}</option>`,
						)}
					</select>
				</td>
			</tr>`,
		);

	return html`
		${legacyBanner}
		${card({
			title: "模型档案",
			sub: `${llm.profiles.length} 个`,
			actions: html`
				${llm.legacy?.configured ? html`<button class="btn ghost small" data-profile-test="legacy">测旧配置</button>` : ""}
				<button class="btn primary small" id="llm-add">${raw(icon("plus", { size: 15 }))}添加档案</button>
			`,
			body: profileRows,
			tight: true,
		})}
		<div class="page-section"></div>
		${card({
			title: "角色绑定",
			sub: "不同用途可以指不同档案",
			body: html`<div class="table-wrap"><table><tbody>${roleRows}</tbody></table></div>`,
			tight: true,
		})}
		<div class="page-section"></div>
		${card({
			title: "调用统计",
			body: html`<div class="row small muted" style="gap:18px">
				<span>调用 ${llm.pool.calls} 次</span>
				<span>失败 ${llm.pool.failures} 次</span>
				<span>累计 ${llm.pool.tokens} tokens</span>
			</div>`,
		})}
	`;
}

function mcpPanel(mcp) {
	const rows = mcp.servers.length
		? html`<div class="table-wrap">
				<table>
					<thead><tr><th>服务器</th><th class="nowrap">类型</th><th class="nowrap">最近测试</th><th></th></tr></thead>
					<tbody>
						${mcp.servers.map(
							(server) => html`<tr>
								<td>
									<div class="dim">${server.name}</div>
									<div class="tiny muted break">${server.type === "stdio" ? server.command : server.url}</div>
								</td>
								<td class="nowrap"><span class="chip chip-muted">${server.type}</span></td>
								<td class="nowrap tiny">
									${server.lastTest
										? html`<span class="${server.lastTest.ok ? "chip chip-ok" : "chip-danger"}">${server.lastTest.ok ? "连通" : "失败"}</span>`
										: html`<span class="muted">未测试</span>`}
								</td>
								<td class="nowrap center">
									<button class="btn ghost small" data-mcp-test="${server.id}">测试</button>
									<button class="btn ghost small" data-mcp-edit="${server.id}">编辑</button>
									<button class="btn-icon danger" data-mcp-del="${server.id}" title="删除">${raw(icon("trash", { size: 16 }))}</button>
								</td>
							</tr>`,
						)}
					</tbody>
				</table>
			</div>`
		: html`<div class="muted small">还没有 MCP 服务器。</div>`;

	return card({
		title: "MCP 服务器",
		sub: "http / sse 支持连通性测试，stdio 仅保存配置",
		actions: html`<button class="btn primary small" id="mcp-add">${raw(icon("plus", { size: 15 }))}添加</button>`,
		body: html`
			${rows}
			<div class="hint-box mt-12">
				${raw(icon("alert", { size: 16 }))}
				<span>stdio 型服务器不在控制台里自动拉起：控制台跑在宿主机上，自动执行任意本地命令等于开了一个无审批的执行入口。
				需要时请在受控终端里运行，再用 http/sse 暴露。</span>
			</div>
		`,
		tight: false,
	});
}

function reportPanel(settings, templates) {
	const tplRows = templates.items
		.map(
			(template) => html`<tr>
				<td>
					<div class="dim">${template.name}</div>
					<div class="tiny muted">${template.desc}</div>
				</td>
				<td class="nowrap tiny">${template.sections.map((s) => templates.sections[s] ?? s).join(" → ")}</td>
				<td class="nowrap center">
					<button class="btn ghost small" data-tpl-edit="${template.id}">编辑</button>
					${template.system ? "" : html`<button class="btn-icon danger" data-tpl-del="${template.id}">${raw(icon("trash", { size: 16 }))}</button>`}
				</td>
			</tr>`,
		);

	return html`
		${card({
			title: "报告配置",
			actions: html`<button class="btn primary small" id="report-save">保存</button>`,
			body: html`
				<div class="split-even" style="gap:12px">
					<label class="field">
						<span>出具方</span>
						<input id="rp-issuer" value="${settings.issuer ?? ""}" placeholder="某某安全服务团队" />
					</label>
					<label class="field">
						<span>语言</span>
						<select id="rp-language">
							<option value="zh-CN" ${settings.language === "zh-CN" ? "selected" : ""}>简体中文</option>
							<option value="en-US" ${settings.language === "en-US" ? "selected" : ""}>English</option>
						</select>
					</label>
				</div>
				<div class="row" style="gap:18px;flex-wrap:wrap">
					<label class="checkbox">
						<input type="checkbox" id="rp-traffic" ${settings.showTraffic ? "checked" : ""} />
						<span>附请求流水</span>
					</label>
					<label class="checkbox">
						<input type="checkbox" id="rp-evidence" ${settings.showEvidence ? "checked" : ""} />
						<span>附证据原文</span>
					</label>
				</div>
			`,
		})}
		<div class="page-section"></div>
		${card({
			title: "报告模板",
			sub: `${templates.items.length} 个`,
			actions: html`<button class="btn ghost small" id="tpl-add">${raw(icon("plus", { size: 15 }))}新建模板</button>`,
			body: html`<div class="table-wrap"><table><tbody>${tplRows}</tbody></table></div>`,
			tight: true,
		})}
	`;
}

function skillsPanel(settings) {
	return card({
		title: "技能目录",
		sub: "每行一个，支持相对项目根目录",
		body: html`
			<label class="field mb-0">
				<span>目录列表</span>
				<textarea data-k="skills.dirs" rows="4">${(settings.skills?.dirs ?? []).join("\n")}</textarea>
				<span class="hint">靠前的目录优先；同名技能以先命中的为准。</span>
			</label>
		`,
	});
}

function accountPanel(gate) {
	const config = gate.config;
	const endpoint = gate.endpoint;
	return html`
		${card({
			title: "修改口令",
			body: html`
				<form id="pw-form">
					<label class="field">
						<span>当前口令</span>
						<input name="current" type="password" autocomplete="current-password" />
					</label>
					<label class="field">
						<span>新口令（至少 8 位）</span>
						<input name="next" type="password" autocomplete="new-password" />
					</label>
					<label class="field">
						<span>确认新口令</span>
						<input name="confirm" type="password" autocomplete="new-password" />
					</label>
					<button class="btn ghost small" type="submit">更新口令</button>
					<span class="hint" style="display:block;margin-top:8px">更新后所有会话失效，需要重新登录。</span>
				</form>
			`,
		})}
		<div class="page-section"></div>
		${card({
			title: "守门设置（AI 审批）",
			sub: endpoint ? `端点：${endpoint.from} · ${endpoint.modelId}` : "端点：未配置",
			body: html`
				<p class="small muted" style="margin-top:0">
					AI 审批模式下，设备命令 / 文件推送 / frida 动作先交给守门模型判定：返回
					<code>ALLOW</code> 才执行，<code>BLOCK: 理由</code> 则拒绝。判定失败一律放行并记账。
				</p>
				<div class="split-even" style="gap:12px">
					<label class="field">
						<span>判定超时（毫秒）</span>
						<input id="gate-timeout" type="number" min="1000" max="120000" value="${config.timeoutMs}" />
					</label>
					<label class="field">
						<span>并发上限</span>
						<input id="gate-concurrency" type="number" min="0" max="64" value="${config.concurrency}" />
					</label>
				</div>
				<div class="field">
					<span>受守门的动作</span>
					<div class="row" style="gap:14px;flex-wrap:wrap">
						${gate.scopes.map(
							(scope) => html`<label class="checkbox" title="${scope.hint}">
								<input type="checkbox" data-scope="${scope.id}" ${config.guard[scope.id] ? "checked" : ""} />
								<span>${scope.label}</span>
							</label>`,
						)}
					</div>
				</div>
				<div class="apk-section">
					<h4>独立判定端点（留空则用「模型」页的激活档案）</h4>
					<label class="field">
						<span>Base URL</span>
						<input id="gate-base" placeholder="https://api.example.com/v1" value="${config.model.baseUrl}" />
					</label>
					<div class="split-even" style="gap:12px">
						<label class="field">
							<span>API Key</span>
							<input id="gate-key" type="password" placeholder="留空表示不修改" value="${config.model.apiKey ? "••••••••" : ""}" />
						</label>
						<label class="field">
							<span>模型 ID</span>
							<input id="gate-model" placeholder="deepseek-chat" value="${config.model.modelId}" />
						</label>
					</div>
				</div>
				<div class="row mt-12">
					<button class="btn primary small" id="gate-save">保存守门配置</button>
					<button class="btn ghost small" id="gate-test">测试判定</button>
				</div>
				<div id="gate-test-out" class="mt-12"></div>
			`,
		})}
	`;
}

function systemPanel(system, gate) {
	return card({
		title: "系统信息",
		body: html`
			<dl class="kv">
				<dt>版本</dt><dd>${system.version}</dd>
				<dt>Node</dt><dd>${system.node}</dd>
				<dt>平台</dt><dd>${system.platform}</dd>
				<dt>运行时长</dt><dd>${Math.floor(system.uptime / 60)} 分钟</dd>
				<dt>内存</dt><dd>${system.memoryMB} MB</dd>
				<dt>数据目录</dt><dd>${system.dataDir}</dd>
				<dt>会话</dt><dd>${system.sessions}</dd>
				<dt>设备监听</dt><dd>${system.listen ? `${system.listen.host}:${system.listen.port}` : "未启用"}</dd>
			</dl>
			<div class="mt-12 hint-box">
				${raw(icon("shield", { size: 16 }))}
				<span>业务状态在 data/state.json（单文件 + 250ms 防抖落盘），产物在 data/artifacts/。备份直接拷 data 目录。</span>
			</div>
		`,
	});
}

// ---------------------------------------------------------------- 表单

function buildPatch(root) {
	const patch = {};
	for (const node of root.querySelectorAll("[data-k]")) {
		const [section, field] = node.dataset.k.split(".");
		let value;
		if (node.type === "checkbox") value = node.checked;
		else if (node.type === "number") value = Number(node.value) || 0;
		else if (node.tagName === "TEXTAREA" && (field === "paths" || field === "dirs")) {
			value = node.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
		} else value = node.value;
		patch[section] = { ...(patch[section] ?? {}), [field]: value };
	}
	return patch;
}

function openProfileForm(profile, llm, ctx) {
	const overlay = openOverlay(html`
		<div class="overlay-head"><h3>${profile ? "编辑模型档案" : "添加模型档案"}</h3></div>
		<div class="overlay-body">
			<label class="field">
				<span>名称</span>
				<input data-name value="${profile?.name ?? ""}" placeholder="DeepSeek 主用" />
			</label>
			<label class="field">
				<span>Base URL</span>
				<input data-base value="${profile?.baseUrl ?? ""}" placeholder="https://api.deepseek.com/v1" />
			</label>
			<div class="split-even" style="gap:12px">
				<label class="field">
					<span>API Key</span>
					<input data-key type="password" value="${profile?.apiKey ?? ""}" placeholder="留空表示不修改" />
				</label>
				<label class="field">
					<span>模型 ID</span>
					<input data-model value="${profile?.modelId ?? ""}" placeholder="deepseek-chat" />
				</label>
			</div>
		</div>
		<div class="overlay-foot">
			<button class="btn ghost" data-close>取消</button>
			<button class="btn primary" data-save>保存</button>
		</div>
	`);
	overlay.panel.querySelector("[data-name]").focus();
	overlay.panel.querySelector("[data-save]").addEventListener("click", async () => {
		try {
			await api.post("/api/llm/profiles", {
				id: profile?.id,
				name: overlay.panel.querySelector("[data-name]").value.trim(),
				baseUrl: overlay.panel.querySelector("[data-base]").value.trim(),
				apiKey: overlay.panel.querySelector("[data-key]").value,
				modelId: overlay.panel.querySelector("[data-model]").value.trim(),
			});
			overlay.close();
			toast("已保存", "success");
			ctx.reload();
		} catch (error) {
			toast(error.message, "error");
		}
	});
}

function openMcpForm(server, ctx) {
	const overlay = openOverlay(html`
		<div class="overlay-head"><h3>${server ? "编辑 MCP 服务器" : "添加 MCP 服务器"}</h3></div>
		<div class="overlay-body">
			<label class="field">
				<span>名称</span>
				<input data-name value="${server?.name ?? ""}" placeholder="filesystem" />
			</label>
			<label class="field">
				<span>类型</span>
				<select data-type>
					<option value="http" ${server?.type === "http" ? "selected" : ""}>http</option>
					<option value="sse" ${server?.type === "sse" ? "selected" : ""}>sse</option>
					<option value="stdio" ${server?.type === "stdio" ? "selected" : ""}>stdio（仅保存）</option>
				</select>
			</label>
			<label class="field">
				<span>URL</span>
				<input data-url value="${server?.url ?? ""}" placeholder="http://127.0.0.1:3000/mcp" />
			</label>
			<label class="field mb-0">
				<span>命令（stdio 用）</span>
				<input data-command value="${server?.command ?? ""}" placeholder="npx -y @modelcontextprotocol/server-filesystem /tmp" />
			</label>
		</div>
		<div class="overlay-foot">
			<button class="btn ghost" data-close>取消</button>
			<button class="btn primary" data-save>保存</button>
		</div>
	`);
	overlay.panel.querySelector("[data-save]").addEventListener("click", async () => {
		const command = overlay.panel.querySelector("[data-command]").value.trim();
		try {
			await api.post("/api/mcp", {
				id: server?.id,
				name: overlay.panel.querySelector("[data-name]").value.trim(),
				type: overlay.panel.querySelector("[data-type]").value,
				url: overlay.panel.querySelector("[data-url]").value.trim(),
				command,
				args: command ? command.split(/\s+/).slice(1) : [],
				enabled: true,
			});
			overlay.close();
			toast("已保存", "success");
			ctx.reload();
		} catch (error) {
			toast(error.message, "error");
		}
	});
}

function openTemplateForm(template, sections, ctx) {
	const selected = new Set(template?.sections ?? ["scope", "overview", "findings"]);
	const overlay = openOverlay(html`
		<div class="overlay-head"><h3>${template ? "编辑模板" : "新建模板"}</h3></div>
		<div class="overlay-body">
			<label class="field">
				<span>名称</span>
				<input data-name value="${template?.name ?? ""}" />
			</label>
			<label class="field">
				<span>描述</span>
				<input data-desc value="${template?.desc ?? ""}" />
			</label>
			<div class="field">
				<span>章节顺序</span>
				<div class="row" style="gap:12px;flex-wrap:wrap">
					${Object.entries(sections).map(
						([id, label]) => html`<label class="checkbox">
							<input type="checkbox" data-section="${id}" ${selected.has(id) ? "checked" : ""} />
							<span>${label}</span>
						</label>`,
					)}
				</div>
			</div>
		</div>
		<div class="overlay-foot">
			<button class="btn ghost" data-close>取消</button>
			<button class="btn primary" data-save>保存</button>
		</div>
	`);
	overlay.panel.querySelector("[data-save]").addEventListener("click", async () => {
		const chosen = [...overlay.panel.querySelectorAll("[data-section]")].filter((n) => n.checked).map((n) => n.dataset.section);
		try {
			await api.post("/api/report-templates", {
				id: template?.id,
				name: overlay.panel.querySelector("[data-name]").value.trim(),
				desc: overlay.panel.querySelector("[data-desc]").value.trim(),
				sections: chosen,
			});
			overlay.close();
			toast("已保存", "success");
			ctx.reload();
		} catch (error) {
			toast(error.message, "error");
		}
	});
}
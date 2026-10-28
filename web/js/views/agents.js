/**
 * Agent 管理：角色提示词 + 工具授权 + 模型角色绑定。
 */

import { icon } from "../icons.js";
import { api, fmtTime, html, mount, openOverlay, raw, toast, toNode } from "../core.js";
import { card, emptyState, inlineError, loading } from "../ui.js";

const ROLE_LABEL = { planner: "规划", executor: "执行", judge: "守门", wrapup: "收尾" };

export default {
	title: "Agent",
	subtitle: "角色提示词、工具授权与模型绑定",

	async render(root, ctx) {
		mount(root, loading("读取 Agent 定义…"));
		let payload;
		try {
			payload = await api.get("/api/agents");
		} catch (error) {
			mount(root, inlineError(error.message));
			return;
		}

		let agents = payload.agents;
		const toolList = payload.tools;

		const actions = toNode(html`<button class="btn primary small" id="new-agent">${raw(icon("plus", { size: 15 }))}新建 Agent</button>`);
		ctx.setHeader("Agent", `${agents.length} 个定义`, actions);
		actions.querySelector("#new-agent").addEventListener("click", () => openForm(null, toolList, ctx));

		const paint = () => {
			const body = agents.length
				? html`<div class="grid grid-2">
						${agents.map(
							(agent) => html`<div class="card">
								<div class="card-body">
									<div class="row" style="gap:8px">
										<span class="nav-icon">${raw(icon("cpu", { size: 18 }))}</span>
										<div style="min-width:0">
											<div class="dim" style="font-weight:600">${agent.name}</div>
											<div class="tiny muted mono">${agent.key}</div>
										</div>
										<span class="spacer"></span>
										${agent.enabled ? html`<span class="chip chip-ok">启用</span>` : html`<span class="chip chip-muted">停用</span>`}
									</div>
									<p class="small muted" style="margin:10px 0 0;min-height:34px">${agent.description || "（无描述）"}</p>
									<div class="row tiny muted mt-12" style="gap:8px">
										<span class="chip chip-muted">${ROLE_LABEL[agent.modelRole] ?? agent.modelRole}</span>
										<span class="chip chip-muted">${agent.toolCount} 个工具</span>
										<span class="chip chip-muted">${agent.maxTurns} 轮上限</span>
									</div>
									<div class="row mt-12">
										<button class="btn ghost small" data-edit="${agent.key}">编辑</button>
										<button class="btn ghost small" data-toggle="${agent.key}">${agent.enabled ? "停用" : "启用"}</button>
										<button class="btn-icon danger" data-del="${agent.key}" title="删除">${raw(icon("trash", { size: 16 }))}</button>
									</div>
								</div>
							</div>`,
						)}
					</div>`
				: emptyState({
						iconName: "cpu",
						title: "还没有 Agent",
						description: "Agent 是一段角色提示词加一组工具授权。新建一个，比如「Web 侦察员」只给侦察类工具。",
					});

			mount(root, card({ body, tight: false }));

			root.querySelectorAll("[data-edit]").forEach((node) =>
				node.addEventListener("click", () => {
					const agent = agents.find((a) => a.key === node.dataset.edit);
					openForm(agent, toolList, ctx);
				}),
			);
			root.querySelectorAll("[data-toggle]").forEach((node) =>
				node.addEventListener("click", async () => {
					const agent = agents.find((a) => a.key === node.dataset.toggle);
					try {
						await api.post("/api/agents", { ...agent, enabled: !agent.enabled });
						ctx.reload();
					} catch (error) {
						toast(error.message, "error");
					}
				}),
			);
			root.querySelectorAll("[data-del]").forEach((node) =>
				node.addEventListener("click", async () => {
					try {
						await api.del(`/api/agents/${node.dataset.del}`);
						agents = agents.filter((a) => a.key !== node.dataset.del);
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

function openForm(agent, toolList, ctx) {
	const selected = new Set(agent?.tools ?? toolList.filter((t) => t.enabled).map((t) => t.id));
	const overlay = openOverlay(html`
		<div class="overlay-head"><h3>${agent ? "编辑 Agent" : "新建 Agent"}</h3></div>
		<div class="overlay-body">
			<div class="split-even" style="gap:12px">
				<label class="field">
					<span>Key（唯一标识）</span>
					<input data-key value="${agent?.key ?? ""}" ${agent ? "readonly" : ""} placeholder="web-recon" />
				</label>
				<label class="field">
					<span>名称</span>
					<input data-name value="${agent?.name ?? ""}" placeholder="Web 侦察员" />
				</label>
			</div>
			<label class="field">
				<span>描述</span>
				<input data-desc value="${agent?.description ?? ""}" placeholder="这个 Agent 负责什么" />
			</label>
			<div class="split-even" style="gap:12px">
				<label class="field">
					<span>模型角色</span>
					<select data-role>
						${Object.entries(ROLE_LABEL).map(
							([id, label]) => html`<option value="${id}" ${agent?.modelRole === id ? "selected" : ""}>${label}</option>`,
						)}
					</select>
				</label>
				<label class="field">
					<span>最大轮数</span>
					<input data-turns type="number" min="1" max="200" value="${agent?.maxTurns ?? 40}" />
				</label>
			</div>
			<label class="field">
				<span>角色提示词</span>
				<textarea data-prompt rows="8" placeholder="你是……。你的职责是……。不要……。">${agent?.systemPrompt ?? ""}</textarea>
			</label>
			<div class="field">
				<span>可用工具</span>
				<div class="row" style="gap:14px;flex-wrap:wrap">
					${toolList.map(
						(tool) => html`<label class="checkbox">
							<input type="checkbox" data-tool="${tool.id}" ${selected.has(tool.id) ? "checked" : ""} ${tool.enabled ? "" : "disabled"} />
							<span>${tool.name}${tool.enabled ? "" : "（已停用）"}</span>
						</label>`,
					)}
				</div>
			</div>
		</div>
		<div class="overlay-foot">
			<button class="btn ghost" data-close>取消</button>
			<button class="btn primary" data-save>保存</button>
		</div>
	`, { wide: true });

	overlay.panel.querySelector("[data-save]").addEventListener("click", async () => {
		const tools = [...overlay.panel.querySelectorAll("[data-tool]")].filter((n) => n.checked).map((n) => n.dataset.tool);
		const payload = {
			key: overlay.panel.querySelector("[data-key]").value.trim(),
			name: overlay.panel.querySelector("[data-name]").value.trim(),
			description: overlay.panel.querySelector("[data-desc]").value.trim(),
			modelRole: overlay.panel.querySelector("[data-role]").value,
			maxTurns: Number(overlay.panel.querySelector("[data-turns]").value) || 40,
			systemPrompt: overlay.panel.querySelector("[data-prompt]").value,
			tools,
			enabled: agent?.enabled !== false,
		};
		if (!payload.key) return toast("Key 不能为空", "error");
		try {
			await api.post("/api/agents", payload);
			overlay.close();
			toast("已保存", "success");
			ctx.reload();
		} catch (error) {
			toast(error.message, "error");
		}
	});
}
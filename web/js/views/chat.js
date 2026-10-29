/**
 * 对话：多轮 + 真实模型调用 + 项目（任务）绑定。
 *
 * 这个页面是"主 agent"的操作台，所以它同时要回答三个问题：
 *   1. 这次对话对应哪个项目、现在跑到哪一步了（项目条）；
 *   2. 刚才那几句话让模型对目标做了什么（消息里的工具折叠块 + 右侧实时流量）；
 *   3. 要不要挂到某个客户、某台安卓设备上（绑定选择器）。
 * 只有把这三件事摆在同一个屏幕里，操作员才不用来回跳页确认"到底动了没有"。
 */

import { icon } from "../icons.js";
import { api, fmtClock, html, mount, raw, relTime, statusChip, toast, toNode } from "../core.js";
import { card, inlineError, loading } from "../ui.js";

const TOOL_LABEL = {
	project_overview: "查项目概况",
	list_tasks: "列任务",
	list_assets: "列资产",
	list_findings: "列漏洞",
	whois_lookup: "WHOIS 查询",
	dns_lookup: "DNS 解析",
	create_recon_task: "发起侦察",
	record_finding: "记录漏洞",
	generate_report: "生成报告",
	list_devices: "列安卓设备",
	device_exec: "设备命令",
	device_screencap: "设备截屏",
	device_logcat: "设备日志",
	device_pull: "设备拉文件",
	device_packages: "设备应用列表",
};

export default {
	title: "对话",
	subtitle: "与大模型的多轮会话（自动建项目 + 可操作安卓设备）",

	async render(root, ctx) {
		mount(root, loading("读取会话…"));
		let list;
		let current = null;
		try {
			const payload = await api.get("/api/chat");
			list = payload.conversations ?? [];
		} catch (error) {
			mount(root, inlineError(error.message));
			return;
		}

		// 找一下模型端点，决定输入框是否可用。
		// 用 available 而不是 active：旧配置兜底生效时 active 是空的，会把"能聊"误判成"没配"。
		let hasModel = false;
		let llmState = null;
		try {
			llmState = await api.get("/api/llm");
			hasModel = Boolean(llmState.available);
		} catch {
			hasModel = false;
		}

		const actions = toNode(html`<button class="btn primary small" id="new-chat">${raw(icon("plus", { size: 15 }))}新对话</button>`);
		ctx.setHeader("对话", `${list.length} 条会话`, actions);
		actions.querySelector("#new-chat").addEventListener("click", async () => {
			try {
				const result = await api.post("/api/chat", { title: "新对话" });
				ctx.go(`#/chat/${result.conversation.id}`);
				ctx.reload();
			} catch (error) {
				toast(error.message, "error");
			}
		});

		// 支持 #/chat/<id> 直达；不带 id 时自动打开最近一条会话。
		const requested = ctx.param || list[0]?.id;
		if (requested) {
			try {
				const loaded = await api.get(`/api/chat/${requested}`);
				current = loaded && typeof loaded === "object"
					? { ...loaded, messages: Array.isArray(loaded.messages) ? loaded.messages : [] }
					: null;
			} catch {
				current = null;
			}
		}

		// 实时流量：只跟当前会话，4 秒一轮。离开页面必须停掉。
		let traffic = [];
		let trafficTimer = null;
		const loadTraffic = async () => {
			if (!current?.id) return [];
			try {
				const items = await api.get(`/api/traffic?limit=12&conversationId=${encodeURIComponent(current.id)}`);
				traffic = Array.isArray(items) ? items : [];
			} catch {
				traffic = [];
			}
			return traffic;
		};

		const paint = () => {
			const project = current?.project ?? null;
			const devices = current?.devices ?? [];
			const companies = current?.companies ?? [];

			const projectCard = card({
				title: "项目",
				sub: project ? `${project.id}` : "未绑定",
				actions: project ? html`<a class="btn ghost small" href="#/tasks/${project.id}">打开</a>` : "",
				body: project
					? html`<div class="project-card">
							<div class="row" style="gap:8px;align-items:center">
								<span class="dim" style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${project.title}</span>
								${statusChip(project.running ? "running" : project.status)}
							</div>
							<div class="tiny muted mt-8">${project.stage || "—"} · 目标 ${(project.scope ?? []).length}</div>
							<div class="project-metrics">
								<span><strong>${project.assets ?? 0}</strong> 资产</span>
								<span><strong>${project.findings ?? 0}</strong> 发现</span>
								<span><strong>${project.traffic ?? 0}</strong> 流量</span>
							</div>
							<div class="row mt-12" style="gap:8px">
								<a class="btn ghost small" href="#/traffic?taskId=${project.id}">看流量</a>
								<a class="btn ghost small" href="#/tasks/${project.id}">看项目</a>
							</div>
						</div>`
					: html`<div class="small muted">
							还没有项目。在下面说一句"对 example.com 做评估"，会话会自动建一个项目并开始侦察；
							模型也可以随时用 create_recon_task 追加目标。
						</div>`,
			});

			const bindCard = card({
				title: "绑定",
				sub: "归属与设备",
				body: html`
					<label class="field">
						<span>公司（交付给谁）</span>
						<select id="bind-company">
							<option value="">未归属</option>
							${companies.map(
								(company) =>
									html`<option value="${company.id}" ${company.id === current?.companyId ? "selected" : ""}>${company.name}</option>`,
							)}
						</select>
					</label>
					<label class="field mb-0">
						<span>安卓设备（本会话默认操作哪台）</span>
						<select id="bind-device">
							<option value="">自动（唯一在线设备）</option>
							${devices.map(
								(device) =>
									html`<option value="${device.id}" ${device.id === current?.deviceId ? "selected" : ""}>
										${device.name} · ${device.model ?? "?"} · ${device.liveness}
									</option>`,
							)}
						</select>
					</label>
					<div class="tiny muted mt-8">
						${devices.length
							? "设备命令会走守门：人工审批模式下在「守门」页放行后才执行。"
							: html`没有设备接入。到「安卓设备」页建令牌，用 regedit-droid APK 拨进来。`}
					</div>
				`,
			});

			const trafficCard = card({
				title: "流量",
				sub: `${traffic.length} 条（最近）`,
				actions: current ? html`<a class="btn ghost small" href="#/traffic?conversationId=${current.id}">全部</a>` : "",
				body: traffic.length
					? html`<div class="traffic-tail">
							${traffic.slice(0, 8).map(
								(item) => html`<div class="traffic-tail-row">
									<span class="chip ${item.status === 0 ? "chip-danger" : item.status < 300 ? "chip-ok" : "chip-warn"}">${item.status || "ERR"}</span>
									<span class="mono tiny">${item.method}</span>
									<span class="tiny break" title="${item.url}">${item.url}</span>
									<span class="tiny muted nowrap">${fmtClock(item.at)}</span>
								</div>`,
							)}
						</div>`
					: html`<div class="small muted">这个会话还没有产生流量。任务跑起来后，DNS / HTTP / 设备命令都会在这里出现。</div>`,
			});

			const sidebar = list.length
				? html`<div style="display:flex;flex-direction:column;gap:4px;max-height:40vh;overflow:auto">
						${list.map(
							(conversation) => html`<div class="nav-item ${current?.id === conversation.id ? "active" : ""}" data-open="${conversation.id}" style="cursor:pointer">
								<div style="min-width:0;flex:1">
									<div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${conversation.title}</div>
									<div class="tiny muted">
										${conversation.messageCount} 条 · ${relTime(conversation.updatedAt)}${conversation.taskId ? ` · ${conversation.taskId}` : ""}
									</div>
								</div>
							</div>`,
						)}
					</div>`
				: html`<div class="muted small">还没有会话，点右上角「新对话」。</div>`;

			const messages = current?.messages?.length
				? current.messages.map(
							(message) => html`<div style="margin-bottom:16px;padding:12px 14px;border-radius:10px;
								background:${message.role === "user" ? "rgba(63,224,166,.07)" : "rgba(255,255,255,.03)"};
								border:1px solid ${message.role === "user" ? "rgba(63,224,166,.22)" : "var(--line-soft)"}">
								<div class="row tiny muted" style="gap:8px;margin-bottom:6px">
									<span>${message.role === "user" ? "我" : "模型"}</span>
									${message.model ? html`<span class="chip chip-muted">${message.model}</span>` : ""}
									${message.projectId ? html`<a class="chip chip-info" href="#/tasks/${message.projectId}">${message.projectId}</a>` : ""}
									${message.inputTokens ? html`<span title="输入（prompt）token">输入 ${message.inputTokens}</span>` : ""}
									${message.outputTokens ? html`<span title="输出（completion）token">输出 ${message.outputTokens}</span>` : ""}
									${message.reasoningTokens ? html`<span title="推理过程消耗的 token">推理 ${message.reasoningTokens}</span>` : ""}
									${!message.inputTokens && message.tokens ? html`<span>${message.tokens} tokens</span>` : ""}
									${message.finishReason && message.finishReason !== "stop" ? html`<span class="chip chip-warn">${message.finishReason}</span>` : ""}
									<span class="spacer"></span>
									<span>${message.at ? fmtClock(message.at) : ""}</span>
								</div>
								${message.note ? html`<div class="hint-box" style="margin-bottom:8px">${raw(icon("alert", { size: 15 }))}<span>${message.note}</span></div>` : ""}
								${message.projectNote ? html`<div class="hint-box hint-ok" style="margin-bottom:8px">${raw(icon("layers", { size: 15 }))}<span>${message.projectNote}</span></div>` : ""}
								${Array.isArray(message.toolCalls) && message.toolCalls.length
									? html`<div class="chat-tools">
											${message.toolCalls.map(
												(call) => html`<details class="chat-tool" ${call.ok ? "" : "data-failed"}>
													<summary>
														${raw(icon("terminal", { size: 14 }))}
														<span class="mono tiny">${call.name}</span>
														<span class="tiny muted">${TOOL_LABEL[call.name] ?? ""} ${call.ok ? "完成" : "失败"}</span>
													</summary>
													<pre class="tiny">${JSON.stringify(call.args, null, 2)}</pre>
													<pre class="tiny">${call.summary}</pre>
												</details>`,
											)}
										</div>`
									: ""}
								<div style="white-space:pre-wrap;${message.error ? "color:#ff9dae" : ""}">${message.content || "（空）"}</div>
							</div>`,
						)
				: html`<div class="muted small" style="padding:20px 0">还没有消息。${hasModel ? "在下面输入开始。" : "先到「设置 → 模型」加一个端点。"}</div>`;

			// 状态条：让操作员一眼看到"用的是哪个模型、当前这条会话什么状态"。
			const statusBar = html`<div class="chat-status">
				<div class="row tiny muted" style="gap:14px;flex-wrap:wrap">
					<span>${llmState?.effectiveFrom ? html`模型 <strong style="color:var(--fg)">${llmState.effectiveFrom.modelId}</strong>（${llmState.effectiveFrom.name}）` : html`<span style="color:#ff9dae">未配置模型</span>`}</span>
					<span>会话 ${current?.messages?.length ?? 0} 条</span>
					${current?.updatedAt ? html`<span>更新于 ${relTime(current.updatedAt)}</span>` : ""}
					${llmState?.pool?.calls ? html`<span>调用 ${llmState.pool.calls} 次 · 输入 ${llmState.pool.inputTokens ?? 0} · 输出 ${llmState.pool.outputTokens ?? 0} tokens</span>` : ""}
					<span class="spacer"></span>
					<span id="send-status"></span>
				</div>
				${current
					? html`<div class="chat-goal">
							<span class="tiny muted nowrap">任务目标</span>
							<input id="chat-goal" placeholder="告诉这个会话最终要交付什么（会注入给模型的指令里）" value="${current.goal ?? ""}" />
							<button class="btn ghost small" id="save-goal">保存</button>
						</div>`
					: ""}
			</div>`;

			mount(
				root,
				html`
					${hasModel
						? llmState?.effectiveFrom && llmState.effectiveFrom.id === "legacy"
							? html`<div class="hint-box page-section">
									${raw(icon("alert", { size: 16 }))}
									<span>当前用的是「设置 → 模型」里迁移过来的旧配置（${llmState.legacy.baseUrl} · ${llmState.legacy.modelId}）。
									建议到「设置 → 模型」建一个正式档案，并把模型 ID 改成端点实际提供的那个。</span>
								</div>`
							: ""
						: html`<div class="hint-box page-section">
								${raw(icon("alert", { size: 16 }))}
								<span>还没有可用的模型端点。去「设置 → 模型」添加一个档案并激活，对话才能工作。</span>
							</div>`}
					<div class="split page-section">
						${card({
							title: current ? current.title : "未选择会话",
							sub: current ? `${current.messages.length} 条消息${project ? ` · 项目 ${project.id}` : ""}` : "",
							actions: current
								? html`<button class="btn-icon danger" id="del-chat" title="删除会话">${raw(icon("trash", { size: 16 }))}</button>`
								: "",
							body: html`
								${statusBar}
								<div id="messages" style="max-height:52vh;overflow:auto;padding-right:6px">${messages}</div>
								<div class="mt-12">
									<textarea id="composer" rows="3" placeholder="${hasModel ? "说一句带目标的活儿，例如：对 example.com 与 www.example.com 做暴露面评估。Ctrl+Enter 发送" : "未配置模型端点"}" ${hasModel && current ? "" : "disabled"}></textarea>
									<div class="row mt-8">
										<button class="btn primary small" id="send" ${hasModel && current ? "" : "disabled"}>发送</button>
										<span class="spacer"></span>
										<span class="tiny muted" id="send-inline"></span>
									</div>
								</div>
							`,
						})}
						<div class="grid" style="gap:14px">
							${projectCard}
							${bindCard}
							${card({ title: "会话", sub: `${list.length} 条`, body: sidebar })}
							${trafficCard}
						</div>
					</div>
				`,
			);

			const messagesNode = root.querySelector("#messages");
			if (messagesNode) messagesNode.scrollTop = messagesNode.scrollHeight;

			root.querySelectorAll("[data-open]").forEach((node) =>
				node.addEventListener("click", () => {
					ctx.go(`#/chat/${node.dataset.open}`);
					ctx.reload();
				}),
			);

			const bindCompany = root.querySelector("#bind-company");
			if (bindCompany) {
				bindCompany.addEventListener("change", async () => {
					try {
						await api.patch(`/api/chat/${current.id}`, { companyId: bindCompany.value });
						toast("已更新归属", "success");
						ctx.reload();
					} catch (error) {
						toast(error.message, "error");
					}
				});
			}
			const bindDevice = root.querySelector("#bind-device");
			if (bindDevice) {
				bindDevice.addEventListener("change", async () => {
					try {
						await api.patch(`/api/chat/${current.id}`, { deviceId: bindDevice.value });
						toast(bindDevice.value ? "已绑定设备，本会话的设备工具默认用它" : "已改为自动选择设备", "success");
						ctx.reload();
					} catch (error) {
						toast(error.message, "error");
					}
				});
			}

			const sendButton = root.querySelector("#send");
			if (sendButton) {
				const send = async () => {
					const composer = root.querySelector("#composer");
					const content = composer.value.trim();
					if (!content) return;
					sendButton.disabled = true;
					sendButton.textContent = "回复中…";
					root.querySelector("#send-status").textContent = "已发送，等待模型回复（推理模型可能要十几秒）";
					root.querySelector("#send-inline").textContent = "正在等待模型…";
					try {
						const result = await api.post(`/api/chat/${current.id}/messages`, { content });
						composer.value = "";
						// 项目是这一轮最重要的副作用，先说它，再说模型回没回话。
						if (result.project) toast(result.project.created ? `已自动建项目 ${result.project.id} 并开始侦察` : `已并入项目 ${result.project.id}`, "success", 6000);
						if (result.note) toast(result.note, "info", 9000);
						else if (!result.project) toast(`已回复（${result.elapsedMs}ms，${result.tokens} tokens）`, "success");
						ctx.reload();
					} catch (error) {
						// 关键：失败时也要刷新。服务端已经把用户消息和失败原因存进会话了。
						toast(error.message, "error", 8000);
						root.querySelector("#send-status").textContent = error.message;
						root.querySelector("#send-inline").textContent = "失败，见会话里的错误记录";
						setTimeout(() => ctx.reload(), 400);
					} finally {
						sendButton.disabled = false;
						sendButton.textContent = "发送";
					}
				};
				sendButton.addEventListener("click", send);
				root.querySelector("#composer").addEventListener("keydown", (event) => {
					if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
						event.preventDefault();
						send();
					}
				});
			}

			const delButton = root.querySelector("#del-chat");
			if (delButton) {
				delButton.addEventListener("click", async () => {
					try {
						await api.del(`/api/chat/${current.id}`);
						toast("已删除", "success");
						ctx.go("#/chat");
						ctx.reload();
					} catch (error) {
						toast(error.message, "error");
					}
				});
			}

			// 任务目标：对应原版的 {{.Goal}}，改了之后下一次对话就生效
			const saveGoal = root.querySelector("#save-goal");
			if (saveGoal) {
				saveGoal.addEventListener("click", async () => {
					try {
						await api.patch(`/api/chat/${current.id}`, { goal: root.querySelector("#chat-goal").value.trim() });
						toast("任务目标已保存", "success");
						ctx.reload();
					} catch (error) {
						toast(error.message, "error");
					}
				});
			}
		};

		await loadTraffic();
		paint();

		if (current?.id) {
			trafficTimer = setInterval(async () => {
				const prevFirst = traffic[0]?.id;
				const prevLen = traffic.length;
				const after = await loadTraffic();
				// 有新包才重绘，避免每 4 秒把输入框里的草稿和滚动位置重置掉。
				if (after.length !== prevLen || after[0]?.id !== prevFirst) {
					const draft = root.querySelector("#composer")?.value ?? "";
					paint();
					const composer = root.querySelector("#composer");
					if (composer && draft) composer.value = draft;
					const messagesNode = root.querySelector("#messages");
					if (messagesNode) messagesNode.scrollTop = messagesNode.scrollHeight;
				}
			}, 4000);
		}

		return () => {
			if (trafficTimer) clearInterval(trafficTimer);
			trafficTimer = null;
		};
	},
};
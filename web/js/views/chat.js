/**
 * 对话：流式会话 + 项目（任务）绑定 + 安卓形态。
 *
 * 这一版重点解决"卡"：
 *   1. 发送后立刻把用户气泡画出来（不等任何接口）；
 *   2. 服务端用 SSE 把"建了项目 / 第几轮 / 哪个工具跑完 / 最终结果"逐步推回来，
 *      界面只更新"正在回复"那一条气泡，不整页重绘；
 *   3. 右侧流量卡片每 4 秒只刷新自己那一小块，不动消息列表与输入框；
 *   4. 回复过程中可以点「停止」，走 /api/chat/:id/abort 中断上游请求。
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
	enumerate_subdomains: "子域枚举",
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

function escapeHtml(value) {
	return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

/** 消息节点：用户/模型气泡 + 工具折叠块。流式回复期间只重画"最后一条"。 */
function messageNode(message) {
	const mine = message.role === "user";
	const tools = Array.isArray(message.toolCalls) ? message.toolCalls : [];
	const node = document.createElement("div");
	node.className = mine ? "msg msg-user" : "msg msg-assistant";
	node.style.cssText = `margin-bottom:16px;padding:12px 14px;border-radius:10px;background:${mine ? "rgba(63,224,166,.07)" : "rgba(255,255,255,.03)"};border:1px solid ${mine ? "rgba(63,224,166,.22)" : "var(--line-soft)"}`;
	const meta = [];
	meta.push(`<span>${mine ? "我" : "模型"}</span>`);
	if (message.model) meta.push(`<span class="chip chip-muted">${escapeHtml(message.model)}</span>`);
	if (message.projectId) meta.push(`<a class="chip chip-info" href="#/tasks/${escapeHtml(message.projectId)}">${escapeHtml(message.projectId)}</a>`);
	if (message.inputTokens) meta.push(`<span title="输入 token">输入 ${message.inputTokens}</span>`);
	if (message.outputTokens) meta.push(`<span title="输出 token">输出 ${message.outputTokens}</span>`);
	if (message.reasoningTokens) meta.push(`<span title="推理 token">推理 ${message.reasoningTokens}</span>`);
	if (message.finishReason && message.finishReason !== "stop") meta.push(`<span class="chip chip-warn">${escapeHtml(message.finishReason)}</span>`);
	meta.push(`<span class="spacer"></span><span>${message.at ? fmtClock(message.at) : ""}</span>`);

	const toolHtml = tools.length
		? `<div class="chat-tools">${tools
				.map(
					(call) => `<details class="chat-tool" ${call.ok === false ? "data-failed" : ""}>
						<summary>${icon("terminal", { size: 14 })}<span class="mono tiny">${escapeHtml(call.name)}</span>
						<span class="tiny muted">${escapeHtml(TOOL_LABEL[call.name] ?? "")} ${call.ok === false ? "失败" : "完成"}${call.repeat ? "（重复调用）" : ""}</span></summary>
						<pre class="tiny">${escapeHtml(JSON.stringify(call.args ?? {}, null, 2))}</pre>
						<pre class="tiny">${escapeHtml(call.summary ?? "")}</pre>
					</details>`,
				)
				.join("")}</div>`
		: "";

	node.innerHTML = `
		<div class="row tiny muted" style="gap:8px;margin-bottom:6px">${meta.join("")}</div>
		${message.note ? `<div class="hint-box" style="margin-bottom:8px">${icon("alert", { size: 15 })}<span>${escapeHtml(message.note)}</span></div>` : ""}
		${message.projectNote ? `<div class="hint-box hint-ok" style="margin-bottom:8px">${icon("layers", { size: 15 })}<span>${escapeHtml(message.projectNote)}</span></div>` : ""}
		${toolHtml}
		<div class="msg-body" style="white-space:pre-wrap;${message.error ? "color:#ff9dae" : ""}">${escapeHtml(message.content || "（空）")}</div>`;
	return node;
}

export default {
	title: "对话",
	subtitle: "流式会话（自动建项目 · 可操作安卓设备）",

	async render(root, ctx) {
		mount(root, loading("读取会话…"));
		let list = [];
		try {
			list = (await api.get("/api/chat")).conversations ?? [];
		} catch (error) {
			mount(root, inlineError(error.message));
			return;
		}
		let llmState = null;
		try {
			llmState = await api.get("/api/llm");
		} catch {
			llmState = null;
		}
		const hasModel = Boolean(llmState?.available);

		const requested = ctx.param || list[0]?.id;
		let current = null;
		if (requested) {
			try {
				const loaded = await api.get(`/api/chat/${requested}`);
				current = loaded && typeof loaded === "object" ? { ...loaded, messages: Array.isArray(loaded.messages) ? loaded.messages : [] } : null;
			} catch {
				current = null;
			}
		}

		// ---- 页面状态：消息、项目、设备、流量都放在这里，重绘只动对应区块。
		const state = {
			messages: current?.messages ? [...current.messages] : [],
			project: current?.project ?? null,
			devices: current?.devices ?? [],
			companies: current?.companies ?? [],
			traffic: [],
			sending: false,
			streamTools: [],
			status: "",
			abort: null,
		};

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

		const projectCardBody = () => {
			const project = state.project;
			if (!project) {
				return `<div class="small muted">还没有项目。在下面说一句"对 example.com 做评估"，会话会自动建一个项目并开始侦察；
					模型也可以随时用 create_recon_task 追加目标。</div>`;
			}
			return `<div class="project-card">
				<div class="row" style="gap:8px;align-items:center">
					<span class="dim" style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(project.title)}</span>
					${statusChip(project.running ? "running" : project.status)}
				</div>
				<div class="tiny muted mt-8">
					${project.appPackage ? `<span class="mono">${escapeHtml(project.appPackage)}</span> · ` : ""}${escapeHtml(project.stage || "—")}
					${project.platform === "android" ? "" : ` · 目标 ${(project.scope ?? []).length}`}
				</div>
				<div class="project-metrics">
					<span><strong>${project.assets ?? 0}</strong> 资产</span>
					<span><strong>${project.findings ?? 0}</strong> 发现</span>
					<span><strong>${project.traffic ?? 0}</strong> 流量</span>
				</div>
				<div class="row mt-12" style="gap:8px">
					<a class="btn ghost small" href="#/traffic?taskId=${project.id}">看流量</a>
					<a class="btn ghost small" href="#/tasks/${project.id}">看项目</a>
					<a class="btn ghost small" href="#/findings?taskId=${project.id}">看漏洞</a>
				</div>
			</div>`;
		};

		const trafficCardBody = () => {
			if (!state.traffic.length) {
				return `<div class="small muted">这个会话还没有产生流量。任务跑起来后，DNS / HTTP / 设备命令都会在这里出现。</div>`;
			}
			return `<div class="traffic-tail">${state.traffic
				.slice(0, 8)
				.map(
					(item) => `<div class="traffic-tail-row">
						<span class="chip ${item.status === 0 ? "chip-danger" : item.status < 300 ? "chip-ok" : "chip-warn"}">${item.status || "ERR"}</span>
						<span class="mono tiny">${escapeHtml(item.method)}</span>
						<span class="tiny break" title="${escapeHtml(item.url)}">${escapeHtml(item.url)}</span>
						<span class="tiny muted nowrap">${fmtClock(item.at)}</span>
					</div>`,
				)
				.join("")}</div>`;
		};

		const sidebarBody = () =>
			list.length
				? `<div style="display:flex;flex-direction:column;gap:4px;max-height:40vh;overflow:auto">${list
						.map(
							(conversation) => `<div class="nav-item ${current?.id === conversation.id ? "active" : ""}" data-open="${conversation.id}" style="cursor:pointer">
								<div style="min-width:0;flex:1">
									<div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(conversation.title)}</div>
									<div class="tiny muted">${conversation.messageCount} 条 · ${relTime(conversation.updatedAt)}${conversation.taskId ? ` · ${escapeHtml(conversation.taskId)}` : ""}</div>
								</div>
							</div>`,
						)
						.join("")}</div>`
				: `<div class="muted small">还没有会话，点右上角「新对话」。</div>`;

		mount(
			root,
			html`
				${hasModel
					? ""
					: html`<div class="hint-box page-section">${raw(icon("alert", { size: 16 }))}<span>还没有可用的模型端点。去「设置 → 模型」添加一个档案并激活，对话才能工作。</span></div>`}
				<div class="split page-section">
					${card({
						title: current ? current.title : "未选择会话",
						sub: current ? `${state.messages.length} 条消息` : "",
						actions: current ? html`<button class="btn-icon danger" id="del-chat" title="删除会话">${raw(icon("trash", { size: 16 }))}</button>` : "",
						body: html`
							<div class="chat-status">
								<div class="row tiny muted" style="gap:14px;flex-wrap:wrap">
									<span>${llmState?.effectiveFrom ? html`模型 <strong style="color:var(--fg)">${llmState.effectiveFrom.modelId}</strong>` : html`<span style="color:#ff9dae">未配置模型</span>`}</span>
									<span id="msg-count">会话 ${state.messages.length} 条</span>
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
							</div>
							<div id="messages" style="max-height:52vh;overflow:auto;padding-right:6px"></div>
							<div class="mt-12">
								<textarea id="composer" rows="3" placeholder="${hasModel && current ? "说一句带目标的活儿，例如：对 example.com 与 www.example.com 做暴露面评估。Ctrl+Enter 发送" : "未配置模型端点"}" ${hasModel && current ? "" : "disabled"}></textarea>
								<div class="row mt-8" style="gap:8px">
									<button class="btn primary small" id="send" ${hasModel && current ? "" : "disabled"}>发送</button>
									<button class="btn danger small" id="stop" style="display:none">停止</button>
									<span class="spacer"></span>
									<span class="tiny muted" id="send-inline"></span>
								</div>
							</div>
						`,
					})}
					<div class="grid" style="gap:14px">
						${card({
							title: "项目",
							sub: state.project ? `${state.project.id}${state.project.platform === "android" ? " · 移动端" : ""}` : "未绑定",
							actions: state.project ? html`<a class="btn ghost small" href="#/tasks/${state.project.id}">打开</a>` : "",
							body: html`<div id="project-card-body"></div>`,
						})}
						${card({
							title: "绑定",
							sub: "形态 / 归属 / 设备",
							body: html`
								<label class="field">
									<span>会话形态</span>
									<select id="bind-mode">
										<option value="web" ${(current?.mode ?? "web") === "web" ? "selected" : ""}>Web 站点评估</option>
										<option value="android" ${current?.mode === "android" ? "selected" : ""}>安卓 App 评估</option>
									</select>
									<span class="hint">移动端形态下新项目按 App 建（认包名），不发起站点侦察。</span>
								</label>
								<label class="field">
									<span>公司（交付给谁）</span>
									<select id="bind-company">
										<option value="">未归属</option>
										${state.companies.map(
											(company) => html`<option value="${company.id}" ${company.id === current?.companyId ? "selected" : ""}>${company.name}</option>`,
										)}
									</select>
								</label>
								<label class="field mb-0">
									<span>安卓设备（默认操作哪台）</span>
									<select id="bind-device">
										<option value="">自动（唯一在线设备）</option>
										${state.devices.map(
											(device) => html`<option value="${device.id}" ${device.id === current?.deviceId ? "selected" : ""}>
												${device.name} · ${device.model ?? "?"} · ${device.liveness}
											</option>`,
										)}
									</select>
								</label>
							`,
						})}
						${card({ title: "会话", sub: `${list.length} 条`, body: html`<div id="chat-sidebar"></div>` })}
						${card({
							title: "流量",
							sub: "本会话最近",
							actions: current ? html`<a class="btn ghost small" href="#/traffic?conversationId=${current.id}">全部</a>` : "",
							body: html`<div id="traffic-tail"></div>`,
						})}
					</div>
				</div>
			`,
		);

		const messagesEl = root.querySelector("#messages");
		const composerEl = root.querySelector("#composer");
		const sendBtn = root.querySelector("#send");
		const stopBtn = root.querySelector("#stop");
		const statusEl = root.querySelector("#send-status");
		const inlineEl = root.querySelector("#send-inline");
		const nearBottom = () => messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;

		const paintMessages = () => {
			const stick = nearBottom();
			messagesEl.innerHTML = "";
			if (!state.messages.length) {
				messagesEl.innerHTML = `<div class="muted small empty-hint" style="padding:20px 0">还没有消息。${hasModel ? "在下面输入开始。" : "先到「设置 → 模型」加个端点。"}</div>`;
				return;
			}
			for (const message of state.messages) messagesEl.append(messageNode(message));
			if (stick) messagesEl.scrollTop = messagesEl.scrollHeight;
			const count = root.querySelector("#msg-count");
			if (count) count.textContent = `会话 ${state.messages.length} 条`;
		};
		const dropEmptyHint = () => messagesEl.querySelector(".empty-hint")?.remove();
		const appendMessage = (message) => {
			state.messages.push(message);
			const stick = nearBottom();
			dropEmptyHint();
			messagesEl.append(messageNode(message));
			if (stick) messagesEl.scrollTop = messagesEl.scrollHeight;
			const count = root.querySelector("#msg-count");
			if (count) count.textContent = `会话 ${state.messages.length} 条`;
		};
		const paintProject = () => {
			const body = root.querySelector("#project-card-body");
			if (body) body.innerHTML = projectCardBody();
		};
		const paintTraffic = () => {
			const body = root.querySelector("#traffic-tail");
			if (body) body.innerHTML = trafficCardBody();
		};
		const paintSidebar = () => {
			const body = root.querySelector("#chat-sidebar");
			if (!body) return;
			body.innerHTML = sidebarBody();
			body.querySelectorAll("[data-open]").forEach((node) =>
				node.addEventListener("click", () => {
					ctx.go(`#/chat/${node.dataset.open}`);
					ctx.reload();
				}),
			);
		};

		paintMessages();
		paintProject();
		paintTraffic();
		paintSidebar();

		// ---- 流式回复气泡：只有它会被反复改写，消息列表其它节点不动。
		let streamNode = null;
		const ensureStreamNode = () => {
			if (streamNode) return streamNode;
			dropEmptyHint();
			streamNode = document.createElement("div");
			streamNode.className = "msg msg-assistant";
			streamNode.style.cssText =
				"margin-bottom:16px;padding:12px 14px;border-radius:10px;background:rgba(255,255,255,.03);border:1px solid var(--line-soft)";
			streamNode.innerHTML = `<div class="row tiny muted" style="gap:8px;margin-bottom:6px"><span>模型</span><span id="stream-state">准备中…</span></div>
				<div id="stream-tools" class="chat-tools" style="display:none"></div>
				<div id="stream-body" style="white-space:pre-wrap;color:var(--muted)"></div>`;
			messagesEl.append(streamNode);
			messagesEl.scrollTop = messagesEl.scrollHeight;
			return streamNode;
		};
		const setStreamState = (text) => {
			ensureStreamNode();
			const el = streamNode.querySelector("#stream-state");
			if (el) el.textContent = text;
			statusEl.textContent = text;
		};
		const addStreamTool = (call) => {
			ensureStreamNode();
			const box = streamNode.querySelector("#stream-tools");
			box.style.display = "";
			const chip = document.createElement("details");
			chip.className = "chat-tool";
			if (call.ok === false) chip.setAttribute("data-failed", "");
			chip.innerHTML = `<summary>${icon("terminal", { size: 14 })}<span class="mono tiny">${escapeHtml(call.name)}</span>
				<span class="tiny muted">${escapeHtml(TOOL_LABEL[call.name] ?? "")} ${call.ok === false ? "失败" : "完成"}</span></summary>
				<pre class="tiny">${escapeHtml(JSON.stringify(call.args ?? {}, null, 2))}</pre>
				<pre class="tiny">${escapeHtml(call.summary ?? "")}</pre>`;
			box.append(chip);
			messagesEl.scrollTop = messagesEl.scrollHeight;
		};
		const clearStreamNode = () => {
			if (streamNode) streamNode.remove();
			streamNode = null;
		};

		// ---- SSE 解析：按 "\n\n" 切事件，event: 名字 / data: JSON。
		const readStream = async (response, onEvent) => {
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				let index = buffer.indexOf("\n\n");
				while (index >= 0) {
					const chunk = buffer.slice(0, index);
					buffer = buffer.slice(index + 2);
					let event = "message";
					let data = "";
					for (const line of chunk.split("\n")) {
						if (line.startsWith("event:")) event = line.slice(6).trim();
						else if (line.startsWith("data:")) data += line.slice(5).trim();
					}
					if (data) {
						try {
							onEvent(event, JSON.parse(data));
						} catch {
							/* 半截 JSON 丢掉即可 */
						}
					}
					index = buffer.indexOf("\n\n");
				}
			}
		};

		const setSending = (sending) => {
			state.sending = sending;
			sendBtn.disabled = sending;
			sendBtn.textContent = sending ? "回复中…" : "发送";
			stopBtn.style.display = sending ? "" : "none";
			inlineEl.textContent = sending ? "已发送，正在等模型…" : "";
		};

		const send = async () => {
			if (!current || state.sending) return;
			const content = composerEl.value.trim();
			if (!content) return;
			composerEl.value = "";
			// 1) 乐观渲染：用户气泡立刻出现，不等服务端。
			appendMessage({ role: "user", content, at: new Date().toISOString() });
			setSending(true);
			state.streamTools = [];
			ensureStreamNode();
			setStreamState("已发送，等待模型…");
			const controller = new AbortController();
			state.abort = controller;
			let finished = false;

			const finishTurn = () => {
				finished = true;
				state.abort = null;
				clearStreamNode();
				setSending(false);
			};

			try {
				let response;
				try {
					response = await fetch(`/api/chat/${current.id}/messages/stream`, {
						method: "POST",
						headers: { "content-type": "application/json", authorization: `Bearer ${localStorage.getItem("regedit.token") ?? ""}` },
						body: JSON.stringify({ content }),
						signal: controller.signal,
					});
				} catch (error) {
					throw new Error(`网络错误：${error.message}`);
				}
				if (!response.ok) {
					const payload = await response.json().catch(() => null);
					throw new Error(payload?.error ?? `HTTP ${response.status}`);
				}
				const contentType = response.headers.get("content-type") ?? "";
				if (!contentType.includes("text/event-stream") || !response.body) {
					// 反代/老环境把 SSE 吃掉了：退回一次性 JSON，行为与旧版一致。
					const payload = await response.json().catch(() => null);
					if (!payload?.reply) throw new Error("服务端没有返回内容");
					appendMessage({
						role: "assistant",
						content: payload.reply,
						at: new Date().toISOString(),
						model: payload.model,
						projectId: payload.conversation?.taskId ?? undefined,
						note: payload.note,
						toolCalls: payload.tools,
						inputTokens: payload.inputTokens,
						outputTokens: payload.outputTokens,
					});
					if (payload.project) toast(payload.project.created ? `已建项目 ${payload.project.id}` : `已并入项目 ${payload.project.id}`, "success");
					finishTurn();
					await refreshProject();
					return;
				}

				await readStream(response, (event, payload) => {
					if (event === "user") {
						// 服务端回执：把乐观气泡的时间戳对齐真实入库值（内容一致，不动节点）。
						const last = state.messages[state.messages.length - 1];
						if (last && last.role === "user" && payload.message?.at) last.at = payload.message.at;
						return;
					}
					if (event === "project") {
						state.project = { ...(state.project ?? {}), ...(payload.project ?? {}) };
						paintProject();
						if (payload.note) appendSystemNote(payload.note);
						return;
					}
					if (event === "round") {
						setStreamState(`第 ${payload.round} 轮 · ${payload.calls} 个工具调用`);
						return;
					}
					if (event === "status") {
						setStreamState(payload.text ?? "处理中…");
						return;
					}
					if (event === "tool-start") {
						setStreamState(`执行 ${TOOL_LABEL[payload.name] ?? payload.name}…`);
						return;
					}
					if (event === "tool") {
						addStreamTool(payload);
						setStreamState(`已完成 ${TOOL_LABEL[payload.name] ?? payload.name}`);
						return;
					}
					if (event === "done") {
						const result = payload.result ?? {};
						clearStreamNode();
						appendMessage({
							role: "assistant",
							content: result.reply ?? "",
							at: new Date().toISOString(),
							model: result.model,
							projectId: result.conversation?.taskId ?? undefined,
							note: result.note,
							toolCalls: result.tools,
							inputTokens: result.inputTokens,
							outputTokens: result.outputTokens,
							finishReason: result.finishReason,
						});
						if (result.project) {
							toast(result.project.created ? `已自动建项目 ${result.project.id}` : `已并入项目 ${result.project.id}`, "success", 5000);
						}
						if (result.note) toast(result.note, "info", 8000);
						finished = true;
						return;
					}
					if (event === "error") {
						appendMessage({ role: "assistant", content: `（调用失败）${payload.message ?? "未知错误"}`, at: new Date().toISOString(), error: true });
						finished = true;
					}
				});
			} catch (error) {
				if (error.name === "AbortError") {
					appendMessage({ role: "assistant", content: "（已停止本次回复）", at: new Date().toISOString(), note: "你点了停止，或连接中断" });
				} else {
					appendMessage({ role: "assistant", content: `（调用失败）${error.message}`, at: new Date().toISOString(), error: true });
				}
			} finally {
				finishTurn();
				await refreshProject();
			}
		};

		// 项目新建/追加的系统提示：作为一条轻量气泡插入，避免污染模型消息历史。
		const appendSystemNote = (text) => {
			const note = document.createElement("div");
			note.className = "hint-box hint-ok";
			note.style.marginBottom = "12px";
			note.innerHTML = `${icon("layers", { size: 15 })}<span>${escapeHtml(text)}</span>`;
			messagesEl.append(note);
			messagesEl.scrollTop = messagesEl.scrollHeight;
		};

		/** 拉一次项目详情（轻量：只取 task），刷新项目卡与侧栏。 */
		const refreshProject = async () => {
			if (!current?.taskId && !state.project?.id) return;
			const taskId = state.project?.id ?? current?.taskId;
			try {
				const detail = await api.get(`/api/tasks/${taskId}`);
				const task = detail.task ?? {};
				state.project = {
					...(state.project ?? {}),
					id: task.id,
					title: task.title,
					status: task.status,
					stage: task.stage,
					platform: task.platform ?? "web",
					appPackage: task.appPackage ?? "",
					scope: task.scope ?? [],
					running: task.running,
					assets: (detail.assets ?? []).length,
					findings: (detail.findings ?? []).length,
					traffic: (detail.traffic ?? []).length,
				};
				paintProject();
			} catch {
				/* 项目详情失败不影响对话 */
			}
		};

		// ---- 事件绑定
		sendBtn.addEventListener("click", send);
		composerEl.addEventListener("keydown", (event) => {
			if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
				event.preventDefault();
				send();
			}
		});
		stopBtn.addEventListener("click", async () => {
			try {
				await api.post(`/api/chat/${current.id}/abort`, {});
				state.abort?.abort();
				toast("已发送停止指令", "info");
			} catch (error) {
				toast(error.message, "error");
			}
		});

		root.querySelector("#bind-mode")?.addEventListener("change", async (event) => {
			try {
				await api.patch(`/api/chat/${current.id}`, { mode: event.target.value });
				toast(event.target.value === "android" ? "已切到安卓形态" : "已切到 Web 形态", "success", 5000);
			} catch (error) {
				toast(error.message, "error");
			}
		});
		root.querySelector("#bind-company")?.addEventListener("change", async (event) => {
			try {
				await api.patch(`/api/chat/${current.id}`, { companyId: event.target.value });
				toast("已更新归属", "success");
			} catch (error) {
				toast(error.message, "error");
			}
		});
		root.querySelector("#bind-device")?.addEventListener("change", async (event) => {
			try {
				await api.patch(`/api/chat/${current.id}`, { deviceId: event.target.value });
				toast(event.target.value ? "已绑定设备" : "已改为自动选择设备", "success");
			} catch (error) {
				toast(error.message, "error");
			}
		});
		root.querySelector("#save-goal")?.addEventListener("click", async () => {
			try {
				await api.patch(`/api/chat/${current.id}`, { goal: root.querySelector("#chat-goal").value.trim() });
				toast("任务目标已保存", "success");
			} catch (error) {
				toast(error.message, "error");
			}
		});
		root.querySelector("#del-chat")?.addEventListener("click", async () => {
			try {
				await api.del(`/api/chat/${current.id}`);
				toast("已删除", "success");
				ctx.go("#/chat");
				ctx.reload();
			} catch (error) {
				toast(error.message, "error");
			}
		});

		// ---- 流量卡片：只刷自己那一块，4 秒一轮；不得触碰消息列表与输入框。
		const loadTraffic = async () => {
			if (!current?.id) return;
			try {
				const items = await api.get(`/api/traffic?limit=12&conversationId=${encodeURIComponent(current.id)}`);
				state.traffic = Array.isArray(items) ? items : [];
				paintTraffic();
			} catch {
				/* 流量失败静默：不影响对话 */
			}
		};
		await loadTraffic();
		const trafficTimer = setInterval(loadTraffic, 4000);

		return () => {
			clearInterval(trafficTimer);
			state.abort?.abort();
		};
	},
};
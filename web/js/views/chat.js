/**
 * 对话：多轮 + 真实模型调用。
 * 没有配模型端点时页面明确提示去哪配，不假装能聊。
 */

import { icon } from "../icons.js";
import { api, fmtTime, html, mount, raw, relTime, toast, toNode } from "../core.js";
import { card, inlineError, loading } from "../ui.js";

export default {
	title: "对话",
	subtitle: "与大模型的多轮会话",

	async render(root, ctx) {
		mount(root, loading("读取会话…"));
		let list;
		let current = null;
		try {
			const payload = await api.get("/api/chat");
			list = payload.conversations;
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
		// 直接进「对话」页却看到"未选择会话"，会让人以为刚才的对话丢了。
		const requested = ctx.param || list[0]?.id;
		if (requested) {
			try {
				const loaded = await api.get(`/api/chat/${requested}`);
				// 服务端理论上一定给 messages，但这里不能假设：缺字段会让整个页面
				// 崩在 current.messages.length 上（UI 测试就抓到过）。
				current = loaded && typeof loaded === "object"
					? { ...loaded, messages: Array.isArray(loaded.messages) ? loaded.messages : [] }
					: null;
			} catch {
				current = null;
			}
		}

		const paint = () => {
			const sidebar = list.length
				? html`<div style="display:flex;flex-direction:column;gap:4px;max-height:66vh;overflow:auto">
						${list.map(
							(conversation) => html`<div class="nav-item ${current?.id === conversation.id ? "active" : ""}" data-open="${conversation.id}" style="cursor:pointer">
								<div style="min-width:0;flex:1">
									<div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${conversation.title}</div>
									<div class="tiny muted">${conversation.messageCount} 条 · ${relTime(conversation.updatedAt)}</div>
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
									${message.inputTokens ? html`<span title="输入（prompt）token">输入 ${message.inputTokens}</span>` : ""}
									${message.outputTokens ? html`<span title="输出（completion）token">输出 ${message.outputTokens}</span>` : ""}
									${message.reasoningTokens ? html`<span title="推理过程消耗的 token">推理 ${message.reasoningTokens}</span>` : ""}
									${!message.inputTokens && message.tokens ? html`<span>${message.tokens} tokens</span>` : ""}
									${message.finishReason && message.finishReason !== "stop" ? html`<span class="chip chip-warn">${message.finishReason}</span>` : ""}
									<span class="spacer"></span>
									<span>${message.at ? fmtTime(message.at).slice(11, 19) : ""}</span>
								</div>
								${message.note ? html`<div class="hint-box" style="margin-bottom:8px">${raw(icon("alert", { size: 15 }))}<span>${message.note}</span></div>` : ""}
								${Array.isArray(message.toolCalls) && message.toolCalls.length
									? html`<div class="chat-tools">
											${message.toolCalls.map(
												(call) => html`<details class="chat-tool" ${call.ok ? "" : "data-failed"}>
													<summary>
														${raw(icon("terminal", { size: 14 }))}
														<span class="mono tiny">${call.name}</span>
														<span class="tiny muted">${call.ok ? "完成" : "失败"}</span>
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

			// 状态条：让操作员一眼看到"用的是哪个模型、当前这条会话什么状态"，
			// 而不是发了消息只看到一片空白不知道发生了什么。
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
							sub: current ? `${current.messages.length} 条消息` : "",
							actions: current
								? html`<button class="btn-icon danger" id="del-chat" title="删除会话">${raw(icon("trash", { size: 16 }))}</button>`
								: "",
							body: html`
								${statusBar}
								<div id="messages" style="max-height:52vh;overflow:auto;padding-right:6px">${messages}</div>
								<div class="mt-12">
									<textarea id="composer" rows="3" placeholder="${hasModel ? "输入消息，Ctrl+Enter 发送" : "未配置模型端点"}" ${hasModel && current ? "" : "disabled"}></textarea>
									<div class="row mt-8">
										<button class="btn primary small" id="send" ${hasModel && current ? "" : "disabled"}>发送</button>
										<span class="spacer"></span>
										<span class="tiny muted" id="send-inline"></span>
									</div>
								</div>
							`,
						})}
						${card({ title: "会话", sub: `${list.length} 条`, body: sidebar })}
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
						// 服务端把"空正文/被截断"的原因放在 note 里，必须让操作员看到
						if (result.note) toast(result.note, "info", 9000);
						else toast(`已回复（${result.elapsedMs}ms，${result.tokens} tokens）`, "success");
						ctx.reload();
					} catch (error) {
						// 关键：失败时也要刷新。服务端已经把用户消息和失败原因存进会话了，
						// 不刷新的话界面上还是空的，看起来像"什么都没发生"。
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

		paint();
	},
};
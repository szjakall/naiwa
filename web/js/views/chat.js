/**
 * 对话：多轮 + 真实模型调用。
 * 没有配模型端点时页面明确提示去哪配，不假装能聊。
 */

import { icon } from "../icons.js";
import { api, fmtTime, html, mount, openOverlay, raw, relTime, toast, toNode } from "../core.js";
import { card, emptyState, inlineError, loading } from "../ui.js";

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

		// 支持 #/chat/<id> 直达
		const requested = ctx.param;
		if (requested) {
			try {
				current = await api.get(`/api/chat/${requested}`);
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
									${message.tokens ? html`<span>${message.tokens} tokens</span>` : ""}
									<span class="spacer"></span>
									<span>${message.at ? fmtTime(message.at).slice(11, 19) : ""}</span>
								</div>
								<div style="white-space:pre-wrap;${message.error ? "color:#ff9dae" : ""}">${message.content}</div>
							</div>`,
						)
				: html`<div class="muted small" style="padding:20px 0">还没有消息。${hasModel ? "在下面输入开始。" : "先到「设置 → 模型」加一个端点。"}</div>`;

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
								<div id="messages" style="max-height:52vh;overflow:auto;padding-right:6px">${messages}</div>
								<div class="mt-12">
									<textarea id="composer" rows="3" placeholder="${hasModel ? "输入消息，Ctrl+Enter 发送" : "未配置模型端点"}" ${hasModel && current ? "" : "disabled"}></textarea>
									<div class="row mt-8">
										<button class="btn primary small" id="send" ${hasModel && current ? "" : "disabled"}>发送</button>
										<span class="spacer"></span>
										<span class="tiny muted" id="send-status"></span>
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
					root.querySelector("#send-status").textContent = "发送中…";
					try {
						const result = await api.post(`/api/chat/${current.id}/messages`, { content });
						composer.value = "";
						toast(`已回复（${result.elapsedMs}ms，${result.tokens} tokens）`, "success");
						ctx.reload();
					} catch (error) {
						toast(error.message, "error");
						root.querySelector("#send-status").textContent = error.message;
					} finally {
						sendButton.disabled = false;
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
		};

		paint();
	},
};
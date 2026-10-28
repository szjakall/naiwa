/**
 * 代理、通知、权限、公司与报告配置：四个管理页合成一个"设置中心"式的入口？
 * 不合并——它们本来就是独立页，合并会让导航变得难找。
 * 这个文件只放代理与通知（都是"通道"类），权限与公司各自独立。
 */

import { icon } from "../icons.js";
import { api, fmtTime, html, mount, openOverlay, raw, relTime, toast, toNode } from "../core.js";
import { card, emptyState, inlineError, loading } from "../ui.js";

// ---------------------------------------------------------------- 代理

export const proxies = {
	title: "代理",
	subtitle: "代理档案与连通性测试",

	async render(root, ctx) {
		mount(root, loading("读取代理档案…"));
		let payload;
		try {
			payload = await api.get("/api/proxies");
		} catch (error) {
			mount(root, inlineError(error.message));
			return;
		}

		let items = payload.items;
		const actions = toNode(html`<button class="btn primary small" id="new-proxy">${raw(icon("plus", { size: 15 }))}新建档案</button>`);
		ctx.setHeader("代理", `${items.length} 个档案`, actions);
		actions.querySelector("#new-proxy").addEventListener("click", () => openProxyForm(null, ctx));

		const paint = () => {
			const body = items.length
				? html`<div class="table-wrap">
						<table>
							<thead>
								<tr><th>名称</th><th class="nowrap">类型</th><th class="nowrap">地址</th><th class="nowrap">节点</th><th class="nowrap">最近测试</th><th></th></tr>
							</thead>
							<tbody>
								${items.map(
									(item) => html`<tr>
										<td>
											<div class="dim">${item.name}</div>
											${item.note ? html`<div class="tiny muted">${item.note}</div>` : ""}
										</td>
										<td class="nowrap"><span class="chip chip-muted">${item.type}</span></td>
										<td class="nowrap mono tiny">${item.host ? `${item.host}:${item.port}` : item.subscription ? "订阅" : "—"}</td>
										<td class="nowrap mono tiny">${item.nodes.length || "—"}</td>
										<td class="nowrap tiny">
											${item.lastTest
												? html`<span class="${item.lastTest.ok ? "chip chip-ok" : "chip-danger"}">${item.lastTest.ok ? "可用" : "失败"}</span>
														<div class="muted">${relTime(item.lastTest.at)}</div>`
												: html`<span class="muted">未测试</span>`}
										</td>
										<td class="nowrap center">
											<button class="btn ghost small" data-test="${item.id}">测试</button>
											${item.subscription ? html`<button class="btn ghost small" data-refresh="${item.id}">拉取</button>` : ""}
											<button class="btn ghost small" data-edit="${item.id}">编辑</button>
											<button class="btn-icon danger" data-del="${item.id}" title="删除">${raw(icon("trash", { size: 16 }))}</button>
										</td>
									</tr>`,
								)}
							</tbody>
						</table>
					</div>`
				: emptyState({
						iconName: "link",
						title: "还没有代理档案",
						description: "档案用于记录出口节点，并可做真实连通性测试。控制台自身的请求不走代理。",
					});

			mount(
				root,
				html`
					<div class="hint-box page-section">
						${raw(icon("alert", { size: 16 }))}
						<span>说明：控制台本身不通过代理发请求。这里是"可管理、可测试、可导出"的档案，
						给作业容器/设备网关用；本项目当前没有容器，所以它只做配置与连通性验证。</span>
					</div>
					${card({ body, tight: true })}
				`,
			);

			root.querySelectorAll("[data-test]").forEach((node) =>
				node.addEventListener("click", async () => {
					node.disabled = true;
					node.textContent = "测试中";
					try {
						const result = await api.post(`/api/proxies/${node.dataset.test}/test`, {});
						toast(result.message, result.ok ? "success" : "error", 6000);
						ctx.reload();
					} catch (error) {
						toast(error.message, "error");
						node.disabled = false;
						node.textContent = "测试";
					}
				}),
			);
			root.querySelectorAll("[data-refresh]").forEach((node) =>
				node.addEventListener("click", async () => {
					node.disabled = true;
					try {
						const result = await api.post(`/api/proxies/${node.dataset.refresh}/refresh`, {});
						toast(result.ok ? `拉取到 ${result.nodes} 个节点` : result.error, result.ok ? "success" : "error");
						ctx.reload();
					} catch (error) {
						toast(error.message, "error");
						node.disabled = false;
					}
				}),
			);
			root.querySelectorAll("[data-edit]").forEach((node) =>
				node.addEventListener("click", () => {
					openProxyForm(items.find((i) => i.id === node.dataset.edit), ctx);
				}),
			);
			root.querySelectorAll("[data-del]").forEach((node) =>
				node.addEventListener("click", async () => {
					try {
						await api.del(`/api/proxies/${node.dataset.del}`);
						items = items.filter((i) => i.id !== node.dataset.del);
						paint();
					} catch (error) {
						toast(error.message, "error");
					}
				}),
			);
		};

		paint();
	},
};

function openProxyForm(profile, ctx) {
	const overlay = openOverlay(html`
		<div class="overlay-head"><h3>${profile ? "编辑代理档案" : "新建代理档案"}</h3></div>
		<div class="overlay-body">
			<div class="split-even" style="gap:12px">
				<label class="field">
					<span>名称</span>
					<input data-name value="${profile?.name ?? ""}" placeholder="香港出口" />
				</label>
				<label class="field">
					<span>类型</span>
					<select data-type>
						${["http", "socks5", "socks5h"].map(
							(t) => html`<option value="${t}" ${profile?.type === t ? "selected" : ""}>${t}</option>`,
						)}
					</select>
				</label>
			</div>
			<div class="split-even" style="gap:12px">
				<label class="field">
					<span>主机</span>
					<input data-host value="${profile?.host ?? ""}" placeholder="127.0.0.1" />
				</label>
				<label class="field">
					<span>端口</span>
					<input data-port type="number" value="${profile?.port ?? ""}" placeholder="1080" />
				</label>
			</div>
			<div class="split-even" style="gap:12px">
				<label class="field">
					<span>用户名（可选）</span>
					<input data-username value="${profile?.username ?? ""}" />
				</label>
				<label class="field">
					<span>密码（可选）</span>
					<input data-password type="password" value="${profile?.password ?? ""}" />
				</label>
			</div>
			<label class="field">
				<span>订阅地址（可选，支持 base64 / Clash YAML / host:port 列表）</span>
				<input data-subscription value="${profile?.subscription ?? ""}" placeholder="https://…" />
			</label>
			<label class="field mb-0">
				<span>备注</span>
				<input data-note value="${profile?.note ?? ""}" />
			</label>
		</div>
		<div class="overlay-foot">
			<button class="btn ghost" data-close>取消</button>
			<button class="btn primary" data-save>保存</button>
		</div>
	`, { wide: true });

	overlay.panel.querySelector("[data-save]").addEventListener("click", async () => {
		const payload = {
			id: profile?.id,
			name: overlay.panel.querySelector("[data-name]").value.trim(),
			type: overlay.panel.querySelector("[data-type]").value,
			host: overlay.panel.querySelector("[data-host]").value.trim(),
			port: Number(overlay.panel.querySelector("[data-port]").value) || 0,
			username: overlay.panel.querySelector("[data-username]").value.trim(),
			password: overlay.panel.querySelector("[data-password]").value,
			subscription: overlay.panel.querySelector("[data-subscription]").value.trim(),
			note: overlay.panel.querySelector("[data-note]").value.trim(),
		};
		try {
			await api.post("/api/proxies", payload);
			overlay.close();
			toast("已保存", "success");
			ctx.reload();
		} catch (error) {
			toast(error.message, "error");
		}
	});
}

// ---------------------------------------------------------------- 通知

export const notify = {
	title: "通知",
	subtitle: "Webhook / 邮件渠道与触发点",

	async render(root, ctx) {
		mount(root, loading("读取通知配置…"));
		let state;
		try {
			state = await api.get("/api/notify");
		} catch (error) {
			mount(root, inlineError(error.message));
			return;
		}

		const actions = toNode(html`<button class="btn primary small" id="new-channel">${raw(icon("plus", { size: 15 }))}新建渠道</button>`);
		ctx.setHeader("通知", `${state.channels.length} 个渠道`, actions);
		actions.querySelector("#new-channel").addEventListener("click", () => openChannelForm(null, ctx));

		const channelsBody = state.channels.length
			? html`<div class="table-wrap">
					<table>
						<tbody>
							${state.channels.map(
								(channel) => html`<tr>
									<td class="nowrap"><span class="chip chip-muted">${channel.kind}</span></td>
									<td>
										<div class="dim">${channel.name}</div>
										<div class="tiny muted break">${channel.kind === "email" ? `${channel.smtpHost} → ${channel.emailTo}` : channel.url}</div>
									</td>
									<td class="nowrap">
										${channel.enabled ? html`<span class="chip chip-ok">启用</span>` : html`<span class="chip chip-muted">停用</span>`}
									</td>
									<td class="nowrap tiny muted">
										${channel.lastTest ? html`<span class="${channel.lastTest.ok ? "chip chip-ok" : "chip-danger"}">${channel.lastTest.ok ? "发送成功" : "失败"}</span>` : "未测试"}
									</td>
									<td class="nowrap center">
										<button class="btn ghost small" data-test="${channel.id}">测试</button>
										<button class="btn ghost small" data-edit="${channel.id}">编辑</button>
										<button class="btn-icon danger" data-del="${channel.id}" title="删除">${raw(icon("trash", { size: 16 }))}</button>
									</td>
								</tr>`,
							)}
						</tbody>
					</table>
				</div>`
			: emptyState({ iconName: "alert", title: "还没有通知渠道", description: "配一个 Webhook 或邮件，守门拦截与设备离线时会叫你。" });

		mount(
			root,
			html`
				<div class="page-section">
					${card({
						title: "触发点",
						sub: "什么时候发通知",
						body: html`<div class="row" style="gap:18px;flex-wrap:wrap">
							${state.triggers.map(
								(trigger) => html`<label class="checkbox">
									<input type="checkbox" data-trigger="${trigger.id}" ${trigger.enabled ? "checked" : ""} />
									<span>${trigger.label}<span class="tiny muted"> · ${trigger.hint}</span></span>
								</label>`,
							)}
						</div>`,
					})}
				</div>
				<div class="page-section">${card({ title: "渠道", body: channelsBody, tight: true })}</div>
				${state.history.length
					? card({
							title: "发送记录",
							body: html`<div class="table-wrap" style="max-height:240px">
								<table>
									<tbody>
										${state.history.slice(0, 20).map(
											(row) => html`<tr>
												<td class="nowrap tiny muted">${fmtTime(row.at).slice(5, 16)}</td>
												<td class="nowrap tiny">${row.channel}</td>
												<td class="break tiny">${row.title}</td>
												<td class="nowrap">${row.ok ? html`<span class="chip chip-ok">成功</span>` : html`<span class="chip chip-danger">失败</span>`}</td>
												<td class="nowrap tiny muted">${row.message ?? ""}</td>
											</tr>`,
										)}
									</tbody>
								</table>
							</div>`,
						})
					: ""}
			`,
		);

		root.querySelectorAll("[data-trigger]").forEach((node) =>
			node.addEventListener("change", async () => {
				try {
					await api.put(`/api/notify/triggers/${node.dataset.trigger}`, { enabled: node.checked });
					toast("已更新", "success");
				} catch (error) {
					toast(error.message, "error");
					node.checked = !node.checked;
				}
			}),
		);
		root.querySelectorAll("[data-test]").forEach((node) =>
			node.addEventListener("click", async () => {
				node.disabled = true;
				node.textContent = "发送中";
				try {
					const result = await api.post(`/api/notify/channels/${node.dataset.test}/test`, {});
					toast(result.message, result.ok ? "success" : "error", 6000);
					ctx.reload();
				} catch (error) {
					toast(error.message, "error");
					node.disabled = false;
					node.textContent = "测试";
				}
			}),
		);
		root.querySelectorAll("[data-edit]").forEach((node) =>
			node.addEventListener("click", () => {
				openChannelForm(state.channels.find((c) => c.id === node.dataset.edit), ctx);
			}),
		);
		root.querySelectorAll("[data-del]").forEach((node) =>
			node.addEventListener("click", async () => {
				try {
					await api.del(`/api/notify/channels/${node.dataset.del}`);
					ctx.reload();
				} catch (error) {
					toast(error.message, "error");
				}
			}),
		);
	},
};

function openChannelForm(channel, ctx) {
	const overlay = openOverlay(html`
		<div class="overlay-head"><h3>${channel ? "编辑渠道" : "新建渠道"}</h3></div>
		<div class="overlay-body">
			<div class="split-even" style="gap:12px">
				<label class="field">
					<span>名称</span>
					<input data-name value="${channel?.name ?? ""}" placeholder="运维群" />
				</label>
				<label class="field">
					<span>类型</span>
					<select data-kind>
						<option value="webhook" ${channel?.kind === "webhook" ? "selected" : ""}>Webhook</option>
						<option value="email" ${channel?.kind === "email" ? "selected" : ""}>邮件</option>
					</select>
				</label>
			</div>
			<label class="field">
				<span>Webhook 地址</span>
				<input data-url value="${channel?.url ?? ""}" placeholder="https://oapi.dingtalk.com/robot/send?access_token=…" />
			</label>
			<div class="apk-section">
				<h4>邮件设置（选邮件类型时填）</h4>
				<div class="split-even" style="gap:12px">
					<label class="field">
						<span>SMTP 主机</span>
						<input data-smtp-host value="${channel?.smtpHost ?? ""}" placeholder="smtp.example.com" />
					</label>
					<label class="field">
						<span>端口</span>
						<input data-smtp-port type="number" value="${channel?.smtpPort ?? ""}" placeholder="465" />
					</label>
					<label class="field">
						<span>用户名</span>
						<input data-smtp-user value="${channel?.smtpUser ?? ""}" />
					</label>
					<label class="field">
						<span>密码 / 授权码</span>
						<input data-password type="password" value="${channel?.password ?? ""}" />
					</label>
					<label class="field">
						<span>收件人</span>
						<input data-email value="${channel?.emailTo ?? ""}" />
					</label>
					<label class="checkbox" style="align-self:end;margin-bottom:12px">
						<input type="checkbox" data-secure ${channel?.secure ? "checked" : ""} />
						<span>使用 TLS（465）</span>
					</label>
				</div>
			</div>
		</div>
		<div class="overlay-foot">
			<button class="btn ghost" data-close>取消</button>
			<button class="btn primary" data-save>保存</button>
		</div>
	`, { wide: true });

	overlay.panel.querySelector("[data-save]").addEventListener("click", async () => {
		const payload = {
			id: channel?.id,
			name: overlay.panel.querySelector("[data-name]").value.trim(),
			kind: overlay.panel.querySelector("[data-kind]").value,
			enabled: channel?.enabled !== false,
			url: overlay.panel.querySelector("[data-url]").value.trim(),
			smtpHost: overlay.panel.querySelector("[data-smtp-host]").value.trim(),
			smtpPort: Number(overlay.panel.querySelector("[data-smtp-port]").value) || 0,
			smtpUser: overlay.panel.querySelector("[data-smtp-user]").value.trim(),
			password: overlay.panel.querySelector("[data-password]").value,
			emailTo: overlay.panel.querySelector("[data-email]").value.trim(),
			secure: overlay.panel.querySelector("[data-secure]").checked,
		};
		try {
			await api.post("/api/notify/channels", payload);
			overlay.close();
			toast("已保存", "success");
			ctx.reload();
		} catch (error) {
			toast(error.message, "error");
		}
	});
}
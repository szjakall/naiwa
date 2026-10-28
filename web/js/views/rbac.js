/**
 * 权限（RBAC）：角色 × 权限矩阵，用户 → 角色映射。
 * 内置角色不可删除，但权限可改；owner 兜底，避免把自己锁在门外。
 */

import { icon } from "../icons.js";
import { api, html, mount, openOverlay, raw, toast, toNode } from "../core.js";
import { card, emptyState, inlineError, loading } from "../ui.js";

export default {
	title: "权限",
	subtitle: "角色、权限与用户映射",

	async render(root, ctx) {
		mount(root, loading("读取权限配置…"));
		let meta;
		let users;
		try {
			[meta, users] = await Promise.all([api.get("/api/rbac/metadata"), api.get("/api/rbac/users")]);
		} catch (error) {
			mount(root, inlineError(error.message));
			return;
		}

		let roles = meta.roles;
		const catalogue = meta.catalogue;

		const actions = toNode(html`<button class="btn primary small" id="new-role">${raw(icon("plus", { size: 15 }))}新建角色</button>`);
		ctx.setHeader("权限", `${roles.length} 个角色 · ${users.users.length} 个用户`, actions);
		actions.querySelector("#new-role").addEventListener("click", () => openRoleForm(null, catalogue, ctx));

		const paint = () => {
			const roleCards = roles
				.map(
					(role) => html`<div class="card">
						<div class="card-head">
							<h3>${role.name}</h3>
							<span class="sub">${role.id}</span>
							<div class="spacer"></div>
							${role.system ? html`<span class="chip chip-muted">内置</span>` : ""}
							<span class="chip chip-info">${role.perms.length} 项权限</span>
							<span class="chip chip-muted">${role.userCount} 人</span>
						</div>
						<div class="card-body">
							<p class="small muted" style="margin-top:0">${role.desc || "（无描述）"}</p>
							<div class="permission-list">
								${role.perms.slice(0, 18).map((perm) => html`<span class="permission">${perm}</span>`)}
								${role.perms.length > 18 ? html`<span class="permission">…还有 ${role.perms.length - 18} 项</span>` : ""}
							</div>
							<div class="row mt-12">
								<button class="btn ghost small" data-edit="${role.id}">编辑权限</button>
								${role.system
									? ""
									: html`<button class="btn-icon danger" data-del="${role.id}" title="删除角色">${raw(icon("trash", { size: 16 }))}</button>`}
							</div>
						</div>
					</div>`,
				);

			const userRows = users.users
				.map(
					(user) => html`<tr>
						<td class="dim">${user.name}</td>
						<td class="nowrap">
							<select data-user-role="${user.name}" style="max-width:180px">
								${roles.map(
									(role) => html`<option value="${role.id}" ${user.roleId === role.id ? "selected" : ""}>${role.name}</option>`,
								)}
							</select>
						</td>
						<td class="nowrap tiny muted">${user.roleName}</td>
					</tr>`,
				);

			mount(
				root,
				html`
					<div class="hint-box page-section">
						${raw(icon("shield", { size: 16 }))}
						<span>两个开关都要过：工具（设置 → 工具）决定这项能力是否挂载，角色决定这个人能不能用。
						当前控制台只有一个 admin 账号，新增账号需要先在「设置 → 口令」里改口令后用同一账号登录。</span>
					</div>
					<div class="page-section">${card({ title: "用户", body: html`<div class="table-wrap"><table><tbody>${userRows}</tbody></table></div>`, tight: true })}</div>
					<div class="page-section"><div class="grid grid-2">${roleCards}</div></div>
				`,
			);

			root.querySelectorAll("[data-user-role]").forEach((node) =>
				node.addEventListener("change", async () => {
					try {
						await api.put(`/api/rbac/users/${encodeURIComponent(node.dataset.userRole)}`, { roleId: node.value });
						toast("已更新角色", "success");
						ctx.reload();
					} catch (error) {
						toast(error.message, "error");
					}
				}),
			);
			root.querySelectorAll("[data-edit]").forEach((node) =>
				node.addEventListener("click", () => {
					openRoleForm(roles.find((r) => r.id === node.dataset.edit), catalogue, ctx);
				}),
			);
			root.querySelectorAll("[data-del]").forEach((node) =>
				node.addEventListener("click", async () => {
					try {
						await api.del(`/api/rbac/roles/${node.dataset.del}`);
						toast("已删除", "success");
						ctx.reload();
					} catch (error) {
						toast(error.message, "error");
					}
				}),
			);
		};

		paint();
	},
};

function openRoleForm(role, catalogue, ctx) {
	const selected = new Set(role?.perms ?? []);
	const overlay = openOverlay(
		html`
			<div class="overlay-head"><h3>${role ? `编辑角色 · ${role.name}` : "新建角色"}</h3></div>
			<div class="overlay-body">
				<div class="split-even" style="gap:12px">
					<label class="field">
						<span>ID</span>
						<input data-id value="${role?.id ?? ""}" ${role ? "readonly" : ""} placeholder="web-operator" />
					</label>
					<label class="field">
						<span>名称</span>
						<input data-name value="${role?.name ?? ""}" placeholder="Web 操作员" />
					</label>
				</div>
				<label class="field">
					<span>描述</span>
					<input data-desc value="${role?.desc ?? ""}" />
				</label>
				${catalogue.map(
					(group) => html`<div class="field">
						<span>${group.group}</span>
						<div class="row" style="gap:12px;flex-wrap:wrap">
							${group.items.map(
								(item) => html`<label class="checkbox">
									<input type="checkbox" data-perm="${item.id}" ${selected.has(item.id) ? "checked" : ""} />
									<span>${item.label}</span>
								</label>`,
							)}
						</div>
					</div>`,
				)}
			</div>
			<div class="overlay-foot">
				<button class="btn ghost" data-close>取消</button>
				<button class="btn primary" data-save>保存</button>
			</div>
		`,
		{ wide: true },
	);

	overlay.panel.querySelector("[data-save]").addEventListener("click", async () => {
		const perms = [...overlay.panel.querySelectorAll("[data-perm]")].filter((n) => n.checked).map((n) => n.dataset.perm);
		try {
			await api.post("/api/rbac/roles", {
				id: overlay.panel.querySelector("[data-id]").value.trim(),
				name: overlay.panel.querySelector("[data-name]").value.trim(),
				desc: overlay.panel.querySelector("[data-desc]").value.trim(),
				perms,
			});
			overlay.close();
			toast("已保存", "success");
			ctx.reload();
		} catch (error) {
			toast(error.message, "error");
		}
	});
}
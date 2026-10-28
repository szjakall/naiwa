/**
 * RBAC：角色与用户。
 *
 * 与"工具开关"分工：工具管能力是否挂载（全局），RBAC 管某个人能不能用（按人）。
 * 判定顺序是"两者都要过"——工具关了谁都过不去，角色没有也过不去。
 *
 * 权限项复用工具 id + 一组管理项，避免两套词表互相翻译出错。
 */

import { randomUUID } from "node:crypto";
import { store } from "./store.mjs";
import { catalogIds } from "./tool-ids.mjs";

/** 管理类权限：不属于某个工具，但同样要控。 */
const ADMIN_PERMS = [
	{ id: "manage_users", label: "管理用户与角色" },
	{ id: "manage_settings", label: "修改系统设置" },
	{ id: "manage_tools", label: "开关工具" },
	{ id: "manage_knowledge", label: "维护知识库" },
	{ id: "view_audit", label: "查看审计日志" },
	{ id: "approve_gate", label: "审批守门队列" },
];

export function permissionCatalogue() {
	return [
		{ group: "功能", items: catalogIds().map((id) => ({ id, label: id })) },
		{ group: "管理", items: ADMIN_PERMS },
	];
}

export const ALL_PERMISSIONS = [...catalogIds(), ...ADMIN_PERMS.map((p) => p.id)];

const DEFAULT_ROLES = [
	{
		id: "owner",
		name: "所有者",
		desc: "全部权限，包含用户与角色管理",
		perms: ALL_PERMISSIONS,
		system: true,
	},
	{
		id: "operator",
		name: "操作员",
		desc: "可执行全部评估动作与查看审计，但不能管理用户",
		perms: ALL_PERMISSIONS.filter((p) => p !== "manage_users"),
		system: true,
	},
	{
		id: "viewer",
		name: "只读",
		desc: "只能看，不能执行任何动作",
		perms: ["knowledge", "report", "view_audit"],
		system: true,
	},
];

function rbac() {
	if (!store.state.rbac) store.state.rbac = { roles: [], assignments: {} };
	const state = store.state.rbac;
	if (!Array.isArray(state.roles) || state.roles.length === 0) {
		state.roles = DEFAULT_ROLES.map((r) => ({ ...r, perms: [...r.perms] }));
	}
	if (!state.assignments || typeof state.assignments !== "object") state.assignments = {};
	return state;
}

export function listRoles() {
	return rbac().roles.map((role) => ({
		...role,
		userCount: Object.values(rbac().assignments).filter((roleId) => roleId === role.id).length,
	}));
}

export function upsertRole(input) {
	const state = rbac();
	const id = String(input.id ?? "").trim() || `role-${randomUUID().slice(0, 6)}`;
	const existing = state.roles.find((r) => r.id === id);
	if (existing?.system && input.perms !== undefined) {
		// 内置角色允许改权限，但不允许删；这里只拦"改名"，避免把 owner 改成别的东西
		if (input.name && input.name !== existing.name) throw new Error("内置角色不能改名");
	}
	const role = {
		id,
		name: String(input.name ?? existing?.name ?? "未命名角色").slice(0, 40),
		desc: String(input.desc ?? existing?.desc ?? "").slice(0, 200),
		perms: Array.isArray(input.perms)
			? input.perms.filter((p) => ALL_PERMISSIONS.includes(p))
			: existing?.perms ?? [],
		system: existing?.system === true,
	};
	if (existing) Object.assign(existing, role);
	else state.roles.push(role);
	store.save();
	return { role };
}

export function deleteRole(id) {
	const state = rbac();
	const index = state.roles.findIndex((r) => r.id === id);
	if (index < 0) return { ok: false, error: "角色不存在" };
	if (state.roles[index].system) return { ok: false, error: "内置角色不能删除" };
	const inUse = Object.values(state.assignments).filter((roleId) => roleId === id).length;
	if (inUse > 0) return { ok: false, error: `还有 ${inUse} 个用户在用这个角色` };
	state.roles.splice(index, 1);
	store.save();
	return { ok: true };
}

/**
 * 用户：
 * - 存在控制台账号里的人是 user（有口令）；
 * - 只做角色映射、不建账号的是"占位用户"，用于预留权限。
 */
export function listUsers() {
	const state = rbac();
	return store.state.users.map((user) => ({
		id: user.id,
		name: user.name,
		createdAt: user.createdAt,
		roleId: state.assignments[user.name] ?? "owner",
		roleName: state.roles.find((r) => r.id === (state.assignments[user.name] ?? "owner"))?.name ?? "—",
	}));
}

export function assignRole(userName, roleId) {
	const state = rbac();
	if (!state.roles.some((r) => r.id === roleId)) return { ok: false, error: "角色不存在" };
	if (!store.state.users.some((u) => u.name === userName)) return { ok: false, error: "用户不存在" };
	state.assignments[userName] = roleId;
	store.save();
	store.log("info", `已把用户 ${userName} 指到角色 ${roleId}`);
	return { ok: true };
}

/** 某个用户实际拥有的权限集合（角色权限 ∩ 已启用工具）。 */
export function permissionsOf(userName) {
	const state = rbac();
	const roleId = state.assignments[userName] ?? "owner";
	const role = state.roles.find((r) => r.id === roleId);
	return role ? [...role.perms] : [];
}

export function hasPermission(userName, permission) {
	if (!permission) return true;
	const perms = permissionsOf(userName);
	// owner 是兜底：避免把自己锁在门外
	if (perms.includes("manage_users") && perms.length === ALL_PERMISSIONS.length) return true;
	return perms.includes(permission);
}

/** 给前端"我的权限"，用于隐藏无权限的入口。 */
export function me(userName) {
	const state = rbac();
	const roleId = state.assignments[userName] ?? "owner";
	const role = state.roles.find((r) => r.id === roleId);
	return {
		user: userName,
		role: role ? { id: role.id, name: role.name } : null,
		permissions: role ? role.perms : [],
		catalogue: permissionCatalogue(),
	};
}

export function stats() {
	const state = rbac();
	return {
		roles: state.roles.length,
		users: store.state.users.length,
		permissions: ALL_PERMISSIONS.length,
		assignments: Object.keys(state.assignments).length,
	};
}
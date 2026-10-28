/**
 * 会话：token 存 localStorage，用户信息只放内存。
 *
 * 控制台是单操作员工具，token 的作用域就是这个浏览器。把用户信息落盘反而会让
 * "退出登录"之后界面还残留上一个账号的名字。
 */

import { getToken, setToken } from "./core.js";

export const session = {
	user: "",
	operator: "",
};

export async function loadSession(token, user) {
	setToken(token);
	session.user = user ?? "";
}

export function clearSession() {
	setToken("");
	session.user = "";
}

export function hasSession() {
	return Boolean(getToken());
}
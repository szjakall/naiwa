/**
 * 认证：scrypt 口令哈希 + 内存会话。
 *
 * 会话只活在内存里：控制台重启后需要重新登录，这是有意的取舍——
 * 换成持久化 token 就要处理吊销与密钥轮换，收益远小于它带来的风险面。
 */

import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { store } from "./store.mjs";
import { readSettings } from "./config.mjs";

const KEY_LEN = 64;

export function hashPassword(password) {
	const salt = randomBytes(16).toString("hex");
	const hash = scryptSync(password, salt, KEY_LEN).toString("hex");
	return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
	if (typeof stored !== "string") return false;
	const [scheme, salt, hash] = stored.split("$");
	if (scheme !== "scrypt" || !salt || !hash) return false;
	const expected = Buffer.from(hash, "hex");
	const actual = scryptSync(password, salt, expected.length);
	return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** 口令强度只做最低限度的要求：长度。复杂字符集不带来实际熵。 */
export function checkPasswordPolicy(password) {
	if (typeof password !== "string") return "口令必须是字符串";
	if (password.length < 8) return "口令至少 8 位";
	if (password.length > 200) return "口令过长";
	return null;
}

export class SessionTable {
	#sessions = new Map();

	create(user) {
		const hours = Number(readSettings().auth?.sessionHours ?? 12);
		const token = randomBytes(32).toString("base64url");
		this.#sessions.set(token, {
			id: randomUUID(),
			user: user.name,
			userId: user.id,
			expiresAt: Date.now() + hours * 3600_000,
		});
		return token;
	}

	get(token) {
		if (!token) return null;
		const entry = this.#sessions.get(token);
		if (!entry) return null;
		if (entry.expiresAt < Date.now()) {
			this.#sessions.delete(token);
			return null;
		}
		return entry;
	}

	drop(token) {
		if (token) this.#sessions.delete(token);
	}

	/** 退出登录 / 改口令时踢掉该用户的全部会话。 */
	dropUser(userId) {
		for (const [token, entry] of [...this.#sessions]) {
			if (entry.userId === userId) this.#sessions.delete(token);
		}
	}

	prune() {
		const now = Date.now();
		for (const [token, entry] of [...this.#sessions]) {
			if (entry.expiresAt < now) this.#sessions.delete(token);
		}
	}

	get size() {
		return this.#sessions.size;
	}
}

export const sessions = new SessionTable();

/** 从 Authorization: Bearer 取会话；设备反连用的是另一套 token，别混。 */
export function sessionFromRequest(req) {
	const header = req.headers.authorization ?? "";
	const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
	return { token, session: sessions.get(token) };
}

export function hasUser() {
	return store.state.users.length > 0;
}

export function createUser(name, password) {
	const user = {
		id: randomUUID(),
		name,
		hash: hashPassword(password),
		createdAt: new Date().toISOString(),
	};
	store.state.users.push(user);
	store.save();
	return user;
}

export function findUser(name) {
	return store.state.users.find((user) => user.name === name);
}

export function setPassword(user, password) {
	user.hash = hashPassword(password);
	user.updatedAt = new Date().toISOString();
	store.save();
}

export function requireAuth(req, res) {
	const { session } = sessionFromRequest(req);
	if (!session) {
		res.writeHead(401, { "content-type": "application/json; charset=utf-8" });
		res.end(JSON.stringify({ error: "未登录或会话已过期" }));
		return null;
	}
	return session;
}

setInterval(() => sessions.prune(), 10 * 60_000).unref?.();
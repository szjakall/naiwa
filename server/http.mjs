/**
 * HTTP 小工具：JSON 收发、原始字节上传、静态文件服务。
 *
 * 安全点：静态文件服务只允许 web/ 目录内的文件——先解析再归一，再比对前缀，
 * 这样 ../ 和符号链接都逃不出去。
 */

import { createReadStream, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { WEB_DIR } from "./config.mjs";

const MIME = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
	".woff": "font/woff",
	".map": "application/json; charset=utf-8",
	".txt": "text/plain; charset=utf-8",
	".md": "text/markdown; charset=utf-8",
	".webmanifest": "application/manifest+json",
};

export function sendJson(res, status, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(body),
		"cache-control": "no-store",
	});
	res.end(body);
}

export function sendText(res, status, text, contentType = "text/plain; charset=utf-8") {
	res.writeHead(status, {
		"content-type": contentType,
		"content-length": Buffer.byteLength(text),
		"cache-control": "no-store",
	});
	res.end(text);
}

export function sendError(res, status, message) {
	sendJson(res, status, { error: message });
}

/** 读 JSON 请求体，硬上限 2MB：设置/表单不可能更大，超过就是打错了。 */
export async function readJson(req, limit = 2 * 1024 * 1024) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > limit) throw new Error("请求体过大");
		chunks.push(chunk);
	}
	if (size === 0) return {};
	const text = Buffer.concat(chunks).toString("utf8");
	try {
		return JSON.parse(text);
	} catch {
		throw new Error("请求体不是合法 JSON");
	}
}

/** 读原始字节，APK 上传走这里（上限 512MB）。 */
export async function readRaw(req, limit = 512 * 1024 * 1024) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > limit) throw new Error("上传体积超过上限");
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}

/**
 * 静态文件。返回 true 表示已经响应；false 表示不是静态资源，交给调用方。
 * 入口页与 JS 一律 no-store，避免改了代码浏览器还拿旧的。
 */
export function serveStatic(req, res, pathname) {
	let relative;
	try {
		relative = decodeURIComponent(pathname);
	} catch {
		// 畸形百分号编码：当成没匹配到，交给调用方回 404。
		return false;
	}
	if (relative === "/" || relative === "") relative = "/index.html";
	const full = resolve(join(WEB_DIR, normalize(relative)));
	if (full !== WEB_DIR && !full.startsWith(WEB_DIR + sep)) return false;

	let stat;
	try {
		stat = statSync(full);
	} catch {
		return false;
	}
	if (!stat.isFile()) return false;

	const ext = extname(full).toLowerCase();
	const immutable = relative.startsWith("/vendor/");
	res.writeHead(200, {
		"content-type": MIME[ext] ?? "application/octet-stream",
		"content-length": stat.size,
		"cache-control": immutable ? "public, max-age=31536000, immutable" : "no-store",
		"x-content-type-options": "nosniff",
	});
	if (req.method === "HEAD") {
		res.end();
		return true;
	}
	createReadStream(full).pipe(res);
	return true;
}
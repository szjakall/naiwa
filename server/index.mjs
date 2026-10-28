/**
 * 进程入口：起 HTTP 服务、挂 REST、挂设备反连的 WebSocket 升级、打印启动信息。
 *
 * 启动顺序有讲究：先把数据目录和状态读进来（store 在 import 时就完成了），
 * 再起监听，最后才去起安卓反连监听——反连端口被占用不该让控制台起不来。
 */

import { createServer } from "node:http";
import { DATA_DIR, VERSION, ensureDirs, readSettings } from "./config.mjs";
import { hasUser } from "./auth.mjs";
import { gateway } from "./droid.mjs";
import { migrateLegacyLlm } from "./agents.mjs";
import { handleApi } from "./api.mjs";
import { sendError, serveStatic } from "./http.mjs";
import { store } from "./store.mjs";

ensureDirs();

// 把旧版「大模型」配置迁成模型档案：上一轮改设置页时删了旧 UI 却没搬数据，
// 结果"填了地址和密钥却显示未配置"。迁移只在没有档案时跑，不会覆盖已有配置。
const migration = migrateLegacyLlm();
if (migration.migrated) {
	console.log(`  模型     已把旧 LLM 配置迁移为档案：${migration.profile.baseUrl} / ${migration.profile.modelId}`);
}

const settings = readSettings();
const PORT = Number(process.env.REGEDIT_PORT ?? 8848);
const HOST = process.env.REGEDIT_HOST ?? "0.0.0.0";

const server = createServer(async (req, res) => {
	const started = Date.now();
	try {
		let url;
		try {
			url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
		} catch {
			return sendError(res, 400, "请求地址不合法");
		}

		// 基础安全头：控制台不该被嵌进别人的 iframe，也不该被 MIME 猜测。
		res.setHeader("x-content-type-options", "nosniff");
		res.setHeader("x-frame-options", "SAMEORIGIN");
		res.setHeader("referrer-policy", "no-referrer");

		if (url.pathname.startsWith("/api/")) {
			const handled = await handleApi(req, res, url);
			if (!handled) sendError(res, 404, `未知接口：${req.method} ${url.pathname}`);
			if (Date.now() - started > 3000) {
				store.log("warn", `慢请求 ${req.method} ${url.pathname}（${Date.now() - started}ms）`);
			}
			return;
		}

		if (req.method === "GET" || req.method === "HEAD") {
			if (serveStatic(req, res, url.pathname)) return;
		}

		res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
		res.end("404 Not Found");
	} catch (error) {
		// 单个请求出错不能带崩进程：能回就回 500，回不了就断开。
		store.log("error", `请求处理失败：${error instanceof Error ? error.message : String(error)}`);
		if (!res.headersSent) sendError(res, 500, "服务端处理失败");
		else res.end();
	}
});

// 设备反连走同端口的 /ws/droid；升级请求不经过上面的 HTTP 处理器。
server.on("upgrade", (req, socket, head) => {
	// 任何升级路径上的异常都不能冒泡：一条坏连接不该带走整个控制台。
	socket.on("error", () => {
		/* 对端 RST 时静默收场 */
	});
	try {
		const handled = gateway.handleUpgrade(req, socket, head);
		if (!handled) {
			// 用 end 而不是 write+destroy：否则客户端只看到连接重置，看不到 404。
			socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
			const timer = setTimeout(() => socket.destroy(), 1000);
			timer.unref?.();
		}
	} catch (error) {
		store.log("warn", `WebSocket 升级处理失败：${error instanceof Error ? error.message : String(error)}`);
		try {
			socket.destroy();
		} catch {
			/* 忽略 */
		}
	}
});

server.listen(PORT, HOST, async () => {
	const actualPort = server.address().port;
	console.log("");
	console.log(`  regedit v${VERSION} —— 安全评估控制台`);
	console.log(`  ───────────────────────────────────────────`);
	console.log(`  控制台   http://127.0.0.1:${actualPort}/`);
	console.log(`  数据目录 ${DATA_DIR}`);
	console.log(`  会话     ${hasUser() ? "已初始化，请登录" : "首次启动，按页面提示设置口令"}`);

	if (settings.android.autostart) {
		const outcome = await gateway.listen(settings.android.listenHost, settings.android.listenPort);
		if (outcome.ok) {
			console.log(`  安卓反连 ws://${settings.android.listenHost}:${outcome.port}/ws/droid`);
		} else {
			// 端口被占用很常见，不应该拦住控制台启动。
			console.log(`  安卓反连未启动：${outcome.error}（可在「安卓」页内重新开启）`);
			store.log("warn", `设备反连监听启动失败：${outcome.error}`);
		}
	}
	console.log("");
});

server.on("error", (error) => {
	if (error.code === "EADDRINUSE") {
		console.error(`端口 ${PORT} 已被占用。用 REGEDIT_PORT=另一个端口 启动。`);
		process.exit(1);
	}
	console.error(error);
	process.exit(1);
});

function shutdown(signal) {
	console.log(`\n收到 ${signal}，正在退出…`);
	gateway.stopListener();
	store.flush();
	server.close(() => process.exit(0));
	// 有长连接时 close 不会立刻回调，兜底退出。
	setTimeout(() => process.exit(0), 2000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
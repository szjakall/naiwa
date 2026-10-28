/**
 * 安卓模式的服务端：设备反连网关 + 设备注册表 + 设备操作。
 *
 * 拓扑：设备主动拨号 ws(s)://<host>:<port>/ws/droid?token=…，方向是从手机到
 * 操作员网络，所以服务器不必对手机开任何端口，NAT 后面也能用。一个网关管
 * 所有在线设备；上层 API 只发"请求帧 + 等结果"，不用碰任何 WebSocket 细节。
 *
 * 保活判断（真机结论）：设备不再发帧，几乎不是 socket 断了，
 * 而是 Android 或模拟器把整个进程 SIGSTOP 了——TCP 还是 ESTABLISHED，但没有
 * 线程在跑。所以"在线"必须叠加心跳年龄，否则每个请求都要各自超时一分钟才
 * 知道对面早就不动了。心跳 15s，三帧丢了就判无响应，第一次再收到帧即恢复。
 */

import { randomBytes, randomUUID } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { store } from "./store.mjs";
import { acceptUpgrade, rejectUpgrade } from "./ws.mjs";
import {
	DROID_DEFAULT_TIMEOUT_MS,
	DROID_MAX_FRAME_BYTES,
	DROID_MAX_STREAM_BYTES,
	DROID_PATH,
	DROID_PUSH_CHUNK_BYTES,
	DROID_STALE_MS,
	DROID_WATCHDOG_TICK_MS,
} from "./droid-protocol.mjs";

// ---------------------------------------------------------------- 注册表

const droidState = () => store.state.droid;

export function listTokens() {
	return droidState().tokens.map((token) => ({ ...token }));
}

export function createToken(label) {
	const token = {
		id: randomUUID().slice(0, 8),
		label: String(label || "未命名").slice(0, 60),
		// 32 字节 urlsafe：手抄困难，扫码/复制粘贴足够安全。
		token: randomBytes(24).toString("base64url"),
		createdAt: new Date().toISOString(),
		lastUsedAt: null,
	};
	droidState().tokens.push(token);
	store.save();
	store.log("info", `创建设备令牌：${token.label}`);
	return { ...token };
}

export function deleteToken(id) {
	const state = droidState();
	const index = state.tokens.findIndex((token) => token.id === id);
	if (index < 0) return { ok: false, error: "令牌不存在" };
	const [removed] = state.tokens.splice(index, 1);
	// 令牌删了就不能再认证：用它连上的设备一并踢下线。
	for (const device of state.devices) {
		if (device.tokenId === removed.id) gateway.disconnectByRecord(device);
	}
	store.save();
	store.log("warn", `删除设备令牌：${removed.label}`);
	return { ok: true };
}

export function findToken(token) {
	return droidState().tokens.find((entry) => entry.token === token);
}

export function listDevices() {
	return droidState().devices.map((device) => ({ ...device }));
}

export function getDevice(id) {
	return droidState().devices.find((device) => device.id === id);
}

export function renameDevice(id, name) {
	const device = getDevice(id);
	if (!device) return { ok: false, error: "设备不存在" };
	const next = String(name || "").trim().slice(0, 60);
	if (!next) return { ok: false, error: "名称不能为空" };
	device.name = next;
	store.save();
	return { ok: true };
}

export function deleteDevice(id) {
	const state = droidState();
	const index = state.devices.findIndex((device) => device.id === id);
	if (index < 0) return { ok: false, error: "设备不存在" };
	const device = state.devices[index];
	gateway.disconnectByRecord(device);
	state.devices.splice(index, 1);
	store.save();
	store.log("warn", `删除设备：${device.name}`);
	return { ok: true };
}

/** 设备 hello 上来时登记/更新。token 记录决定它属于哪个操作员。 */
function upsertDevice(hello, tokenId) {
	const state = droidState();
	let device = state.devices.find((entry) => entry.deviceId === hello.deviceId);
	const now = new Date().toISOString();
	if (!device) {
		device = {
			id: `dv${(state.devices.length + 1).toString(36)}${Date.now().toString(36).slice(-4)}`,
			deviceId: hello.deviceId,
			name: hello.model || "未知机型",
			model: hello.model || "未知机型",
			androidVersion: hello.androidVersion || "未知",
			sdkInt: Number(hello.sdkInt ?? 0),
			rooted: hello.rooted === true,
			online: true,
			tokenId,
			firstSeen: now,
			lastSeen: now,
		};
		state.devices.push(device);
		store.log("info", `新设备接入：${device.name}（Android ${device.androidVersion}）`);
	} else {
		device.model = hello.model || device.model;
		device.androidVersion = hello.androidVersion || device.androidVersion;
		device.sdkInt = Number(hello.sdkInt ?? device.sdkInt ?? 0);
		device.rooted = hello.rooted === true;
		device.online = true;
		device.tokenId = tokenId;
		device.lastSeen = now;
	}
	const token = state.tokens.find((entry) => entry.id === tokenId);
	if (token) token.lastUsedAt = now;
	store.save();
	return device;
}

function setDeviceOnline(deviceId, online) {
	const device = droidState().devices.find((entry) => entry.deviceId === deviceId);
	if (!device) return;
	device.online = online;
	device.lastSeen = new Date().toISOString();
	store.save();
}

// ---------------------------------------------------------------- 网关

function unresponsiveMessage(idleMs) {
	const seconds = Math.round(idleMs / 1000);
	return `设备无响应：已 ${seconds}s 未收到心跳（设备端进程可能被系统或模拟器冻结：socket 还在，但 app 不再执行任何代码）。请在设备上唤醒或重开设备端应用，等心跳恢复后重试`;
}

function shellQuote(value) {
	return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export class DroidGateway {
	/** APK 侧 deviceId → 连接。 */
	#connections = new Map();
	/** reqId → 等待中的请求。 */
	#pending = new Map();
	/** reqId → APK 侧 deviceId，断线时精确失败该设备的调用。 */
	#pendingDevices = new Map();
	#tunnels = new Map();
	#listener = null;
	#watchdog = null;
	#counter = 0;
	#staleMs;
	#tickMs;

	constructor(options = {}) {
		this.#staleMs = options.staleMs ?? DROID_STALE_MS;
		this.#tickMs = options.watchdogTickMs ?? DROID_WATCHDOG_TICK_MS;
		// 网关是"在线"的唯一真相来源：上次进程留下的 online 标记一律作废。
		for (const device of droidState().devices) device.online = false;
	}

	// ---- 连接管理 ----

	/** HTTP upgrade 分发：只认这一个路径，且 token 必须有效。 */
	handleUpgrade(req, socket, head, options = {}) {
		const url = new URL(req.url ?? "/", "http://localhost");
		if (!options.anyPath && url.pathname !== DROID_PATH) return false;
		const token = url.searchParams.get("token") ?? "";
		const record = findToken(token);
		if (!record) {
			rejectUpgrade(socket, 401, "Unauthorized");
			store.log("warn", "设备反连被拒绝：token 无效或已删除");
			return true;
		}
		const ws = acceptUpgrade(req, socket, head, { maxFrameBytes: DROID_MAX_FRAME_BYTES });
		if (ws) this.#onConnection(ws, record.id);
		return true;
	}

	#onConnection(ws, tokenId) {
		let device;
		let helloed = false;

		ws.on("message", (raw) => {
			let frame;
			try {
				frame = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
			} catch {
				return;
			}
			if (device) this.#markAlive(device.deviceId, ws);
			if (!helloed) {
				if (frame.t !== "hello") {
					ws.close(4001, "handshake required");
					return;
				}
				if (!frame.deviceId || typeof frame.deviceId !== "string") {
					ws.close(4002, "deviceId required");
					return;
				}
				// 同一台设备重复连接：新的赢（旧 socket 通常是半死的）。
				const previous = this.#connections.get(frame.deviceId);
				if (previous) previous.ws.close(4003, "replaced by a new connection");
				device = upsertDevice(
					{
						deviceId: frame.deviceId,
						model: String(frame.model ?? "未知机型"),
						androidVersion: String(frame.androidVersion ?? "未知"),
						sdkInt: Number(frame.sdkInt ?? 0),
						rooted: frame.rooted === true,
					},
					tokenId,
				);
				this.#connections.set(frame.deviceId, {
					ws,
					device,
					streams: new Map(),
					tcp: new Map(),
					lastFrameAt: Date.now(),
					stale: false,
				});
				this.#ensureWatchdog();
				helloed = true;
				ws.send(JSON.stringify({ t: "welcome", deviceId: frame.deviceId })).catch(() => {});
				store.log(
					"info",
					`设备上线：${device.name}（Android ${device.androidVersion}${device.rooted ? "，已 root" : ""}）`,
				);
				return;
			}
			if (!device) return;

			if (frame.t === "hb") {
				setDeviceOnline(device.deviceId, true);
				return;
			}
			if (frame.t === "data") {
				this.#onData(device.deviceId, frame.reqId, frame.seq, frame.b64);
				return;
			}
			if (frame.t === "tcp_data") {
				const socket = this.#tunnels.get(frame.tunnelId)?.connections.get(frame.connId);
				socket?.write(Buffer.from(frame.b64, "base64"));
				return;
			}
			if (frame.t === "tcp_closed") {
				const tunnel = this.#tunnels.get(frame.tunnelId);
				tunnel?.connections.get(frame.connId)?.destroy();
				tunnel?.connections.delete(frame.connId);
				return;
			}
			if (frame.t === "tcp_opened") {
				const pending = this.#pending.get(frame.reqId);
				if (!pending) return;
				this.#pending.delete(frame.reqId);
				this.#pendingDevices.delete(frame.reqId);
				clearTimeout(pending.timer);
				// 客户端在设备拨号完成前就发了数据（frida 握手就是这样），按序冲出去。
				const tunnel = this.#tunnels.get(frame.tunnelId);
				const buffered = tunnel?.buffers.get(frame.connId);
				if (tunnel && buffered && frame.ok === true) {
					tunnel.buffers.delete(frame.connId);
					for (const chunk of buffered) {
						ws.send(
							JSON.stringify({
								t: "tcp_send",
								tunnelId: frame.tunnelId,
								connId: frame.connId,
								b64: chunk.toString("base64"),
							}),
						).catch(() => {});
					}
				} else if (tunnel) {
					tunnel.buffers.delete(frame.connId);
				}
				pending.resolve({ ok: frame.ok === true, error: frame.error });
				return;
			}
			if (frame.t === "result") {
				const pending = this.#pending.get(frame.reqId);
				if (!pending) return;
				this.#pending.delete(frame.reqId);
				this.#pendingDevices.delete(frame.reqId);
				clearTimeout(pending.timer);
				const ok = frame.ok === true;
				pending.resolve({
					ok,
					code: frame.code,
					stdout: frame.stdout,
					stderr: frame.stderr,
					// 设备端把失败原因放在 stderr 里（和 shell 一致），只看 error 字段
					// 会让上层拿到 undefined，界面上就只剩一句"失败"。这里统一补齐。
					error: frame.error ?? (ok ? undefined : frame.stderr || `设备执行失败（退出码 ${frame.code ?? "?"}）`),
					bytes: this.#takeStream(device.deviceId, frame.reqId),
				});
			}
		});

		ws.on("close", () => {
			if (!device) return;
			// 被顶替的旧连接不许把它继任者的登记删掉。
			const current = this.#connections.get(device.deviceId);
			if (current && current.ws !== ws) return;
			this.#connections.delete(device.deviceId);
			this.#stopWatchdogIfIdle();
			setDeviceOnline(device.deviceId, false);
			for (const [tunnelId, tunnel] of [...this.#tunnels.entries()]) {
				if (tunnel.deviceId !== device.deviceId) continue;
				for (const socket of tunnel.connections.values()) socket.destroy();
				tunnel.server.close();
				this.#tunnels.delete(tunnelId);
			}
			this.#failPendingOf(device.deviceId, "设备连接已断开");
			store.log("warn", `设备离线：${device.name}`);
		});
		ws.on("error", () => ws.close());
	}

	#ensureWatchdog() {
		if (this.#watchdog) return;
		this.#watchdog = setInterval(() => this.#sweepLiveness(), this.#tickMs);
		this.#watchdog.unref?.();
	}

	#stopWatchdogIfIdle() {
		if (!this.#watchdog || this.#connections.size > 0) return;
		clearInterval(this.#watchdog);
		this.#watchdog = null;
	}

	/** 设备不出声就立刻失败它的在飞调用，而不是让每个调用自己熬超时。 */
	#sweepLiveness() {
		const now = Date.now();
		for (const [deviceId, conn] of this.#connections) {
			if (conn.stale || now - conn.lastFrameAt <= this.#staleMs) continue;
			conn.stale = true;
			const idleMs = now - conn.lastFrameAt;
			store.log("warn", `设备无响应：${conn.device.name}（已 ${Math.round(idleMs / 1000)}s 未收到心跳）`);
			this.#failPendingOf(deviceId, unresponsiveMessage(idleMs));
		}
	}

	#markAlive(deviceId, ws) {
		const conn = this.#connections.get(deviceId);
		if (!conn || conn.ws !== ws) return;
		conn.lastFrameAt = Date.now();
		if (!conn.stale) return;
		conn.stale = false;
		store.log("info", `设备恢复响应：${conn.device.name}`);
	}

	#isStale(conn, now = Date.now()) {
		return conn.stale || now - conn.lastFrameAt > this.#staleMs;
	}

	#staleFailure(conn) {
		return { ok: false, error: unresponsiveMessage(Date.now() - conn.lastFrameAt) };
	}

	/** 组装一条流式载荷；乱序或超限都判该请求失败。 */
	#onData(deviceId, reqId, seq, b64) {
		const pending = this.#pending.get(reqId);
		const conn = this.#connections.get(deviceId);
		if (!pending || !conn) return;
		let stream = conn.streams.get(reqId);
		if (!stream) {
			stream = { chunks: [], bytes: 0, nextSeq: 0 };
			conn.streams.set(reqId, stream);
		}
		if (seq !== stream.nextSeq) {
			this.#fail(reqId, `流分片乱序：期望 ${stream.nextSeq}，收到 ${seq}`);
			conn.streams.delete(reqId);
			return;
		}
		stream.nextSeq += 1;
		const chunk = Buffer.from(String(b64 ?? ""), "base64");
		stream.bytes += chunk.length;
		if (stream.bytes > DROID_MAX_STREAM_BYTES) {
			this.#fail(reqId, "流超过大小上限");
			conn.streams.delete(reqId);
			return;
		}
		// 边收边写给消费者（大文件拉取才真的是流式），否则攒起来在 result 时取走。
		if (pending.onData) pending.onData(chunk);
		else stream.chunks.push(chunk);
	}

	#takeStream(deviceId, reqId) {
		const conn = this.#connections.get(deviceId);
		const stream = conn?.streams.get(reqId);
		if (!stream) return undefined;
		conn.streams.delete(reqId);
		return Buffer.concat(stream.chunks);
	}

	#fail(reqId, error) {
		const pending = this.#pending.get(reqId);
		if (!pending) return;
		this.#pending.delete(reqId);
		this.#pendingDevices.delete(reqId);
		clearTimeout(pending.timer);
		pending.resolve({ ok: false, error });
	}

	#failPendingOf(deviceId, error) {
		for (const [reqId, pending] of [...this.#pending.entries()]) {
			if (this.#pendingDevices.get(reqId) !== deviceId) continue;
			this.#pending.delete(reqId);
			this.#pendingDevices.delete(reqId);
			clearTimeout(pending.timer);
			pending.resolve({ ok: false, error });
		}
	}

	// ---- 查询 ----

	/** 给控制台用的设备列表：持久字段 + 运行时在线/心跳年龄。 */
	devices() {
		const now = Date.now();
		return droidState().devices.map((device) => {
			const conn = this.#connections.get(device.deviceId);
			if (!conn) return { ...device, online: false, liveness: "offline" };
			const stale = this.#isStale(conn, now);
			return {
				...device,
				online: true,
				stale,
				idleMs: now - conn.lastFrameAt,
				liveness: stale ? "frozen" : "online",
			};
		});
	}

	onlineDeviceIds() {
		return [...this.#connections.keys()];
	}

	isOnline(deviceId) {
		return this.#connections.has(deviceId);
	}

	disconnectByRecord(device) {
		const conn = this.#connections.get(device.deviceId);
		conn?.ws.close(4004, "deleted");
	}

	disconnect(deviceId) {
		const device = getDevice(deviceId);
		if (device) this.disconnectByRecord(device);
		const conn = this.#connections.get(deviceId);
		conn?.ws.close(4004, "deleted");
	}

	// ---- 反连监听（可运行时换绑）----

	listenInfo() {
		return this.#listener ? { host: this.#listener.host, port: this.#listener.port } : null;
	}

	async listen(host, port) {
		this.stopListener();
		const server = createHttpServer();
		// 这个端口只服务设备的 WebSocket 反连。普通浏览器访问时给个明确提示，
		// 否则 Node 没有 request 监听器，请求会一直挂着不给响应。
		server.on("request", (req, res) => {
			res.writeHead(426, { "content-type": "text/plain; charset=utf-8", connection: "close" });
			res.end("regedit 设备反连端点：请用 WebSocket 连接 /ws/droid?token=<令牌>\n");
		});
		server.on("upgrade", (req, socket, head) => {
			// 同主端口：坏连接的 error 必须就地吃掉，否则一条 ECONNRESET 能打挂进程。
			socket.on("error", () => {
				/* 静默 */
			});
			try {
				// 专用监听端口上，每条 upgrade 都是设备；token 规则与主端口一致。
				const url = new URL(req.url ?? "/", "http://localhost");
				const token = url.searchParams.get("token") ?? "";
				const record = findToken(token);
				if (!record) {
					rejectUpgrade(socket, 401, "Unauthorized");
					store.log("warn", "设备反连被拒绝：token 无效或已删除");
					return;
				}
				const ws = acceptUpgrade(req, socket, head, { maxFrameBytes: DROID_MAX_FRAME_BYTES });
				if (ws) this.#onConnection(ws, record.id);
			} catch (error) {
				store.log("warn", `设备反连处理失败：${error instanceof Error ? error.message : String(error)}`);
				try {
					socket.destroy();
				} catch {
					/* 忽略 */
				}
			}
		});
		const outcome = await new Promise((resolve) => {
			server.once("error", (error) => {
				if (this.#listener?.server === server) this.#listener = null;
				resolve({ ok: false, error: `监听失败：${error.message}` });
			});
			const bindHost = host === "0.0.0.0" || host === "::" ? undefined : host;
			server.listen(port, bindHost, () => {
				const boundPort = server.address().port;
				this.#listener = { server, host, port: boundPort };
				store.log("info", `设备反连监听：${host}:${boundPort}`);
				resolve({ ok: true, port: boundPort, host });
			});
		});
		return outcome;
	}

	stopListener() {
		if (!this.#listener) return;
		const { server } = this.#listener;
		this.#listener = null;
		server.close();
	}

	// ---- 请求 ----

	/**
	 * 发一个请求帧并等它的最终结果。
	 * `onData` 存在时分片直接交给消费者，`bytes` 为空（流式路径）。
	 */
	request(deviceId, req, options = {}) {
		const conn = this.#connections.get(deviceId);
		if (!conn) return Promise.resolve({ ok: false, error: "设备不在线" });
		if (this.#isStale(conn)) return Promise.resolve(this.#staleFailure(conn));

		this.#counter += 1;
		const reqId = `d${Date.now().toString(36)}${this.#counter.toString(36)}${randomUUID().slice(0, 8)}`;
		const frame = { ...req, reqId };
		const timeoutMs = options.timeoutMs ?? DROID_DEFAULT_TIMEOUT_MS;
		this.#pendingDevices.set(reqId, deviceId);

		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.#pending.delete(reqId);
				this.#pendingDevices.delete(reqId);
				conn.streams.delete(reqId);
				resolve({ ok: false, error: `设备响应超时（${Math.round(timeoutMs / 1000)}s）` });
			}, timeoutMs);
			this.#pending.set(reqId, { resolve, timer, onData: options.onData });
			this.#sendFrame(conn, frame).catch((error) => {
				if (!this.#pending.has(reqId)) return;
				this.#pending.delete(reqId);
				this.#pendingDevices.delete(reqId);
				clearTimeout(timer);
				resolve({ ok: false, error: `发送失败：${error.message}` });
			});
		});
	}

	/** 按设备记录 id（控制台视角）发请求。 */
	requestByRecordId(id, req, options) {
		const device = getDevice(id);
		if (!device) return Promise.resolve({ ok: false, error: "设备不存在" });
		return this.request(device.deviceId, req, options);
	}

	/** 把文件按 push 分片写进设备：同一个 reqId 跨所有分片，设备只在 done 时回一次。 */
	pushFile(deviceId, path, bytes, options = {}) {
		const conn = this.#connections.get(deviceId);
		if (!conn) return Promise.resolve({ ok: false, error: "设备不在线" });
		if (this.#isStale(conn)) return Promise.resolve(this.#staleFailure(conn));
		if (bytes.length > DROID_MAX_STREAM_BYTES) {
			return Promise.resolve({ ok: false, error: `文件 ${bytes.length} 字节超过上限` });
		}
		this.#counter += 1;
		const reqId = `d${Date.now().toString(36)}${this.#counter.toString(36)}${randomUUID().slice(0, 8)}`;
		// 慢链路不能半路超时：按 100KB/s 兜底，只有真卡住才放弃。
		const timeoutMs = Math.max(options.timeoutMs ?? DROID_DEFAULT_TIMEOUT_MS, 30_000 + Math.ceil(bytes.length / 100_000) * 1000);
		this.#pendingDevices.set(reqId, deviceId);
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.#pending.delete(reqId);
				this.#pendingDevices.delete(reqId);
				resolve({ ok: false, error: `设备响应超时（${Math.round(timeoutMs / 1000)}s）` });
			}, timeoutMs);
			this.#pending.set(reqId, { resolve, timer });
			void this.#sendPushChunks(conn, deviceId, reqId, path, bytes, options.mode);
		});
	}

	async #sendPushChunks(conn, deviceId, reqId, path, bytes, mode) {
		const total = Math.max(1, Math.ceil(bytes.length / DROID_PUSH_CHUNK_BYTES));
		try {
			for (let seq = 0; seq < total; seq += 1) {
				if (!this.#pending.has(reqId)) return;
				if (this.#connections.get(deviceId) !== conn) {
					this.#fail(reqId, "设备连接已断开");
					return;
				}
				const chunk = bytes.subarray(seq * DROID_PUSH_CHUNK_BYTES, (seq + 1) * DROID_PUSH_CHUNK_BYTES);
				await this.#sendFrame(conn, {
					t: "push",
					reqId,
					path,
					seq,
					done: seq === total - 1,
					b64: chunk.toString("base64"),
					...(mode ? { mode } : {}),
				});
			}
		} catch (error) {
			this.#fail(reqId, `发送失败：${error.message}`);
		}
	}

	/** 唯一的出帧口：任何调用方都不能把大载荷塞进一条消息里。 */
	#sendFrame(conn, frame) {
		const text = JSON.stringify(frame);
		if (Buffer.byteLength(text) > DROID_MAX_FRAME_BYTES) {
			return Promise.reject(new Error("单帧超过上限，请分片发送"));
		}
		return conn.ws.send(text);
	}

	// ---- TCP 隧道（frida-cli 连设备上的 frida-server 走这条）----

	listTunnels() {
		return [...this.#tunnels.entries()].map(([tunnelId, tunnel]) => ({
			tunnelId,
			deviceName: "",
			port: tunnel.port,
			targetHost: tunnel.targetHost,
			targetPort: tunnel.targetPort,
		}));
	}

	openTunnel(apkDeviceId, targetHost, targetPort) {
		const conn = this.#connections.get(apkDeviceId);
		if (!conn) return Promise.resolve({ ok: false, error: "设备不在线" });
		if (this.#isStale(conn)) return Promise.resolve(this.#staleFailure(conn));
		for (const [tunnelId, tunnel] of this.#tunnels) {
			if (tunnel.deviceId === apkDeviceId && tunnel.targetHost === targetHost && tunnel.targetPort === targetPort) {
				return Promise.resolve({ ok: true, port: tunnel.port, tunnelId, reused: true });
			}
		}
		this.#counter += 1;
		const tunnelId = `tn${Date.now().toString(36)}${this.#counter.toString(36)}`;
		const tunnel = {
			deviceId: apkDeviceId,
			server: createTcpServer(),
			port: 0,
			targetHost,
			targetPort,
			connections: new Map(),
			buffers: new Map(),
		};
		this.#tunnels.set(tunnelId, tunnel);
		return new Promise((resolve) => {
			tunnel.server.on("connection", (socket) => {
				const connId = randomUUID().slice(0, 8);
				const reqId = randomUUID().slice(0, 8);
				tunnel.connections.set(connId, socket);
				tunnel.buffers.set(connId, []);
				this.#pendingDevices.set(reqId, apkDeviceId);
				const timer = setTimeout(() => {
					this.#pending.delete(reqId);
					this.#pendingDevices.delete(reqId);
					tunnel.connections.delete(connId);
					socket.destroy();
				}, 10_000);
				this.#pending.set(reqId, {
					resolve: (result) => {
						clearTimeout(timer);
						if (!result.ok) {
							tunnel.connections.delete(connId);
							socket.destroy();
						}
					},
					timer,
				});
				conn.ws
					.send(JSON.stringify({ t: "tcp_open", reqId, tunnelId, connId, host: targetHost, port: targetPort }))
					.catch(() => {});
				socket.on("data", (chunk) => {
					if (this.#connections.get(apkDeviceId) !== conn) return;
					// 设备侧还在拨号：先按序攒着，tcp_opened 后冲出。
					const buffer = tunnel.buffers.get(connId);
					if (buffer) buffer.push(chunk);
					else conn.ws.send(JSON.stringify({ t: "tcp_send", tunnelId, connId, b64: chunk.toString("base64") })).catch(() => {});
				});
				const cleanup = () => {
					tunnel.connections.delete(connId);
					tunnel.buffers.delete(connId);
					if (this.#connections.get(apkDeviceId) === conn) {
						conn.ws.send(JSON.stringify({ t: "tcp_close", tunnelId, connId })).catch(() => {});
					}
				};
				socket.on("close", cleanup);
				socket.on("error", () => socket.destroy());
			});
			tunnel.server.on("error", (error) => {
				this.#tunnels.delete(tunnelId);
				resolve({ ok: false, error: `隧道监听失败：${error.message}` });
			});
			tunnel.server.listen(0, "127.0.0.1", () => {
				tunnel.port = tunnel.server.address().port;
				resolve({ ok: true, port: tunnel.port, tunnelId });
			});
		});
	}

	closeTunnel(tunnelId) {
		const tunnel = this.#tunnels.get(tunnelId);
		if (!tunnel) return false;
		for (const socket of tunnel.connections.values()) socket.destroy();
		tunnel.server.close();
		this.#tunnels.delete(tunnelId);
		return true;
	}

	// ---- 高层设备操作（API 直接用这些）----

	async exec(apkDeviceId, cmd, options = {}) {
		return this.request(apkDeviceId, {
			t: "exec",
			cmd,
			asRoot: options.asRoot === true,
			timeoutMs: options.timeoutMs ?? 30_000,
		}, { timeoutMs: (options.timeoutMs ?? 30_000) + 5_000 });
	}

	async ls(apkDeviceId, path, asRoot) {
		const target = path ? shellQuote(path) : "/sdcard";
		return this.exec(apkDeviceId, `ls -la ${target} 2>&1`, { asRoot });
	}

	async pull(apkDeviceId, path) {
		return this.request(apkDeviceId, { t: "pull", path, maxBytes: DROID_MAX_STREAM_BYTES }, { timeoutMs: 120_000 });
	}

	async push(apkDeviceId, path, bytes, mode) {
		return this.pushFile(apkDeviceId, path, bytes, { mode });
	}

	async screencap(apkDeviceId) {
		return this.request(apkDeviceId, { t: "screencap" }, { timeoutMs: 60_000 });
	}

	async logcat(apkDeviceId, lines = 200, filter) {
		return this.request(apkDeviceId, { t: "logcat", lines, ...(filter ? { filter } : {}) }, { timeoutMs: 60_000 });
	}

	async packages(apkDeviceId, thirdPartyOnly = true) {
		return this.request(apkDeviceId, { t: "packages", thirdPartyOnly }, { timeoutMs: 60_000 });
	}

	async captureStart(apkDeviceId, iface = "any", seconds = 30) {
		return this.request(apkDeviceId, { t: "capture_start", iface, seconds }, { timeoutMs: 30_000 });
	}

	async captureStop(apkDeviceId) {
		return this.request(apkDeviceId, { t: "capture_stop" }, { timeoutMs: 60_000 });
	}

	async captureStatus(apkDeviceId) {
		return this.request(apkDeviceId, { t: "capture_status" }, { timeoutMs: 15_000 });
	}
}

export const gateway = new DroidGateway();
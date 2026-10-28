/**
 * 自研 WebSocket 服务端（RFC 6455 的最小可用子集）。
 *
 * 为什么要自己写：整个项目零外部依赖，"解压 + node 一条命令"就能跑。
 * 设备反连只需要文本帧 + 少量二进制帧 + ping/pong + close，协议面很窄，
 * 自己实现 150 行的可控性优于引入 ws 再处理它的传递依赖。
 *
 * 已处理：握手校验、掩码解帧、分片重组、控制帧插队、ping→pong、背压、关闭握手。
 * 未处理（本项目用不到）：permessage-deflate 扩展。
 */

import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export const OPCODE = {
	CONTINUATION: 0x0,
	TEXT: 0x1,
	BINARY: 0x2,
	CLOSE: 0x8,
	PING: 0x9,
	PONG: 0xa,
};

export function computeAccept(key) {
	return createHash("sha1").update(key + GUID).digest("base64");
}

function encodeFrame(opcode, payload) {
	const length = payload.length;
	let header;
	if (length < 126) {
		header = Buffer.alloc(2);
		header[0] = 0x80 | opcode;
		header[1] = length;
	} else if (length < 65536) {
		header = Buffer.alloc(4);
		header[0] = 0x80 | opcode;
		header[1] = 126;
		header.writeUInt16BE(length, 2);
	} else {
		header = Buffer.alloc(10);
		header[0] = 0x80 | opcode;
		header[1] = 127;
		header.writeBigUInt64BE(BigInt(length), 2);
	}
	return Buffer.concat([header, payload]);
}

export class WebSocketConnection extends EventEmitter {
	#buffer;
	#fragments = [];
	#fragmentOpcode = OPCODE.CONTINUATION;
	#finished = false;

	/**
	 * @param {import("node:net").Socket} socket 升级后的裸 socket
	 * @param {Buffer} head 升级请求中已经读出的多余字节
	 */
	constructor(socket, head, options = {}) {
		super();
		this.socket = socket;
		this.maxFrameBytes = options.maxFrameBytes ?? 8 * 1024 * 1024;
		this.open = true;
		this.closed = false;
		this.closeCode = 1006;
		this.#buffer = head && head.length ? Buffer.from(head) : Buffer.alloc(0);

		socket.setNoDelay?.(true);
		socket.on("data", (chunk) => this.#onData(chunk));
		socket.on("error", (error) => {
			this.#finish();
			socket.destroy();
			this.emit("error", error);
		});
		socket.on("close", () => this.#finish());
		socket.on("end", () => this.#finish());

		// head 里可能已经带了一整帧：等构造完成、监听器挂好再解析。
		if (this.#buffer.length) setImmediate(() => this.#parse());
	}

	#onData(chunk) {
		if (this.closed) return;
		this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, chunk]) : chunk;
		this.#parse();
	}

	#parse() {
		// 一次 data 里可能有多帧；循环到不够一整帧为止。
		for (;;) {
			const buf = this.#buffer;
			if (buf.length < 2) return;
			const fin = (buf[0] & 0x80) !== 0;
			const opcode = buf[0] & 0x0f;
			const masked = (buf[1] & 0x80) !== 0;
			let length = buf[1] & 0x7f;
			let offset = 2;

			if (length === 126) {
				if (buf.length < 4) return;
				length = buf.readUInt16BE(2);
				offset = 4;
			} else if (length === 127) {
				if (buf.length < 10) return;
				const big = buf.readBigUInt64BE(2);
				if (big > BigInt(this.maxFrameBytes)) {
					this.close(1009, "frame too large");
					return;
				}
				length = Number(big);
				offset = 10;
			}
			if (length > this.maxFrameBytes) {
				this.close(1009, "frame too large");
				return;
			}
			const maskLength = masked ? 4 : 0;
			if (buf.length < offset + maskLength + length) return;

			let payload = buf.subarray(offset + maskLength, offset + maskLength + length);
			if (masked) {
				const mask = buf.subarray(offset, offset + 4);
				// subarray 是视图，必须复制后再异或，否则会改到 socket 的接收缓冲。
				const copy = Buffer.allocUnsafe(length);
				for (let i = 0; i < length; i += 1) copy[i] = payload[i] ^ mask[i & 3];
				payload = copy;
			}
			this.#buffer = buf.subarray(offset + maskLength + length);
			this.#handleFrame(fin, opcode, payload);
			if (this.closed) return;
		}
	}

	#handleFrame(fin, opcode, payload) {
		if (opcode === OPCODE.PING) {
			this.#write(OPCODE.PONG, payload).catch(() => {});
			return;
		}
		if (opcode === OPCODE.PONG) return;
		if (opcode === OPCODE.CLOSE) {
			const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
			this.close(code, "peer closed");
			return;
		}

		if (opcode === OPCODE.CONTINUATION) {
			this.#fragments.push(payload);
			if (!fin) return;
			const full = Buffer.concat(this.#fragments);
			const fullOpcode = this.#fragmentOpcode;
			this.#fragments = [];
			this.#fragmentOpcode = OPCODE.CONTINUATION;
			this.#emitMessage(fullOpcode, full);
			return;
		}

		if (!fin) {
			this.#fragmentOpcode = opcode;
			this.#fragments = [payload];
			return;
		}
		this.#emitMessage(opcode, payload);
	}

	#emitMessage(opcode, payload) {
		if (opcode === OPCODE.TEXT) this.emit("message", payload.toString("utf8"), false);
		else if (opcode === OPCODE.BINARY) this.emit("message", payload, true);
	}

	#write(opcode, payload) {
		if (!this.open || this.socket.destroyed) return Promise.resolve();
		const frame = encodeFrame(opcode, payload);
		if (this.socket.write(frame)) return Promise.resolve();
		// 背压：等 drain，但连接一断就必须立刻放开，否则推送分片会永远挂住。
		return new Promise((resolve) => {
			const done = () => {
				this.socket.off("drain", done);
				this.socket.off("close", done);
				resolve();
			};
			this.socket.once("drain", done);
			this.socket.once("close", done);
		});
	}

	send(text) {
		return this.#write(OPCODE.TEXT, Buffer.from(String(text), "utf8"));
	}

	sendBinary(buffer) {
		return this.#write(OPCODE.BINARY, buffer);
	}

	ping() {
		return this.#write(OPCODE.PING, Buffer.alloc(0));
	}

	/**
	 * 发起关闭握手：先写 close 帧，再 FIN，最后兜底销毁。
	 * 不在这里 open=false 之前写帧——#write 会因为 !open 直接返回，帧就丢了。
	 */
	close(code = 1000, reason = "") {
		if (this.closed) return;
		this.closeCode = code;
		if (!this.socket.destroyed) {
			const reasonBytes = Buffer.from(reason, "utf8").subarray(0, 120);
			const payload = Buffer.allocUnsafe(2 + reasonBytes.length);
			payload.writeUInt16BE(code >= 1000 && code <= 4999 ? code : 1000, 0);
			reasonBytes.copy(payload, 2);
			try {
				this.socket.write(encodeFrame(OPCODE.CLOSE, payload));
			} catch {
				/* 已经断了就算了 */
			}
		}
		this.closed = true;
		this.open = false;
		try {
			this.socket.end();
		} catch {
			/* 忽略 */
		}
		// 对端可能永远不发 FIN：兜底销毁，别把 fd 留在那儿。
		const timer = setTimeout(() => this.socket.destroy(), 2000);
		timer.unref?.();
	}

	#finish() {
		this.open = false;
		this.closed = true;
		if (this.#finished) return;
		this.#finished = true;
		this.emit("close", this.closeCode);
	}
}

/**
 * 握手失败时给客户端一个明确的 HTTP 状态，而不是直接掐断。
 *
 * 踩过的坑（两次）：
 * 1. `write()` 之后立刻 `destroy()` 会把还没刷出去的数据丢掉，客户端收到的是
 *    ECONNRESET 而不是 401——设备侧只显示"连接错误"，排障时看不出是令牌不对。
 *    所以改用 end() 正常收尾（写完后 FIN）。
 * 2. 只 end() 不挂 error 监听更糟：对端拿着 401 立刻 RST 时，Socket 会抛
 *    'error' 事件，而这条连接上没有任何监听器 → **未捕获异常直接把整个进程带走**。
 *    任何扫描器往 9945 发一条坏 token 就能打挂控制台。所以必须挂一个空 error 处理器。
 */
export function rejectUpgrade(socket, status = 400, message = "Bad Request") {
	// 先挂错误处理：下面任何一步都可能因为对端 RST 触发 error 事件
	socket.on("error", () => {
		/* 对端走了就算了，绝不能让它冒泡成未捕获异常 */
	});
	try {
		socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
	} catch {
		/* 忽略 */
	}
	const timer = setTimeout(() => socket.destroy(), 1000);
	timer.unref?.();
}

/** 完成握手并返回连接对象；请求头不合格时返回 null（已写回错误响应）。 */
export function acceptUpgrade(req, socket, head, options = {}) {
	const key = req.headers["sec-websocket-key"];
	const upgrade = String(req.headers.upgrade ?? "").toLowerCase();
	if (!key || upgrade !== "websocket") {
		rejectUpgrade(socket, 400, "Bad Request");
		return null;
	}
	const headers = [
		"HTTP/1.1 101 Switching Protocols",
		"Upgrade: websocket",
		"Connection: Upgrade",
		`Sec-WebSocket-Accept: ${computeAccept(key)}`,
	];
	for (const [name, value] of Object.entries(options.extraHeaders ?? {})) headers.push(`${name}: ${value}`);
	socket.write(`${headers.join("\r\n")}\r\n\r\n`);
	return new WebSocketConnection(socket, head, options);
}
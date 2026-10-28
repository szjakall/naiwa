/**
 * 前端基座：请求封装、安全的模板字符串、格式化、弹层与提示。
 *
 * 模板用 `html` 标签函数自动转义插值——目标站点的标题、响应头、APK 字符串
 * 全是不可信数据，直接拼字符串进 innerHTML 就是给自己开 XSS。需要插原始
 * HTML 的地方显式包 `raw()`，一眼能看出风险点。
 */

import { icon } from "./icons.js";

// ---------------------------------------------------------------- 请求

const TOKEN_KEY = "regedit.token";

export function getToken() {
	return localStorage.getItem(TOKEN_KEY) ?? "";
}

export function setToken(token) {
	if (token) localStorage.setItem(TOKEN_KEY, token);
	else localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
	constructor(message, status, payload) {
		super(message);
		this.status = status;
		this.payload = payload;
	}
}

async function request(method, path, options = {}) {
	const headers = { ...(options.headers ?? {}) };
	if (options.json !== undefined) headers["content-type"] = "application/json";
	const token = getToken();
	if (token) headers.authorization = `Bearer ${token}`;

	let response;
	try {
		response = await fetch(path, {
			method,
			headers,
			body: options.json !== undefined ? JSON.stringify(options.json) : options.body,
		});
	} catch (error) {
		throw new ApiError(`网络错误：${error.message}`, 0, null);
	}

	const contentType = response.headers.get("content-type") ?? "";
	const payload = contentType.includes("application/json")
		? await response.json().catch(() => null)
		: await response.text();

	if (response.status === 401 && !path.startsWith("/api/auth/")) {
		setToken("");
		window.dispatchEvent(new CustomEvent("regedit:unauthorized"));
	}
	if (!response.ok) {
		throw new ApiError(payload?.error ?? payload?.message ?? `HTTP ${response.status}`, response.status, payload);
	}
	return payload;
}

export const api = {
	get: (path) => request("GET", path),
	post: (path, json) => request("POST", path, { json }),
	put: (path, json) => request("PUT", path, { json }),
	patch: (path, json) => request("PATCH", path, { json }),
	del: (path) => request("DELETE", path),
	text: async (path) => {
		const response = await fetch(path, { headers: getToken() ? { authorization: `Bearer ${getToken()}` } : {} });
		if (!response.ok) throw new ApiError(`HTTP ${response.status}`, response.status, null);
		return response.text();
	},
	blob: async (path) => {
		const response = await fetch(path, { headers: getToken() ? { authorization: `Bearer ${getToken()}` } : {} });
		if (!response.ok) throw new ApiError(`HTTP ${response.status}`, response.status, null);
		return response.blob();
	},
	/** APK 上传走裸字节，避免在浏览器里做 multipart 解析。 */
	upload: (path, file) =>
		request("POST", path, {
			body: file,
			headers: { "content-type": "application/octet-stream" },
		}),
};

// ---------------------------------------------------------------- 模板

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function esc(value) {
	return String(value ?? "").replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

class SafeHtml {
	constructor(value) {
		this.value = value;
	}
	toString() {
		return this.value;
	}
}

/** 标记"这段 HTML 是我自己拼的、可信"，不要对用户数据用。 */
export function raw(value) {
	return new SafeHtml(String(value ?? ""));
}

function flatten(value) {
	if (value === null || value === undefined || value === false) return "";
	if (value instanceof SafeHtml) return value.value;
	if (Array.isArray(value)) return value.map(flatten).join("");
	// 已经是 DOM 节点时取它的 outerHTML：直接 String() 会拼成 "[object HTMLDivElement]"。
	if (typeof value === "object" && typeof value.nodeType === "number") {
		return value.nodeType === 1 ? value.outerHTML : (value.textContent ?? "");
	}
	return esc(value);
}

export function html(strings, ...values) {
	let out = strings[0];
	for (let i = 0; i < values.length; i += 1) out += flatten(values[i]) + strings[i + 1];
	return new SafeHtml(out);
}

export function mount(target, content) {
	target.innerHTML = content instanceof SafeHtml ? content.value : String(content ?? "");
	return target;
}

/**
 * 把一组 html`` 片段拼成一段可信 HTML。
 *
 * 存在的理由：`[html`<a/>`, html`<b/>`].join("")` 会把 SafeHtml 变成**普通字符串**，
 * 再插进模板时 `flatten()` 会把它转义，页面上就出现一堆 `<div class="stat">` 字面量。
 * 这个坑一次踩了 8 处，所以提供一个显式的拼接函数：要么用 `joinHtml([...])`，
 * 要么直接把数组插进模板（`${items.map(...)}`，flatten 认数组）。
 */
export function joinHtml(items, separator = "") {
	const list = Array.isArray(items) ? items : [items];
	return new SafeHtml(list.map((item) => flatten(item)).join(separator));
}

/**
 * 把一段 html`` 变成真实节点，用于需要 append 的场合（如顶栏动作区）。
 *
 * 统一包一层 `.row`：视图里普遍是 `actions.querySelector("#refresh")` 的写法，
 * 若直接返回按钮本身，这个查询必然拿到 null。包一层后既是容器又是行内布局。
 */
export function toNode(content) {
	const holder = document.createElement("div");
	holder.innerHTML = content instanceof SafeHtml ? content.value : String(content ?? "");
	const wrapper = document.createElement("div");
	wrapper.className = "row";
	while (holder.firstChild) wrapper.append(holder.firstChild);
	return wrapper;
}

// ---------------------------------------------------------------- 格式化

export function fmtTime(iso) {
	if (!iso) return "—";
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return String(iso);
	const pad = (n) => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function fmtClock(iso) {
	if (!iso) return "—";
	return fmtTime(iso).slice(11);
}

export function relTime(iso) {
	if (!iso) return "—";
	const diff = Date.now() - new Date(iso).getTime();
	if (!Number.isFinite(diff)) return "—";
	if (diff < 5_000) return "刚刚";
	if (diff < 60_000) return `${Math.floor(diff / 1000)} 秒前`;
	if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)} 小时前`;
	return `${Math.floor(diff / 86_400_000)} 天前`;
}

export function fmtBytes(bytes) {
	const value = Number(bytes ?? 0);
	if (value < 1024) return `${value} B`;
	if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
	if (value < 1024 * 1024 * 1024) return `${(value / 1048576).toFixed(1)} MB`;
	return `${(value / 1073741824).toFixed(2)} GB`;
}

export function fmtDuration(ms) {
	const value = Number(ms ?? 0);
	if (value < 1000) return `${value} ms`;
	if (value < 60_000) return `${(value / 1000).toFixed(1)} s`;
	return `${Math.floor(value / 60_000)} 分 ${Math.round((value % 60_000) / 1000)} 秒`;
}

export const SEVERITIES = {
	critical: { label: "严重", order: 0 },
	high: { label: "高危", order: 1 },
	medium: { label: "中危", order: 2 },
	low: { label: "低危", order: 3 },
	info: { label: "信息", order: 4 },
};

export function severityChip(severity) {
	const meta = SEVERITIES[severity] ?? { label: severity, order: 9 };
	return html`<span class="chip sev-${severity}">${meta.label}</span>`;
}

export function statusChip(status) {
	const map = {
		queued: ["待运行", "muted"],
		running: ["运行中", "info"],
		done: ["已完成", "ok"],
		stopped: ["已停止", "warn"],
		failed: ["失败", "danger"],
		open: ["未处理", "warn"],
		closed: ["已关闭", "muted"],
		archived: ["已归档", "muted"],
		online: ["在线", "ok"],
		frozen: ["无响应", "warn"],
		offline: ["离线", "muted"],
	};
	const [label, tone] = map[status] ?? [status, "muted"];
	return html`<span class="chip chip-${tone}">${label}</span>`;
}

// ---------------------------------------------------------------- 提示与弹层

export function toast(message, kind = "info", timeout = 3600) {
	const root = document.getElementById("toast-root");
	const node = document.createElement("div");
	node.className = `toast toast-${kind}`;
	node.innerHTML = `<span class="toast-icon">${icon(kind === "error" ? "alert" : kind === "success" ? "check" : "spark", { size: 16 })}</span><span></span>`;
	node.lastElementChild.textContent = String(message);
	root.append(node);
	requestAnimationFrame(() => node.classList.add("in"));
	setTimeout(() => {
		node.classList.remove("in");
		setTimeout(() => node.remove(), 220);
	}, timeout);
}

let overlayStack = [];

/**
 * 通用弹层。返回 { close }，调用方负责关闭；点遮罩与 ESC 也会关。
 */
export function openOverlay(content, options = {}) {
	const root = document.getElementById("overlay-root");
	const wrap = document.createElement("div");
	wrap.className = `overlay ${options.wide ? "overlay-wide" : ""}`;
	const panel = document.createElement("div");
	panel.className = "overlay-panel";
	panel.innerHTML = content instanceof SafeHtml ? content.value : String(content);
	wrap.append(panel);
	root.append(wrap);
	requestAnimationFrame(() => wrap.classList.add("in"));

	const close = () => {
		wrap.classList.remove("in");
		overlayStack = overlayStack.filter((entry) => entry !== close);
		setTimeout(() => wrap.remove(), 180);
	};
	overlayStack.push(close);
	wrap.addEventListener("click", (event) => {
		if (event.target === wrap) close();
	});
	panel.querySelectorAll("[data-close]").forEach((node) => node.addEventListener("click", close));
	return { close, panel, wrap };
}

export function closeTopOverlay() {
	const top = overlayStack[overlayStack.length - 1];
	if (top) top();
}

window.addEventListener("keydown", (event) => {
	if (event.key === "Escape") closeTopOverlay();
});

export function confirmDialog({ title, message, confirmText = "确认", danger = false }) {
	return new Promise((resolve) => {
		const overlay = openOverlay(html`
			<div class="overlay-head">
				<h3>${title}</h3>
			</div>
			<div class="overlay-body"><p class="muted">${message}</p></div>
			<div class="overlay-foot">
				<button class="btn ghost" data-close>取消</button>
				<button class="btn ${danger ? "danger" : "primary"}" data-confirm>${confirmText}</button>
			</div>
		`);
		overlay.panel.querySelector("[data-confirm]").addEventListener("click", () => {
			overlay.close();
			resolve(true);
		});
		overlay.panel.querySelectorAll("[data-close]").forEach((node) =>
			node.addEventListener("click", () => resolve(false)),
		);
		overlay.wrap.addEventListener("click", (event) => {
			if (event.target === overlay.wrap) resolve(false);
		});
	});
}

/** 单输入框弹层，重命名这类场景用。 */
export function promptDialog({ title, label, value = "", placeholder = "", confirmText = "保存" }) {
	return new Promise((resolve) => {
		const overlay = openOverlay(html`
			<div class="overlay-head"><h3>${title}</h3></div>
			<div class="overlay-body">
				<label class="field">
					<span>${label}</span>
					<input data-input value="${value}" placeholder="${placeholder}" />
				</label>
			</div>
			<div class="overlay-foot">
				<button class="btn ghost" data-close>取消</button>
				<button class="btn primary" data-confirm>${confirmText}</button>
			</div>
		`);
		const input = overlay.panel.querySelector("[data-input]");
		input.focus();
		input.select();
		const submit = () => {
			const next = input.value.trim();
			overlay.close();
			resolve(next || null);
		};
		overlay.panel.querySelector("[data-confirm]").addEventListener("click", submit);
		input.addEventListener("keydown", (event) => {
			if (event.key === "Enter") submit();
		});
		overlay.panel.querySelectorAll("[data-close]").forEach((node) =>
			node.addEventListener("click", () => resolve(null)),
		);
	});
}

/**
 * 复制到剪贴板。
 *
 * 为什么需要三层降级：`navigator.clipboard` 只在**安全上下文**（HTTPS 或
 * localhost）里存在。控制台常被部署成 `http://<内网IP>:8848`，此时该 API
 * 直接是 undefined，之前只提示"当前环境不支持自动复制"，等于把功能废掉了。
 *
 * 降级顺序：
 *   1. navigator.clipboard.writeText —— 现代、无侵入；
 *   2. 选中隐藏 textarea + document.execCommand('copy') —— 老 API，但非安全
 *      上下文里仍然可用，覆盖了绝大多数内网部署；
 *   3. 弹出可选中的对话框 —— 前两条都被浏览器拒绝时（如权限策略），
 *      让操作员自己选中按键复制，至少不是死路。
 */
export async function copyText(text) {
	const value = String(text ?? "");

	// 1) 标准 API
	if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
		try {
			await navigator.clipboard.writeText(value);
			toast("已复制到剪贴板", "success");
			return true;
		} catch {
			// 继续走降级：可能是权限被拒或 iframe 策略限制
		}
	}

	// 2) execCommand 兜底：非安全上下文里的唯一可行路径
	if (execCommandCopy(value)) {
		toast("已复制到剪贴板", "success");
		return true;
	}

	// 3) 都失败：把内容放进可选中的弹层，不让操作员卡住
	showCopyFallback(value);
	return false;
}

/** 用隐藏 textarea + execCommand 复制；成功返回 true。 */
function execCommandCopy(value) {
	let textarea = null;
	try {
		textarea = document.createElement("textarea");
		textarea.value = value;
		// 必须留在布局里（不能用 display:none），否则 iOS 与部分 Chrome
		// 会认为元素不可交互、拒绝选中。
		textarea.setAttribute("readonly", "");
		textarea.style.position = "fixed";
		textarea.style.top = "0";
		textarea.style.left = "0";
		textarea.style.width = "1px";
		textarea.style.height = "1px";
		textarea.style.padding = "0";
		textarea.style.border = "none";
		textarea.style.outline = "none";
		textarea.style.boxShadow = "none";
		textarea.style.background = "transparent";
		textarea.style.opacity = "0";
		document.body.appendChild(textarea);

		const selection = document.getSelection();
		const saved = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

		textarea.focus({ preventScroll: true });
		textarea.select();
		textarea.setSelectionRange(0, value.length);

		const ok = document.execCommand && document.execCommand("copy");

		// 还原用户原来的选区，别因为一次复制把阅读位置弄丢
		if (saved && selection) {
			selection.removeAllRanges();
			selection.addRange(saved);
		}
		return Boolean(ok);
	} catch {
		return false;
	} finally {
		if (textarea && textarea.parentNode) textarea.parentNode.removeChild(textarea);
	}
}

/** 兜底弹层：内容自动全选，再点一次可重试复制。 */
function showCopyFallback(value) {
	const overlay = openOverlay(html`
		<div class="overlay-head">
			<h3>手动复制</h3>
			<div class="spacer"></div>
			<button class="btn-icon" data-close>✕</button>
		</div>
		<div class="overlay-body">
			<p class="small muted" style="margin-top:0">
				浏览器拒绝了自动复制（通常是 http 环境或权限策略）。下面的内容已全选，
				直接按 <kbd>Ctrl</kbd>+<kbd>C</kbd>（macOS 为 <kbd>⌘</kbd>+<kbd>C</kbd>）即可。
			</p>
			<textarea data-copy-text rows="4" readonly style="width:100%;font-family:var(--mono)"></textarea>
		</div>
		<div class="overlay-foot">
			<button class="btn ghost" data-close>关闭</button>
			<button class="btn primary" data-retry>再试一次</button>
		</div>
	`, { wide: true });

	const area = overlay.panel.querySelector("[data-copy-text]");
	area.value = value;
	area.focus();
	area.select();
	overlay.panel.querySelector("[data-retry]").addEventListener("click", () => {
		if (execCommandCopy(value)) {
			overlay.close();
			toast("已复制到剪贴板", "success");
		} else {
			toast("仍然被拒绝，请手动按 Ctrl+C", "error");
		}
	});
}

/**
 * 把一段值以"可复制"的形式展示出来：复制成功后自动关闭，失败则留在原地。
 * 令牌这类一次性可见的东西用它比单纯 toast 稳。
 */
export function showSecret({ title, value, hint, note }) {
	const overlay = openOverlay(html`
		<div class="overlay-head">
			<h3>${title}</h3>
			<div class="spacer"></div>
			<button class="btn-icon" data-close>✕</button>
		</div>
		<div class="overlay-body">
			${hint ? html`<p class="small muted" style="margin-top:0">${hint}</p>` : ""}
			<div class="copy-box" data-secret style="user-select:all;-webkit-user-select:all"></div>
			${note ? html`<div class="hint-box mt-12">${note}</div>` : ""}
		</div>
		<div class="overlay-foot">
			<button class="btn ghost" data-close>关闭</button>
			<button class="btn primary" data-copy>复制</button>
		</div>
	`, { wide: true });

	const box = overlay.panel.querySelector("[data-secret]");
	box.textContent = value;
	overlay.panel.querySelector("[data-copy]").addEventListener("click", async () => {
		const ok = await copyText(value);
		if (ok) overlay.close();
	});
	// 打开即选中，操作员直接 Ctrl+C 也行
	const range = document.createRange();
	range.selectNodeContents(box);
	const selection = document.getSelection();
	if (selection) {
		selection.removeAllRanges();
		selection.addRange(range);
	}
	return overlay;
}

export function download(filename, content, type = "text/plain;charset=utf-8") {
	const blob = content instanceof Blob ? content : new Blob([content], { type });
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = url;
	link.download = filename;
	link.click();
	setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ---------------------------------------------------------------- Markdown

/**
 * 极简 Markdown 渲染：报告预览够用（标题/列表/表格/代码块/粗体/行内代码）。
 * 先整体转义，再只放行自己生成的标签，所以不引入 XSS 面。
 */
export function renderMarkdown(text) {
	const lines = String(text ?? "").split(/\r?\n/);
	const out = [];
	let inCode = false;
	let inList = false;
	let tableBuffer = [];

	const inline = (line) =>
		esc(line)
			.replace(/`([^`]+)`/g, "<code>$1</code>")
			.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
			.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
			.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');

	const flushTable = () => {
		if (!tableBuffer.length) return;
		const rows = tableBuffer.filter((row) => !/^\|[\s:|-]+\|$/.test(row));
		const cells = rows.map((row) =>
			row
				.replace(/^\||\|$/g, "")
				.split("|")
				.map((cell) => cell.trim()),
		);
		if (cells.length) {
			out.push("<table class=\"md-table\">");
			cells.forEach((row, index) => {
				const tag = index === 0 ? "th" : "td";
				out.push(`<tr>${row.map((cell) => `<${tag}>${inline(cell)}</${tag}>`).join("")}</tr>`);
			});
			out.push("</table>");
		}
		tableBuffer = [];
	};

	for (const line of lines) {
		if (line.trim().startsWith("```")) {
			flushTable();
			if (inList) {
				out.push("</ul>");
				inList = false;
			}
			out.push(inCode ? "</pre>" : "<pre class=\"md-code\">");
			inCode = !inCode;
			continue;
		}
		if (inCode) {
			out.push(esc(line));
			continue;
		}
		if (/^\s*\|/.test(line)) {
			tableBuffer.push(line.trim());
			continue;
		}
		flushTable();
		const heading = /^(#{1,6})\s+(.*)$/.exec(line);
		if (heading) {
			if (inList) {
				out.push("</ul>");
				inList = false;
			}
			const level = Math.min(heading[1].length + 1, 5);
			out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
			continue;
		}
		if (/^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
			if (!inList) {
				out.push("<ul>");
				inList = true;
			}
			out.push(`<li>${inline(line.replace(/^\s*(?:[-*]|\d+\.)\s+/, ""))}</li>`);
			continue;
		}
		if (inList) {
			out.push("</ul>");
			inList = false;
		}
		if (line.startsWith(">")) {
			out.push(`<blockquote>${inline(line.replace(/^>\s?/, ""))}</blockquote>`);
			continue;
		}
		if (/^-{3,}$/.test(line.trim())) {
			out.push("<hr />");
			continue;
		}
		if (line.trim() === "") {
			out.push("");
			continue;
		}
		out.push(`<p>${inline(line)}</p>`);
	}
	if (inList) out.push("</ul>");
	if (inCode) out.push("</pre>");
	flushTable();
	return out.join("\n");
}
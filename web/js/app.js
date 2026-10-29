/**
 * 应用外壳：启动引导（首次设置 / 登录 / 控制台）、哈希路由、顶部标题与导航徽标。
 *
 * 路由用 hash 而不是 history API：控制台常被反代到子路径下，hash 路由不需要
 * 服务端做任何 rewrite，刷新也不会 404。
 */

import { brandMark, icon } from "./icons.js";
import { api, html, mount, raw, toast } from "./core.js";
import { clearSession, loadSession } from "./session.js";

import dashboard from "./views/dashboard.js";
import tasks from "./views/tasks.js";
import assets from "./views/assets.js";
import findings from "./views/findings.js";
import reports from "./views/reports.js";
import traffic from "./views/traffic.js";
import skills from "./views/skills.js";
import android from "./views/android.js";
import gates from "./views/gates.js";
import logs from "./views/logs.js";
import settings from "./views/settings.js";
import exploration from "./views/exploration.js";
import knowledge from "./views/knowledge.js";
import tools from "./views/tools.js";
import agents from "./views/agents.js";
import chat from "./views/chat.js";
import pocs from "./views/pocs.js";
import intel from "./views/intel.js";
import { proxies, notify } from "./views/channels.js";
import rbac from "./views/rbac.js";
import companies from "./views/companies.js";

const VIEWS = {
	dashboard,
	chat,
	tasks,
	assets,
	findings,
	reports,
	companies,
	android,
	exploration,
	knowledge,
	pocs,
	intel,
	gates,
	tools,
	agents,
	rbac,
	traffic,
	skills,
	proxies,
	notify,
	logs,
	settings,
};

const NAV = [
	{ group: "作业" },
	{ id: "dashboard", label: "总览" },
	{ id: "chat", label: "对话" },
	{ id: "tasks", label: "任务" },
	{ id: "assets", label: "资产" },
	{ id: "findings", label: "漏洞" },
	{ id: "reports", label: "报告" },
	{ id: "companies", label: "公司" },
	{ group: "移动端" },
	{ id: "android", label: "安卓设备" },
	{ group: "情报" },
	{ id: "exploration", label: "探索图" },
	{ id: "knowledge", label: "知识库" },
	{ id: "pocs", label: "POC 库" },
	{ id: "intel", label: "资产测绘" },
	{ group: "管控" },
	{ id: "gates", label: "守门" },
	{ id: "tools", label: "工具" },
	{ id: "agents", label: "Agent" },
	{ id: "rbac", label: "权限" },
	{ group: "资料" },
	{ id: "traffic", label: "流量" },
	{ id: "skills", label: "技能" },
	{ id: "proxies", label: "代理" },
	{ id: "notify", label: "通知" },
	{ id: "logs", label: "审计日志" },
	{ id: "settings", label: "设置" },
];

export const app = {
	boot: null,
	stats: {},
	view: null,
	dispose: null,
};

const root = document.getElementById("app");

// ---------------------------------------------------------------- 启动

export async function start() {
	try {
		const boot = await api.get("/api/bootstrap");
		app.boot = boot;
		app.stats = boot.stats ?? {};
		if (boot.firstRun) return renderSetup(boot);
		if (!boot.authenticated) return renderLogin(boot, "");
		return renderShell();
	} catch (error) {
		mount(
			root,
			html`<div class="login-form-wrap" style="min-height:100vh">
				<div class="login-form">
					<h2>无法连接控制台</h2>
					<p class="muted">${error.message}</p>
					<button class="btn primary full" onclick="location.reload()">重试</button>
				</div>
			</div>`,
		);
	}
}

window.addEventListener("regedit:unauthorized", () => {
	clearSession();
	renderLogin(app.boot ?? {}, "会话已过期，请重新登录");
});

// ---------------------------------------------------------------- 登录 / 首次设置

function loginLayout(inner) {
	return html`
		<div class="login">
			<div class="login-side">
				<div class="login-brand">
					${raw(brandMark(40))}
					<div class="brand-text">
						<span class="brand-name">regedit</span>
						<span class="brand-tag">Security Console</span>
					</div>
				</div>
				<div class="login-copy">
					<h1>把评估过程<em>留在可复核的轨道</em>上</h1>
					<p>
						任务、资产、漏洞、报告一条链留痕；安卓设备用反连通道接进来，shell、文件、截屏、
						抓包与 frida 全部在同一处操作。所有主动动作都只对已获书面授权的目标发起。
					</p>
				</div>
				<div class="login-facts">
					<div><strong>任务 → 资产 → 漏洞 → 报告</strong>一条链留痕</div>
					<div><strong>设备反连</strong>设备不出公网即可调试</div>
					<div><strong>纯 Node · 零依赖</strong>解压即可运行</div>
				</div>
			</div>
			<div class="login-form-wrap"><div class="login-form">${inner}</div></div>
		</div>
	`;
}

function renderLogin(boot, errorText) {
	const view = mount(
		root,
		loginLayout(html`
			<h2>登录控制台</h2>
			<p>输入口令进入 ${boot.site?.name ?? "regedit"}。连续失败 8 次会锁定 10 分钟。</p>
			${errorText ? html`<div class="login-error">${errorText}</div>` : ""}
			<form id="login-form">
				<label class="field">
					<span>账号</span>
					<input name="user" value="admin" autocomplete="username" />
				</label>
				<label class="field">
					<span>口令</span>
					<input name="password" type="password" autocomplete="current-password" autofocus />
				</label>
				<button class="btn primary full" type="submit">进入控制台</button>
			</form>
			<div class="login-foot">
				仅用于已获书面授权的安全评估。未授权访问他人系统在多数司法辖区属违法行为。
			</div>
		`),
	);
	const form = view.querySelector("#login-form");
	form.addEventListener("submit", async (event) => {
		event.preventDefault();
		const data = new FormData(form);
		const button = form.querySelector("button");
		button.disabled = true;
		button.textContent = "验证中…";
		try {
			const result = await api.post("/api/auth/login", {
				user: data.get("user"),
				password: data.get("password"),
			});
			await loadSession(result.token, result.user);
			await start();
		} catch (error) {
			renderLogin(boot, error.message);
		}
	});
	form.querySelector("input[name=password]").focus();
}

function renderSetup(boot) {
	const view = mount(
		root,
		loginLayout(html`
			<h2>初始化控制台</h2>
			<p>首次启动需要设置口令与操作员名称，口令只保存在本机的状态文件里（scrypt 哈希）。</p>
			<form id="setup-form">
				<label class="field">
					<span>操作员名称</span>
					<input name="operator" placeholder="例如：红队-张三" autocomplete="off" />
					<span class="hint">会写进报告首页与审计日志。</span>
				</label>
				<label class="field">
					<span>口令（至少 8 位）</span>
					<input name="password" type="password" autocomplete="new-password" autofocus />
				</label>
				<label class="field">
					<span>确认口令</span>
					<input name="confirm" type="password" autocomplete="new-password" />
				</label>
				<label class="checkbox mb-12">
					<input type="checkbox" name="consent" />
					<span>我承诺只在已获授权的范围内使用本工具</span>
				</label>
				<button class="btn primary full" type="submit">创建并进入</button>
			</form>
			<div class="login-foot">口令丢失无法找回：删除 data/state.json 会清空账号与全部业务数据。</div>
		`),
	);
	const form = view.querySelector("#setup-form");
	const error = document.createElement("div");
	error.className = "login-error hidden";
	form.prepend(error);
	form.addEventListener("submit", async (event) => {
		event.preventDefault();
		const data = new FormData(form);
		const password = String(data.get("password") ?? "");
		const showError = (text) => {
			error.textContent = text;
			error.classList.remove("hidden");
		};
		if (password.length < 8) return showError("口令至少 8 位");
		if (password !== data.get("confirm")) return showError("两次输入的口令不一致");
		if (!data.get("consent")) return showError("需要先确认授权使用承诺");
		try {
			const result = await api.post("/api/auth/setup", {
				operator: data.get("operator"),
				password,
			});
			await loadSession(result.token, result.user);
			await start();
		} catch (err) {
			showError(err.message);
		}
	});
}

// ---------------------------------------------------------------- 控制台外壳

function navBadge(id) {
	if (id === "findings" && app.stats.findings) return app.stats.findings;
	if (id === "android" && app.stats.online) return app.stats.online;
	if (id === "gates" && app.stats.pending) return app.stats.pending;
	if (id === "tasks" && app.stats.running) return app.stats.running;
	// 流量徽标：有包就亮，数量封顶 999（四位数会把侧栏挤歪）。
	if (id === "traffic" && app.stats.traffic) return app.stats.traffic > 999 ? "999+" : app.stats.traffic;
	return null;
}

function renderShell() {
	mount(
		root,
		html`
			<div class="shell">
				<aside class="sider">
					<div class="sider-brand">
						${raw(brandMark(30))}
						<div class="brand-text">
							<span class="brand-name">regedit</span>
							<span class="brand-tag">Security Console</span>
						</div>
					</div>
					<nav class="sider-nav" id="sider-nav">
						${NAV.map((item) =>
							item.group
								? html`<div class="nav-group">${item.group}</div>`
								: html`<button class="nav-item" data-nav="${item.id}">
										<span class="nav-icon">${raw(icon(item.id, { size: 18 }))}</span>
										<span class="nav-label">${item.label}</span>
										${navBadge(item.id) ? html`<span class="nav-badge">${navBadge(item.id)}</span>` : ""}
									</button>`,
						)}
					</nav>
					<div class="sider-foot">
						<div class="user-chip">
							<span class="user-dot"></span>
							<span>${app.boot?.user ?? "—"}</span>
							<button class="btn-link" id="logout">退出</button>
						</div>
					</div>
				</aside>
				<main class="main">
					<header class="topbar">
						<div class="topbar-title">
							<h1 id="page-title">总览</h1>
							<span id="page-subtitle"></span>
						</div>
						<div class="topbar-actions" id="page-actions"></div>
					</header>
					<section class="page" id="view"></section>
				</main>
			</div>
		`,
	);

	document.getElementById("sider-nav").addEventListener("click", (event) => {
		const button = event.target.closest("[data-nav]");
		if (!button) return;
		location.hash = `#/${button.dataset.nav}`;
	});
	document.getElementById("logout").addEventListener("click", async () => {
		try {
			await api.post("/api/auth/logout", {});
		} catch {
			/* 已经过期也无所谓 */
		}
		clearSession();
		app.boot = null;
		location.hash = "";
		renderLogin({}, "");
	});

	if (!location.hash) location.hash = "#/dashboard";
	window.addEventListener("hashchange", route);
	route();
	// 徽标数据（未关闭漏洞数 / 在线设备数）低频刷新，别给后端添堵。
	setInterval(refreshBadges, 20_000);
}

async function refreshBadges() {
	try {
		const boot = await api.get("/api/bootstrap");
		app.stats = boot.stats ?? {};
		for (const item of NAV.filter((entry) => entry.id)) {
			const button = document.querySelector(`[data-nav="${item.id}"]`);
		 if (!button) continue;
			const badge = navBadge(item.id);
			const existing = button.querySelector(".nav-badge");
			if (badge) {
				if (existing) existing.textContent = badge;
				else button.insertAdjacentHTML("beforeend", `<span class="nav-badge">${badge}</span>`);
			} else if (existing) {
				existing.remove();
			}
		}
	} catch {
		/* 徽标失败不影响使用 */
	}
}

// ---------------------------------------------------------------- 路由

function setHeader(title, subtitle, actions) {
	const titleNode = document.getElementById("page-title");
	const subNode = document.getElementById("page-subtitle");
	const actionNode = document.getElementById("page-actions");
	if (titleNode) titleNode.textContent = title;
	if (subNode) subNode.textContent = subtitle ?? "";
	if (actionNode) {
		actionNode.innerHTML = "";
		if (actions) actionNode.append(actions);
	}
}

const ctx = {
	go(hash) {
		location.hash = hash;
	},
	/** 视图自己点"刷新"时重跑当前路由。 */
	reload() {
		if (app.dispose) app.dispose();
		app.dispose = null;
		route(true);
	},
	setHeader,
};

async function route(force = false) {
	const hash = location.hash.replace(/^#\/?/, "");
	// 支持 `#/assets?company=co1`：哈希路由里带查询串，视图用 ctx.query 读。
	// 之前不分 ? 的话，`assets?company=co1` 会被当成一个不存在的视图名，直接掉回总览。
	const [pathPart, queryPart] = hash.split("?");
	const [id, ...rest] = pathPart.split("/");
	const query = new URLSearchParams(queryPart ?? "");
	const viewId = VIEWS[id] ? id : "dashboard";
	const param = rest.join("/");
	const queryKey = query.toString();
	if (!force && app.view === viewId && app.lastParam === param && app.lastQuery === queryKey) return;

	if (app.dispose) {
		try {
			app.dispose();
		} catch {
			/* 视图清理失败不该阻断切换 */
		}
		app.dispose = null;
	}
	app.view = viewId;
	app.lastParam = param;
	app.lastQuery = queryKey;

	document.querySelectorAll("[data-nav]").forEach((node) => {
		node.classList.toggle("active", node.dataset.nav === viewId);
	});

	const container = document.getElementById("view");
	const module = VIEWS[viewId];
	setHeader(module.title ?? "", module.subtitle ?? "", null);
	container.innerHTML = "";
	try {
		const dispose = await module.render(container, { ...ctx, param, query });
		app.dispose = typeof dispose === "function" ? dispose : null;
	} catch (error) {
		container.innerHTML = "";
		mount(
			container,
			html`<div class="card"><div class="card-body">
				<div class="empty">
					${raw(icon("alert", { size: 26 }))}
					<strong>页面加载失败</strong>
					<p>${error.message}</p>
				</div>
			</div></div>`,
		);
		toast(error.message, "error");
	}
	window.scrollTo({ top: 0 });
}

start();
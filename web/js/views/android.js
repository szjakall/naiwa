/**
 * 安卓模式：设备反连、设备操作与 APK 静态分析。
 *
 * 结构照搬原实现的分栏思路：
 *   左栏 = 服务面（反连监听、令牌、拨号地址、接入步骤）
 *   右栏 = 设备面（在线设备、设备工作台）
 * 工作台一套标签：控制台 / 文件 / 屏幕 / 日志 / 抓包 / Frida / 应用，
 * 与设备端协议一一对应（exec / pull / push / screencap / logcat / packages /
 * capture_* / tcp 隧道）。
 *
 * 与旧实现的一处差异：这里没有"会话内工具开关"——regedit 的安卓操作只由
 * 操作员在页面上触发，Agent 通道未接入，先把链路做稳再谈自动化。
 */

import { icon } from "../icons.js";
import {
	api,
	confirmDialog,
	copyText,
	fmtBytes,
	html,
	mount,
	openOverlay,
	promptDialog,
	raw,
	relTime,
	joinHtml,
	showSecret,
	statusChip,
	toast,
	toNode,
} from "../core.js";
import { card, emptyState, inlineError, loading } from "../ui.js";
import { base64ToBlob, deviceApi, fileToBase64, waitApproval } from "../android-api.js";
import { renderApkCard } from "./android-apk.js";

const TABS = [
	{ id: "console", label: "控制台" },
	{ id: "files", label: "文件" },
	{ id: "screen", label: "屏幕" },
	{ id: "log", label: "日志" },
	{ id: "capture", label: "抓包" },
	{ id: "frida", label: "Frida" },
	{ id: "apps", label: "应用" },
];

const QUICK_COMMANDS = [
	{ label: "身份", cmd: "id" },
	{ label: "机型", cmd: "getprop ro.product.model; getprop ro.build.version.release" },
	{ label: "网络", cmd: "ip addr show wlan0 2>/dev/null || ifconfig wlan0" },
	{ label: "frida 进程", cmd: "ps -A 2>/dev/null | grep -i frida" },
	{ label: "已装应用", cmd: "pm list packages -3 | head -n 40" },
];

export default {
	title: "安卓设备",
	subtitle: "设备反连通道、设备操作与 APK 静态分析",

	async render(root, ctx) {
		mount(root, loading("读取设备状态…"));
		let state;
		try {
			state = await api.get("/api/android/state");
		} catch (error) {
			mount(root, inlineError(error.message));
			return;
		}

		let selectedId = ctx.param && state.devices.some((device) => device.id === ctx.param) ? ctx.param : (state.devices[0]?.id ?? null);
		let activeTab = "console";
		/** 屏幕标签的自动刷新定时器，切标签/切设备时必须清掉。 */
		let screenTimer = null;
		/** 每个设备的控制台滚动缓冲，切换设备/标签不丢。 */
		const buffers = new Map();
		const bufferOf = (id) => {
			if (!buffers.has(id)) buffers.set(id, []);
			return buffers.get(id);
		};

		const refreshState = async () => {
			const previous = selectedId;
			try {
				state = await api.get("/api/android/state");
			} catch {
				return false;
			}
			if (selectedId && !state.devices.some((device) => device.id === selectedId)) selectedId = state.devices[0]?.id ?? null;
			// 第一台设备刚连上时自动选中，省一次点击。
			if (!selectedId && state.devices.length) selectedId = state.devices[0].id;
			return previous !== selectedId;
		};

		// ---------------------------------------------------- 静态骨架

		const dialUrl = () => {
			if (state.listen) {
				const host = state.listen.host === "0.0.0.0" ? state.lanIps[0] ?? "127.0.0.1" : state.listen.host;
				return `ws://${host}:${state.listen.port}/ws/droid`;
			}
			return state.consoleUrl;
		};

		mount(
			root,
			html`
				<div class="split-even page-section">
					${card({
						title: "反连服务",
						sub: "设备主动拨出，服务器不对手机开端口",
						actions: html`<span id="listen-chip"></span>`,
						body: html`
							<div class="split-even" style="gap:12px">
								<label class="field">
									<span>监听地址</span>
									<select id="listen-host">
										<option value="0.0.0.0">0.0.0.0（所有网卡）</option>
										<option value="127.0.0.1">127.0.0.1（仅本机）</option>
										${state.lanIps.map((ip) => html`<option value="${ip}">${ip}（网卡）</option>`)}
									</select>
								</label>
								<label class="field">
									<span>端口</span>
									<input id="listen-port" type="number" min="1" max="65535" value="${state.listenConfig.port}" />
								</label>
							</div>
							<div class="row mt-8">
								<button class="btn primary small" id="listen-start">启动 / 重启监听</button>
								<button class="btn ghost small" id="listen-stop">停止监听</button>
							</div>

							<div class="apk-section">
								<h4>设备拨号地址</h4>
								<div class="copy-box" id="dial-url">${dialUrl()}</div>
								<div class="row mt-8">
									<button class="btn ghost small" id="copy-dial">复制地址</button>
									<span class="tiny muted">token 在下面创建，拨号时拼成 ?token=…</span>
								</div>
							</div>

							<div class="apk-section">
								<h4>三步接入</h4>
								<ol class="small muted" style="margin:0;padding-left:18px;line-height:1.9">
									<li>在右侧「连接令牌」新建一个令牌，复制它的值。</li>
									<li>设备安装配套 APK，打开后填写上面的拨号地址与令牌。</li>
									<li>设备心跳一进来就出现在「在线设备」，点卡片进入工作台。</li>
								</ol>
							</div>
						`,
					})}

					${card({
						title: "连接令牌",
						sub: "设备的唯一身份凭据",
						actions: html`<span class="chip chip-muted" id="token-count"></span>`,
						body: html`
							<div class="row">
								<input id="token-label" placeholder="备注，例如：Pixel 6 测试机" style="flex:1;min-width:160px" />
								<button class="btn primary small" id="token-create">创建</button>
							</div>
							<div id="token-list" class="mt-12"></div>
							<div class="hint-box mt-12">
								${raw(icon("alert", { size: 16 }))}
								<span>令牌等于设备的登录口令：删除后旧连接立即失效；不要贴进公开渠道。</span>
							</div>
						`,
					})}
				</div>

				<div class="page-section">
					${card({
						title: "在线设备",
						sub: "无响应的设备不算在线（进程可能被系统冻结）",
						actions: html`<span class="chip chip-muted" id="device-count"></span>`,
						body: html`<div class="device-grid" id="device-grid"></div>`,
					})}
				</div>

				<div class="page-section" id="device-area"></div>
				<div class="page-section" id="apk-card"></div>
			`,
		);

		// ---------------------------------------------------- 动态片段

		const tokenListHtml = () => {
			if (!state.tokens.length) return emptyState({ iconName: "key", title: "还没有令牌", description: "创建一个令牌，设备端用它认证。" });
			return html`<div class="table-wrap" style="max-height:220px">
				<table>
					<tbody>
						${state.tokens.map(
							(token) => html`<tr>
								<td>
									<div class="small dim">${token.label}</div>
									<div class="tiny muted mono">${token.id} · ${token.lastUsedAt ? `最近使用 ${relTime(token.lastUsedAt)}` : "尚未使用"}</div>
								</td>
								<td class="nowrap center">
									<button class="btn ghost small" data-token-copy="${token.id}">复制</button>
									<button class="btn-icon danger" data-token-del="${token.id}" title="删除令牌">
										${raw(icon("trash", { size: 16 }))}
									</button>
								</td>
							</tr>`,
						)}
					</tbody>
				</table>
			</div>`;
		};

		const deviceGridHtml = () => {
			if (!state.devices.length) {
				return emptyState({
					iconName: "android",
					title: "还没有设备接入",
					description: "在设备上打开 regedit 设备端，填入上面的拨号地址与令牌；连上后这里会出现设备卡片。",
				});
			}
			// 注意：不能写成 .map(...).join("")，那会把 SafeHtml 转成普通字符串，
			// 插回页面时被转义成一堆字面量标签。joinHtml 会保留"可信 HTML"标记。
			return joinHtml(
				state.devices.map(
					(device) => html`<div class="device-card ${device.id === selectedId ? "active" : ""}" data-device="${device.id}">
						<div class="device-card-head">
							<span class="dot ${device.liveness === "online" ? "ok" : device.liveness === "frozen" ? "warn" : ""}"></span>
							<span class="device-name">${device.name}</span>
							<span class="spacer"></span>
							${statusChip(device.liveness)}
						</div>
						<div class="device-meta">
							<span>${device.model}</span>
							<span>Android ${device.androidVersion}</span>
							<span>SDK ${device.sdkInt}</span>
							${device.rooted ? html`<span class="chip chip-warn">已 root</span>` : html`<span class="chip chip-muted">未 root</span>`}
						</div>
						<div class="tiny muted mt-8">
							${device.liveness === "offline" ? `离线 · 最后心跳 ${relTime(device.lastSeen)}` : `最近心跳 ${relTime(new Date(Date.now() - (device.idleMs ?? 0)).toISOString())}`}
						</div>
					</div>`,
				),
			);
		};

		const syncDynamic = () => {
			const listenChip = root.querySelector("#listen-chip");
			if (listenChip) {
				listenChip.className = `chip ${state.listen ? "chip-ok" : "chip-muted"}`;
				listenChip.textContent = state.listen ? `监听中 ${state.listen.host}:${state.listen.port}` : "未启用独立监听";
			}
			const dial = root.querySelector("#dial-url");
			if (dial) dial.textContent = dialUrl();
			const tokenCount = root.querySelector("#token-count");
			if (tokenCount) tokenCount.textContent = `${state.tokens.length} 个`;
			const deviceCount = root.querySelector("#device-count");
			if (deviceCount) {
				deviceCount.textContent = `${state.devices.filter((device) => device.liveness === "online").length}/${state.devices.length} 在线`;
			}
			const tokenList = root.querySelector("#token-list");
			if (tokenList) {
				mount(tokenList, tokenListHtml());
				wireTokenActions(tokenList);
			}
			const grid = root.querySelector("#device-grid");
			if (grid) {
				mount(grid, deviceGridHtml());
				wireDeviceCards(grid);
			}
			const statusSlot = root.querySelector("#device-status");
			if (statusSlot) {
				const device = currentDevice();
				if (device) statusSlot.innerHTML = String(statusChip(device.liveness));
			}
		};

		const wireTokenActions = (scope) => {
			scope.querySelectorAll("[data-token-copy]").forEach((node) =>
				node.addEventListener("click", async () => {
					const token = state.tokens.find((entry) => entry.id === node.dataset.tokenCopy);
					if (!token) return;
					// 复制失败（http 环境）时把令牌展示出来，让操作员能手动选中，
					// 而不是弹一句"不支持"就结束。
					const ok = await copyText(token.token);
					if (!ok) {
						showSecret({
							title: `令牌 · ${token.label}`,
							value: token.token,
							hint: "浏览器拒绝自动复制，请手动选中后按 Ctrl+C。",
						});
					}
				}),
			);
			scope.querySelectorAll("[data-token-del]").forEach((node) =>
				node.addEventListener("click", async () => {
					const ok = await confirmDialog({
						title: "删除令牌",
						message: "用这个令牌连上的设备会立刻掉线，且无法再用它重连。",
						confirmText: "删除",
						danger: true,
					});
					if (!ok) return;
					try {
						await api.del(`/api/android/tokens/${node.dataset.tokenDel}`);
						await refreshState();
						syncDynamic();
						renderDeviceArea();
						toast("令牌已删除", "success");
					} catch (error) {
						toast(error.message, "error");
					}
				}),
			);
		};

		const currentDevice = () => state.devices.find((device) => device.id === selectedId) ?? null;

		const wireDeviceCards = (scope) => {
			scope.querySelectorAll("[data-device]").forEach((node) =>
				node.addEventListener("click", () => {
					selectedId = node.dataset.device;
					syncDynamic();
					renderDeviceArea();
				}),
			);
		};

		// ---------------------------------------------------- 服务与令牌交互

		const hostSelect = root.querySelector("#listen-host");
		hostSelect.value = state.listenConfig.host;
		root.querySelector("#listen-port").value = state.listenConfig.port;

		root.querySelector("#listen-start").addEventListener("click", async (event) => {
			const button = event.currentTarget;
			button.disabled = true;
			try {
				const result = await api.post("/api/android/listen", {
					host: hostSelect.value,
					port: Number(root.querySelector("#listen-port").value),
				});
				await refreshState();
				syncDynamic();
				toast(`监听已启动：${result.host ?? hostSelect.value}:${result.port}`, "success");
			} catch (error) {
				toast(error.message, "error");
			} finally {
				button.disabled = false;
			}
		});

		root.querySelector("#listen-stop").addEventListener("click", async () => {
			try {
				await api.post("/api/android/listen/stop", {});
				await refreshState();
				syncDynamic();
				toast("监听已停止", "info");
			} catch (error) {
				toast(error.message, "error");
			}
		});

		root.querySelector("#copy-dial").addEventListener("click", async () => {
			const ok = await copyText(dialUrl());
			if (!ok) {
				showSecret({ title: "设备拨号地址", value: dialUrl(), hint: "浏览器拒绝自动复制，请手动选中后按 Ctrl+C。" });
			}
		});

		root.querySelector("#token-create").addEventListener("click", async () => {
			const label = root.querySelector("#token-label").value.trim() || "未命名设备";
			try {
				const result = await api.post("/api/android/tokens", { label });
				root.querySelector("#token-label").value = "";
				await refreshState();
				syncDynamic();

				// 无论能不能自动复制，都把令牌完整展示一次：这是它唯一可见的时机，
				// 而且操作员要拿它去手机上手输，光靠 toast 不够。
				const ok = await copyText(result.token.token);
				showSecret({
					title: `令牌已创建 · ${result.token.label}`,
					value: result.token.token,
					hint: ok
						? "已复制到剪贴板。把它连同下面的拨号地址一起填进手机上的「regedit 设备端」。"
						: "浏览器拒绝自动复制，请手动选中后按 Ctrl+C，再填进手机上的「regedit 设备端」。",
					note: html`拨号地址：<span class="mono">${dialUrl()}</span>`,
				});
			} catch (error) {
				toast(error.message, "error");
			}
		});

		// ---------------------------------------------------- 工作台

		function renderDeviceArea() {
			const container = root.querySelector("#device-area");
			const device = currentDevice();
			if (!device) {
				mount(
					container,
					card({
						title: "设备工作台",
						body: emptyState({
							iconName: "phone",
							title: "先接入一台设备",
							description: "令牌 + 拨号地址就能把设备接进来。设备上线后，这台卡片会出现在上面的列表里。",
						}),
					}),
				);
				return;
			}

			const actions = toNode(html`
				<div class="row">
					<span id="device-status">${raw(statusChip(device.liveness))}</span>
					<button class="btn ghost small" id="device-rename">重命名</button>
					<button class="btn ghost small" id="device-delete">删除设备</button>
				</div>
			`);

			mount(
				container,
				card({
					title: device.name,
					sub: `${device.model} · Android ${device.androidVersion} · SDK ${device.sdkInt}${device.rooted ? " · 已 root" : ""}`,
					actions,
					body: html`
						<div class="tabs mb-12">
							${TABS.map(
								(tab) =>
									html`<button class="tab ${tab.id === activeTab ? "active" : ""}" data-tab="${tab.id}">${tab.label}</button>`,
							)}
						</div>
						<div id="device-panel"></div>
					`,
				}),
			);

			container.querySelector("#device-rename").addEventListener("click", async () => {
				const name = await promptDialog({
					title: "重命名设备",
					label: "设备名称",
					value: device.name,
					confirmText: "保存",
				});
				if (!name) return;
				try {
					await api.patch(`/api/android/devices/${device.id}`, { name });
					await refreshState();
					syncDynamic();
					renderDeviceArea();
				} catch (error) {
					toast(error.message, "error");
				}
			});

			container.querySelector("#device-delete").addEventListener("click", async () => {
				const ok = await confirmDialog({
					title: "删除设备",
					message: "只删除登记记录；设备重连后会重新出现。",
					confirmText: "删除",
					danger: true,
				});
				if (!ok) return;
				try {
					await api.del(`/api/android/devices/${device.id}`);
					selectedId = null;
					await refreshState();
					syncDynamic();
					renderDeviceArea();
					toast("已删除", "success");
				} catch (error) {
					toast(error.message, "error");
				}
			});

			container.querySelectorAll("[data-tab]").forEach((node) =>
				node.addEventListener("click", () => {
					activeTab = node.dataset.tab;
					container.querySelectorAll("[data-tab]").forEach((tab) => tab.classList.toggle("active", tab === node));
					renderPanel();
				}),
			);

			// 顶栏随设备变化，保持与导航一致。
			ctx.setHeader("安卓设备", `${state.devices.length} 台登记 · ${state.devices.filter((item) => item.liveness === "online").length} 台在线`, null);

			renderPanel();
		}

		function renderPanel() {
			const panel = root.querySelector("#device-panel");
			if (!panel) return;
			const device = currentDevice();
			if (!device) return;
			// 上一个标签的自刷新定时器必须停掉，否则切走以后还在背后截屏。
			if (screenTimer) {
				clearInterval(screenTimer);
				screenTimer = null;
			}
			panel.innerHTML = "";
			const api2 = deviceApi(device.id);

			if (activeTab === "console") return renderConsole(panel, device, api2);
			if (activeTab === "files") return renderFiles(panel, device, api2);
			if (activeTab === "screen") return renderScreen(panel, device, api2);
			if (activeTab === "log") return renderLog(panel, device, api2);
			if (activeTab === "capture") return renderCapture(panel, device, api2);
			if (activeTab === "frida") return renderFrida(panel, device, api2);
			if (activeTab === "apps") return renderApps(panel, device, api2);
		}

		// ---------------------------------------------------- 控制台

		function renderConsole(panel, device, dapi) {
			mount(
				panel,
				html`
					<div class="row mb-12">
						<input id="cmd" placeholder="输入 shell 命令，例如 getprop ro.product.model" style="flex:1;min-width:200px" />
						<label class="checkbox"><input type="checkbox" id="as-root" ${device.rooted ? "checked" : ""} /><span>root</span></label>
						<button class="btn primary small" id="run">执行</button>
						<button class="btn ghost small" id="clear">清空</button>
					</div>
					<div class="row mb-12" style="gap:6px">
						${QUICK_COMMANDS.map((item) => html`<button class="btn ghost small" data-quick="${item.cmd}">${item.label}</button>`)}
					</div>
					<div class="console" id="out"></div>
				`,
			);

			const out = panel.querySelector("#out");
			const lines = bufferOf(device.id);
			const paint = () => {
				mount(
					out,
					lines.length
						? lines.map(
								(line) => html`<div class="log-line ${line.kind}">
									<span class="log-time">${line.at}</span>
									<span class="log-text">${line.text}</span>
								</div>`,
							)
						: html`<div class="muted">连接已在，执行一条命令试试。</div>`,
				);
				out.scrollTop = out.scrollHeight;
			};
			const append = (kind, text) => {
				const at = new Date().toTimeString().slice(0, 8);
				for (const chunk of String(text ?? "").split(/\r?\n/)) {
					if (chunk === "") continue;
					lines.push({ kind, text: chunk, at });
				}
				if (lines.length > 500) lines.splice(0, lines.length - 500);
				paint();
			};
			paint();

			const run = async () => {
				const input = panel.querySelector("#cmd");
				const cmd = input.value.trim();
				if (!cmd) return;
				const button = panel.querySelector("#run");
				button.disabled = true;
				append("step", `$ ${cmd}`);
				try {
					let result = await dapi.exec(cmd, panel.querySelector("#as-root").checked);
					// 人工审批模式：命令先进队列，这里等操作员在「守门」页放行。
					if (result?.pending) {
						append("warn", "已进入审批队列，等待操作员在「守门」页批准…");
						const outcome = await waitApproval(result.approvalId, {
							onTick: (item) => {
								if (item.status === "pending") return;
							},
						});
						if (outcome.status === "timeout") {
							append("error", "等待审批超时（5 分钟），命令未执行");
							return;
						}
						if (outcome.status === "rejected") {
							append("error", `操作员拒绝了该命令${outcome.item?.reason ? `：${outcome.item.reason}` : ""}`);
							return;
						}
						result = outcome.item?.result ?? { ok: false, error: "审批已通过但没有返回执行结果" };
						append("info", "审批已通过，命令已执行");
					}
					if (result?.blocked) {
						append("error", result.error ?? "守门员拦截");
					} else if (result?.error) {
						append("error", result.error);
					}
					if (result?.stdout) append("info", result.stdout);
					if (result?.stderr) append("warn", result.stderr);
					if (result?.gateError) append("warn", `守门判定失败，已按设计放行：${result.gateError}`);
					if (result?.ok && !result.stdout && !result.stderr) append("info", `（无输出，退出码 ${result.code ?? 0}）`);
				} catch (error) {
					append("error", error.message);
				} finally {
					button.disabled = false;
					input.focus();
				}
			};

			panel.querySelector("#run").addEventListener("click", run);
			panel.querySelector("#cmd").addEventListener("keydown", (event) => {
				if (event.key === "Enter" && !event.shiftKey) {
					event.preventDefault();
					run();
				}
			});
			panel.querySelector("#clear").addEventListener("click", () => {
				lines.length = 0;
				paint();
			});
			panel.querySelectorAll("[data-quick]").forEach((node) =>
				node.addEventListener("click", () => {
					panel.querySelector("#cmd").value = node.dataset.quick;
					run();
				}),
			);
			panel.querySelector("#cmd").focus();
		}

		// ---------------------------------------------------- 文件

		function renderFiles(panel, device, dapi) {
			mount(
				panel,
				html`
					<div class="row mb-12">
						<input id="ls-path" value="/sdcard" placeholder="/sdcard" style="flex:1;min-width:200px" />
						<button class="btn primary small" id="ls">列出</button>
					</div>
					<div class="console" id="ls-out" style="height:240px"></div>

					<div class="apk-section">
						<h4>拉取文件</h4>
						<div class="row">
							<input id="pull-path" placeholder="/sdcard/DCIM/screenshot.png" style="flex:1;min-width:200px" />
							<button class="btn ghost small" id="pull">下载到本机</button>
						</div>
						<span class="hint">单文件上限 32MB（浏览器下载限制）；更大的文件用设备侧命令处理。</span>
					</div>

					<div class="apk-section">
						<h4>推送文件</h4>
						<div class="row">
							<input type="file" id="push-file" />
							<input id="push-path" placeholder="/data/local/tmp/tool" style="flex:1;min-width:160px" />
							<button class="btn ghost small" id="push">推送</button>
						</div>
						<span class="hint">推送后默认 0700 权限，可直接执行。</span>
					</div>
				`,
			);

			const out = panel.querySelector("#ls-out");
			const writeOut = (text) => {
				out.textContent = text;
				out.scrollTop = 0;
			};

			const doLs = async () => {
				const path = panel.querySelector("#ls-path").value.trim();
				writeOut("读取中…");
				try {
					const result = await dapi.ls(path);
					writeOut(result.stdout || result.error || result.stderr || "（空）");
				} catch (error) {
					writeOut(error.message);
				}
			};

			panel.querySelector("#ls").addEventListener("click", doLs);
			panel.querySelector("#ls-path").addEventListener("keydown", (event) => {
				if (event.key === "Enter") doLs();
			});

			panel.querySelector("#pull").addEventListener("click", async (event) => {
				const path = panel.querySelector("#pull-path").value.trim();
				if (!path) return toast("先填要拉取的路径", "error");
				const button = event.currentTarget;
				button.disabled = true;
				button.textContent = "拉取中…";
				try {
					const result = await dapi.pull(path);
					if (result.file) {
						// 大文件：服务端已经落盘，这里直接给下载链接，避免把 65MB 的
						// base64 塞进页面内存。
						const link = document.createElement("a");
						link.href = result.file;
						link.download = result.filename || "file.bin";
						link.click();
						toast(`已下载 ${result.filename}（${fmtBytes(result.size)}，服务端已存档）`, "success");
						return;
					}
					const blob = base64ToBlob(result.base64);
					const url = URL.createObjectURL(blob);
					const link = document.createElement("a");
					link.href = url;
					link.download = result.filename || "file.bin";
					link.click();
					setTimeout(() => URL.revokeObjectURL(url), 4000);
					toast(`已下载 ${result.filename}（${fmtBytes(result.size)}）`, "success");
				} catch (error) {
					toast(error.message, "error");
				} finally {
					button.disabled = false;
					button.textContent = "下载到本机";
				}
			});

			panel.querySelector("#push").addEventListener("click", async (event) => {
				const file = panel.querySelector("#push-file").files?.[0];
				const target = panel.querySelector("#push-path").value.trim();
				if (!file) return toast("先选本地文件", "error");
				if (!target) return toast("先填设备上的目标路径", "error");
				const button = event.currentTarget;
				button.disabled = true;
				button.textContent = "推送中…";
				try {
					const base64 = await fileToBase64(file);
					const result = await dapi.push(target, base64, "0700");
					if (result?.pending) {
						toast("已进入审批队列，请到「守门」页批准后才会写入设备", "info", 6000);
					} else if (result?.blocked) {
						toast(result.error ?? "守门员拦截", "error", 6000);
					} else if (!result.ok) {
						throw new Error(result.error ?? "推送失败");
					} else {
						toast(`已推送 ${file.name} 到 ${target}`, "success");
					}
				} catch (error) {
					toast(error.message, "error");
				} finally {
					button.disabled = false;
					button.textContent = "推送";
				}
			});
		}

		// ---------------------------------------------------- 屏幕

		function renderScreen(panel, device, dapi) {
			mount(
				panel,
				html`
					<div class="row mb-12">
						<button class="btn primary small" id="cap">截屏</button>
						<label class="checkbox"><input type="checkbox" id="auto" /><span>每 5 秒自动刷新</span></label>
						<span class="spacer"></span>
						<span class="tiny muted" id="cap-meta"></span>
					</div>
					<div class="screen-frame" id="cap-frame">
						<div class="muted small" style="align-self:center">还没有画面，点「截屏」。</div>
					</div>
				`,
			);

			const frame = panel.querySelector("#cap-frame");
			const meta = panel.querySelector("#cap-meta");

			const shoot = async () => {
				const button = panel.querySelector("#cap");
				button.disabled = true;
				try {
					const result = await dapi.screencap();
					frame.innerHTML = "";
					const image = document.createElement("img");
					image.src = `data:image/png;base64,${result.base64}`;
					image.alt = "设备截屏";
					frame.append(image);
					meta.textContent = `${fmtBytes(result.size)} · ${new Date().toLocaleTimeString("zh-CN")}`;
				} catch (error) {
					// 失败原因直接写在画面区：只弹 toast 会被错过，操作员只看到"点不动"。
					mount(
						frame,
						html`<div style="align-self:center;text-align:center;padding:20px">
							<div class="chip chip-danger mb-12">截屏失败</div>
							<div class="tiny muted" style="max-width:420px;line-height:1.7">${error.message}</div>
							<div class="tiny muted mt-12">常见原因：设备不在线、进程被系统冻结、或「设备截屏」工具被停用。</div>
						</div>`,
					);
					toast(error.message, "error", 6000);
				} finally {
					button.disabled = false;
				}
			};

			panel.querySelector("#cap").addEventListener("click", shoot);
			panel.querySelector("#auto").addEventListener("change", (event) => {
				if (screenTimer) {
					clearInterval(screenTimer);
					screenTimer = null;
				}
				if (event.target.checked) {
					shoot();
					screenTimer = setInterval(shoot, 5000);
				}
			});
			shoot();
		}

		// ---------------------------------------------------- 日志

		function renderLog(panel, device, dapi) {
			mount(
				panel,
				html`
					<div class="row mb-12">
						<input id="log-lines" type="number" min="10" max="5000" value="200" style="max-width:110px" />
						<input id="log-filter" placeholder="过滤关键字，例如 regedit 或 ActivityManager" style="flex:1;min-width:160px" />
						<button class="btn primary small" id="log-fetch">抓取</button>
					</div>
					<pre class="console" id="log-out" style="height:340px;white-space:pre">点「抓取」读取设备 logcat。</pre>
				`,
			);
			panel.querySelector("#log-fetch").addEventListener("click", async (event) => {
				const button = event.currentTarget;
				button.disabled = true;
				const out = panel.querySelector("#log-out");
				out.textContent = "读取中…";
				try {
					const result = await dapi.logcat(
						Number(panel.querySelector("#log-lines").value) || 200,
						panel.querySelector("#log-filter").value.trim() || undefined,
					);
					out.textContent = result.ok ? result.text || "（空）" : result.error ?? "读取失败";
				} catch (error) {
					out.textContent = error.message;
				} finally {
					button.disabled = false;
				}
			});
		}

		// ---------------------------------------------------- 抓包

		function renderCapture(panel, device, dapi) {
			mount(
				panel,
				html`
					<div class="row mb-12">
						<label class="field" style="margin:0;max-width:150px">
							<span>网卡</span>
							<input id="cap-iface" value="any" />
						</label>
						<label class="field" style="margin:0;max-width:120px">
							<span>时长（秒）</span>
							<input id="cap-seconds" type="number" min="5" max="600" value="30" />
						</label>
						<div class="row" style="align-self:flex-end;gap:8px">
							<button class="btn primary small" id="cap-start">开始</button>
							<button class="btn ghost small" id="cap-stop">停止并取回</button>
							<button class="btn ghost small" id="cap-status">状态</button>
						</div>
					</div>
					<div id="cap-result" class="hint-box">
						${raw(icon("traffic", { size: 16 }))}
						<span>抓包在设备侧执行（需要设备有 tcpdump 且已 root），停止后 pcap 落到控制台的 data/artifacts 供下载。</span>
					</div>
				`,
			);

			const result = panel.querySelector("#cap-result");
			const show = (htmlContent) => mount(result, htmlContent);

			panel.querySelector("#cap-start").addEventListener("click", async (event) => {
				event.currentTarget.disabled = true;
				try {
					const outcome = await dapi.capture(
						"start",
						panel.querySelector("#cap-iface").value.trim() || "any",
						Number(panel.querySelector("#cap-seconds").value) || 30,
					);
					show(
						outcome.ok
							? html`<span>已开始抓包${outcome.stdout ? `：${outcome.stdout}` : ""}</span>`
							: inlineError(outcome.error ?? "启动失败"),
					);
				} catch (error) {
					show(inlineError(error.message));
				} finally {
					panel.querySelector("#cap-start").disabled = false;
				}
			});

			panel.querySelector("#cap-stop").addEventListener("click", async (event) => {
				event.currentTarget.disabled = true;
				try {
					const outcome = await dapi.capture("stop");
					if (outcome.file) {
						show(html`
							<span>抓包完成：${fmtBytes(outcome.size ?? 0)}</span>
							<a class="btn ghost small" href="${outcome.file}" download>下载 pcap</a>
						`);
					} else {
						show(outcome.ok ? html`<span>已停止${outcome.stdout ? `：${outcome.stdout}` : ""}</span>` : inlineError(outcome.error ?? "停止失败"));
					}
				} catch (error) {
					show(inlineError(error.message));
				} finally {
					panel.querySelector("#cap-stop").disabled = false;
				}
			});

			panel.querySelector("#cap-status").addEventListener("click", async () => {
				try {
					const outcome = await dapi.capture("status");
					show(html`<span class="mono tiny">${outcome.text || outcome.error || "（空）"}</span>`);
				} catch (error) {
					show(inlineError(error.message));
				}
			});
		}

		// ---------------------------------------------------- Frida

		function renderFrida(panel, device, dapi) {
			mount(
				panel,
				html`
					<div class="row mb-12">
						<select id="tpl" style="max-width:320px"></select>
						<button class="btn ghost small" id="tpl-load">载入模板</button>
						<span class="spacer"></span>
						<button class="btn primary small" id="frida-push">推送到设备</button>
					</div>
					<textarea id="script" rows="12" placeholder="// 选择上面的模板，或直接写 frida 脚本"></textarea>
					<div id="frida-out" class="mt-12"></div>

					<div class="apk-section">
						<h4>frida-server</h4>
						<div class="row">
							<input id="fs-path" value="/data/local/tmp/frida-server" style="flex:1;min-width:200px" />
							<button class="btn ghost small" id="fs-start">在设备上启动</button>
						</div>
						<span class="hint">设备侧需要已推送可执行的 frida-server；默认以 root 身份 nohup 起。</span>
					</div>

					<div class="apk-section">
						<h4>TCP 隧道</h4>
						<div class="row">
							<input id="tunnel-port" type="number" value="27042" style="max-width:120px" />
							<button class="btn ghost small" id="tunnel-open">开隧道到设备 27042</button>
						</div>
						<div id="tunnel-list" class="mt-12"></div>
						<span class="hint">
							隧道在本机监听一个端口，把流量桥到设备上的 frida-server：主机上执行
							<code>frida -H 127.0.0.1:&lt;端口&gt; -f &lt;包名&gt;</code> 即可。
						</span>
					</div>
				`,
			);

			const out = panel.querySelector("#frida-out");
			const show = (content) => mount(out, content);
			const select = panel.querySelector("#tpl");

			const loadTemplates = async () => {
				try {
					const templates = await api.get("/api/android/frida/templates");
					mount(
						select,
						html`${templates.map(
							(template) => html`<option value="${template.name}" data-content="${template.content}">${template.title}</option>`,
						)}`,
					);
					select.dataset.loaded = "1";
					select.dispatchEvent(new Event("change"));
				} catch (error) {
					show(inlineError(error.message));
				}
			};

			select.addEventListener("change", () => {
				const option = select.selectedOptions[0];
				if (option?.dataset.content) panel.querySelector("#script").value = option.dataset.content;
			});
			panel.querySelector("#tpl-load").addEventListener("click", loadTemplates);
			panel.querySelector("#tpl-load").dispatchEvent(new Event("click"));

			panel.querySelector("#frida-push").addEventListener("click", async (event) => {
				const content = panel.querySelector("#script").value;
				if (!content.trim()) return toast("脚本为空", "error");
				event.currentTarget.disabled = true;
				try {
					const result = await dapi.frida("push", {
						name: select.value || `regedit-${Date.now()}.js`,
						content,
					});
					if (result?.pending) {
						show(inlineError("已进入审批队列：到「守门」页批准后脚本才会写到设备上"));
						return;
					}
					if (result?.blocked) {
						show(inlineError(result.error ?? "守门员拦截"));
						return;
					}
					show(html`
						<div class="hint-box">
							${raw(icon("check", { size: 16 }))}
							<span>已推送：<span class="mono">${result.path}</span><br />${result.hint}</span>
						</div>
					`);
				} catch (error) {
					show(inlineError(error.message));
				} finally {
					event.currentTarget.disabled = false;
				}
			});

			panel.querySelector("#fs-start").addEventListener("click", async (event) => {
				event.currentTarget.disabled = true;
				try {
					const result = await dapi.frida("server", { path: panel.querySelector("#fs-path").value.trim() });
					if (result?.pending) return show(inlineError("已进入审批队列：到「守门」页批准后才会在设备上启动"));
					if (result?.blocked) return show(inlineError(result.error ?? "守门员拦截"));
					show(html`<pre class="md-code" style="padding:12px;border-radius:9px;background:#070b10">${result.text || "（空）"}</pre>`);
				} catch (error) {
					show(inlineError(error.message));
				} finally {
					event.currentTarget.disabled = false;
				}
			});

			const paintTunnels = () => {
				const node = panel.querySelector("#tunnel-list");
				const tunnels = state.tunnels ?? [];
				if (!tunnels.length) {
					mount(node, html`<div class="tiny muted">当前没有隧道。</div>`);
					return;
				}
				mount(
					node,
					html`<div class="table-wrap">
						<table>
							<tbody>
								${tunnels.map(
									(tunnel) => html`<tr>
										<td class="mono tiny">本机 :${tunnel.port}</td>
										<td class="mono tiny muted">→ ${tunnel.targetHost}:${tunnel.targetPort}</td>
										<td class="nowrap center">
											<button class="btn ghost small" data-tunnel-close="${tunnel.tunnelId}">关闭</button>
										</td>
									</tr>`,
								)}
							</tbody>
						</table>
					</div>`,
				);
				node.querySelectorAll("[data-tunnel-close]").forEach((button) =>
					button.addEventListener("click", async () => {
						try {
							await api.del(`/api/android/tunnels/${button.dataset.tunnelClose}`);
							await refreshState();
							syncDynamic();
							paintTunnels();
						} catch (error) {
							toast(error.message, "error");
						}
					}),
				);
			};
			paintTunnels();

			panel.querySelector("#tunnel-open").addEventListener("click", async (event) => {
				event.currentTarget.disabled = true;
				try {
					const port = Number(panel.querySelector("#tunnel-port").value) || 27042;
					const result = await dapi.tunnel("127.0.0.1", port);
					await refreshState();
					paintTunnels();
					show(
						html`<div class="hint-box">
							${raw(icon("link", { size: 16 }))}
							<span>隧道就绪：本机 <span class="mono">127.0.0.1:${result.port}</span> → 设备 127.0.0.1:${port}<br />
							主机执行 <code>frida -H 127.0.0.1:${result.port} -U</code> 或指定包名启动。</span>
						</div>`,
					);
				} catch (error) {
					show(inlineError(error.message));
				} finally {
					event.currentTarget.disabled = false;
				}
			});
		}

		// ---------------------------------------------------- 应用

		function renderApps(panel, device, dapi) {
			mount(
				panel,
				html`
					<div class="row mb-12">
						<label class="checkbox"><input type="checkbox" id="third-only" checked /><span>只看第三方应用</span></label>
						<button class="btn primary small" id="apps-load">列出应用</button>
						<input id="apps-filter" placeholder="过滤包名" style="flex:1;min-width:160px" />
					</div>
					<div class="console" id="apps-out" style="height:340px">点「列出应用」。</div>
				`,
			);

			const out = panel.querySelector("#apps-out");
			let packages = [];

			const paint = () => {
				const keyword = panel.querySelector("#apps-filter").value.trim().toLowerCase();
				const visible = packages.filter((name) => !keyword || name.toLowerCase().includes(keyword));
				out.textContent = visible.length ? visible.join("\n") : "（没有匹配的包名）";
			};

			panel.querySelector("#apps-load").addEventListener("click", async (event) => {
				event.currentTarget.disabled = true;
				out.textContent = "读取中…";
				try {
					const result = await dapi.packages(panel.querySelector("#third-only").checked);
					packages = (result.text ?? "")
						.split(/\r?\n/)
						.map((line) => line.replace(/^package:/, "").trim())
						.filter(Boolean)
						.sort();
					paint();
				} catch (error) {
					out.textContent = error.message;
				} finally {
					event.currentTarget.disabled = false;
				}
			});
			panel.querySelector("#apps-filter").addEventListener("input", paint);
		}

		// ---------------------------------------------------- 首次渲染

		syncDynamic();
		renderDeviceArea();
		renderApkCard(root.querySelector("#apk-card"), ctx);

		const timer = setInterval(async () => {
			const selectionChanged = await refreshState();
			syncDynamic();
			if (selectionChanged) renderDeviceArea();
		}, 3000);

		return () => {
			clearInterval(timer);
			if (screenTimer) clearInterval(screenTimer);
		};
	},
};
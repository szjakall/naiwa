/**
 * 流量：任务引擎、对话工具、设备抓包发出的每一次交互都留一行。
 *
 * 这一页是证据链的底稿——报告里的"请求流水"就是从这张表取的，所以除了
 * "有没有数据"，更要能看见**这一条包本身**：请求头、响应头、正文摘录。
 * 早先只列了时间/状态/地址几列，操作员看到一行 200 却不知道对方返回了什么，
 * 体感就是"流量不显示"。
 */

import { icon } from "../icons.js";
import { api, copyText, fmtBytes, fmtClock, fmtDuration, html, mount, raw, toast, toNode } from "../core.js";
import { card, emptyState, inlineError, loading } from "../ui.js";

const KINDS = [
	{ id: "all", label: "全部" },
	{ id: "http", label: "HTTP" },
	{ id: "dns", label: "DNS" },
	{ id: "whois", label: "WHOIS" },
	{ id: "device", label: "设备" },
];

const KIND_LABEL = { http: "HTTP", dns: "DNS", whois: "WHOIS", device: "设备" };

function statusTone(status) {
	if (!status) return "chip-danger";
	if (status < 300) return "chip-ok";
	if (status < 400) return "chip-info";
	if (status < 500) return "chip-warn";
	return "chip-danger";
}

/**
 * 请求包 / 响应包：优先用服务端逐字记录的原始报文；老记录（1.1 之前只存了白名单头）
 * 用结构化字段拼一份"接近原始"的版本，至少能看出请求行、头和正文，不留空白。
 */
function rawRequestOf(item) {
	if (item.rawRequest) return item.rawRequest;
	const headers = item.requestHeaders;
	if (!headers || !Object.keys(headers).length) return "";
	const lines = [`${item.method ?? "GET"} ${item.url ?? "/"} HTTP/1.1`];
	for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
	return lines.join("\r\n");
}

function rawResponseOf(item) {
	if (item.rawResponse) return item.rawResponse;
	const headers = item.responseHeaders;
	const lines = [`HTTP/1.1 ${item.status || 0}`];
	if (headers) for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
	const body = item.bodyPreview ?? "";
	return body ? `${lines.join("\r\n")}\r\n\r\n${body}` : lines.join("\r\n");
}

/** 设备抓包这类没有 HTTP 语义的记录，用 note 拼一条可读的"包"。 */
function devicePacket(item) {
	if (item.kind === "dns") return item.rawResponse ?? item.note ?? "";
	if (item.kind === "whois") return item.rawResponse ?? item.note ?? "";
	return item.rawResponse ?? item.note ?? "";
}

export default {
	title: "流量",
	subtitle: "每一次出网的交互都留痕：HTTP / DNS / WHOIS / 设备",

	async render(root, ctx) {
		mount(root, loading("读取流量…"));

		let items = [];
		let tasks = [];
		let companies = [];
		let timer = null;
		let live = false;
		let expanded = new Set();

		// 进页面就带过滤条件：从公司/任务/会话点进来时不该再让操作员手动选一次。
		let kind = ctx.query?.get("kind") ?? "all";
		let taskId = ctx.query?.get("taskId") ?? "";
		let companyId = ctx.query?.get("companyId") ?? "";
		let conversationId = ctx.query?.get("conversationId") ?? "";
		let keyword = ctx.query?.get("q") ?? "";

		try {
			const [traffic, taskList, companyList] = await Promise.all([
				api.get("/api/traffic?limit=800"),
				api.get("/api/tasks"),
				api.get("/api/companies"),
			]);
			items = Array.isArray(traffic) ? traffic : [];
			tasks = Array.isArray(taskList) ? taskList : [];
			companies = Array.isArray(companyList?.items) ? companyList.items : [];
		} catch (error) {
			mount(root, inlineError(error.message));
			return;
		}

		// 过滤在前端做：800 条的量级，来回打接口反而更慢，也让"自动刷新"变成抖动源。
		const visible = () =>
			items.filter((item) => {
				if (kind !== "all" && (item.kind ?? "http") !== kind) return false;
				if (taskId && item.taskId !== taskId) return false;
				if (companyId && item.companyId !== companyId) return false;
				if (conversationId && item.conversationId !== conversationId) return false;
				if (keyword) {
					const haystack = `${item.url ?? ""} ${item.note ?? ""} ${item.method ?? ""} ${item.contentType ?? ""}`.toLowerCase();
					if (!haystack.includes(keyword.toLowerCase())) return false;
				}
				return true;
			});

		const taskTitle = (id) => tasks.find((task) => task.id === id)?.title ?? "";
		const companyName = (id) => companies.find((company) => company.id === id)?.name ?? "";

		const paint = () => {
			const rows = visible();
			const buckets = rows.reduce((acc, item) => {
				const key = item.status === 0 ? "失败" : `${Math.floor(item.status / 100)}xx`;
				acc[key] = (acc[key] ?? 0) + 1;
				return acc;
			}, {});
			const kindCounts = rows.reduce((acc, item) => {
				const key = item.kind ?? "http";
				acc[key] = (acc[key] ?? 0) + 1;
				return acc;
			}, {});

			const actions = toNode(html`
				<button class="btn ghost small" id="toggle-live" data-on="${live ? "1" : "0"}">
					${raw(icon(live ? "stop" : "play", { size: 14 }))}${live ? "停止实时" : "实时刷新"}
				</button>
				<button class="btn ghost small" id="refresh">${raw(icon("refresh", { size: 15 }))}刷新</button>
			`);
			ctx.setHeader("流量", `最近 ${rows.length} 条 · 合计 ${items.length} 条`, actions);
			actions.querySelector("#refresh").addEventListener("click", () => load());
			actions.querySelector("#toggle-live").addEventListener("click", () => {
				live = !live;
				schedule();
				paint();
			});

			const filters = html`<div class="page-section row" style="gap:10px;flex-wrap:wrap">
				<div class="tabs">
					${KINDS.map(
						(item) =>
							html`<button class="tab ${item.id === kind ? "active" : ""}" data-kind="${item.id}">
								${item.label}${kindCounts[item.id] ? ` ${kindCounts[item.id]}` : ""}
							</button>`,
					)}
				</div>
				<select id="task-filter" style="max-width:260px">
					<option value="">全部项目</option>
					${tasks.map(
						(task) =>
							html`<option value="${task.id}" ${task.id === taskId ? "selected" : ""}>${task.title}（${task.id}）</option>`,
					)}
				</select>
				<input id="q" placeholder="搜地址 / 备注 / 类型" style="max-width:240px" value="${keyword}" />
				<div class="spacer"></div>
				${Object.entries(buckets).map(([key, count]) => html`<span class="chip chip-muted">${key} · ${count}</span>`)}
			</div>`;

			const table = rows.length
				? html`<div class="table-wrap" style="max-height:68vh">
						<table>
							<thead>
								<tr>
									<th class="nowrap">时间</th>
									<th class="nowrap">类型</th>
									<th class="nowrap">状态</th>
									<th class="nowrap">方法</th>
									<th>地址</th>
									<th class="nowrap">耗时</th>
									<th class="nowrap">大小</th>
									<th class="nowrap">归属</th>
								</tr>
							</thead>
							<tbody>
								${rows.map((item) => {
									const open = expanded.has(item.id);
									return html`<tr class="traffic-row" data-row="${item.id}">
											<td class="nowrap mono tiny">${fmtClock(item.at)}</td>
											<td class="nowrap"><span class="chip chip-muted">${KIND_LABEL[item.kind ?? "http"] ?? item.kind}</span></td>
											<td class="nowrap"><span class="chip ${statusTone(item.status)}">${item.status || "ERR"}</span></td>
											<td class="nowrap mono tiny">${item.method}</td>
											<td class="break tiny mono">
												<span class="traffic-caret">${open ? "▾" : "▸"}</span>
												${item.url}
												${item.probe ? html`<span class="chip chip-muted tiny">探针</span>` : ""}
											</td>
											<td class="nowrap mono tiny">${fmtDuration(item.ms ?? 0)}</td>
											<td class="nowrap mono tiny">${fmtBytes(item.bytes ?? 0)}</td>
											<td class="nowrap tiny muted">
												${item.taskId
													? html`<a href="#/tasks/${item.taskId}" class="link">${taskTitle(item.taskId) || item.taskId}</a>`
													: companyId
														? companyName(item.companyId)
														: "—"}
											</td>
										</tr>
										${open
											? html`<tr class="traffic-detail">
													<td colspan="8">
														<div class="traffic-packet">
															<div class="row small muted" style="gap:14px;flex-wrap:wrap;margin-bottom:8px">
																<span>记录 ${item.id}</span>
																<span>${item.note || "—"}</span>
																${item.contentType ? html`<span>${item.contentType}</span>` : ""}
																${item.conversationId ? html`<a class="link" href="#/chat/${item.conversationId}">来源会话</a>` : ""}
																<span class="spacer"></span>
																<button class="btn ghost small" data-copy="${item.id}" data-which="request">复制请求包</button>
																<button class="btn ghost small" data-copy="${item.id}" data-which="response">复制响应包</button>
															</div>
															${(item.kind ?? "http") === "http"
																? html`<div class="traffic-cols">
																		<div>
																			<div class="traffic-cap">请求包</div>
																			<pre class="traffic-body tiny" data-pkt-req="${item.id}">${rawRequestOf(item) || "（未记录请求报文）"}</pre>
																		</div>
																		<div>
																			<div class="traffic-cap">响应包</div>
																			<pre class="traffic-body tiny" data-pkt-res="${item.id}">${rawResponseOf(item) || "（未记录响应报文）"}</pre>
																		</div>
																	</div>`
																: html`<div>
																		<div class="traffic-cap">${KIND_LABEL[item.kind ?? "http"] ?? item.kind} 原始记录</div>
																		<pre class="traffic-body tiny" data-pkt-res="${item.id}">${devicePacket(item) || "（未记录内容）"}</pre>
																	</div>`}
															${item.truncated ? html`<div class="tiny muted mt-8">正文超过采集上限，已截断。</div>` : ""}
														</div>
													</td>
												</tr>`
											: ""}`;
								})}
							</tbody>
						</table>
					</div>`
				: card({
						body: emptyState({
							iconName: "traffic",
							title: items.length ? "当前过滤条件下没有流量" : "还没有流量记录",
							description: items.length
								? "换一个类型或项目筛选；也可以清掉搜索词。"
								: "跑一个任务、或在对话里让 Agent 查一次 DNS/WHOIS，这里就会出现第一条记录。任务被守门拦住（待审批）时不会发请求，所以先看「守门」页有没有排队。",
						}),
					});

			mount(
				root,
				html`
					${filters}
					${rows.length
						? card({
								title: "请求流水",
								sub: `${rows.length} 条${conversationId ? " · 仅本会话" : ""}`,
								actions: html`<button class="btn ghost small" id="copy">复制为文本</button>`,
								body: table,
								tight: true,
							})
						: table}
				`,
			);

			root.querySelectorAll("[data-kind]").forEach((node) =>
				node.addEventListener("click", () => {
					kind = node.dataset.kind;
					paint();
				}),
			);
			const taskSelect = root.querySelector("#task-filter");
			if (taskSelect) {
				taskSelect.addEventListener("change", () => {
					taskId = taskSelect.value;
					paint();
				});
			}
			const search = root.querySelector("#q");
			if (search) {
				search.addEventListener("change", () => {
					keyword = search.value.trim();
					paint();
				});
				search.addEventListener("keydown", (event) => {
					if (event.key === "Enter") {
						keyword = search.value.trim();
						paint();
					}
				});
			}
			root.querySelectorAll("[data-row]").forEach((node) =>
				node.addEventListener("click", (event) => {
					// 点归属里的链接时不要顺手把行展开/收起。
					if (event.target.closest("a")) return;
					const id = node.dataset.row;
					if (expanded.has(id)) expanded.delete(id);
					else expanded.add(id);
					paint();
				}),
			);
			// 复制单条包的请求/响应：报告里贴证据时最常用的动作。
			root.querySelectorAll("[data-copy]").forEach((node) =>
				node.addEventListener("click", async (event) => {
					event.stopPropagation();
					const item = items.find((entry) => entry.id === node.dataset.copy);
					if (!item) return;
					const text =
						node.dataset.which === "request"
							? rawRequestOf(item)
							: rawResponseOf(item) || devicePacket(item);
					if (!text) {
						toast("这条记录没有对应的报文", "info");
						return;
					}
					await copyText(text);
				}),
			);
			const copy = root.querySelector("#copy");
			if (copy) {
				copy.addEventListener("click", async () => {
					const text = rows
						.map(
							(item) =>
								`${fmtClock(item.at)}\t${KIND_LABEL[item.kind ?? "http"]}\t${item.status}\t${item.method}\t${item.url}\t${item.ms}ms`,
						)
						.join("\n");
					try {
						await navigator.clipboard.writeText(text);
						toast("已复制请求流水", "success");
					} catch {
						toast("当前环境不支持自动复制", "error");
					}
				});
			}
		};

		const load = async () => {
			try {
				const traffic = await api.get("/api/traffic?limit=800");
				items = Array.isArray(traffic) ? traffic : [];
				paint();
			} catch (error) {
				toast(error.message, "error");
			}
		};

		const schedule = () => {
			if (timer) {
				clearInterval(timer);
				timer = null;
			}
			if (!live) return;
			timer = setInterval(() => load(), 2500);
		};

		paint();
		schedule();

		// 离开页面要停掉轮询：不然每换一次页就多一个定时器，越用越卡。
		return () => {
			if (timer) clearInterval(timer);
			timer = null;
		};
	},
};
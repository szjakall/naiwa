/**
 * 流量：任务引擎发出去的每一条 HTTP 交互都留痕。
 * 只读视图，作为证据链的底稿——报告里的"请求流水"就是从这张表取的。
 */

import { icon } from "../icons.js";
import { api, fmtClock, html, mount, raw, toast, toNode } from "../core.js";
import { card, emptyState, inlineError, loading } from "../ui.js";

export default {
	title: "流量",
	subtitle: "引擎发出的只读请求流水",

	async render(root, ctx) {
		mount(root, loading());
		let items = [];
		try {
			items = await api.get("/api/traffic?limit=400");
		} catch (error) {
			mount(root, inlineError(error.message));
			return;
		}

		const actions = toNode(html`<button class="btn ghost small" id="refresh">${raw(icon("refresh", { size: 15 }))}刷新</button>`);
		ctx.setHeader("流量", `最近 ${items.length} 条`, actions);
		actions.querySelector("#refresh").addEventListener("click", () => ctx.reload());

		if (!items.length) {
			mount(
				root,
				card({
					body: emptyState({
						iconName: "traffic",
						title: "还没有流量记录",
						description: "任务引擎每发一条请求都会在这里落一行；跳转链的每一跳也单独记一条。",
					}),
				}),
			);
			return;
		}

		const buckets = items.reduce((acc, item) => {
			const key = item.status === 0 ? "error" : `${Math.floor(item.status / 100)}xx`;
			acc[key] = (acc[key] ?? 0) + 1;
			return acc;
		}, {});

		const statusTone = (status) => {
			if (status === 0) return "chip-danger";
			if (status < 300) return "chip-ok";
			if (status < 400) return "chip-info";
			if (status < 500) return "chip-warn";
			return "chip-danger";
		};

		const body = html`<div class="table-wrap" style="max-height:70vh">
			<table>
				<thead>
					<tr>
						<th class="nowrap">时间</th>
						<th class="nowrap">状态</th>
						<th class="nowrap">方法</th>
						<th>地址</th>
						<th class="nowrap">耗时</th>
						<th class="nowrap">大小</th>
						<th class="nowrap">备注</th>
					</tr>
				</thead>
				<tbody>
					${items.map(
						(item) => html`<tr>
							<td class="nowrap mono tiny">${fmtClock(item.at)}</td>
							<td class="nowrap"><span class="chip ${statusTone(item.status)}">${item.status || "ERR"}</span></td>
							<td class="nowrap mono tiny">${item.method}</td>
							<td class="break tiny mono">${item.url}</td>
							<td class="nowrap mono tiny">${item.ms ?? 0}ms</td>
							<td class="nowrap mono tiny">${item.bytes ?? 0}</td>
							<td class="nowrap tiny muted">${item.note ?? ""}</td>
						</tr>`,
					)}
				</tbody>
			</table>
		</div>`;

		mount(
			root,
			html`
				<div class="row page-section small muted" style="gap:10px">
					${Object.entries(buckets).map(
						([key, count]) => html`<span class="chip chip-muted">${key} · ${count}</span>`,
					)}
					<div class="spacer"></div>
					<button class="btn ghost small" id="copy">复制为文本</button>
				</div>
				${card({ body, tight: true })}
			`,
		);

		root.querySelector("#copy").addEventListener("click", async () => {
			const text = items
				.map((item) => `${fmtClock(item.at)}\t${item.status}\t${item.method}\t${item.url}\t${item.ms}ms`)
				.join("\n");
			try {
				await navigator.clipboard.writeText(text);
				toast("已复制请求流水", "success");
			} catch {
				toast("当前环境不支持自动复制", "error");
			}
		});
	},
};
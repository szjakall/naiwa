/**
 * 探索图：把一次评估画成"目标 → 意图 → 事实 → 发现"的图。
 *
 * 布局用**按类型分列**而不是力导向：
 * - 力导向在几十个节点时抖动大、每次刷新位置都变，操作员记不住"刚才那个在哪"；
 * - 分列是确定性的，同一批节点永远落在同一列，看第二眼就能找到。
 * 列顺序就是探索的推进方向，左侧是"想做什么"，右侧是"看到了什么"。
 */

import { icon } from "../icons.js";
import { api, fmtTime, html, mount, openOverlay, raw, relTime, toast, toNode } from "../core.js";
import { card, emptyState, inlineError, loading } from "../ui.js";

const COLUMNS = ["goal", "intent", "fact", "finding", "asset"];

const KIND_STYLE = {
	goal: { fill: "#1b3a52", stroke: "#63b3ff", text: "#cfe6ff" },
	intent: { fill: "#3a3218", stroke: "#ffc65c", text: "#ffe6b0" },
	fact: { fill: "#1d2836", stroke: "#7e93a8", text: "#d8e3ee" },
	finding: { fill: "#3a1c24", stroke: "#ff5d78", text: "#ffc2cc" },
	asset: { fill: "#14332a", stroke: "#3fe0a6", text: "#c8ffe9" },
};

export default {
	title: "探索图",
	subtitle: "目标 → 意图 → 事实 → 发现，评估过程的图结构",

	async render(root, ctx) {
		mount(root, loading("读取图谱…"));
		let snap;
		let frontierItems = [];
		let activity = [];
		try {
			[snap, { items: frontierItems }, { items: activity }] = await Promise.all([
				api.get("/api/exploration/graph"),
				api.get("/api/exploration/frontier"),
				api.get("/api/exploration/activity?limit=60"),
			]);
		} catch (error) {
			mount(root, inlineError(error.message));
			return;
		}

		const actions = toNode(html`
			<button class="btn ghost small" id="seed">从资产/发现回填</button>
			<button class="btn primary small" id="add">${raw(icon("plus", { size: 15 }))}添加节点</button>
		`);
		ctx.setHeader("探索图", `${snap.stats.nodes} 个节点 · ${snap.stats.frontier} 条前沿`, actions);

		const reload = () => ctx.reload();
		actions.querySelector("#seed").addEventListener("click", async () => {
			try {
				const result = await api.post("/api/exploration/seed", {});
				toast(`已回填 ${result.created} 个节点`, "success");
				reload();
			} catch (error) {
				toast(error.message, "error");
			}
		});
		actions.querySelector("#add").addEventListener("click", () => openNodeForm(ctx));

		// ---------------------------------------------------- 图形

		const paintGraph = () => {
			if (snap.nodes.length === 0) {
				return emptyState({
					iconName: "grid",
					title: "图还是空的",
					description:
						"点「从资产/发现回填」把已有数据铺进来，或手动加一个「目标」开始。评估推进时每一条观察都记成节点，前沿会告诉你下一步能做什么。",
				});
			}

			// 分列布局：每列宽 200，节点高 62，列内自上而下排
			const colWidth = 220;
			const nodeHeight = 64;
			const gapY = 16;
			const byColumn = new Map();
			for (const kind of COLUMNS) byColumn.set(kind, snap.nodes.filter((n) => n.kind === kind));
			const maxRows = Math.max(1, ...[...byColumn.values()].map((list) => list.length));
			const width = COLUMNS.length * colWidth + 40;
			const height = Math.max(320, maxRows * (nodeHeight + gapY) + 80);

			const positions = new Map();
			COLUMNS.forEach((kind, columnIndex) => {
				const list = byColumn.get(kind) ?? [];
				const total = list.length;
				list.forEach((node, rowIndex) => {
					const x = 24 + columnIndex * colWidth + colWidth / 2 - 80;
					const y = 56 + rowIndex * (nodeHeight + gapY) + (maxRows - total) * 10;
					positions.set(node.id, { x, y, kind });
				});
			});

			const edges = snap.edges
				.map((edge) => {
					const from = positions.get(edge.from);
					const to = positions.get(edge.to);
					if (!from || !to) return "";
					const x1 = from.x + 160;
					const y1 = from.y + nodeHeight / 2;
					const x2 = to.x;
					const y2 = to.y + nodeHeight / 2;
					const midX = (x1 + x2) / 2;
					const color = edge.type === "exploits" ? "#ff5d78" : edge.type === "discovered_on" ? "#3fe0a6" : "#33475c";
					return `<path d="M${x1},${y1} C${midX},${y1} ${midX},${y2} ${x2},${y2}" fill="none" stroke="${color}" stroke-width="1.4" opacity="0.75" marker-end="url(#arrow)"/>`;
				})
				.join("");

			const headers = COLUMNS.map((kind, index) => {
				const meta = snap.kinds[kind];
				const x = 24 + index * colWidth + colWidth / 2 - 40;
				return `<text x="${x}" y="28" fill="#74879c" font-size="11" font-family="system-ui">${meta.label} ${(byColumn.get(kind) ?? []).length}</text>`;
			}).join("");

			const nodes = snap.nodes
				.map((node) => {
					const pos = positions.get(node.id);
					if (!pos) return "";
					const style = KIND_STYLE[node.kind] ?? KIND_STYLE.fact;
					const title = node.title.length > 22 ? `${node.title.slice(0, 22)}…` : node.title;
					const dim = node.kind === "intent" && node.state !== "open";
					return `
						<g class="graph-node" data-node="${node.id}" style="cursor:pointer;opacity:${dim ? 0.5 : 1}">
							<rect x="${pos.x}" y="${pos.y}" width="160" height="${nodeHeight}" rx="9"
								fill="${style.fill}" stroke="${style.stroke}" stroke-width="1.2"/>
							<text x="${pos.x + 12}" y="${pos.y + 24}" fill="${style.text}" font-size="12" font-weight="600" font-family="system-ui">${escapeXml(title)}</text>
							<text x="${pos.x + 12}" y="${pos.y + 42}" fill="#74879c" font-size="10" font-family="system-ui">${snap.kinds[node.kind].label}${node.seenCount > 1 ? ` · 见 ${node.seenCount} 次` : ""}</text>
							<text x="${pos.x + 12}" y="${pos.y + 56}" fill="#5c6f83" font-size="${8}">${escapeXml(node.state)}</text>
						</g>`;
				})
				.join("");

			return html`<div style="overflow:auto;max-height:64vh;border-radius:10px;background:#080d13;border:1px solid var(--line-soft)">
				<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" style="min-width:100%">
					<defs>
						<marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
							<path d="M0,0 L10,5 L0,10 z" fill="#33475c"/>
						</marker>
					</defs>
					${raw(headers)}
					${raw(edges)}
					${raw(nodes)}
				</svg>
			</div>`;
		};

		const frontierHtml = frontierItems.length
			? html`<div class="table-wrap" style="max-height:240px">
					<table>
						<tbody>
							${frontierItems.map(
								(item) => html`<tr>
									<td>
										<div class="dim small">${item.title}</div>
										<div class="tiny muted">${item.detail || "（无描述）"}</div>
									</td>
									<td class="nowrap">
										${item.executable
											? html`<span class="chip chip-ok">可执行</span>`
											: html`<span class="chip chip-warn">未挂资产</span>`}
									</td>
									<td class="nowrap">
										<button class="btn ghost small" data-claim="${item.id}">认领</button>
									</td>
								</tr>`,
							)}
						</tbody>
					</table>
				</div>`
			: emptyState({
					iconName: "check",
					title: "没有待探索的方向",
					description: "前沿为空是正常状态：说明当前没有已识别但还没验证的假设。",
				});

		const activityHtml = activity.length
			? html`<div class="console" style="height:240px">
					${activity.map(
						(event) => html`<div class="log-line">
							<span class="log-time">${fmtTime(event.at).slice(11)}</span>
							<span class="log-text">${event.text}</span>
						</div>`,
					)}
				</div>`
			: html`<div class="muted small">还没有活动记录。</div>`;

		mount(
			root,
			html`
				<div class="grid grid-4 page-section">
					${statBlock("节点", snap.stats.nodes, `${Object.entries(snap.stats.byKind).map(([k, v]) => `${snap.kinds[k].label}${v}`).join(" · ")}`)}
					${statBlock("边", snap.stats.edges, "表示“由什么推出什么”")}
					${statBlock("前沿", snap.stats.frontier, "可执行的探索方向")}
					${statBlock("重复观察", snap.stats.duplicates, "同一事实被再次看到")}
				</div>

				<div class="page-section">
					${card({
						title: "图谱",
						sub: "点节点看详情",
						actions: html`<button class="btn ghost small" id="reload-graph">刷新</button>`,
						body: paintGraph(),
					})}
				</div>

				<div class="split page-section">
					${card({ title: "前沿", sub: "下一步能做什么", body: frontierHtml, tight: true })}
					${card({ title: "活动流", sub: "最近发生了什么", body: activityHtml })}
				</div>
			`,
		);

		root.querySelector("#reload-graph").addEventListener("click", reload);
		root.querySelectorAll("[data-node]").forEach((node) =>
			node.addEventListener("click", () => openNodeDetail(node.dataset.node, ctx)),
		);
		root.querySelectorAll("[data-claim]").forEach((node) =>
			node.addEventListener("click", async () => {
				try {
					await api.patch(`/api/exploration/nodes/${node.dataset.claim}`, { state: "claimed" });
					toast("已认领该方向", "success");
					reload();
				} catch (error) {
					toast(error.message, "error");
				}
			}),
		);
	},
};

function statBlock(label, value, foot) {
	return html`<div class="stat">
		<div class="stat-label">${label}</div>
		<div class="stat-value">${value}</div>
		<div class="stat-foot">${foot}</div>
	</div>`;
}

/** SVG 里不能直接塞 HTML 转义的 &，这里只处理最小的三个字符。 */
function escapeXml(text) {
	return String(text ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function openNodeDetail(id, ctx) {
	api
		.get(`/api/exploration/nodes/${id}`)
		.then((node) => {
			const overlay = openOverlay(
				html`
					<div class="overlay-head">
						<span class="chip chip-muted">${node.kind}</span>
						<h3 style="margin:0">${node.title}</h3>
						<div class="spacer"></div>
						<button class="btn-icon" data-close>${raw(icon("x", { size: 16 }))}</button>
					</div>
					<div class="overlay-body">
						${node.detail ? html`<p class="dim small" style="white-space:pre-wrap">${node.detail}</p>` : html`<p class="muted small">（无描述）</p>`}
						<dl class="kv mt-12">
							<dt>状态</dt><dd>${node.state}</dd>
							<dt>优先级</dt><dd>${node.priority}</dd>
							<dt>来源</dt><dd>${node.origin}</dd>
							<dt>创建</dt><dd>${fmtTime(node.createdAt)}</dd>
							<dt>观察次数</dt><dd>${node.seenCount ?? 1}</dd>
						</dl>
						${node.neighbors.length
							? html`<div class="apk-section">
									<h4>相邻节点（${node.neighbors.length}）</h4>
									<div class="permission-list">
										${node.neighbors.map((n) => html`<span class="permission">${n.kind}: ${n.title}</span>`)}
									</div>
								</div>`
							: ""}
					</div>
					<div class="overlay-foot">
						<button class="btn danger small" data-del>删除节点</button>
						<div class="spacer"></div>
						<button class="btn ghost" data-close>关闭</button>
					</div>
				`,
				{ wide: true },
			);
			overlay.panel.querySelector("[data-del]").addEventListener("click", async () => {
				try {
					await api.del(`/api/exploration/nodes/${id}`);
					overlay.close();
					ctx.reload();
				} catch (error) {
					toast(error.message, "error");
				}
			});
		})
		.catch((error) => toast(error.message, "error"));
}

function openNodeForm(ctx) {
	const overlay = openOverlay(html`
		<div class="overlay-head"><h3>添加节点</h3></div>
		<div class="overlay-body">
			<label class="field">
				<span>类型</span>
				<select data-kind>
					<option value="goal">目标 — 拆出来的可探索子目标</option>
					<option value="intent">意图 — 一个待验证的方向</option>
					<option value="fact" selected>事实 — 一次观察的客观结果</option>
					<option value="finding">发现 — 可复现的漏洞</option>
					<option value="asset">资产 — 接触过的站点/接口</option>
				</select>
			</label>
			<label class="field">
				<span>标题</span>
				<input data-title placeholder="例如：登录接口未做频率限制" />
			</label>
			<label class="field">
				<span>详情</span>
				<textarea data-detail rows="4" placeholder="具体观察、证据位置、复现条件"></textarea>
			</label>
			<div class="hint-box">
				${raw(icon("alert", { size: 16 }))}
				<span>同一类型下标题重复的节点会被合并（只增加"观察次数"），不会重复占位。</span>
			</div>
		</div>
		<div class="overlay-foot">
			<button class="btn ghost" data-close>取消</button>
			<button class="btn primary" data-save>添加</button>
		</div>
	`);

	overlay.panel.querySelector("[data-title]").focus();
	overlay.panel.querySelector("[data-save]").addEventListener("click", async () => {
		const kind = overlay.panel.querySelector("[data-kind]").value;
		const title = overlay.panel.querySelector("[data-title]").value.trim();
		const detail = overlay.panel.querySelector("[data-detail]").value.trim();
		if (!title) return toast("标题不能为空", "error");
		try {
			const result = await api.post("/api/exploration/nodes", { kind, title, detail });
			overlay.close();
			toast(result.duplicate ? "已存在同名节点，观察次数 +1" : "已添加", "success");
			ctx.reload();
		} catch (error) {
			toast(error.message, "error");
		}
	});
}
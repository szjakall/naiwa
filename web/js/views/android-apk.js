/**
 * APK 静态分析面板：上传 → 服务端解 ZIP/AXML/DEX → 结论。
 * 结果分四块：基本信息、清单与组件、字符串线索、结论（会同步进漏洞库）。
 */

import { icon } from "../icons.js";
import { api, fmtBytes, fmtTime, html, mount, openOverlay, raw, severityChip, toast } from "../core.js";
import { card, emptyState, loading } from "../ui.js";

function listOrDash(items, empty = "—") {
	if (!items || items.length === 0) return html`<span class="muted">${empty}</span>`;
	return html`<div class="permission-list">${items.map((item) => html`<span class="permission">${item}</span>`)}</div>`;
}

function flagChip(label, value) {
	if (value === null || value === undefined) return html`<span class="chip chip-muted">${label} 未知</span>`;
	return html`<span class="chip ${value ? "chip-warn" : "chip-ok"}">${label} ${value ? "是" : "否"}</span>`;
}

export function renderResult(result) {
	const components = result.components ?? [];
	const exported = components.filter((component) => component.exported === true);
	return html`
		<div class="row" style="gap:8px;flex-wrap:wrap">
			<span class="chip chip-info">${result.package ?? "未识别包名"}</span>
			<span class="chip chip-muted">v${result.versionName || "?"} (${result.versionCode ?? "?"})</span>
			<span class="chip chip-muted">${fmtBytes(result.size)}</span>
			<span class="chip chip-muted">${result.dexCount} 个 dex</span>
			${(result.abis ?? []).map((abi) => html`<span class="chip chip-muted">${abi}</span>`)}
			${result.signature?.v3 || result.signature?.v2
				? html`<span class="chip chip-ok">v2/v3 签名</span>`
				: result.signature?.v1
					? html`<span class="chip chip-warn">仅 v1 签名</span>`
					: html`<span class="chip chip-danger">未识别签名</span>`}
		</div>

		<div class="apk-section">
			<h4>基本信息</h4>
			<dl class="kv">
				<dt>包名</dt><dd>${result.package ?? "—"}</dd>
				<dt>版本</dt><dd>${result.versionName || "—"}（versionCode ${result.versionCode ?? "—"}）</dd>
				<dt>SDK</dt><dd>min ${result.minSdk ?? "—"} / target ${result.targetSdk ?? "—"}</dd>
				<dt>SHA-256</dt><dd>${result.sha256}</dd>
				<dt>条目</dt><dd>${result.entries} 个，解压 ${fmtBytes(result.uncompressedSize)}</dd>
				<dt>分析时间</dt><dd>${fmtTime(result.analyzedAt)}</dd>
			</dl>
			<div class="row mt-12" style="gap:8px">
				${flagChip("debuggable", result.flags?.debuggable)}
				${flagChip("allowBackup", result.flags?.allowBackup)}
				${flagChip("明文流量", result.flags?.cleartext)}
				${flagChip("networkSecurityConfig", result.flags?.networkSecurityConfig)}
			</div>
		</div>

		<div class="apk-section">
			<h4>结论（已同步进漏洞库）</h4>
			${result.findings?.length
				? html`<div class="table-wrap" style="max-height:240px">
						<table>
							<tbody>
								${result.findings.map(
									(finding) => html`<tr>
										<td class="nowrap">${severityChip(finding.severity)}</td>
										<td>
											<div class="dim">${finding.title}</div>
											<div class="tiny muted">${finding.detail}</div>
										</td>
									</tr>`,
								)}
							</tbody>
						</table>
					</div>`
				: html`<div class="muted small">静态层面没有命中项。注意：加固/壳包会掩盖真实逻辑。</div>`}
		</div>

		<div class="apk-section">
			<h4>权限（${(result.permissions ?? []).length}）</h4>
			${listOrDash(result.permissions)}
		</div>

		<div class="apk-section">
			<h4>组件（${components.length}，其中显式导出 ${exported.length}）</h4>
			${components.length
				? html`<div class="table-wrap" style="max-height:260px">
						<table>
							<thead><tr><th class="nowrap">类型</th><th>组件</th><th class="nowrap">导出</th></tr></thead>
							<tbody>
								${components.slice(0, 120).map(
									(component) => html`<tr>
										<td class="nowrap tiny mono">${component.type}</td>
										<td class="break tiny">${component.name}</td>
										<td class="nowrap">
											${component.exported === true
												? html`<span class="chip chip-danger">是</span>`
												: component.exported === false
													? html`<span class="chip chip-muted">否</span>`
													: html`<span class="chip chip-warn">未声明</span>`}
										</td>
									</tr>`,
								)}
							</tbody>
						</table>
					</div>`
				: html`<div class="muted small">清单里没有组件信息（可能被加固壳替换）。</div>`}
		</div>

		<div class="apk-section">
			<h4>字符串线索</h4>
			${(result.strings?.urls ?? []).length
				? html`<div class="mb-12"><div class="tiny muted mb-0">URL（${result.strings.urls.length}）</div>
						${listOrDash(result.strings.urls.slice(0, 24))}</div>`
				: ""}
			${(result.strings?.ips ?? []).length
				? html`<div class="mb-12"><div class="tiny muted mb-0">IP（${result.strings.ips.length}）</div>
						${listOrDash(result.strings.ips)}</div>`
				: ""}
			${(result.strings?.secrets ?? []).length
				? html`<div class="mb-12"><div class="tiny muted mb-0">疑似密钥（${result.strings.secrets.length}）</div>
						${listOrDash(result.strings.secrets)}</div>`
				: ""}
			${(result.strings?.emails ?? []).length
				? html`<div class="mb-12"><div class="tiny muted mb-0">邮箱</div>${listOrDash(result.strings.emails)}</div>`
				: ""}
			${(result.notes ?? []).length
				? html`<div class="hint-box mt-12">
						${raw(icon("alert", { size: 16 }))}
						<span>${result.notes.join("；")}</span>
					</div>`
				: ""}
		</div>
	`;
}

export function renderApkCard(container, ctx) {
	mount(
		container,
		card({
			title: "APK 静态分析",
			sub: "不连设备也能拿到结论：清单 / 组件 / 权限 / 字符串 / 签名",
			body: html`
				<div class="drop-zone" id="apk-drop">
					${raw(icon("upload", { size: 22 }))}
					<div class="mt-8">把 APK 拖到这里，或点击选择文件</div>
					<div class="tiny muted mt-8">纯本地解析，不上传第三方；单文件上限 512MB</div>
					<input type="file" id="apk-file" accept=".apk,application/vnd.android.package-archive" class="hidden" />
				</div>
				<div id="apk-progress" class="mt-12"></div>
				<div id="apk-result"></div>
				<div class="apk-section">
					<h4>历史记录</h4>
					<div id="apk-history">${loading("读取历史…")}</div>
				</div>
			`,
		}),
	);

	const drop = container.querySelector("#apk-drop");
	const fileInput = container.querySelector("#apk-file");
	const progress = container.querySelector("#apk-progress");
	const resultNode = container.querySelector("#apk-result");

	drop.addEventListener("click", () => fileInput.click());
	for (const event of ["dragover", "dragenter"]) {
		drop.addEventListener(event, (dragoverEvent) => {
			dragoverEvent.preventDefault();
			drop.classList.add("over");
		});
	}
	for (const event of ["dragleave", "drop"]) {
		drop.addEventListener(event, (dragEvent) => {
			dragEvent.preventDefault();
			drop.classList.remove("over");
		});
	}
	drop.addEventListener("drop", (event) => {
		const file = event.dataTransfer?.files?.[0];
		if (file) upload(file);
	});
	fileInput.addEventListener("change", () => {
		const file = fileInput.files?.[0];
		if (file) upload(file);
	});

	const upload = async (file) => {
		if (!file.name.toLowerCase().endsWith(".apk")) {
			toast("只接受 .apk 文件", "error");
			return;
		}
		mount(progress, loading(`正在解析 ${file.name}（${fmtBytes(file.size)}）…`));
		try {
			const record = await api.upload(`/api/android/apk?name=${encodeURIComponent(file.name)}`, file);
			mount(resultNode, renderResult(record.result));
			mount(progress, html`<div class="hint-box">
				${raw(icon("check", { size: 16 }))}
				<span>解析完成：${record.result.findings.length} 条结论已同步到漏洞库。</span>
			</div>`);
			toast("APK 分析完成", "success");
			refreshHistory();
			fileInput.value = "";
		} catch (error) {
			mount(progress, "");
			toast(error.message, "error");
		}
	};

	const openRecord = async (id) => {
		const overlay = openOverlay(html`<div class="overlay-body">${loading("读取分析结果…")}</div>`, { wide: true });
		try {
			const record = await api.get(`/api/android/apk/${encodeURIComponent(id)}`);
			mount(
				overlay.panel,
				html`
					<div class="overlay-head">
						<h3 style="margin:0">${record.name}</h3>
						<div class="spacer"></div>
						<div class="row">
							<button class="btn ghost small" data-findings>查看漏洞库</button>
							<button class="btn-icon" data-close>${raw(icon("x", { size: 16 }))}</button>
						</div>
					</div>
					<div class="overlay-body">${renderResult(record.result)}</div>
				`,
			);
			overlay.panel.querySelector("[data-close]").addEventListener("click", () => overlay.close());
			overlay.panel.querySelector("[data-findings]").addEventListener("click", () => {
				overlay.close();
				ctx.go("#/findings");
			});
		} catch (error) {
			overlay.close();
			toast(error.message, "error");
		}
	};

	const refreshHistory = async () => {
		const target = container.querySelector("#apk-history");
		let records = [];
		try {
			records = await api.get("/api/android/apk");
		} catch (error) {
			mount(target, html`<div class="muted small">${error.message}</div>`);
			return;
		}
		if (!records.length) {
			mount(target, emptyState({ iconName: "file", title: "还没有分析记录", description: "上面传一个 APK 就会出现在这里。" }));
			return;
		}
		mount(
			target,
			html`<div class="table-wrap" style="max-height:260px">
				<table>
					<thead><tr><th>文件</th><th class="nowrap">包名</th><th class="nowrap">结论</th><th class="nowrap">时间</th><th></th></tr></thead>
					<tbody>
						${records.map(
							(record) => html`<tr>
								<td class="break tiny">${record.name}</td>
								<td class="break tiny mono">${record.package ?? "—"}</td>
								<td class="nowrap mono tiny">${record.findings}</td>
								<td class="nowrap tiny muted">${fmtTime(record.at)}</td>
								<td class="nowrap center">
									<button class="btn ghost small" data-open="${record.id}">查看</button>
									<button class="btn-icon danger" data-del="${record.id}" title="删除">
										${raw(icon("trash", { size: 16 }))}
									</button>
								</td>
							</tr>`,
						)}
					</tbody>
				</table>
			</div>`,
		);
		target.querySelectorAll("[data-open]").forEach((node) =>
			node.addEventListener("click", () => openRecord(node.dataset.open)),
		);
		target.querySelectorAll("[data-del]").forEach((node) =>
			node.addEventListener("click", async () => {
				try {
					await api.del(`/api/android/apk/${node.dataset.del}`);
					refreshHistory();
					toast("已删除记录", "success");
				} catch (error) {
					toast(error.message, "error");
				}
			}),
		);
	};

	refreshHistory();
}
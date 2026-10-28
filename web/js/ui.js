/**
 * 页面级复用组件：卡片、统计块、空态、严重性分布条。
 * 只做布局，不碰数据请求——视图负责取数，这里负责长得一致。
 */

import { icon } from "./icons.js";
import { SEVERITIES, html, raw } from "./core.js";

export function card({ title, sub, actions, body, tight = false, className = "" }) {
	return html`
		<div class="card ${className}">
			${title
				? html`<div class="card-head">
						<h3>${title}</h3>
						${sub ? html`<span class="sub">${sub}</span>` : ""}
						${actions ? html`<div class="spacer"></div><div class="row">${actions}</div>` : ""}
					</div>`
				: ""}
			<div class="card-body ${tight ? "tight" : ""}">${body}</div>
		</div>
	`;
}

export function statCard({ label, value, foot, iconName }) {
	return html`
		<div class="stat">
			<div class="row">
				<span class="stat-label">${label}</span>
				${iconName ? html`<span class="spacer muted">${raw(icon(iconName, { size: 16 }))}</span>` : ""}
			</div>
			<div class="stat-value">${value}</div>
			${foot ? html`<div class="stat-foot">${foot}</div>` : ""}
		</div>
	`;
}

export function emptyState({ iconName = "spark", title, description, action }) {
	return html`
		<div class="empty">
			${raw(icon(iconName, { size: 28 }))}
			<strong>${title}</strong>
			${description ? html`<p>${description}</p>` : ""}
			${action ?? ""}
		</div>
	`;
}

/** 严重性分布条：宽度按占比，鼠标悬停给数量。 */
export function severityBar(counts, total) {
	const sum = total ?? Object.values(counts).reduce((acc, value) => acc + value, 0);
	if (!sum) return html`<div class="sev-bar"></div>`;
	const order = ["critical", "high", "medium", "low", "info"];
	return html`
		<div class="sev-bar">
			${order
				.filter((severity) => counts[severity])
				.map(
					(severity) =>
						html`<i
							class="b-${severity}"
							style="width:${((counts[severity] / sum) * 100).toFixed(2)}%"
							title="${SEVERITIES[severity].label} ${counts[severity]}"
						></i>`,
				)}
		</div>
	`;
}

export function severityLegend(counts) {
	const order = ["critical", "high", "medium", "low", "info"];
	return html`
		<div class="row small muted" style="gap:14px">
			${order.map(
				(severity) => html`<span class="row" style="gap:6px">
					<span class="dot" style="background:var(--sev-${severity}, #4b5f75)"></span>
					${SEVERITIES[severity].label} ${counts[severity] ?? 0}
				</span>`,
			)}
		</div>
	`;
}

/** 载入中占位，避免切页时闪空。 */
export function loading(text = "正在加载…") {
	return html`<div class="empty">
		<span class="spin">${raw(icon("refresh", { size: 24 }))}</span>
		<p>${text}</p>
	</div>`;
}

export function inlineError(message) {
	return html`<div class="hint-box" style="border-color:rgba(255,93,120,.3);background:rgba(255,93,120,.07);color:#ffb3c1">
		${raw(icon("alert", { size: 16 }))}<span>${message}</span>
	</div>`;
}
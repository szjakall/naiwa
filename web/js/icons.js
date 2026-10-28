/**
 * regedit 图标集：一套自己画的线性图标，替换掉旧项目里的图标。
 *
 * 造型语言：24×24 网格、1.7 描边、圆头圆角，几何为主（注册表/密钥/设备的隐喻），
 * 不沿用狐狸或盾牌的既有符号，视觉上要和 regedit 的标记一致。
 * 全部以 fill=none + currentColor 描边实现，深浅色和状态色都可以直接换。
 */

const ATTRS = 'fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"';

const PATHS = {
	// 导航
	dashboard:
		'<rect x="3.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="3.5" width="7" height="4.6" rx="1.6"/><rect x="13.5" y="11.1" width="7" height="9.4" rx="1.6"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.6"/>',
	tasks:
		'<path d="M4 6.5h8M4 12h8M4 17.5h5"/><path d="M15.5 5.2l1.6 1.6 3-3.4"/><path d="M15.5 15.6l1.6 1.6 3-3.4"/><circle cx="18.5" cy="10.4" r="1.6"/>',
	assets:
		'<path d="M12 3.2l8.2 4.4L12 12 3.8 7.6z"/><path d="M3.8 12.4L12 16.8l8.2-4.4"/><path d="M3.8 16.9L12 21.3l8.2-4.4"/>',
	findings:
		'<path d="M12 2.8l7.2 3v6c0 4.1-3 7.4-7.2 9.4-4.2-2-7.2-5.3-7.2-9.4v-6z"/><path d="M12 8v4.6"/><circle cx="12" cy="16" r=".9" fill="currentColor" stroke="none"/>',
	reports:
		'<path d="M6.5 3.5h7.2l4.3 4.3v12.7H6.5z"/><path d="M13.5 3.6v4.4h4.4"/><path d="M9.4 12.4h6"/><path d="M9.4 16.2h6"/>',
	traffic:
		'<path d="M3 12.5h3.2L9 5.6l3.4 12.6 2.7-8.2 1.6 2.5H21"/>',
	skills:
		'<path d="M12 2.8l2.4 5.3 5.8 2.3-5.8 2.3L12 18l-2.4-5.3L3.8 10.4l5.8-2.3z"/><path d="M18.6 16.4l.9 2 2 .8-2 .8-.9 2-.9-2-2-.8 2-.8z"/>',
	android:
		'<rect x="7" y="3.6" width="10" height="16.8" rx="2.2"/><path d="M10.6 18.4h2.8"/><path d="M12 1.6v2"/><path d="M4.4 8.2c-1 1.5-1 4.6 0 6.1M19.6 8.2c1 1.5 1 4.6 0 6.1"/>',
	logs:
		'<rect x="3.4" y="4.6" width="17.2" height="14.8" rx="2"/><path d="M7.6 10l2.6 2.2-2.6 2.2"/><path d="M12.8 14.6h4"/>',
	settings:
		'<circle cx="12" cy="12" r="3.1"/><path d="M12 2.6v2.6M12 18.8v2.6M4.3 7.1l2.3 1.3M17.4 15.6l2.3 1.3M4.3 16.9l2.3-1.3M17.4 8.4l2.3-1.3"/>',
	overview: 'circle',

	// 操作
	plus: '<path d="M12 5v14M5 12h14"/>',
	refresh:
		'<path d="M20 11.2a8 8 0 10-2.3 5.6"/><path d="M20 4.4v6.8h-6.8"/>',
	play: '<path d="M8.5 5.2l10.2 6.8-10.2 6.8z"/>',
	stop: '<rect x="6.4" y="6.4" width="11.2" height="11.2" rx="1.8"/>',
	trash:
		'<path d="M4.6 6.8h14.8"/><path d="M9.4 6.8V4.4h5.2v2.4"/><path d="M6.6 6.8l.9 12.4a1.6 1.6 0 001.6 1.5h5.8a1.6 1.6 0 001.6-1.5l.9-12.4"/><path d="M10.4 10.8v5.6M13.6 10.8v5.6"/>',
	copy:
		'<rect x="8.6" y="8.6" width="11.8" height="11.8" rx="2"/><path d="M15.4 8.6V6a1.6 1.6 0 00-1.6-1.6H5.2A1.6 1.6 0 003.6 6v8.6A1.6 1.6 0 005.2 16h2.6"/>',
	download:
		'<path d="M12 3.6v11.2"/><path d="M7.6 10.6L12 15l4.4-4.4"/><path d="M4.4 17.2v1.8a1.6 1.6 0 001.6 1.6h12a1.6 1.6 0 001.6-1.6v-1.8"/>',
	upload:
		'<path d="M12 15.2V4"/><path d="M7.6 8.4L12 4l4.4 4.4"/><path d="M4.4 17.2v1.8a1.6 1.6 0 001.6 1.6h12a1.6 1.6 0 001.6-1.6v-1.8"/>',
	x: '<path d="M6 6l12 12M18 6L6 18"/>',
	search: '<circle cx="10.6" cy="10.6" r="6.4"/><path d="M15.4 15.4l4.2 4.2"/>',
	chevron: '<path d="M6.4 9.4L12 15l5.6-5.6"/>',
	code: '<path d="M8.6 8L4.4 12l4.2 4M15.4 8l4.2 4-4.2 4"/>',
	key:
		'<circle cx="8.2" cy="15.8" r="3.6"/><path d="M10.8 13.2L20 4M17 7l2.2 2.2M14.6 9.4l2.2 2.2"/>',
	phone:
		'<rect x="7" y="2.8" width="10" height="18.4" rx="2.2"/><path d="M10.6 19h2.8"/>',
	camera:
		'<path d="M3.6 8.4h3.2l1.6-2.4h7.2l1.6 2.4h3.2v10.2H3.6z"/><circle cx="12" cy="13.2" r="3.2"/>',
	folder:
		'<path d="M3.6 6.6A1.6 1.6 0 015.2 5h4l1.8 2.2h7.8a1.6 1.6 0 011.6 1.6v9.4a1.6 1.6 0 01-1.6 1.6H5.2a1.6 1.6 0 01-1.6-1.6z"/>',
	file: '<path d="M6.6 3.4h7l4.2 4.2v13H6.6z"/><path d="M13.4 3.5v4.3h4.3"/>',
	bug:
		'<circle cx="12" cy="12" r="4.4"/><path d="M12 3.6v4M12 20.4v-4M4.6 8.6l3 1.6M19.4 8.6l-3 1.6M4.6 15.4l3-1.6M19.4 15.4l-3-1.6"/>',
	wifi:
		'<path d="M3.4 9.2a13 13 0 0117.2 0"/><path d="M6.6 12.8a8.4 8.4 0 0110.8 0"/><path d="M9.8 16.4a3.8 3.8 0 014.4 0"/><circle cx="12" cy="19.6" r=".9" fill="currentColor" stroke="none"/>',
	terminal:
		'<rect x="3.2" y="4.4" width="17.6" height="15.2" rx="2"/><path d="M7.4 9.6l2.6 2.4-2.6 2.4"/><path d="M12.6 14.4h4"/>',
	shield:
		'<path d="M12 3l7 3v5.6c0 4-2.9 7.2-7 9.1-4.1-1.9-7-5.1-7-9.1V6z"/>',
	alert:
		'<path d="M12 3.8L21 19.6H3z"/><path d="M12 9.6v4.2"/><circle cx="12" cy="16.8" r=".9" fill="currentColor" stroke="none"/>',
	check: '<path d="M4.8 12.6l4.6 4.6L19.2 7.4"/>',
	clock: '<circle cx="12" cy="12" r="8.4"/><path d="M12 7.4V12l3.4 2"/>',
	user: '<circle cx="12" cy="8.2" r="3.8"/><path d="M4.8 20.4c.9-3.6 3.8-5.6 7.2-5.6s6.3 2 7.2 5.6"/>',
	logout: '<path d="M14.6 7.6V4.8H4.4v14.4h10.2v-2.8"/><path d="M10 12h9.6"/><path d="M16.4 8.4L20 12l-3.6 3.6"/>',
	link: '<path d="M10 13.8a4 4 0 005.6 0l3-3a4 4 0 10-5.6-5.6l-1.4 1.4"/><path d="M14 10.2a4 4 0 00-5.6 0l-3 3a4 4 0 105.6 5.6l1.4-1.4"/>',
	cpu: '<rect x="6.4" y="6.4" width="11.2" height="11.2" rx="2"/><path d="M10 2.8v2.4M14 2.8v2.4M10 18.8v2.4M14 18.8v2.4M2.8 10h2.4M2.8 14h2.4M18.8 10h2.4M18.8 14h2.4"/>',
	layers:
		'<path d="M12 3.6l8 4.2-8 4.2-8-4.2z"/><path d="M4 12l8 4.2 8-4.2"/>',
	spark: '<path d="M12 3.4l2 5.2 5.2 2-5.2 2-2 5.2-2-5.2-5.2-2 5.2-2z"/>',
	grid: '<rect x="3.6" y="3.6" width="7" height="7" rx="1.4"/><rect x="13.4" y="3.6" width="7" height="7" rx="1.4"/><rect x="3.6" y="13.4" width="7" height="7" rx="1.4"/><rect x="13.4" y="13.4" width="7" height="7" rx="1.4"/>',
};

export function icon(name, options = {}) {
	const body = PATHS[name];
	if (!body) return "";
	const size = options.size ?? 18;
	const extra = options.class ? ` class="${options.class}"` : "";
	return `<svg${extra} width="${size}" height="${size}" viewBox="0 0 24 24" ${ATTRS} aria-hidden="true">${body}</svg>`;
}

/** 品牌标记：圆角方块 + 钥匙孔造型的 "r"，是整个产品唯一的标识符。 */
export function brandMark(size = 28, options = {}) {
	const id = options.id ?? `rg${Math.random().toString(36).slice(2, 8)}`;
	return `<svg width="${size}" height="${size}" viewBox="0 0 40 40" aria-hidden="true" class="${options.class ?? ""}">
  <defs>
    <linearGradient id="${id}" x1="4" y1="2" x2="36" y2="38" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#4ff0b0"/>
      <stop offset="0.55" stop-color="#31c8b4"/>
      <stop offset="1" stop-color="#2f7ef0"/>
    </linearGradient>
  </defs>
  <rect x="2" y="2" width="36" height="36" rx="11" fill="url(#${id})"/>
  <path d="M13.4 28.6V15.2c0-2.3 1.9-4.2 4.2-4.2h2.9c2.9 0 5.2 2.3 5.2 5.2s-2.3 5.2-5.2 5.2h-4.4" fill="none" stroke="#061018" stroke-width="3.1" stroke-linecap="round" stroke-linejoin="round" opacity="0.92"/>
  <circle cx="21.6" cy="16.2" r="2.5" fill="#061018" opacity="0.92"/>
  <path d="M13.4 24.4h6.2" stroke="#061018" stroke-width="3.1" stroke-linecap="round" opacity="0.92"/>
</svg>`;
}

export const NAV_ICONS = {
	dashboard: "dashboard",
	tasks: "tasks",
	assets: "assets",
	findings: "findings",
	reports: "reports",
	traffic: "traffic",
	skills: "skills",
	android: "android",
	logs: "logs",
	settings: "settings",
};
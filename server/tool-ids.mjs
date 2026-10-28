/** 工具 id 清单：单独一个文件，避免 agents.mjs 与 tools.mjs 循环依赖。 */

export function catalogIds() {
	// 与 tools.mjs 的 CATALOG 保持同步；这里只列 id，想改描述去 tools.mjs
	return [
		"recon",
		"recon_live",
		"asset_scan",
		"web_search",
		"device_exec",
		"device_file",
		"device_screen",
		"device_capture",
		"device_frida",
		"apk_analyze",
		"knowledge",
		"report",
		"poc",
		"gate",
		"explore",
		"chat",
	];
}
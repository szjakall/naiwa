/**
 * 安卓设备操作的 API 封装。
 * 单独一个文件，是因为"设备工作台"和"APK 分析"两块的调用面完全不同，
 * 混在一个视图里会让两边都难读。
 */

import { api } from "./core.js";

export function deviceApi(deviceId) {
	const base = `/api/android/devices/${encodeURIComponent(deviceId)}`;
	return {
		exec: (cmd, asRoot = false, timeoutMs = 30_000) => api.post(`${base}/exec`, { cmd, asRoot, timeoutMs }),
		ls: (path, asRoot = false) => api.post(`${base}/ls`, { path, asRoot }),
		pull: (path) => api.post(`${base}/pull`, { path }),
		push: (path, base64, mode) => api.post(`${base}/push`, { path, base64, mode }),
		screencap: () => api.post(`${base}/screencap`, {}),
		logcat: (lines, filter) => api.post(`${base}/logcat`, { lines, filter }),
		packages: (thirdPartyOnly = true) => api.post(`${base}/packages`, { thirdPartyOnly }),
		capture: (action, iface, seconds) => api.post(`${base}/capture`, { action, iface, seconds }),
		tunnel: (host, port) => api.post(`${base}/tunnel`, { host, port }),
		frida: (action, payload) => api.post(`${base}/frida`, { action, ...payload }),
	};
}

/** 守门相关：人工审批模式下动作会先进队列，这里查它的结果。 */
export const gateApi = {
	getApproval: (id) => api.get(`/api/gatekeeper/approvals/${encodeURIComponent(id)}`),
	approve: (id) => api.post(`/api/gatekeeper/approvals/${encodeURIComponent(id)}/approve`, {}),
	reject: (id, reason) => api.post(`/api/gatekeeper/approvals/${encodeURIComponent(id)}/reject`, { reason }),
};

/**
 * 轮询一个待审批项直到有结果。
 * 返回 { status, result }；超时返回 { status: "timeout" }。
 */
export async function waitApproval(id, { timeoutMs = 300_000, intervalMs = 1500, onTick } = {}) {
	const started = Date.now();
	for (;;) {
		const item = await gateApi.getApproval(id);
		onTick?.(item);
		if (item.status !== "pending") return { status: item.status, item };
		if (Date.now() - started > timeoutMs) return { status: "timeout", item };
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
}

/** File → base64（不带 data: 前缀）。 */
export function fileToBase64(file) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const result = String(reader.result ?? "");
			const comma = result.indexOf(",");
			resolve(comma >= 0 ? result.slice(comma + 1) : result);
		};
		reader.onerror = () => reject(new Error("读取本地文件失败"));
		reader.readAsDataURL(file);
	});
}

export function base64ToBlob(base64, type = "application/octet-stream") {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
	return new Blob([bytes], { type });
}
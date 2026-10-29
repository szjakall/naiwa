/**
 * 运行期配置：路径、默认设置、设置文件的读写。
 *
 * 设计取舍：整个控制台零外部依赖，只需要 Node 20+。设置拆成独立文件
 * (data/settings.json)，业务状态放 data/state.json，产物放 data/artifacts/，
 * 这样改设置不会重写业务数据，业务数据膨胀也不会拖慢设置读取。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 包根目录（server/ 的上一级）。 */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 数据目录：默认 <项目>/data，可用 REGEDIT_DATA 指到别处。 */
export const DATA_DIR = process.env.REGEDIT_DATA ? resolve(process.env.REGEDIT_DATA) : join(ROOT, "data");

export const ARTIFACT_DIR = join(DATA_DIR, "artifacts");
export const WEB_DIR = join(ROOT, "web");
export const SETTINGS_FILE = join(DATA_DIR, "settings.json");
export const STATE_FILE = join(DATA_DIR, "state.json");

/** 控制台版本，界面上会显示，也是静态资源缓存的版本号。 */
export const VERSION = "1.3.0";

export function ensureDirs() {
	for (const dir of [
		DATA_DIR,
		ARTIFACT_DIR,
		join(ARTIFACT_DIR, "reports"),
		join(ARTIFACT_DIR, "apk"),
		// 从设备拉回来的大文件落在这里（小文件仍走 base64 直传）
		join(ARTIFACT_DIR, "pull"),
	]) {
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	}
}

/**
 * 默认设置。技能库默认读项目内的 skills/ 目录，
 * 这样新项目直接继承基础框架的方法论沉淀；把技能拷进 <项目>/skills 后
 * 会优先用项目内的副本，便于改写成自己的体系。
 */
export function defaultSettings() {
	return {
		site: {
			name: "regedit",
			tagline: "安全评估控制台",
			operator: "",
		},
		auth: {
			sessionHours: 12,
			// 首次启动必须由操作员设置口令，这里不预置任何默认密码。
			initialized: false,
		},
		recon: {
			timeoutMs: 8000,
			delayMs: 120,
			maxTargets: 32,
			userAgent: "regedit-scanner/1.0 (authorized-assessment)",
			// 探测清单保持保守：只读 GET，不猜口令、不爆破路径。
			paths: [
				"/robots.txt",
				"/sitemap.xml",
				"/.well-known/security.txt",
				"/.git/config",
				"/.svn/entries",
				"/.env",
				"/server-status",
				"/actuator/env",
			],
		},
		llm: {
			enabled: false,
			baseUrl: "",
			apiKey: "",
			model: "",
			temperature: 0.2,
		},
		mcp: [],
		android: {
			listenHost: "0.0.0.0",
			listenPort: 9944,
			autostart: true,
		},
		/**
		 * 对话行为。autoProject：说一句带目标的话，会话自动建项目（任务）并开跑，
		 * 和"原来那套"的开场一致；不想让它自动跑就关掉，模型仍可显式 create_recon_task。
		 */
		chat: {
			autoProject: true,
		},
		skills: {
			dirs: ["skills"],
		},
	};
}

/** 深合并：只补缺失字段，不覆盖用户已存的值。 */
function deepMerge(base, patch) {
	if (Array.isArray(base) || Array.isArray(patch)) return patch === undefined ? base : patch;
	if (typeof base !== "object" || base === null) return patch === undefined ? base : patch;
	if (typeof patch !== "object" || patch === null) return base;
	const out = { ...base };
	for (const [key, value] of Object.entries(patch)) {
		out[key] = key in base ? deepMerge(base[key], value) : value;
	}
	return out;
}

export function resolveSkillsDirs(settings) {
	const dirs = [];
	for (const entry of settings.skills?.dirs ?? []) {
		const abs = isAbsolute(entry) ? entry : join(ROOT, entry);
		if (existsSync(abs)) dirs.push(abs);
	}
	return dirs;
}

export function readSettings() {
	const base = defaultSettings();
	if (!existsSync(SETTINGS_FILE)) return base;
	try {
		const saved = JSON.parse(readFileSync(SETTINGS_FILE, "utf8"));
		return deepMerge(base, saved);
	} catch {
		// 设置文件损坏时退回默认值，不要因为一个坏 JSON 让控制台起不来。
		return base;
	}
}

export function writeSettings(settings) {
	ensureDirs();
	writeFileSync(SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}
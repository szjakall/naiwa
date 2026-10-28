/**
 * APK 静态分析（纯 Node，无外部依赖）。
 *
 * 做的事情，就是"安卓模式"里最快能给出结论的那一步——不用连设备、不用装
 * 工具，把上传的 APK 当二进制读：
 *   1. 解析 ZIP 中央目录（APK 就是 ZIP），拿到清单、dex、so、签名文件清单；
 *   2. 解析二进制 AndroidManifest.xml（AXML：字符串池 + start element 属性表），
 *      取包名、版本、权限、组件与 exported/debuggable/allowBackup/cleartext；
 *   3. 解析 classes*.dex 的字符串表，按特征挑出 URL、IP、邮箱、疑似密钥；
 *   4. 判断签名方案（v1 的 META-INF/*.SF + v2/v3 的 APK Sig Block）；
 *   5. 把结论整理成"发现"，直接汇进 regedit 的漏洞列表。
 *
 * 边界：这是静态判定，不做脱壳、不解密、不执行。被加固的包会看到壳的信息，
 * 这一点在结果里会明说。
 */

import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";

const MAX_ENTRY_BYTES = 96 * 1024 * 1024;
/**
 * 字符串表上限与扫描预算。
 *
 * 踩过的坑：字符串 id 是按 UTF-16 码元排序的，`http` 开头的常量排在很后面
 * （实测一个 59k 字符串的 dex，第一个 http 在 #42607）。按数量硬截断会把
 * 所有 URL 样本切掉，所以上限放到 20 万，并加一个 4 秒的软预算兜住极端样本。
 */
const MAX_DEX_STRINGS = 200_000;
const DEX_SCAN_BUDGET_MS = 4000;
const MAX_STRINGS_PER_DEX = 3;

// ---------------------------------------------------------------- ZIP

function findEndOfCentralDirectory(buf) {
	// EOCD 在文件尾部 22 字节起，注释最长 65535。
	const start = Math.max(0, buf.length - 22 - 0xffff);
	for (let i = buf.length - 22; i >= start; i -= 1) {
		if (buf.readUInt32LE(i) === 0x06054b50) return i;
	}
	return -1;
}

function readZipDirectory(buf) {
	const eocd = findEndOfCentralDirectory(buf);
	if (eocd < 0) throw new Error("不是合法的 ZIP/APK：找不到中央目录结尾记录");
	const total = buf.readUInt16LE(eocd + 10);
	const cdOffset = buf.readUInt32LE(eocd + 16);
	const entries = [];
	let p = cdOffset;
	for (let i = 0; i < total; i += 1) {
		if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) break;
		const method = buf.readUInt16LE(p + 10);
		const compSize = buf.readUInt32LE(p + 20);
		const size = buf.readUInt32LE(p + 24);
		const nameLen = buf.readUInt16LE(p + 28);
		const extraLen = buf.readUInt16LE(p + 30);
		const commentLen = buf.readUInt16LE(p + 32);
		const localOffset = buf.readUInt32LE(p + 42);
		const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
		// ZIP64 的 0xffffffff 占位符：本项目不处理超 4GB 的包，跳过更安全。
		if (size !== 0xffffffff && compSize !== 0xffffffff) {
			entries.push({ name, method, compSize, size, localOffset });
		}
		p += 46 + nameLen + extraLen + commentLen;
	}
	return entries;
}

function extractEntry(buf, entry, limit = MAX_ENTRY_BYTES) {
	if (entry.size > limit) throw new Error(`条目 ${entry.name} 解压后超过 ${Math.round(limit / 1048576)}MB`);
	const p = entry.localOffset;
	if (p + 30 > buf.length || buf.readUInt32LE(p) !== 0x04034b50) throw new Error(`条目 ${entry.name} 的本地头损坏`);
	const nameLen = buf.readUInt16LE(p + 26);
	const extraLen = buf.readUInt16LE(p + 28);
	const start = p + 30 + nameLen + extraLen;
	const data = buf.subarray(start, start + entry.compSize);
	if (entry.method === 0) return data;
	if (entry.method === 8) return inflateRawSync(data);
	throw new Error(`条目 ${entry.name} 使用了不支持的压缩方式 ${entry.method}`);
}

// ---------------------------------------------------------------- AXML

/** 解析 AXML 的字符串池：UTF-8 池有"字符数 + 字节数"两段长度。 */
function parseStringPool(buf, offset) {
	const headerSize = buf.readUInt16LE(offset + 2);
	const count = buf.readUInt32LE(offset + 8);
	const flags = buf.readUInt32LE(offset + 16);
	const stringsStart = buf.readUInt32LE(offset + 20);
	const utf8 = (flags & 0x100) !== 0;
	const base = offset + stringsStart;
	const strings = [];
	for (let i = 0; i < count; i += 1) {
		const entryOffset = buf.readUInt32LE(offset + headerSize + i * 4);
		let p = base + entryOffset;
		if (p >= buf.length) {
			strings.push("");
			continue;
		}
		if (utf8) {
			let len = buf[p];
			p += 1;
			if (len & 0x80) {
				len = ((len & 0x7f) << 8) | buf[p];
				p += 1;
			}
			let byteLen = buf[p];
			p += 1;
			if (byteLen & 0x80) {
				byteLen = ((byteLen & 0x7f) << 8) | buf[p];
				p += 1;
			}
			strings.push(buf.toString("utf8", p, Math.min(p + byteLen, buf.length)));
		} else {
			let len = buf.readUInt16LE(p);
			p += 2;
			if (len & 0x8000) {
				len = ((len & 0x7fff) << 16) | buf.readUInt16LE(p);
				p += 2;
			}
			strings.push(buf.toString("utf16le", p, Math.min(p + len * 2, buf.length)));
		}
	}
	return strings;
}

const RES_XML_START_ELEMENT = 0x0102;

/** 把二进制清单读成 [{name, attrs:{name: value}}]。 */
function parseBinaryXml(buf) {
	const elements = [];
	let pool = [];
	let p = 0;
	// RES_XML_TYPE(0x0003) 是**容器块**：它的 size 等于整个文件，字符串池与
	// 所有元素都是它的子块。直接按平铺块遍历会一把跳过全部内容——必须从它的
	// headerSize（通常是 8）开始遍历子块。
	if (buf.length >= 8 && buf.readUInt16LE(0) === 0x0003) {
		p = buf.readUInt16LE(2);
	}
	while (p + 8 <= buf.length) {
		const type = buf.readUInt16LE(p);
		const headerSize = buf.readUInt16LE(p + 2);
		const chunkSize = buf.readUInt32LE(p + 4);
		if (chunkSize < 8 || p + chunkSize > buf.length) break;

		if (type === 0x0001) {
			pool = parseStringPool(buf, p);
		} else if (type === RES_XML_START_ELEMENT) {
			const ext = p + headerSize;
			const nameIndex = buf.readUInt32LE(ext + 4);
			const attrStart = buf.readUInt16LE(ext + 8);
			const attrSize = buf.readUInt16LE(ext + 10) || 20;
			const attrCount = buf.readUInt16LE(ext + 12);
			const attrs = {};
			let a = ext + attrStart;
			for (let i = 0; i < attrCount; i += 1) {
				if (a + 20 > buf.length) break;
				const nameIdx = buf.readUInt32LE(a + 4);
				const rawValue = buf.readUInt32LE(a + 8);
				const dataType = buf[a + 15];
				const data = buf.readUInt32LE(a + 16);
				const name = pool[nameIdx] ?? `attr${nameIdx}`;
				let value;
				switch (dataType) {
					case 0x03:
						value = pool[data] ?? "";
						break;
					case 0x12:
					case 0x10:
						value = String(data | 0);
						break;
					case 0x11:
						value = `0x${data.toString(16)}`;
						break;
					case 0x01:
						value = pool[data] ?? `@ref/0x${data.toString(16)}`;
						break;
					case 0x04: {
						// typedValue.data 就是 IEEE754 原始位，按小端读回浮点。
						const view = new DataView(new ArrayBuffer(4));
						view.setUint32(0, data, true);
						value = String(view.getFloat32(0, true));
						break;
					}
					default:
						value = rawValue !== 0xffffffff && pool[rawValue] !== undefined ? pool[rawValue] : String(data);
				}
				attrs[name] = value;
				a += attrSize;
			}
			elements.push({ name: pool[nameIndex] ?? "", attrs });
		}
		p += chunkSize;
	}
	return elements;
}

// ---------------------------------------------------------------- DEX

function readUleb128(buf, offset) {
	let result = 0;
	let shift = 0;
	let p = offset;
	for (;;) {
		if (p >= buf.length || shift > 35) return { value: result, next: p };
		const byte = buf[p];
		p += 1;
		result |= (byte & 0x7f) << shift;
		shift += 7;
		if ((byte & 0x80) === 0) return { value: result, next: p };
	}
}

function dexStrings(buf, limit) {
	if (buf.length < 0x70 || buf.toString("latin1", 0, 4) !== "dex\n") return [];
	const stringIdsSize = buf.readUInt32LE(0x38);
	const stringIdsOff = buf.readUInt32LE(0x3c);
	if (stringIdsOff <= 0 || stringIdsOff >= buf.length) return [];
	const count = Math.min(stringIdsSize, limit);
	const deadline = Date.now() + DEX_SCAN_BUDGET_MS;
	const strings = [];
	for (let i = 0; i < count; i += 1) {
		// 极端样本（几十万字符串的巨包）不能让一次分析卡住整个请求。
		if ((i & 8191) === 0 && Date.now() > deadline) break;
		const offsetPos = stringIdsOff + i * 4;
		if (offsetPos + 4 > buf.length) break;
		const off = buf.readUInt32LE(offsetPos);
		if (off <= 0 || off >= buf.length) continue;
		const { next } = readUleb128(buf, off);
		let end = next;
		while (end < buf.length && buf[end] !== 0) end += 1;
		strings.push(buf.toString("utf8", next, end));
	}
	return strings;
}

// ---------------------------------------------------------------- 特征

const URL_RE = /https?:\/\/[a-z0-9._~:/?#[\]@!$&'()*+,;=%-]{4,200}/gi;
const IPV4_RE = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const SECRET_HINTS = [
	{ re: /AKIA[0-9A-Z]{16}/g, label: "AWS AccessKey" },
	{ re: /AIza[0-9A-Za-z_-]{35}/g, label: "Google API Key" },
	{ re: /sk-[A-Za-z0-9]{20,}/g, label: "疑似 OpenAI/Stripe Key" },
	{ re: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/g, label: "私钥块" },
	{ re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, label: "GitHub Token" },
];
const INTERESTING_WORDS = [
	"frida", "xposed", "root", "su", "magisk", "emulator", "qemu", "hook",
	"debug", "test", "staging", "pre", "uat", "inner", "admin", "token", "secret",
];

/**
 * 命名空间/规范用 URI 不是业务地址：`http://schemas.android.com/apk/res/android`
 * 这种在几乎每个包里都有，不排掉就会给每个 APK 报一条"硬编码 http 地址"。
 */
const URL_NOISE_RE = /(schemas\.android\.com|w3\.org|xmlpull\.org|java\.sun\.com|apache\.org\/xml|json-schema\.org|ns\.adobe\.com|openxmlformats\.org|xml\.org|ietf\.org)/i;

function uniq(list, limit = 200) {
	const seen = new Set();
	const out = [];
	for (const item of list) {
		if (seen.has(item)) continue;
		seen.add(item);
		out.push(item);
		if (out.length >= limit) break;
	}
	return out;
}

/**
 * 主入口：Buffer → 结构化结论。
 */
export function analyzeApk(buffer, filename = "app.apk") {
	if (!buffer || buffer.length < 22) throw new Error("文件太小，不可能是 APK");
	const entries = readZipDirectory(buffer);
	if (entries.length === 0) throw new Error("ZIP 中央目录是空的");

	const find = (name) => entries.find((entry) => entry.name === name);
	const result = {
		name: filename,
		size: buffer.length,
		sha256: createHash("sha256").update(buffer).digest("hex"),
		analyzedAt: new Date().toISOString(),
		entries: entries.length,
		uncompressedSize: entries.reduce((sum, entry) => sum + (entry.size || 0), 0),
		package: null,
		versionName: "",
		versionCode: null,
		minSdk: null,
		targetSdk: null,
		permissions: [],
		components: [],
		flags: { debuggable: false, allowBackup: null, cleartext: null, networkSecurityConfig: false },
		signature: { v1: false, v2: false, certificates: [] },
		dexCount: 0,
		abis: [],
		strings: { urls: [], ips: [], emails: [], secrets: [], interesting: [] },
		notes: [],
		findings: [],
	};

	// --- 清单 ---
	const manifestEntry = find("AndroidManifest.xml");
	if (manifestEntry) {
		try {
			const xml = extractEntry(buffer, manifestEntry, 32 * 1024 * 1024);
			const elements = parseBinaryXml(xml);
			// 一个元素都解析不出来，说明不是标准二进制 AXML（被加密、被壳替换、
			// 或者根本不是 APK）。这种情况要显式说出来，不能让结论看起来"很干净"。
			if (elements.length === 0) {
				result.notes.push("AndroidManifest.xml 里没有解析出任何元素：可能不是二进制 AXML，或被壳加密");
			}
			const manifest = elements.find((element) => element.name === "manifest");
			if (manifest) {
				result.package = manifest.attrs.package ?? null;
				result.versionName = manifest.attrs.versionName ?? "";
				result.versionCode = manifest.attrs.versionCode ? Number(manifest.attrs.versionCode) : null;
			}
			const usesSdk = elements.find((element) => element.name === "uses-sdk");
			if (usesSdk) {
				result.minSdk = usesSdk.attrs.minSdkVersion ? Number(usesSdk.attrs.minSdkVersion) : null;
				result.targetSdk = usesSdk.attrs.targetSdkVersion ? Number(usesSdk.attrs.targetSdkVersion) : null;
			}
			for (const element of elements) {
				if (element.name === "uses-permission" || element.name === "uses-permission-sdk-23") {
					const name = element.attrs.name;
					if (name) result.permissions.push(name);
				}
			}
			const application = elements.find((element) => element.name === "application");
			if (application) {
				result.flags.debuggable = application.attrs.debuggable === "true" || application.attrs.debuggable === "1";
				if (application.attrs.allowBackup !== undefined) {
					result.flags.allowBackup = application.attrs.allowBackup === "true";
				}
				if (application.attrs.usesCleartextTraffic !== undefined) {
					result.flags.cleartext = application.attrs.usesCleartextTraffic === "true";
				}
				result.flags.networkSecurityConfig = application.attrs.networkSecurityConfig !== undefined;
			}

			// 组件与导出状态：显式 exported=true 最危险；带 intent-filter 却没写
			// exported 的（目标 sdk 31 起默认 false，但旧包默认 true）单独标出来。
			let current = null;
			for (const element of elements) {
				if (["activity", "activity-alias", "service", "receiver", "provider"].includes(element.name)) {
					current = {
						type: element.name,
						name: element.attrs.name ?? "",
						exported: element.attrs.exported === undefined ? null : element.attrs.exported === "true",
						hasIntentFilter: false,
						permission: element.attrs.permission ?? null,
					};
					result.components.push(current);
				} else if (element.name === "intent-filter" && current) {
					current.hasIntentFilter = true;
				}
			}
		} catch (error) {
			result.notes.push(`清单解析失败：${error.message}`);
		}
	} else {
		result.notes.push("包里没有 AndroidManifest.xml，可能不是 APK");
	}

	// --- dex + 字符串 ---
	const dexEntries = entries.filter((entry) => /^classes\d*\.dex$/.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name));
	result.dexCount = dexEntries.length;
	const collected = [];
	for (const entry of dexEntries.slice(0, MAX_STRINGS_PER_DEX)) {
		try {
			collected.push(...dexStrings(extractEntry(buffer, entry, 96 * 1024 * 1024), MAX_DEX_STRINGS));
		} catch (error) {
			result.notes.push(`${entry.name} 解析失败：${error.message}`);
		}
	}
	const urls = [];
	const ips = [];
	const emails = [];
	const secrets = [];
	const interesting = [];
	for (const text of collected) {
		if (text.length < 4 || text.length > 400) continue;
		for (const match of text.matchAll(URL_RE)) {
			if (!URL_NOISE_RE.test(match[0])) urls.push(match[0]);
		}
		for (const match of text.matchAll(IPV4_RE)) ips.push(match[0]);
		for (const match of text.matchAll(EMAIL_RE)) emails.push(match[0]);
		for (const hint of SECRET_HINTS) {
			for (const match of text.matchAll(hint.re)) secrets.push(`${hint.label}: ${match[0].slice(0, 80)}`);
		}
		const lower = text.toLowerCase();
		if (text.length < 60 && INTERESTING_WORDS.some((word) => lower === word || lower.startsWith(`${word}.`) || lower.includes(`/${word}`))) {
			interesting.push(text);
		}
	}
	result.strings.urls = uniq(urls, 120);
	result.strings.ips = uniq(ips.filter((ip) => ip !== "0.0.0.0" && !ip.startsWith("127.")), 60);
	result.strings.emails = uniq(emails, 40);
	result.strings.secrets = uniq(secrets, 40);
	result.strings.interesting = uniq(interesting, 60);

	// --- 原生库 / ABI ---
	const abis = new Set();
	for (const entry of entries) {
		const match = /^lib\/([^/]+)\//.exec(entry.name);
		if (match) abis.add(match[1]);
	}
	result.abis = [...abis];

	// --- 签名 ---
	const sf = entries.filter((entry) => /^META-INF\/.*\.(SF|RSA|DSA|EC)$/i.test(entry.name));
	result.signature.v1 = sf.some((entry) => /\.SF$/i.test(entry.name));
	result.signature.certificates = uniq(sf.map((entry) => entry.name), 10);
	// v2/v3 签名块在中央目录之前，块尾有 16 字节魔数。
	const magic = Buffer.from("APK Sig Block 42", "latin1");
	const scanFrom = Math.max(0, buffer.length - 1024 * 1024);
	result.signature.v2 = buffer.subarray(scanFrom).includes(magic);

	// --- 结论：转成发现 ---
	addFinding(result, {
		severity: result.flags.debuggable ? "high" : null,
		title: "应用开启了 debuggable",
		detail: "android:debuggable=\"true\"：任意同用户调试工具可附加进程、读取内存与私有数据，正式包不应携带。",
	});
	addFinding(result, {
		severity: result.flags.allowBackup ? "medium" : null,
		title: "允许 adb backup 备份应用数据",
		detail: "android:allowBackup=\"true\"：具备 adb 权限的人可以完整导出应用私有目录（含 token、数据库）。",
	});
	addFinding(result, {
		severity: result.flags.cleartext ? "medium" : null,
		title: "允许明文 HTTP 流量",
		detail: "android:usesCleartextTraffic=\"true\"：敏感请求可能以明文发出，可被同网段直接读取。",
	});
	const exported = result.components.filter((component) => component.exported === true);
	if (exported.length) {
		addFinding(result, {
			severity: "medium",
			title: `${exported.length} 个组件显式导出`,
			detail: `显式 android:exported="true"：${exported.slice(0, 8).map((item) => `${item.type}:${item.name}`).join("，")}${exported.length > 8 ? " 等" : ""}。逐个确认是否有权限校验。`,
		});
	}
	const implicit = result.components.filter((component) => component.exported === null && component.hasIntentFilter);
	if (implicit.length) {
		addFinding(result, {
			severity: "low",
			title: `${implicit.length} 个组件带 intent-filter 但未声明 exported`,
			detail: "目标 SDK 31 以下默认导出：旧系统上可被外部应用直接拉起，建议显式声明 exported。",
		});
	}
	if (result.strings.secrets.length) {
		addFinding(result, {
			severity: "high",
			title: "DEX 字符串里存在疑似密钥",
			detail: result.strings.secrets.slice(0, 5).join("；"),
		});
	}
	if (urls.some((url) => url.startsWith("http://"))) {
		addFinding(result, {
			severity: "low",
			title: "硬编码了 http:// 地址",
			detail: `共 ${urls.filter((url) => url.startsWith("http://")).length} 条明文地址，例如 ${urls.find((url) => url.startsWith("http://"))}`,
		});
	}
	if (!result.signature.v2 && !result.signature.v1) {
		addFinding(result, {
			severity: "medium",
			title: "未识别到有效签名",
			detail: "既没有 META-INF 的 v1 签名，也没有 APK Signing Block：包可能被重打包或签名被剥离。",
		});
	}
	if (result.dexCount === 0) {
		result.notes.push("没有 classes.dex：可能是加固壳或非标准包结构，静态结论仅覆盖清单层。");
	}

	return result;
}

function addFinding(result, { severity, title, detail }) {
	if (!severity) return;
	result.findings.push({ severity, title, detail });
}
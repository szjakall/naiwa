/**
 * 自检：不启动服务，只验证"模块能加载 + APK 解析器能跑通"。
 *
 * 用途：交付/部署后先跑一次 `node server/selfcheck.mjs`，
 * 能在打开浏览器之前把语法错、循环依赖、ZIP 解析这类问题挡掉。
 */

import { deflateRawSync } from "node:zlib";

const MODULES = [
	"config",
	"store",
	"auth",
	"http",
	"ws",
	"droid-protocol",
	"droid",
	"apk",
	"recon",
	"reports",
	"skills",
	"gatekeeper",
	"tool-ids",
	"tools",
	"exploration",
	"knowledge",
	"agents",
	"rbac",
	"mcp",
	"pocs",
	"intel",
	"websearch",
	"proxies",
	"notify",
	"chat",
	"chat-tools",
	"org",
	"api",
];

let failures = 0;

function ok(label, detail = "") {
	console.log(`  ✓ ${label}${detail ? ` ${detail}` : ""}`);
}

function bad(label, error) {
	failures += 1;
	console.log(`  ✗ ${label} → ${error instanceof Error ? error.message : String(error)}`);
}

console.log("\nregedit 自检");
console.log("───────────────────────────────────────");

for (const name of MODULES) {
	try {
		await import(`./${name}.mjs`);
		ok(`模块 ${name}.mjs`);
	} catch (error) {
		bad(`模块 ${name}.mjs`, error);
	}
}

// ---------------------------------------------------------------- ZIP 构造
// 只做 stored/deflate 两种，够验证 readZipDirectory + extractEntry 的主路径。

function crc32(buffer) {
	let crc = 0xffffffff;
	for (const byte of buffer) {
		crc ^= byte;
		for (let i = 0; i < 8; i += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(files) {
	const locals = [];
	const centrals = [];
	let offset = 0;
	for (const file of files) {
		const raw = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, "utf8");
		const stored = file.store === true;
		const data = stored ? raw : deflateRawSync(raw);
		const name = Buffer.from(file.name, "utf8");
		const crc = crc32(raw);

		const local = Buffer.alloc(30 + name.length);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0, 6);
		local.writeUInt16LE(stored ? 0 : 8, 8);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(data.length, 18);
		local.writeUInt32LE(raw.length, 22);
		local.writeUInt16LE(name.length, 26);
		name.copy(local, 30);

		const central = Buffer.alloc(46 + name.length);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(0, 8);
		central.writeUInt16LE(stored ? 0 : 8, 10);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(data.length, 20);
		central.writeUInt32LE(raw.length, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt32LE(offset, 42);
		name.copy(central, 46);

		locals.push(local, data);
		centrals.push(central);
		offset += local.length + data.length;
	}
	const centralBuf = Buffer.concat(centrals);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(files.length, 8);
	eocd.writeUInt16LE(files.length, 10);
	eocd.writeUInt32LE(centralBuf.length, 12);
	eocd.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, centralBuf, eocd]);
}

// ---------------------------------------------------------------- APK 冒烟

try {
	const { analyzeApk } = await import("./apk.mjs");
	const zip = buildZip([
		// 故意放一段非 AXML 的清单：解析器必须降级成 note，而不是抛异常。
		{ name: "AndroidManifest.xml", data: Buffer.from("not-a-binary-xml", "utf8"), store: true },
		{ name: "classes.dex", data: Buffer.from("dex\n035\0" + " ".repeat(200), "utf8") },
		{ name: "lib/arm64-v8a/libnative.so", data: Buffer.from("ELF", "utf8") },
		{ name: "META-INF/CERT.SF", data: Buffer.from("Signature-Version: 1.0", "utf8") },
	]);
	const result = analyzeApk(zip, "selftest.apk");
	const checks = [
		[result.entries === 4, `条目数应为 4，实际 ${result.entries}`],
		[result.sha256.length === 64, "SHA-256 长度异常"],
		[result.dexCount === 1, `dex 数量应为 1，实际 ${result.dexCount}`],
		[result.abis.includes("arm64-v8a"), "ABI 识别失败"],
		[result.signature.v1 === true, "v1 签名识别失败"],
		// 清单不是合法 AXML：必须降级成 note，而不是抛异常或静默吞掉。
		[result.notes.length > 0, "清单解析失败时应留一条 note"],
		[Array.isArray(result.findings), "findings 必须是数组"],
	];
	for (const [pass, message] of checks) {
		if (!pass) throw new Error(message);
	}
	ok("apk.mjs 解析合成 APK", `(${result.findings.length} 条结论)`);
} catch (error) {
	bad("apk.mjs 解析合成 APK", error);
}

// ---------------------------------------------------------------- 守门判定解析

try {
	const { parseVerdict, normalizeConfig } = await import("./gatekeeper.mjs");
	const cases = [
		["ALLOW", "allow"],
		["allow", "allow"],
		["放行", "allow"],
		["BLOCK:删除业务数据", "block"],
		["BLOCKED", "block"],
		["拦截：停止业务服务", "block"],
	];
	for (const [text, expected] of cases) {
		const verdict = parseVerdict(text);
		if (verdict.decision !== expected) throw new Error(`「${text}」判成 ${verdict.decision}，应为 ${expected}`);
	}
	// 看不懂的回复必须抛错（上层当作失败→放行），不能静默当成 ALLOW。
	let threw = false;
	try {
		parseVerdict("我不太确定");
	} catch {
		threw = true;
	}
	if (!threw) throw new Error("无法解析的回复应当抛错");
	const config = normalizeConfig({ mode: "bogus", timeoutMs: 99, concurrency: 999 });
	if (config.mode !== "review") throw new Error("非法 mode 应回落到 review");
	if (config.timeoutMs !== 1000) throw new Error("超时未收敛到下限");
	if (config.concurrency !== 64) throw new Error("并发未收敛到上限");
	ok("gatekeeper.mjs 判定解析与配置收敛");
} catch (error) {
	bad("gatekeeper.mjs 判定解析与配置收敛", error);
}

// ---------------------------------------------------------------- 新增模块的功能断言

try {
	const kb = await import("./knowledge.mjs");
	const doc = kb.addDoc({ title: "自检文档", content: "Spring Actuator env 端点未鉴权会泄露数据源凭据。\n\n修复方式是关闭或加认证。".repeat(3) });
	if (!doc.doc) throw new Error("知识库入库失败");
	const found = kb.search("actuator 凭据");
	if (found.items.length === 0) throw new Error("知识库检索没有命中");
	kb.deleteDoc(doc.doc.id);
	ok("knowledge.mjs 入库与检索", `(${found.items.length} 条命中)`);
} catch (error) {
	bad("knowledge.mjs 入库与检索", error);
}

try {
	const pocs = await import("./pocs.mjs");
	pocs.seedExamples();
	const list = pocs.listPocs();
	if (list.length === 0) throw new Error("示例 POC 没有导入");
	const git = list.find((p) => p.id === "git-config-exposure");
	if (!git) throw new Error("示例 POC 解析失败");
	if (git.severity !== "high") throw new Error(`severity 解析错：${git.severity}`);
	pocs.clearPocs();
	ok("pocs.mjs 模板解析", `(severity=${git.severity}, tags=${git.tags.join("/")})`);
} catch (error) {
	bad("pocs.mjs 模板解析", error);
}

try {
	const exploration = await import("./exploration.mjs");
	exploration.clearGraph();
	const intent = exploration.addNode({ kind: "intent", title: "自检意图", detail: "验证图写入" });
	if (!intent.node) throw new Error("意图写入失败");
	const again = exploration.addNode({ kind: "intent", title: "自检意图" });
	if (!again.duplicate) throw new Error("重复写入没有被识别");
	const fact = exploration.addNode({ kind: "fact", title: "自检事实", edges: [{ to: intent.node.id, type: "leads_to" }] });
	const snap = exploration.snapshot();
	if (snap.nodes.length !== 2) throw new Error(`节点数不对：${snap.nodes.length}`);
	if (snap.edges.length !== 1) throw new Error(`边数不对：${snap.edges.length}`);
	exploration.deleteNode(intent.node.id);
	if (exploration.snapshot().edges.length !== 0) throw new Error("删节点后留下悬空边");
	exploration.clearGraph();
	ok("exploration.mjs 去重与级联删除", `(节点 ${snap.nodes.length} / 边 ${snap.edges.length})`);
} catch (error) {
	bad("exploration.mjs 去重与级联删除", error);
}

console.log("───────────────────────────────────────");
if (failures === 0) {
	console.log("全部通过。启动：node server/index.mjs\n");
} else {
	console.log(`${failures} 项失败，请先修复再启动。\n`);
	process.exitCode = 1;
}
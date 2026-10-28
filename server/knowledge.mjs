/**
 * 知识库：把报告、笔记、技能文档切成块，做本地检索。
 *
 * 为什么不接向量库：这一版要能在零依赖的 Node 里跑起来，而一个几百到几千块的
 * 知识库用 BM25 足够——实测关键词命中的准确率在"找某段配置怎么写"这类问题上
 * 不比 embedding 差，还省掉一个外部服务。
 *
 * 分块策略：按段落切，块长 300–800 字，重叠 80 字。重叠是为了不让"关键句被切断"
 * 变成检索丢失——这是纯文本检索最常见的漏召回来源。
 */

import { createHash } from "node:crypto";
import { store } from "./store.mjs";

const CHUNK_MIN = 300;
const CHUNK_MAX = 800;
const CHUNK_OVERLAP = 80;

export const CATEGORIES = [
	{ id: "general", label: "通用" },
	{ id: "web", label: "Web 安全" },
	{ id: "mobile", label: "移动端" },
	{ id: "network", label: "内网与网络" },
	{ id: "report", label: "报告与交付" },
	{ id: "custom", label: "自定义" },
];

function kb() {
	if (!store.state.knowledge) store.state.knowledge = { docs: [], chunks: [] };
	const k = store.state.knowledge;
	if (!Array.isArray(k.docs)) k.docs = [];
	if (!Array.isArray(k.chunks)) k.chunks = [];
	return k;
}

/** 按段落聚合成块；段落本身超长时再按句子切。 */
function chunkText(text) {
	const paragraphs = String(text)
		.replace(/\r\n/g, "\n")
		.split(/\n\s*\n/)
		.map((p) => p.trim())
		.filter(Boolean);

	const chunks = [];
	let current = "";
	for (const paragraph of paragraphs) {
		if (paragraph.length > CHUNK_MAX) {
			if (current) {
				chunks.push(current);
				current = "";
			}
			// 长段按句号/换行切，再拼到块长上限
			const sentences = paragraph.split(/(?<=[。！？.!?\n])/);
			let buffer = "";
			for (const sentence of sentences) {
				if ((buffer + sentence).length > CHUNK_MAX && buffer) {
					chunks.push(buffer);
					// 重叠：带上一块尾巴，避免关键句被切断后两边都匹配不到
					buffer = buffer.slice(-CHUNK_OVERLAP) + sentence;
				} else {
					buffer += sentence;
				}
			}
			if (buffer.trim()) chunks.push(buffer.trim());
			continue;
		}
		if ((current + "\n\n" + paragraph).length > CHUNK_MAX && current.length >= CHUNK_MIN) {
			chunks.push(current);
			current = current.slice(-CHUNK_OVERLAP) + "\n\n" + paragraph;
		} else {
			current = current ? `${current}\n\n${paragraph}` : paragraph;
		}
	}
	if (current.trim()) chunks.push(current.trim());
	return chunks.filter((c) => c.trim().length > 0);
}

/** 简易分词：英文按词、中文按二元组。够 BM25 用，也不需要词典。 */
function tokenize(text) {
	const lower = String(text).toLowerCase();
	const tokens = [];
	for (const match of lower.matchAll(/[a-z0-9_][a-z0-9_.-]{1,}/g)) tokens.push(match[0]);
	const cjk = lower.replace(/[^\u4e00-\u9fa5]/g, " ");
	for (const run of cjk.split(/\s+/)) {
		if (!run) continue;
		// 单字太碎，二元组已经能表达大部分语义
		for (let i = 0; i < run.length - 1; i += 1) tokens.push(run.slice(i, i + 2));
		if (run.length === 1) tokens.push(run);
	}
	return tokens;
}

export function listDocs() {
	return kb().docs.map((doc) => ({ ...doc, chunkCount: kb().chunks.filter((c) => c.docId === doc.id).length }));
}

export function getDoc(id) {
	const doc = kb().docs.find((d) => d.id === id);
	if (!doc) return null;
	return { ...doc, chunks: kb().chunks.filter((c) => c.docId === id).map((c) => ({ index: c.index, text: c.text })) };
}

/** 导入一份文档：切块、建索引。 */
export function addDoc({ title, content, category = "general", source = "manual" }) {
	const text = String(content ?? "");
	if (!text.trim()) throw new Error("文档内容为空");
	const k = kb();
	const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);
	// 同内容重复导入直接复用它，避免同一份报告进库两次
	const existing = k.docs.find((d) => d.hash === hash);
	if (existing) return { doc: existing, duplicate: true };

	const doc = {
		id: `kb${hash.slice(0, 8)}`,
		title: String(title || "未命名文档").slice(0, 200),
		category,
		source,
		size: Buffer.byteLength(text),
		hash,
		at: new Date().toISOString(),
	};
	const chunks = chunkText(text);
	chunks.forEach((chunk, index) => {
		k.chunks.push({
			id: `${doc.id}-${index}`,
			docId: doc.id,
			index,
			text: chunk,
			tokens: tokenize(chunk),
		});
	});
	k.docs.unshift(doc);
	store.save();
	return { doc, chunks: chunks.length, duplicate: false };
}

export function deleteDoc(id) {
	const k = kb();
	const index = k.docs.findIndex((d) => d.id === id);
	if (index < 0) return false;
	k.docs.splice(index, 1);
	k.chunks = k.chunks.filter((c) => c.docId !== id);
	store.save();
	return true;
}

export function setCategory(id, category) {
	const doc = kb().docs.find((d) => d.id === id);
	if (!doc) return null;
	doc.category = category;
	store.save();
	return doc;
}

/**
 * 检索：BM25。
 *
 * 参数用通用默认值（k1=1.5, b=0.75）。中文二元组会天然放大词频，
 * 所以 b 取 0.75 让长文档不过度占优。
 */
export function search(query, options = {}) {
	const k = kb();
	const terms = [...new Set(tokenize(query))];
	if (terms.length === 0) return { items: [], total: 0, terms: [] };

	const scoped = options.category && options.category !== "all"
		? k.chunks.filter((c) => {
				const doc = k.docs.find((d) => d.id === c.docId);
				return doc && doc.category === options.category;
			})
		: k.chunks;
	if (scoped.length === 0) return { items: [], total: 0, terms };

	const avgLength = scoped.reduce((sum, c) => sum + c.tokens.length, 0) / scoped.length || 1;
	const docFreq = new Map();
	for (const term of terms) {
		docFreq.set(term, scoped.filter((c) => c.tokens.includes(term)).length);
	}

	const k1 = 1.5;
	const b = 0.75;
	const scored = [];
	for (const chunk of scoped) {
		// 词频用 Map 统计一次，避免对每个词都跑一遍 filter
		const tf = new Map();
		for (const token of chunk.tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
		let score = 0;
		let hits = 0;
		for (const term of terms) {
			const freq = tf.get(term) ?? 0;
			if (freq === 0) continue;
			hits += 1;
			const n = docFreq.get(term) || 0;
			const idf = Math.log(1 + (scoped.length - n + 0.5) / (n + 0.5));
			score += idf * ((freq * (k1 + 1)) / (freq + k1 * (1 - b + b * (chunk.tokens.length / avgLength))));
		}
		if (score <= 0) continue;
		// 命中词种类越多越可信，压过"单个高频词刷分"
		score *= 1 + (hits - 1) * 0.35;
		scored.push({ score, chunk, hits });
	}

	scored.sort((a, b2) => b2.score - a.score);
	const limit = Math.min(Number(options.limit ?? 20) || 20, 100);
	return {
		items: scored.slice(0, limit).map(({ score, chunk, hits }) => {
			const doc = k.docs.find((d) => d.id === chunk.docId);
			return {
				id: chunk.id,
				docId: chunk.docId,
				docTitle: doc?.title ?? "（已删除）",
				category: doc?.category ?? "general",
				index: chunk.index,
				score: Math.round(score * 100) / 100,
				hits,
				text: chunk.text,
			};
		}),
		total: scored.length,
		terms,
	};
}

/** 重建索引：改了分词/分块策略后用。 */
export function reindex() {
	const k = kb();
	let rebuilt = 0;
	for (const doc of k.docs) {
		const content = k.chunks
			.filter((c) => c.docId === doc.id)
			.map((c) => c.text)
			.join("\n\n");
		k.chunks = k.chunks.filter((c) => c.docId !== doc.id);
		chunkText(content).forEach((chunk, index) => {
			k.chunks.push({
				id: `${doc.id}-${index}`,
				docId: doc.id,
				index,
				text: chunk,
				tokens: tokenize(chunk),
			});
			rebuilt += 1;
		});
	}
	store.save();
	return { ok: true, docs: k.docs.length, chunks: rebuilt };
}

export function stats() {
	const k = kb();
	const byCategory = {};
	for (const doc of k.docs) byCategory[doc.category] = (byCategory[doc.category] ?? 0) + 1;
	return {
		docs: k.docs.length,
		chunks: k.chunks.length,
		bytes: k.docs.reduce((sum, d) => sum + (d.size ?? 0), 0),
		byCategory,
		categories: CATEGORIES,
	};
}
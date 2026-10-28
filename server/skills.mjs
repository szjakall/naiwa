/**
 * 技能库：基础框架把"方法论"沉淀成一个个 SKILL.md，控制台只负责索引与展示。
 *
 * 扫描顺序由设置里的 skills.dirs 决定：项目自带的 skills/ 优先，其次才回落到
 * 同级的基础框架目录。这样"继承方法论"和"改写成自己的"两件事互不干扰。
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { ROOT, readSettings, resolveSkillsDirs } from "./config.mjs";

let cache = { at: 0, dirs: [], skills: [] };
const CACHE_MS = 15_000;

function parseFrontMatter(text) {
	if (!text.startsWith("---")) return { meta: {}, body: text };
	const end = text.indexOf("\n---", 3);
	if (end < 0) return { meta: {}, body: text };
	const head = text.slice(3, end);
	const meta = {};
	for (const line of head.split(/\r?\n/)) {
		const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
		if (match) meta[match[1]] = match[2].replace(/^["']|["']$/g, "");
	}
	return { meta, body: text.slice(end + 4).replace(/^\r?\n/, "") };
}

function scan() {
	const settings = readSettings();
	const dirs = resolveSkillsDirs(settings);
	const skills = [];
	dirs.forEach((dir, dirIndex) => {
		let names = [];
		try {
			names = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of names) {
			const file = join(dir, name, "SKILL.md");
			try {
				if (!statSync(file).isFile()) continue;
			} catch {
				continue;
			}
			let text = "";
			try {
				text = readFileSync(file, "utf8");
			} catch {
				continue;
			}
			const { meta, body } = parseFrontMatter(text);
			const id = `${dirIndex}-${name}`;
			skills.push({
				id,
				skill: name,
				title: meta.name || name,
				description: meta.description || body.split(/\r?\n/).find((line) => line.trim())?.replace(/^#+\s*/, "") || "",
				version: meta.version || "",
				// 只暴露相对项目根的路径，不把绝对路径送到浏览器。
				source: relative(ROOT, dir) || basename(dir),
				dirSource: dirIndex === 0 ? "project" : "framework",
				bytes: Buffer.byteLength(text),
			});
		}
	});
	// 同名技能：项目内的版本覆盖框架版本。
	const byName = new Map();
	for (const skill of skills) {
		const existing = byName.get(skill.skill);
		if (!existing || (existing.dirSource === "framework" && skill.dirSource === "project")) {
			byName.set(skill.skill, skill);
		}
	}
	return { dirs, skills: [...byName.values()].sort((a, b) => a.skill.localeCompare(b.skill)) };
}

export function listSkills(force = false) {
	if (!force && Date.now() - cache.at < CACHE_MS) return cache;
	cache = { at: Date.now(), ...scan() };
	return cache;
}

export function readSkill(id) {
	// 重新扫描一次再按 id 取，避免缓存和磁盘不一致。
	const { dirs, skills } = listSkills(true);
	const meta = skills.find((skill) => skill.id === id);
	if (!meta) return null;
	const dirIndex = Number(id.split("-")[0]);
	const dir = dirs[dirIndex];
	if (!dir) return null;
	const file = join(dir, meta.skill, "SKILL.md");
	const text = readFileSync(file, "utf8");
	const { body } = parseFrontMatter(text);
	return { ...meta, content: body };
}
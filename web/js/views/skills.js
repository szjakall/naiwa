/**
 * 技能：基础框架的方法论沉淀（每个 SKILL.md 一张卡）。
 * 控制台只做索引与阅读，不执行——执行发生在任务引擎与操作员手里。
 */

import { icon } from "../icons.js";
import { api, html, mount, openOverlay, raw, renderMarkdown, toast, toNode } from "../core.js";
import { card, emptyState, inlineError, loading } from "../ui.js";

export default {
	title: "技能",
	subtitle: "方法论与作业手册",

	async render(root, ctx) {
		mount(root, loading());
		let payload;
		try {
			payload = await api.get("/api/skills?force=1");
		} catch (error) {
			mount(root, inlineError(error.message));
			return;
		}

		const { skills, sources } = payload;
		const actions = toNode(html`<button class="btn ghost small" id="refresh">${raw(icon("refresh", { size: 15 }))}重新扫描</button>`);
		ctx.setHeader("技能", `共 ${skills.length} 个技能`, actions);
		actions.querySelector("#refresh").addEventListener("click", () => ctx.reload());

		let keyword = "";

		const openSkill = async (skill) => {
			const overlay = openOverlay(html`<div class="overlay-body">${loading("读取技能内容…")}</div>`, { wide: true });
			try {
				const detail = await api.get(`/api/skills/${skill.id}`);
				overlay.panel.innerHTML = "";
				const content = mount(
					overlay.panel,
					html`
						<div class="overlay-head">
							<h3 style="margin:0">${detail.title}</h3>
							<span class="chip chip-muted">${detail.source}</span>
							<div class="spacer"></div>
							<button class="btn-icon" data-close>${raw(icon("x", { size: 16 }))}</button>
						</div>
						<div class="overlay-body">
							<p class="muted small mb-12">${detail.description}</p>
							<div class="md">${raw(renderMarkdown(detail.content))}</div>
						</div>
					`,
				);
				content.querySelectorAll("[data-close]").forEach((node) =>
					node.addEventListener("click", () => overlay.close()),
				);
			} catch (error) {
				overlay.close();
				toast(error.message, "error");
			}
		};

		const paint = () => {
			const visible = skills.filter((skill) => {
				if (!keyword) return true;
				return `${skill.skill} ${skill.title} ${skill.description}`.toLowerCase().includes(keyword.toLowerCase());
			});
			const grid = visible.length
				? html`<div class="grid grid-3">
						${visible.map(
							(skill) => html`<div class="card" data-skill="${skill.id}" style="cursor:pointer">
								<div class="card-body">
									<div class="row" style="gap:8px">
										<span class="nav-icon">${raw(icon("skills", { size: 18 }))}</span>
										<div style="min-width:0">
											<div class="dim" style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
												${skill.skill}
											</div>
											<div class="tiny muted">${skill.version ? `v${skill.version}` : "未标注版本"}</div>
										</div>
									</div>
									<p class="small muted" style="margin:10px 0 0;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden">
										${skill.description}
									</p>
									<div class="row tiny muted mt-12" style="gap:8px">
										<span class="chip chip-muted">${skill.dirSource === "project" ? "项目内" : "框架继承"}</span>
										<span>${Math.max(1, Math.round(skill.bytes / 1024))} KB</span>
									</div>
								</div>
							</div>`,
						)}
					</div>`
				: emptyState({
						iconName: "skills",
						title: keyword ? "没有匹配的技能" : "技能目录是空的",
						description:
							"把 SKILL.md 放到 <项目>/skills/<名字>/ 下即可被索引，也可以在设置里追加其它目录。",
					});

			mount(
				root,
				html`
					<div class="page-section row">
						<input id="search" placeholder="搜索技能" style="max-width:280px" value="${keyword}" />
						<div class="spacer"></div>
						<span class="tiny muted">来源：${sources.join("　") || "—"}</span>
					</div>
					${card({ body: grid })}
				`,
			);
			const search = root.querySelector("#search");
			search.addEventListener("input", () => {
				keyword = search.value.trim();
				const position = search.selectionStart;
				paint();
				const next = root.querySelector("#search");
				next.focus();
				next.setSelectionRange(position, position);
			});
			root.querySelectorAll("[data-skill]").forEach((node) =>
				node.addEventListener("click", () => {
					const skill = skills.find((entry) => entry.id === node.dataset.skill);
					if (skill) openSkill(skill);
				}),
			);
		};
		paint();
	},
};
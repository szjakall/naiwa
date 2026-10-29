/**
 * 公司（客户）维度与报告配置。
 *
 * 资产/发现/报告都挂在"公司"下：一个控制台同时服务多个客户时，
 * 这是唯一不会把数据串到一起的隔离维度。这里保留同样的模型，但**不强加**——
 * 不建公司时所有数据归"未归属"，行为与之前一致。
 */

import { randomUUID } from "node:crypto";
import { store } from "./store.mjs";

// ---------------------------------------------------------------- 公司

function companies() {
	if (!Array.isArray(store.state.companies)) store.state.companies = [];
	return store.state.companies;
}

function countsOf(companyId) {
	return {
		assets: store.state.assets.filter((a) => a.companyId === companyId).length,
		findings: store.state.findings.filter((f) => f.companyId === companyId).length,
		reports: store.state.reports.filter((r) => r.companyId === companyId).length,
		tasks: store.state.tasks.filter((t) => t.companyId === companyId).length,
		traffic: (store.state.traffic ?? []).filter((t) => t.companyId === companyId).length,
	};
}

/**
 * 公司详情：不只是几个计数，而是把这家公司名下的项目、资产、发现、报告都摊开。
 * 界面靠它做"公司 → 项目 → 资产 → 发现"的下钻；只给 counts 的话，
 * 操作员看到"资产 12"却点不进去，等于没关联。
 */
export function companyDetail(id) {
	const company = companies().find((entry) => entry.id === id);
	if (!company) return null;
	const assets = store.state.assets
		.filter((asset) => asset.companyId === id)
		.sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : -1))
		.map((asset) => ({
			id: asset.id,
			type: asset.type,
			value: asset.value,
			title: asset.title,
			status: asset.status,
			ip: asset.ip,
			taskId: asset.taskId,
			lastSeen: asset.lastSeen,
		}));
	const tasks = store.state.tasks
		.filter((task) => task.companyId === id)
		.map((task) => ({
			id: task.id,
			title: task.title,
			status: task.status,
			scope: task.scope ?? [],
			createdAt: task.createdAt,
			findings: store.state.findings.filter((f) => f.taskId === task.id).length,
			assets: store.state.assets.filter((a) => a.taskId === task.id || a.lastTaskId === task.id).length,
		}));
	const findings = store.state.findings
		.filter((finding) => finding.companyId === id)
		.map((finding) => ({
			id: finding.id,
			title: finding.title,
			severity: finding.severity,
			status: finding.status,
			target: finding.target,
			taskId: finding.taskId,
		}));
	const reports = store.state.reports
		.filter((report) => report.companyId === id)
		.map((report) => ({ id: report.id, title: report.title, at: report.at, findings: report.findings }));
	return {
		company: { ...company, counts: countsOf(id) },
		counts: countsOf(id),
		assets,
		tasks,
		findings,
		reports,
	};
}

export function listCompanies() {
	return companies()
		.map((company) => ({ ...company, counts: countsOf(company.id) }))
		.sort((a, b) => (a.at < b.at ? 1 : -1));
}

export function upsertCompany(input) {
	const list = companies();
	const id = String(input.id ?? "").trim() || `co${randomUUID().slice(0, 8)}`;
	const existing = list.find((c) => c.id === id);
	const company = {
		id,
		name: String(input.name ?? "").trim() || "未命名公司",
		contact: String(input.contact ?? "").trim().slice(0, 120),
		note: String(input.note ?? "").slice(0, 500),
		at: existing?.at ?? new Date().toISOString(),
	};
	if (existing) Object.assign(existing, company);
	else list.push(company);
	store.save();
	return { ok: true, company: { ...company, counts: countsOf(id) } };
}

export function deleteCompany(id) {
	const list = companies();
	const index = list.findIndex((c) => c.id === id);
	if (index < 0) return { ok: false, error: "公司不存在" };
	const counts = countsOf(id);
	const total = counts.assets + counts.findings + counts.reports + counts.tasks;
	if (total > 0) {
		return { ok: false, error: `还有 ${total} 条数据归属这家公司，先改归属或删除数据` };
	}
	list.splice(index, 1);
	store.save();
	return { ok: true };
}

/**
 * 批量改归属：把某公司名下的一类数据整体转到另一家。
 * 这里按"类型 + 目标公司"处理，避免一次误操作把资产和报告混着转。
 */
export function reattribute({ fromCompanyId, toCompanyId, kinds = [] }) {
	const collections = { assets: "assets", findings: "findings", reports: "reports", tasks: "tasks" };
	let moved = 0;
	for (const kind of kinds) {
		const key = collections[kind];
		if (!key) continue;
		for (const item of store.state[key] ?? []) {
			if (item.companyId === fromCompanyId) {
				item.companyId = toCompanyId || null;
				moved += 1;
			}
		}
	}
	store.save();
	return { ok: true, moved };
}

/** 把一条数据挂到公司上（资产/发现/报告/任务通用）。 */
export function assignCompany(kindToCollection, id, companyId) {
	const collection = { asset: "assets", finding: "findings", report: "reports", task: "tasks" }[kindToCollection];
	if (!collection) return { ok: false, error: "未知数据类型" };
	const item = (store.state[collection] ?? []).find((entry) => entry.id === id);
	if (!item) return { ok: false, error: "数据不存在" };
	if (companyId && !companies().some((c) => c.id === companyId)) return { ok: false, error: "公司不存在" };
	item.companyId = companyId || null;
	store.save();
	return { ok: true };
}

// ---------------------------------------------------------------- 报告配置

const DEFAULT_REPORT_SETTINGS = {
	issuer: "",            // 报告出具方
	language: "zh-CN",     // zh-CN | en-US
	level: "standard",     // standard | deep
	showTraffic: true,     // 是否附请求流水
	showEvidence: true,    // 是否附证据原文
	logoDataUrl: "",       // 报告 Logo（base64 data url，随报告渲染）
};

function reportSettings() {
	if (!store.state.reportSettings) store.state.reportSettings = { ...DEFAULT_REPORT_SETTINGS };
	// 补齐新增字段（老状态文档读出来缺键）
	for (const [key, value] of Object.entries(DEFAULT_REPORT_SETTINGS)) {
		if (store.state.reportSettings[key] === undefined) store.state.reportSettings[key] = value;
	}
	return store.state.reportSettings;
}

export function getReportSettings() {
	return { ...reportSettings() };
}

export function saveReportSettings(patch) {
	const current = reportSettings();
	for (const key of Object.keys(DEFAULT_REPORT_SETTINGS)) {
		if (patch[key] === undefined) continue;
		if (key === "logoDataUrl") {
			// 只接受图片 data url，且限制体积（塞进状态文档会变慢）
			const value = String(patch[key] ?? "");
			if (value && !/^data:image\/(png|jpeg|svg\+xml|webp);base64,/.test(value)) {
				throw new Error("Logo 必须是图片 data url");
			}
			if (value.length > 300_000) throw new Error("Logo 太大（上限约 220KB）");
			current[key] = value;
			continue;
		}
		if (typeof DEFAULT_REPORT_SETTINGS[key] === "boolean") current[key] = patch[key] === true;
		else current[key] = String(patch[key]).slice(0, 200);
	}
	store.save();
	return { ok: true, settings: getReportSettings() };
}

/** 报告模板：标题/章节顺序/口径说明，报告生成时套用。 */
const DEFAULT_TEMPLATES = [
	{
		id: "tpl-standard",
		name: "标准渗透测试报告",
		desc: "范围 → 概览 → 资产 → 发现 → 流水，适合单次评估交付",
		sections: ["scope", "overview", "assets", "findings", "traffic"],
		system: true,
	},
	{
		id: "tpl-brief",
		name: "简版结论报告",
		desc: "只留概览与发现，给管理层看",
		sections: ["overview", "findings"],
		system: true,
	},
	{
		id: "tpl-remediation",
		name: "整改复测报告",
		desc: "突出修复建议与复测结论",
		sections: ["scope", "findings", "traffic"],
		system: true,
	},
];

export const SECTION_LABELS = {
	scope: "评估范围",
	overview: "结果概览",
	assets: "资产清单",
	findings: "发现详情",
	traffic: "请求流水",
	appendix: "附录",
};

function templates() {
	if (!Array.isArray(store.state.reportTemplates) || store.state.reportTemplates.length === 0) {
		store.state.reportTemplates = DEFAULT_TEMPLATES.map((t) => ({ ...t, sections: [...t.sections] }));
	}
	return store.state.reportTemplates;
}

export function listTemplates() {
	return templates();
}

export function upsertTemplate(input) {
	const list = templates();
	const id = String(input.id ?? "").trim() || `tpl-${randomUUID().slice(0, 6)}`;
	const existing = list.find((t) => t.id === id);
	if (existing?.system && input.name && input.name !== existing.name) {
		throw new Error("内置模板不能改名");
	}
	const template = {
		id,
		name: String(input.name ?? existing?.name ?? "未命名模板").slice(0, 60),
		desc: String(input.desc ?? existing?.desc ?? "").slice(0, 200),
		sections: Array.isArray(input.sections)
			? input.sections.filter((s) => SECTION_LABELS[s])
			: existing?.sections ?? ["scope", "overview", "assets", "findings"],
		system: existing?.system === true,
	};
	if (existing) Object.assign(existing, template);
	else list.push(template);
	store.save();
	return { ok: true, template };
}

export function deleteTemplate(id) {
	const list = templates();
	const index = list.findIndex((t) => t.id === id);
	if (index < 0) return { ok: false, error: "模板不存在" };
	if (list[index].system) return { ok: false, error: "内置模板不能删除" };
	list.splice(index, 1);
	store.save();
	return { ok: true };
}

export function stats() {
	return {
		companies: companies().length,
		templates: templates().length,
	};
}
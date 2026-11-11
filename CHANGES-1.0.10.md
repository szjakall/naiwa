# Starry 1.0.8 → 1.0.10 变更摘要（相对 1.0.7 源码基线）

## 1.0.8 任务删除级联与数据一致性
- DELETE /api/tasks/{id} 级联清理：reports 行+文件、finding_enrichment、
  finding_evidence、finding_traffic、data/i<intentID>/ 工作目录、
  data/report_assets/evidence/<nodeID>/、data/transcripts/exp<expID>-*.jsonl；
  同时删除任务产出的 findings，并从全局资产的 task_ids 中解除本任务关联
  （资产本体跨任务共享，保留）。
- report_finding 入参解析加固：模型在 summary 字段内夹带伪工具标记时，
  拆分还原 evidence/vulnclass/severity（agent/sanitize.go，含单测）。
- llm_profiles.context_window 配置错误导致的 context-limit 超限修复。
- server_logs 分级：LLM 熔断/故障转移记 warn 而非 error。
- assets 数组字面量转义、UpdateScope 事务化、company_scope 先删后插原子化。

## 1.0.9 安全加固（防线矛盾修复）
- 平台管理工具（create/update custom tool 与 MCP）不再默认绑定任何对话 agent
  ——stdio MCP 等价于宿主机命令执行，统一收归 HTTP admin 通道；存量库自动迁移。
- RBAC 映射补齐：/api/devices、/api/android、/api/attachments、/api/gc；
  新增 device:read/write 权限；/traffic 写操作收归 config:write。
- requireAuth 与会话审批闸 fail-closed：DB 故障不再静默放行。
- guard sideEffectTools 补齐四个 host-exec 等价工具（review 模式排队审批）。
- 工具执行 goroutine panic 兜底（转 error result，进程不再被打死）。
- ExecuteExtraTool 内层工具接入与 execOne 相同的权限管线与 hooks
  （deny 规则、内层工具自身权限语义、按名匹配的 hook 不再对 deferred 调用失明）。
- clientIP 仅信任来自回环/私网的 X-Forwarded-For；全局请求体 64MB 上限。
- stdio MCP 单调用 120s 超时；隧道接收缓冲溢出关断；流式结果 256MB 上限；
  traffic 录制目录 ".." 逃逸修复；task Manager sessionID 白名单消毒；
  memory 单条 4KB/注入总预算 8KB；server_logs 分级修正。

## 1.0.10 prompt_too_long 解砖 + 删除全清
- 摘要器兜底：PTL 渐进截断耗尽后按 96K 字符硬预算从尾部保留完整轮次做最后
  一次摘要——网关侧 token 估算口径不可知时，压缩也必然成功，会话不再卡死。
- 任务删除即全清：findings 一并删除、assets.task_ids 解绑、转录文件删除。
- compaction 空摘要防线；IsOverflow 识别 "context limit" 措辞。

## 升级说明
- 从 1.0.7 库升级：无需手工迁移，服务启动时自动执行（幂等 settings 标记）。
- llm_profiles.context_window_k 建议按网关真实限制配置（默认模板见 config.example）。

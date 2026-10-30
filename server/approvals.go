package server

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"time"

	"starry/db"
	"starry/engine/llm"
	"starry/guard"
)

// 会话级审批闸门（approval_mode = review / ai）。
//
// 为什么用阻塞式队列而不是"先拒后补"：一次工具调用被拒，模型只会换个写法再试，
// 既浪费往返也容易把"被拒"当成"目标不可达"。这里让调用原地等待操作员决定
// （10 分钟上限），通过就继续执行，拒绝就把理由交给模型改道。
//
// 落库复用 intercept_pending（rule_id 为 NULL 表示"不是规则触发，而是会话策略"），
// 于是仪表盘的待审批列表、拦截页、审计流水都能直接看到这些记录；
// 放行/拒绝走既有的 POST /api/intercept/pending/{id}/decide，前端无需新页面。

const (
	approvalWait    = 10 * time.Minute
	approvalModeTTL = 3 * time.Second // 会话模式短缓存：每次工具调用查一次主键太浪费
	approvalPreview = 160
)

type approvalModeEntry struct {
	mode     string
	agentKey string
	at       time.Time
}

// Ask 实现 guard.Gate：按会话的审批模式决定"直接放行 / 排队等人工 / AI 判定"。
func (s *Server) Ask(ctx context.Context, convID int64, toolName string, input []byte) (bool, string) {
	pg := s.m.pg
	if pg == nil || convID == 0 {
		return true, ""
	}
	mode, agentKey := s.conversationApprovalMode(pg, convID)
	if mode == "auto" {
		return true, ""
	}
	if ctx.Err() != nil {
		return false, "运行已取消，动作未执行"
	}

	// ai 模式：先落一条审计记录，再让守门模型裁决；模型不可用时降级人工，
	// 并在理由里写明降级原因，不假装"AI 已经判过"。
	if mode == "ai" {
		id, err := pg.CreateToolApproval(convID, agentKey, toolName, input)
		if err != nil {
			return false, "审批登记失败：" + err.Error()
		}
		allowed, reason := s.aiJudge(ctx, toolName, input)
		status := "denied"
		if allowed {
			status = "allowed"
		}
		_ = pg.DecideInterceptPending(id, status)
		_, _ = pg.AppendConvActivity(convID, db.Activity{
			Kind:    "text",
			Summary: "🤖 AI 判定 #" + strconv.FormatInt(id, 10) + " · " + approvalSummary(toolName, input) + " → " + map[bool]string{true: "放行", false: "拒绝"}[allowed],
		})
		if allowed {
			return true, ""
		}
		if reason == "" {
			reason = "AI 判定拒绝"
		}
		return false, "AI 判定拒绝：" + reason
	}

	hint := "人工审批"
	id, err := pg.CreateToolApproval(convID, agentKey, toolName, input)
	if err != nil {
		return false, "审批登记失败：" + err.Error()
	}
	// 让对话里立刻出现"在等审批"，而不是界面静止
	_, _ = pg.AppendConvActivity(convID, db.Activity{
		Kind:    "text",
		Summary: "⏸ 等待审批 #" + strconv.FormatInt(id, 10) + " · " + approvalSummary(toolName, input),
	})

	ch := s.addApprovalWaiter(id)
	var allowed bool
	select {
	case allowed = <-ch:
	case <-time.After(approvalWait):
		_ = pg.DecideInterceptPending(id, "timeout")
		s.dropApprovalWaiter(id)
		return false, "审批超时（10 分钟未处理），动作未执行"
	case <-ctx.Done():
		_ = pg.DecideInterceptPending(id, "timeout")
		s.dropApprovalWaiter(id)
		return false, "运行已取消，审批作废，动作未执行"
	}
	s.dropApprovalWaiter(id)
	if allowed {
		return true, ""
	}
	return false, "审批被拒绝（" + hint + "），动作未执行"
}

// aiJudge 让守门模型判断一次工具调用是否放行。
// 只做一次短请求（≤200 tokens、关闭思考），失败即拒绝（fail-closed）——
// 守门环节不能在模型不可用时"默许"。
func (s *Server) aiJudge(ctx context.Context, toolName string, input []byte) (bool, string) {
	prov, err := s.llmCfg.NewProvider()
	if err != nil {
		return false, "守门模型不可用：" + err.Error()
	}
	judgeCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	req := llm.CompletionRequest{
		System: []string{
			"你是渗透测试控制台的守门员。判断这次工具调用是否可以在已授权目标上执行。",
			"规则：破坏性操作（删除、格式化、关机）、数据外泄、越权访问、影响业务可用性 → 拒绝；" +
				"只读侦察、常规验证、授权的设备操作 → 允许。",
			"只输出一行 JSON：{\"allow\":true|false,\"reason\":\"不超过 40 字的中文理由\"}，不要任何其它文字。",
		},
		Messages:  []llm.Message{llm.UserText("工具调用：" + approvalSummary(toolName, input))},
		MaxTokens: 200,
		Thinking:  "disabled",
	}
	msg, _, _, err := prov.Complete(judgeCtx, req)
	if err != nil {
		return false, "守门模型调用失败：" + err.Error()
	}
	text := flattenMessage(msg)
	allow, reason := parseJudge(text)
	return allow, reason
}

func flattenMessage(msg llm.Message) string {
	var b strings.Builder
	for _, block := range msg.Content {
		if block.Type == llm.BlockText {
			b.WriteString(block.Text)
		}
	}
	return b.String()
}

// parseJudge 从模型输出里取 JSON；模型偶尔会包裹代码块或加解释，这里做宽松提取。
func parseJudge(text string) (bool, string) {
	start := strings.Index(text, "{")
	end := strings.LastIndex(text, "}")
	if start < 0 || end <= start {
		return false, "守门模型没有返回可解析的判定"
	}
	var verdict struct {
		Allow  bool   `json:"allow"`
		Reason string `json:"reason"`
	}
	if err := json.Unmarshal([]byte(text[start:end+1]), &verdict); err != nil {
		return false, "守门模型判定格式错误：" + err.Error()
	}
	return verdict.Allow, verdict.Reason
}

func (s *Server) conversationApprovalMode(pg *db.DB, convID int64) (string, string) {
	s.approvalMu.Lock()
	if entry, ok := s.approvalModes[convID]; ok && time.Since(entry.at) < approvalModeTTL {
		s.approvalMu.Unlock()
		return entry.mode, entry.agentKey
	}
	s.approvalMu.Unlock()

	mode, agentKey, err := pg.GetConversationGateInfo(convID)
	if err != nil || mode == "" {
		mode = "auto"
	}
	s.approvalMu.Lock()
	if s.approvalModes == nil {
		s.approvalModes = map[int64]approvalModeEntry{}
	}
	s.approvalModes[convID] = approvalModeEntry{mode: mode, agentKey: agentKey, at: time.Now()}
	s.approvalMu.Unlock()
	return mode, agentKey
}

func (s *Server) addApprovalWaiter(id int64) chan bool {
	ch := make(chan bool, 1)
	s.approvalMu.Lock()
	if s.approvalWait == nil {
		s.approvalWait = map[int64]chan bool{}
	}
	s.approvalWait[id] = ch
	s.approvalMu.Unlock()
	return ch
}

func (s *Server) dropApprovalWaiter(id int64) {
	s.approvalMu.Lock()
	delete(s.approvalWait, id)
	s.approvalMu.Unlock()
}

// notifyApprovalWaiter 在既有拦截审批被处理时唤醒对应的闸门等待者。
// interceptDecide 已把状态写库；这里只负责把"决定"送进等待中的工具调用。
func (s *Server) notifyApprovalWaiter(id int64, allow bool) {
	s.approvalMu.Lock()
	ch, ok := s.approvalWait[id]
	delete(s.approvalWait, id)
	s.approvalMu.Unlock()
	if ok {
		ch <- allow
	}
}

// approvalSummary 把工具入参压成一行给人看的摘要。
func approvalSummary(toolName string, input []byte) string {
	var raw map[string]any
	_ = json.Unmarshal(input, &raw)
	candidate := ""
	for _, key := range []string{"command", "text", "path", "file_path", "url", "target"} {
		if v, ok := raw[key].(string); ok && strings.TrimSpace(v) != "" {
			candidate = v
			break
		}
	}
	candidate = strings.Join(strings.Fields(candidate), " ")
	if candidate == "" {
		candidate = strings.TrimSpace(string(input))
	}
	if len(candidate) > approvalPreview {
		candidate = candidate[:approvalPreview] + "…"
	}
	return toolName + " " + candidate
}

var _ guard.Gate = (*Server)(nil)
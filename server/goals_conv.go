package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"starry/db"
)

// 目标推进（自主续跑）：给一条会话一句目标，按轮次自动继续，直到出现可判定的停止条件。
//
// 停止条件只有三个，全部可观测：
//   1. 某一轮没有任何工具调用 —— agent 已经给出结论（没有动作可做）；
//   2. 用完轮次预算；
//   3. 运行出错 / 被手动停止。
// 「说过完成」不算完成：模型很容易在正文里宣布成功，但真正能复核的是它做了什么。

// roundBanner 生成轮次横幅：limit=0 表示不限。
func roundBanner(round, limit int) string {
	if limit <= 0 {
		return fmt.Sprintf("▶ 目标推进 · 第 %d 轮（不限轮次）", round)
	}
	return fmt.Sprintf("▶ 目标推进 · 第 %d/%d 轮", round, limit)
}

type convGoalState struct {
	Status     string `json:"status"` // idle | running | paused | done
	Round      int    `json:"round"`
	RoundLimit int    `json:"round_limit"`
	LastNote   string `json:"last_note"`
	UpdatedAt  string `json:"updated_at"`
}

func (s *Server) saveGoalState(convID int64, state convGoalState) {
	pg := s.m.pg
	if pg == nil {
		return
	}
	state.UpdatedAt = time.Now().Format(time.RFC3339)
	raw, err := json.Marshal(state)
	if err != nil {
		return
	}
	_ = pg.SetConversationGoalState(convID, raw)
}

// conversationSetGoal 保存会话目标（POST /api/conversations/{id}/goal）。
func (s *Server) conversationSetGoal(w http.ResponseWriter, r *http.Request) {
	pg, c, ok := s.convByID(w, r)
	if !ok {
		return
	}
	var req struct {
		Goal       string `json:"goal"`
		RoundLimit int    `json:"round_limit"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "请求格式错误")
		return
	}
	goal := strings.TrimSpace(req.Goal)
	if err := pg.SetConversationGoal(c.ID, goal); err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	limit := req.RoundLimit
	if limit < 0 {
		limit = 0
	}
	if limit > 20 {
		limit = 20
	}
	s.saveGoalState(c.ID, convGoalState{Status: "idle", Round: 0, RoundLimit: limit})
	writeJSON(w, 200, map[string]any{"ok": true, "goal": goal, "round_limit": limit})
}

// conversationGoalRun 启动目标推进（POST /api/conversations/{id}/goal/run）。
// 立刻返回，轮次在后台跑，进度写进会话活动流（前端轮询）。
func (s *Server) conversationGoalRun(w http.ResponseWriter, r *http.Request) {
	pg, c, ok := s.convByID(w, r)
	if !ok {
		return
	}
	goal, stateRaw, err := pg.GetConversationGoal(c.ID)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	if strings.TrimSpace(goal) == "" {
		writeErr(w, 400, "这条会话还没有目标：先设置 goal")
		return
	}
	var state convGoalState
	_ = json.Unmarshal(stateRaw, &state)
	var req struct {
		RoundLimit int  `json:"round_limit"`
		Unlimited  bool `json:"unlimited"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	limit := req.RoundLimit
	if limit <= 0 && !req.Unlimited {
		limit = state.RoundLimit
	}
	if req.Unlimited {
		limit = 0
	}
	if limit > 20 {
		limit = 20
	}

	busyKey := s.convBusyKey(c.ID)
	s.chatMu.Lock()
	if s.chatBusy[busyKey] {
		s.chatMu.Unlock()
		writeErr(w, 409, "这条会话正在运行，先等它结束")
		return
	}
	s.chatBusy[busyKey] = true
	s.chatMu.Unlock()

	writeJSON(w, 200, map[string]any{"ok": true, "round_limit": limit, "status": "running"})
	go s.runConversationGoal(c, goal, limit, busyKey)
}

// runConversationGoal 是真正的轮次循环（阻塞到结束）。竞态：chatBusy 已由调用方置位，
// runConversationSync 结束时会把 busy 清掉，所以每轮开始前要重新置位。
func (s *Server) runConversationGoal(c *db.Conversation, goal string, limit int, busyKey string) {
	pg := s.m.pg
	if pg == nil {
		return
	}
	defer func() {
		s.chatMu.Lock()
		delete(s.chatBusy, busyKey)
		s.chatMu.Unlock()
	}()

	// limit <= 0 表示不限轮次：没有轮数上限，也不会因为"某轮没有工具调用"就停。
	// 退出只靠：① 手动停止 ② 达到轮次预算 ③ 运行出错。
	for round := 1; limit <= 0 || round <= limit; round++ {
		s.saveGoalState(c.ID, convGoalState{Status: "running", Round: round, RoundLimit: limit})
		_, _ = pg.AppendConvActivity(c.ID, db.Activity{
			Kind: "text", Summary: roundBanner(round, limit),
		})

		before, _ := pg.MaxConvActivitySeq(c.ID)
		s.chatMu.Lock()
		s.chatBusy[busyKey] = true
		s.chatMu.Unlock()

		s.runConversationSync(c, goalRoundMessage(goal, round, limit), busyKey)

		// 手动停止（/stop）后不再继续下一轮：runConversationSync 结束时会清掉
		// chatCancel，所以这里只能看 /stop 打下的标记。
		s.chatMu.Lock()
		stopped := s.chatStop[busyKey]
		s.chatMu.Unlock()
		if stopped {
			s.saveGoalState(c.ID, convGoalState{
				Status: "paused", Round: round, RoundLimit: limit, LastNote: "已手动停止",
			})
			_, _ = pg.AppendConvActivity(c.ID, db.Activity{
				Kind: "text", Summary: "⏸ 目标暂停：手动停止",
			})
			return
		}

		_, _, err := pg.ConvActivityList(c.ID, before, 0)
		if err != nil {
			s.saveGoalState(c.ID, convGoalState{Status: "paused", Round: round, RoundLimit: limit, LastNote: "读取本轮活动失败：" + err.Error()})
			return
		}
		if limit > 0 && round == limit {
			note := fmt.Sprintf("达到轮次上限 %d", limit)
			s.saveGoalState(c.ID, convGoalState{
				Status: "paused", Round: round, RoundLimit: limit, LastNote: note,
			})
			_, _ = pg.AppendConvActivity(c.ID, db.Activity{
				Kind: "text", Summary: "⏸ 目标暂停：" + note,
			})
			return
		}
	}
}

// goalRoundMessage 给每一轮不同的指令：第 1 轮带目标，之后强调"继续、不要复述"。
func goalRoundMessage(goal string, round, limit int) string {
	if round <= 1 {
		return fmt.Sprintf("【目标】%s\n\n请开始推进这个目标：先确认现状，再执行必要的动作，最后给出结论。", goal)
	}
	return fmt.Sprintf(
		"【继续推进 · 第 %d/%d 轮】目标：%s\n\n不要复述上一轮已经说过的内容，直接做还没做的事；"+
			"如果已经达成目标，明确写出结论与依据；如果无法推进，说明具体缺什么。",
		round, limit, goal,
	)
}
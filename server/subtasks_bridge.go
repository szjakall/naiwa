// Package server: 子任务桥的 Server 实现。
//
// 工具（actool.SubtaskBridge）拿不到会话对象，只能拿 ctx；会话 id 由
// intercept.WithConvID 放在 ctx 里（runConversationSync 已经这么做）。这里按 convID
// 查/建管理器，并在主会话结束时 Shutdown。
package server

import (
	"context"
	"fmt"
	"time"

	"starry/db"
	actool "starry/engine/tool"
	"starry/intercept"
)

// subtaskManagerFor 取（或创建）某会话的子任务管理器。
func (s *Server) subtaskManagerFor(convID int64) (*subtaskManager, error) {
	s.subtaskMu.Lock()
	defer s.subtaskMu.Unlock()
	if m, ok := s.subtasks[convID]; ok {
		return m, nil
	}
	if s.m == nil || s.m.pg == nil {
		return nil, fmt.Errorf("服务未就绪")
	}
	c, err := s.m.pg.GetConversation(convID)
	if err != nil || c == nil {
		return nil, fmt.Errorf("会话不存在")
	}
	m := newSubtaskManager(s, c, s.convBusyKey(convID))
	if s.subtasks == nil {
		s.subtasks = map[int64]*subtaskManager{}
	}
	s.subtasks[convID] = m
	return m, nil
}

// shutdownSubtasks 在主会话结束时清理（取消全部子任务并移除管理器）。
func (s *Server) shutdownSubtasks(convID int64) {
	s.subtaskMu.Lock()
	m := s.subtasks[convID]
	delete(s.subtasks, convID)
	s.subtaskMu.Unlock()
	if m != nil {
		m.Shutdown()
	}
}

// Spawn 实现 actool.SubtaskBridge。
func (s *Server) SubtaskSpawn(ctx context.Context, title, prompt string) (string, error) {
	convID := intercept.ConvIDFromContext(ctx)
	if convID == 0 {
		return "", fmt.Errorf("当前不在会话上下文中，无法派发子任务")
	}
	m, err := s.subtaskManagerFor(convID)
	if err != nil {
		return "", err
	}
	return m.Spawn(ctx, title, prompt)
}

// Join 实现 actool.SubtaskBridge。
func (s *Server) SubtaskJoin(ctx context.Context, ids []string, timeout time.Duration) ([]actool.SubtaskResult, error) {
	convID := intercept.ConvIDFromContext(ctx)
	m, err := s.subtaskManagerFor(convID)
	if err != nil {
		return nil, err
	}
	return m.Join(ctx, ids, timeout)
}

// List 实现 actool.SubtaskBridge。
func (s *Server) SubtaskList(ctx context.Context) ([]actool.SubtaskInfo, error) {
	convID := intercept.ConvIDFromContext(ctx)
	m, err := s.subtaskManagerFor(convID)
	if err != nil {
		return nil, err
	}
	return m.List(ctx)
}

var _ actool.SubtaskBridge = (*Server)(nil)
var _ = db.Activity{}
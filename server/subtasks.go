// Package server: 子任务并行（多 worker 同时推进不同子目标）。
//
// 实现方式：主会话通过 subtask_spawn 把互不依赖的子目标交给独立 worker；
// 每个 worker 是一次 ChatAgent 运行，使用**独立 transcript 会话**（上下文隔离），
// 但活动仍然写回同一条对话，前端能看到各 worker 的进度。
//
// 约束：
//   - 全局并发上限（默认 4），避免把 provider 打爆；
//   - 与主会话共享审批门（guard）：子任务里的副作用动作同样要过审批；
//   - 主会话被停止时，子任务一并取消。
package server

import (
	"context"
	"fmt"
	"log"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"starry/db"
	actool "starry/engine/tool"
)

const (
	maxConcurrentSubtasks = 4
	subtaskOutputLimit    = 8000 // 回传给主会话的输出上限，避免把主上下文撑爆
)

type subtaskEntry struct {
	id      string
	title   string
	status  string // running | done | error | canceled
	output  string
	err     string
	started time.Time
	ended   time.Time
	done    chan struct{}
	cancel  context.CancelFunc
}

type subtaskManager struct {
	srv   *Server
	conv  *db.Conversation
	busy  string // 主会话的 busyKey，用于活动归属
	mu    sync.Mutex
	items map[string]*subtaskEntry
	seq   atomic.Int64
	sem   chan struct{}
	ctx   context.Context
	stop  context.CancelFunc
}

func newSubtaskManager(s *Server, c *db.Conversation, busyKey string) *subtaskManager {
	// 主会话被取消时，子任务也要跟着停：挂在同一个取消链上。
	ctx, stop := context.WithCancel(s.ctx)
	return &subtaskManager{
		srv: s, conv: c, busy: busyKey,
		items: map[string]*subtaskEntry{},
		sem:   make(chan struct{}, maxConcurrentSubtasks),
		ctx:   ctx, stop: stop,
	}
}

// Spawn 启动一个子任务（异步），立即返回 id。
func (m *subtaskManager) Spawn(ctx context.Context, title, prompt string) (string, error) {
	id := fmt.Sprintf("sub-%d", m.seq.Add(1))
	if strings.TrimSpace(title) == "" {
		title = firstLine(prompt, 60)
	}
	entry := &subtaskEntry{id: id, title: title, status: "running", started: time.Now(), done: make(chan struct{})}
	m.mu.Lock()
	m.items[id] = entry
	m.mu.Unlock()

	go m.run(entry, prompt)
	return id, nil
}

func (m *subtaskManager) run(entry *subtaskEntry, prompt string) {
	select {
	case m.sem <- struct{}{}:
	case <-m.ctx.Done():
		m.finish(entry, "canceled", "", "主会话已停止")
		return
	}
	defer func() { <-m.sem }()

	ca := m.srv.chatAgentRef()
	if ca == nil {
		m.finish(entry, "error", "", "agent 未就绪")
		return
	}
	ctx, cancel := context.WithCancel(m.ctx)
	m.mu.Lock()
	entry.cancel = cancel
	m.mu.Unlock()
	defer cancel()

	sessionID := fmt.Sprintf("%s-%s", m.busy, entry.id)
	emit := func(rec db.Activity) {
		// 子任务的活动也写回同一条对话；worker 一律标成子任务 id，
		// 否则前端会把几个 worker 的步混成主会话（都是 mainagent）。
		rec.Worker = entry.id
		if _, err := m.srv.m.pg.AppendConvActivity(m.conv.ID, rec); err != nil {
			log.Printf("[%s] append sub activity failed: %v", entry.id, err)
		}
	}

	started := time.Now()
	// 子任务同样不设墙钟预算（与主会话一致）：靠 ctx 取消或自然结束。
	out, err := ca.Chat(ctx, m.conv.AgentKey, sessionID, prompt, m.srv.agentMaxTurns(m.conv.AgentKey),
		0, false, emit)
	elapsed := int(time.Since(started).Seconds())

	if err != nil {
		m.finish(entry, "error", out, err.Error())
		return
	}
	m.finish(entry, "done", out, "")
	_ = elapsed
}

func (m *subtaskManager) finish(entry *subtaskEntry, status, output, errMsg string) {
	if len(output) > subtaskOutputLimit {
		output = output[:subtaskOutputLimit] + "\n…（已截断）"
	}
	m.mu.Lock()
	entry.status = status
	entry.output = output
	entry.err = errMsg
	entry.ended = time.Now()
	m.mu.Unlock()
	close(entry.done)
}

// Join 等待子任务完成；ids 为空表示等全部。
func (m *subtaskManager) Join(ctx context.Context, ids []string, timeout time.Duration) ([]actool.SubtaskResult, error) {
	m.mu.Lock()
	targets := make([]*subtaskEntry, 0, len(m.items))
	if len(ids) == 0 {
		for _, e := range m.items {
			targets = append(targets, e)
		}
	} else {
		for _, id := range ids {
			if e, ok := m.items[id]; ok {
				targets = append(targets, e)
			}
		}
	}
	m.mu.Unlock()
	if len(targets) == 0 {
		return nil, fmt.Errorf("没有找到子任务：%s", strings.Join(ids, ","))
	}

	deadline := time.After(timeout)
	out := make([]actool.SubtaskResult, 0, len(targets))
	for _, e := range targets {
		select {
		case <-e.done:
		case <-deadline:
			out = append(out, actool.SubtaskResult{ID: e.id, Title: e.title, Status: "running"})
			continue
		case <-ctx.Done():
			return out, ctx.Err()
		}
		m.mu.Lock()
		res := actool.SubtaskResult{
			ID: e.id, Title: e.title, Status: e.status, Output: e.output, Error: e.err,
			Seconds: int(e.ended.Sub(e.started).Seconds()),
		}
		m.mu.Unlock()
		out = append(out, res)
	}
	return out, nil
}

// List 返回状态快照。
func (m *subtaskManager) List(ctx context.Context) ([]actool.SubtaskInfo, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]actool.SubtaskInfo, 0, len(m.items))
	for _, e := range m.items {
		out = append(out, actool.SubtaskInfo{
			ID: e.id, Title: e.title, Status: e.status,
			Started: e.started.Format("15:04:05"),
		})
	}
	return out, nil
}

// Shutdown 取消所有子任务（主会话结束时调用）。
func (m *subtaskManager) Shutdown() {
	m.stop()
	m.mu.Lock()
	for _, e := range m.items {
		if e.cancel != nil {
			e.cancel()
		}
	}
	m.mu.Unlock()
}
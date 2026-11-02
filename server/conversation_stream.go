package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"

	"starry/db"
)

// 对话活动流：SSE 推送。
//
// 现状是前端每 1s 轮询一次 /messages?since=，于是"模型已经吐出一个工具调用"和
// "界面上看见"之间最多差 1 秒，且长会话每次都要重渲染一批。这里改成服务端推送：
// 活动产生即发，前端增量追加；轮询保留作为兜底（EventSource 不可用时）。

type activityBroker struct {
	mu   sync.Mutex
	subs map[int64]map[chan db.Activity]struct{}
}

func newActivityBroker() *activityBroker {
	return &activityBroker{subs: map[int64]map[chan db.Activity]struct{}{}}
}

func (b *activityBroker) subscribe(convID int64) chan db.Activity {
	ch := make(chan db.Activity, 64)
	b.mu.Lock()
	if b.subs[convID] == nil {
		b.subs[convID] = map[chan db.Activity]struct{}{}
	}
	b.subs[convID][ch] = struct{}{}
	b.mu.Unlock()
	return ch
}

func (b *activityBroker) unsubscribe(convID int64, ch chan db.Activity) {
	b.mu.Lock()
	if set, ok := b.subs[convID]; ok {
		delete(set, ch)
		if len(set) == 0 {
			delete(b.subs, convID)
		}
	}
	b.mu.Unlock()
	close(ch)
}

// publish 非阻塞投递：订阅者慢就丢给轮询兜底，绝不拖住模型流。
func (b *activityBroker) publish(convID int64, a db.Activity) {
	if b == nil {
		return
	}
	b.mu.Lock()
	set := b.subs[convID]
	targets := make([]chan db.Activity, 0, len(set))
	for ch := range set {
		targets = append(targets, ch)
	}
	b.mu.Unlock()
	for _, ch := range targets {
		select {
		case ch <- a:
		default:
		}
	}
}

// GET /api/conversations/{id}/stream
//
// 事件：`activity`（一条活动 JSON）+ 15 秒 `ping` 注释保活。
func (s *Server) conversationStream(w http.ResponseWriter, r *http.Request) {
	_, c, ok := s.convByID(w, r)
	if !ok {
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeErr(w, 500, "当前连接不支持流式推送")
		return
	}
	w.Header().Set("content-type", "text/event-stream; charset=utf-8")
	w.Header().Set("cache-control", "no-cache")
	w.Header().Set("x-accel-buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	ch := s.activities.subscribe(c.ID)
	defer s.activities.unsubscribe(c.ID, ch)

	// 先补一条 cursorso 前端知道从哪续（避免刚连上就漏掉正在进行的步）。
	fmt.Fprintf(w, "event: ready\ndata: {\"conversation\":%d}\n\n", c.ID)
	flusher.Flush()

	ping := time.NewTicker(15 * time.Second)
	defer ping.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case a, open := <-ch:
			if !open {
				return
			}
			// 用与 REST 列表相同的 DTO：前端只认识 seq/ts 这套字段名。
			payload, err := json.Marshal(activityDTO(a))
			if err != nil {
				continue
			}
			fmt.Fprintf(w, "event: activity\ndata: %s\n\n", payload)
			flusher.Flush()
		case <-ping.C:
			fmt.Fprint(w, ": ping\n\n")
			flusher.Flush()
		}
	}
}
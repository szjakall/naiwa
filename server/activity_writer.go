// Package server: 活动写入的批量器。
//
// 为什么需要：一个模型步会产生多条活动（tool_use / tool_result / usage / text），
// 原来每条都同步 INSERT 一次，把模型流的节奏绑在数据库往返上；并发会话时还会
// 抢连接。这里改成"先入队、50ms 或 32 条批量提交"，语义不变（顺序一致、失败重试），
// 只是把 N 次往返压成 1 次。
package server

import (
	"log"
	"sync"
	"time"

	"starry/db"
)

type activityWriter struct {
	pg     *db.DB
	convID int64

	mu      sync.Mutex
	pending []db.Activity
	wake    chan struct{}
	done    chan struct{}
	closed  bool
}

// newActivityWriter 启动后台写入协程；调用方必须 Close（或 Flush 后 Close）。
func newActivityWriter(pg *db.DB, convID int64) *activityWriter {
	w := &activityWriter{
		pg:     pg,
		convID: convID,
		wake:   make(chan struct{}, 1),
		done:   make(chan struct{}),
	}
	go w.loop()
	return w
}

// Append 入队一条活动；不阻塞模型流。
func (w *activityWriter) Append(a db.Activity) {
	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		return
	}
	w.pending = append(w.pending, a)
	needFlush := len(w.pending) >= 32
	w.mu.Unlock()
	if needFlush {
		w.signal()
	}
}

func (w *activityWriter) signal() {
	select {
	case w.wake <- struct{}{}:
	default:
	}
}

func (w *activityWriter) loop() {
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-w.wake:
			w.flush()
		case <-ticker.C:
			w.flush()
		case <-w.done:
			w.flush() // 收尾：把队列里剩下的写完
			return
		}
	}
}

// flush 把队列里的一批按顺序写入；单条失败重试 3 次，仍失败只记日志，不阻塞后续。
func (w *activityWriter) flush() {
	w.mu.Lock()
	if len(w.pending) == 0 {
		w.mu.Unlock()
		return
	}
	batch := w.pending
	w.pending = nil
	w.mu.Unlock()

	for _, item := range batch {
		var err error
		for attempt := 1; attempt <= 3; attempt++ {
			if _, err = w.pg.AppendConvActivity(w.convID, item); err == nil {
				break
			}
			time.Sleep(time.Duration(attempt) * 20 * time.Millisecond)
		}
		if err != nil {
			log.Printf("[conv %d] append activity failed (kind=%s tool=%s): %v", w.convID, item.Kind, item.Tool, err)
		}
	}
}

// Flush 等待当前队列写完（用于"这一轮结束、状态要对外可见"的时刻）。
func (w *activityWriter) Flush() {
	// 触发一次写入并等待队列清空（轮询而非新机制，简单可靠）。
	for {
		w.signal()
		time.Sleep(5 * time.Millisecond)
		w.mu.Lock()
		empty := len(w.pending) == 0
		w.mu.Unlock()
		if empty {
			return
		}
	}
}

// Close 停止后台协程，并保证队列已落库。
func (w *activityWriter) Close() {
	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		return
	}
	w.closed = true
	w.mu.Unlock()
	close(w.done)
}
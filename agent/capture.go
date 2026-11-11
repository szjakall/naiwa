package agent

import (
	"context"
	"errors"
	"strings"

	"starry/db"
	"starry/engine/agentcore"
	"starry/engine/harness"
	"starry/engine/llm"
)

// captureRun drives one agent turn-to-completion over Session.Prompt and emits a
// coalesced ActivityRecord per execution step (tool_use / tool_result / text /
// thinking / result). It is shared by every LLM agent in the system (worker,
// planner, …) so their execution is visible instead of a black box — the old
// agentcore.Run discarded every event. The emitted records carry only
// Kind/Tool/ToolUseID/IsError/Summary/Detail; the caller's emit fills in
// IntentID/Worker. Returns the final assistant text + terminal error.
//
// KindText/KindThinking arrive as streaming deltas (one event per fragment); a
// contiguous run is coalesced into a single record so the trace shows whole
// messages, not dozens of fragments.
func captureRun(ctx context.Context, opts agentcore.Options, input string, emit func(db.Activity)) (string, harness.TerminalReason, error) {
	s := agentcore.NewSession(opts)
	defer s.Close() // release the session's background-task manager (temp dir + processes)
	return captureRunSession(ctx, s, input, emit)
}

// captureRunSession is captureRun over an existing session, so a caller can run
// multiple prompts on the SAME conversation (e.g. a settlement round that reuses
// the worker's accumulated context after the main run hit max_turns).
func captureRunSession(ctx context.Context, s *agentcore.Session, input string, emit func(db.Activity)) (string, harness.TerminalReason, error) {
	var reason harness.TerminalReason
	rec := func(r db.Activity) {
		if emit != nil {
			emit(r)
		}
	}
	toolNames := map[string]string{} // tool_use id -> name, to label results

	var tbuf strings.Builder
	var tkind string
	flush := func() {
		if tbuf.Len() == 0 {
			return
		}
		s := strings.TrimSpace(tbuf.String())
		k := tkind
		tbuf.Reset()
		tkind = ""
		if s != "" {
			rec(db.Activity{Kind: k, Summary: firstLine(s, 200), Detail: s})
		}
	}
	addDelta := func(kind, text string) {
		if text == "" {
			return
		}
		if tkind != "" && tkind != kind {
			flush()
		}
		tkind = kind
		tbuf.WriteString(text)
	}

	var finalText string
	var rerr error
	for ev, err := range s.Prompt(ctx, input) {
		if err != nil {
			flush()
			if ctx.Err() != nil { // ctx cancelled = manual stop, not a failure
				rec(db.Activity{Kind: "result", Summary: "（已手动停止本次运行）"})
				return finalText, reason, ctx.Err()
			}
			rec(db.Activity{Kind: "result", IsError: true, Summary: "执行出错: " + err.Error(), Detail: err.Error()})
			return finalText, reason, err
		}
		switch ev.Kind {
		case harness.KindToolUse:
			if ev.ToolUse == nil {
				continue
			}
			flush()
			toolNames[ev.ToolUse.ID] = ev.ToolUse.Name
			in := string(ev.ToolUse.Input)
			rec(db.Activity{Kind: "tool_use", Tool: ev.ToolUse.Name, ToolUseID: ev.ToolUse.ID,
				Summary: ev.ToolUse.Name + " " + firstLine(in, 200), Detail: in})
		case harness.KindToolResult:
			if ev.ToolResult == nil {
				continue
			}
			flush()
			out := blocksText(ev.ToolResult.Content)
			rec(db.Activity{Kind: "tool_result", Tool: toolNames[ev.ToolResult.ToolUseID], ToolUseID: ev.ToolResult.ToolUseID,
				IsError: ev.ToolResult.IsError, Summary: firstLine(out, 200), Detail: out})
		case harness.KindText:
			addDelta("text", ev.Text)
		case harness.KindThinking:
			addDelta("thinking", ev.Text)
		case harness.KindUsage:
			// live cumulative token usage (per model turn). Emitted as a non-rendered
			// "usage" activity carrying only the token fields; the UI uses the latest
			// one for a running session's live token count. Don't flush() here — the
			// buffered final-answer text must stay for the KindResult de-dup.
			if ev.Usage != nil {
				u := *ev.Usage
				rec(db.Activity{Kind: "usage",
					InputTokens: &u.InputTokens, OutputTokens: &u.OutputTokens,
					CacheReadTokens: &u.CacheReadTokens, CacheWriteTokens: &u.CacheWriteTokens})
			}
		case harness.KindResult:
			cause := context.Cause(ctx)
			if ev.Terminal != nil {
				finalText = ev.Terminal.Text
				reason = ev.Terminal.Reason
				// the buffered tail text usually equals Terminal.Text (final answer);
				// drop it to avoid a duplicate record, the result row carries it.
				if tkind == "text" && strings.TrimSpace(tbuf.String()) == strings.TrimSpace(ev.Terminal.Text) {
					tbuf.Reset()
					tkind = ""
				}
				flush() // flush any trailing thinking / non-final text
				sum := ev.Terminal.Text
				if sum == "" {
					switch ev.Terminal.Reason {
					case harness.ReasonAbortedTools, harness.ReasonAbortedStreaming:
						// ctx 被取消。具体是谁取消的靠 context.Cause 判断——
						// 以前一律说"暂停 / 终止 / 重启所致"，用户没法分辨。
						sum = "（本步被中断：未完成）"
						switch {
						case errors.Is(cause, harness.ErrCancelPaused):
							sum = "（已暂停：本步中断，恢复后会重跑）"
						case errors.Is(cause, harness.ErrCancelDone):
							sum = "（任务判定完成，本步中止）"
						case errors.Is(cause, harness.ErrCancelSettled):
							sum = "（任务超时收尾，本步中断）"
						case errors.Is(cause, harness.ErrCancelStopped):
							sum = "（已手动停止：本步中断）"
						case errors.Is(cause, harness.ErrCancelKilled):
							sum = "（已按规划终止本步）"
						case errors.Is(cause, harness.ErrCancelShutdown):
							sum = "（服务退出中断，重启后自动续跑）"
						case errors.Is(cause, context.Canceled):
							sum = "（服务重启中断，重启后自动续跑）"
						}
					case harness.ReasonTimeout, harness.ReasonMaxTurns:
						// 只在显式配置了预算时才会走到这里（对话已默认不限），
						// 文案保持中性、不再出现"预算上限"字样。
						sum = "（本轮结束，已写回事实）"
					case harness.ReasonModelError:
						// 模型调用失败（provider 5xx / 超时 / 限流）。这是可操作的信息：
						// 重试、换 LLM 配置或降并发，而不是让用户对着一句"终态"发呆。
						sum = "（模型调用失败：本步未完成，可重试或切换 LLM 配置）"
					case harness.ReasonCompleted:
						// 模型正常结束但没写文字（常见于只调工具就收尾）：这不算异常，
						// 用中性文案，别再显示"终态: completed"这种内部枚举。
						sum = "（本轮结束，未输出文字总结）"
					default:
						sum = "（无总结，终态: " + string(ev.Terminal.Reason) + "）"
					}
				}
				u := ev.Terminal.Usage // cumulative token usage for this session
				rec(db.Activity{Kind: "result", IsError: ev.Terminal.Err != nil,
					Summary: firstLine(sum, 400), Detail: sum,
					InputTokens: &u.InputTokens, OutputTokens: &u.OutputTokens,
					CacheReadTokens: &u.CacheReadTokens, CacheWriteTokens: &u.CacheWriteTokens})
				if ev.Terminal.Err != nil {
					rerr = ev.Terminal.Err
				}
			}
		}
	}
	flush() // safety: any unflushed text if the stream ended without KindResult
	return finalText, reason, rerr
}

// blocksText concatenates the text of a tool-result's content blocks.
func blocksText(blocks []llm.ContentBlock) string {
	var b strings.Builder
	for _, bl := range blocks {
		if bl.Type == llm.BlockText && bl.Text != "" {
			if b.Len() > 0 {
				b.WriteByte('\n')
			}
			b.WriteString(bl.Text)
		}
	}
	return b.String()
}

// firstLine returns a single-line, length-capped preview for the summary column.
func firstLine(s string, max int) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	if len(s) > max {
		s = s[:max] + "…"
	}
	return s
}

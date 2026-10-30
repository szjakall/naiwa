// Package guard implements the safety boundary layer (docs §11): side-effect
// gating of destructive/exfil shell commands, an audit log, and Observer/G5
// failure attribution. Every tool call passes through the PreToolUse hook before
// executing. (The RoE authorization-scope mechanism was removed; a replacement
// may be added later.)
package guard

import (
	"context"
	"encoding/json"
	"regexp"
	"strings"
	"sync"
	"time"

	"starry/engine/hook"
	"starry/intercept"
)

// AuditEntry records one gated tool call.
type AuditEntry struct {
	TS      int64  `json:"ts"`
	Tool    string `json:"tool"`
	Action  string `json:"action"` // allow|block
	Reason  string `json:"reason,omitempty"`
	Command string `json:"command,omitempty"`
}

// Guard enforces the side-effect policy via agent-core hooks.
type Guard struct {
	mu          sync.Mutex
	audit       []AuditEntry
	attrib      map[string]int // failure attribution counts (Observer / G5)
	reg         *hook.Registry
	interceptor *intercept.Interceptor // optional; nil disables user-configured rules
	gate        Gate                   // optional; per-conversation approval policy
}

// Gate is the per-conversation approval policy hook. The server implements it:
// auto answers immediately, review queues the call for a human, ai asks the
// gatekeeper model. Returning false blocks the tool call with reason shown to the
// model (so it can pivot instead of retrying the same blocked action).
type Gate interface {
	Ask(ctx context.Context, convID int64, toolName string, input []byte) (allowed bool, reason string)
}

// SetGate attaches the conversation-level approval gate. Nil disables it.
func (g *Guard) SetGate(gate Gate) { g.gate = gate }

// sideEffectTools are the tools that touch the target or the workspace; only
// these are worth an approval round-trip. Read-only tools (fetch, dns, list…)
// never queue.
var sideEffectTools = map[string]bool{
	"Bash": true, "shell_open": true, "shell_send": true,
	"Write": true, "Edit": true, "MultiEdit": true, "NotebookEdit": true,
	// 设备侧写操作与命令同样有副作用：review 模式下必须排队，
	// 否则"手机上执行命令"会绕过对 Bash 的审批约束。
	"device_exec": true, "device_file_write": true,
}

// New creates a Guard without user-configured intercept rules (used for pentest
// tasks where the Interceptor is not yet available).
func New() *Guard { return newGuard(nil) }

// NewWithInterceptor creates a Guard with user-configured intercept rules.
func NewWithInterceptor(ic *intercept.Interceptor) *Guard { return newGuard(ic) }

func newGuard(ic *intercept.Interceptor) *Guard {
	g := &Guard{attrib: map[string]int{}, interceptor: ic}
	g.reg = hook.NewRegistry().
		On(hook.PreToolUse, g.preToolUse).
		On(hook.PostToolUse, g.postToolUse)
	return g
}

// Hooks returns the hook registry to attach to an agent session.
func (g *Guard) Hooks() *hook.Registry { return g.reg }

var (
	reDestructive = regexp.MustCompile(`(?i)\b(rm\s+-rf\s+/|mkfs|dd\s+if=|:\(\)\s*\{|shutdown|reboot|>\s*/dev/sd)`)
	reExfil       = regexp.MustCompile(`(?i)(curl|wget|nc|ncat)\b[^|]*\b(\|\s*(curl|wget|nc))`)
)

func (g *Guard) preToolUse(ctx context.Context, ev hook.Event) hook.Result {
	// 会话级审批（review / ai）：有副作用的工具先过闸门。
	// auto 模式下 Gate 立即放行，不产生任何队列开销；没有会话上下文（后台任务）
	// 时也直接放行——任务引擎的边界由 guard 内置规则与任务授权范围负责。
	if g.gate != nil && sideEffectTools[ev.ToolName] {
		if convID := intercept.ConvIDFromContext(ctx); convID != 0 {
			allowed, reason := g.gate.Ask(ctx, convID, ev.ToolName, ev.Input)
			if !allowed {
				msg := strings.TrimSpace(reason)
				if msg == "" {
					msg = "审批未通过，动作未执行"
				}
				return g.block(ev.ToolName, msg, "")
			}
		}
	}
	// Gate the shell-command surface: Bash + the interactive-shell tools (shell_open's
	// command, shell_send's text). Same destructive/exfil rules — an interactive
	// session must not bypass the safety boundary. Other tools pass through.
	var cmd string
	switch ev.ToolName {
	case "Bash", "shell_open":
		var in struct {
			Command string `json:"command"`
		}
		_ = json.Unmarshal(ev.Input, &in)
		cmd = in.Command
	case "shell_send":
		var in struct {
			Text string `json:"text"`
		}
		_ = json.Unmarshal(ev.Input, &in)
		cmd = in.Text
	default:
		g.record(ev.ToolName, "allow", "", "")
		return g.applyIntercept(ctx, ev)
	}
	if strings.TrimSpace(cmd) == "" { // e.g. shell_send with only keys/hex → nothing to check
		g.record(ev.ToolName, "allow", "", "")
		return g.applyIntercept(ctx, ev)
	}

	// destructive / exfil gating (§11 side-effect gating)
	if reDestructive.MatchString(cmd) {
		return g.block(ev.ToolName, "破坏性命令被安全边界拒绝（需人工批准）", cmd)
	}
	if reExfil.MatchString(cmd) {
		return g.block(ev.ToolName, "疑似数据外泄管道被拒绝", cmd)
	}

	g.record(ev.ToolName, "allow", "", cmd)
	return g.applyIntercept(ctx, ev)
}

// applyIntercept evaluates user-configured intercept rules against the tool call.
// It is called after all built-in safety checks pass.
func (g *Guard) applyIntercept(ctx context.Context, ev hook.Event) hook.Result {
	if g.interceptor == nil {
		return hook.Result{}
	}
	if !g.interceptor.IsToolEnabled(ev.ToolName) {
		return hook.Result{}
	}
	dec, matched := g.interceptor.Match(ev.ToolName, ev.Input)
	if !matched {
		return hook.Result{}
	}
	switch dec.Action {
	case "deny":
		return g.block(ev.ToolName, dec.Message, "")
	case "allow":
		return hook.Result{}
	case "ask":
		// If the worker context is already cancelled (task stopped / killed), block
		// immediately without creating a pending record — avoids orphaned DB entries
		// and makes execOne complete fast, reducing the race against drainSynthetic.
		if ctx.Err() != nil {
			return g.block(ev.ToolName, "工作已取消，拦截规则阻止执行", "")
		}
		convID := intercept.ConvIDFromContext(ctx)
		if !g.interceptor.HandleAsk(ctx, convID, dec, ev.ToolName, ev.Input) {
			return g.block(ev.ToolName, "用户拒绝或审批超时", "")
		}
		return hook.Result{}
	}
	return hook.Result{}
}

var reBlocked = regexp.MustCompile(`(?i)\b(403|forbidden|waf|blocked|rate.?limit|429|captcha|denied)\b`)

// postToolUse is the Observer failure-attribution hook (G5): it classifies tool
// results into blocked / error / ok so the planner can change strategy instead
// of giving up at a WAF.
func (g *Guard) postToolUse(_ context.Context, ev hook.Event) hook.Result {
	if ev.ToolName != "Bash" {
		return hook.Result{}
	}
	class := "ok"
	switch {
	case reBlocked.Match(ev.Result):
		class = "blocked"
	case ev.IsError:
		class = "error"
	}
	g.mu.Lock()
	g.attrib[class]++
	g.mu.Unlock()
	return hook.Result{}
}

// Attributions returns failure-attribution counts (Observer / G5).
func (g *Guard) Attributions() map[string]int {
	g.mu.Lock()
	defer g.mu.Unlock()
	out := make(map[string]int, len(g.attrib))
	for k, v := range g.attrib {
		out[k] = v
	}
	return out
}

func (g *Guard) block(tool, reason, cmd string) hook.Result {
	g.record(tool, "block", reason, cmd)
	return hook.Result{Decision: "block", Message: reason}
}

func (g *Guard) record(tool, action, reason, cmd string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.audit = append(g.audit, AuditEntry{TS: time.Now().Unix(), Tool: tool, Action: action, Reason: reason, Command: cmd})
	if len(g.audit) > 2000 {
		g.audit = g.audit[len(g.audit)-2000:]
	}
}

// Audit returns a snapshot of recent gated calls (most recent last).
func (g *Guard) Audit() []AuditEntry {
	g.mu.Lock()
	defer g.mu.Unlock()
	out := make([]AuditEntry, len(g.audit))
	copy(out, g.audit)
	return out
}

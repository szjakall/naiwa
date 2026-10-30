package guard

import (
	"context"
	"strings"
	"testing"

	"starry/engine/hook"
	"starry/intercept"
)

// fakeGate 记录被问到的调用，并按预设结果回答。
type fakeGate struct {
	allow  bool
	reason string
	calls  int
	convID int64
	tool   string
}

func (f *fakeGate) Ask(_ context.Context, convID int64, toolName string, _ []byte) (bool, string) {
	f.calls++
	f.convID = convID
	f.tool = toolName
	return f.allow, f.reason
}

func preTool(t *testing.T, g *Guard, ctx context.Context, tool string, input string) hook.Result {
	t.Helper()
	return g.preToolUse(ctx, hook.Event{Type: hook.PreToolUse, ToolName: tool, Input: []byte(input)})
}

// review 模式下被拒：工具调用必须被拦下，并且理由要能交回模型。
func TestGateDeniesSideEffectTool(t *testing.T) {
	g := New()
	gate := &fakeGate{allow: false, reason: "人工审批拒绝，动作未执行"}
	g.SetGate(gate)

	ctx := intercept.WithConvID(context.Background(), 42)
	res := preTool(t, g, ctx, "Bash", `{"command":"id"}`)

	if res.Decision != "block" {
		t.Fatalf("expected block, got %q", res.Decision)
	}
	if !strings.Contains(res.Message, "人工审批拒绝") {
		t.Fatalf("block message lost the reason: %q", res.Message)
	}
	if gate.calls != 1 || gate.convID != 42 || gate.tool != "Bash" {
		t.Fatalf("gate not consulted correctly: %+v", gate)
	}
}

// 放行后仍要过内置破坏性规则：审批通过不代表可以 rm -rf /。
func TestGateAllowStillAppliesDestructiveRules(t *testing.T) {
	g := New()
	g.SetGate(&fakeGate{allow: true})

	ctx := intercept.WithConvID(context.Background(), 7)
	res := preTool(t, g, ctx, "Bash", `{"command":"rm -rf /"}`)
	if res.Decision != "block" {
		t.Fatalf("destructive command must stay blocked, got %q", res.Decision)
	}
}

// 只读工具不进审批队列。
func TestGateSkipsReadOnlyTools(t *testing.T) {
	g := New()
	gate := &fakeGate{allow: true}
	g.SetGate(gate)

	ctx := intercept.WithConvID(context.Background(), 9)
	res := preTool(t, g, ctx, "webfetch", `{"url":"https://example.com"}`)
	if res.Decision == "block" {
		t.Fatalf("read-only tool should not be blocked: %+v", res)
	}
	if gate.calls != 0 {
		t.Fatalf("read-only tool should not reach the gate, calls=%d", gate.calls)
	}
}

// 没有会话上下文（后台任务）时不触发会话审批。
func TestGateIgnoredWithoutConversation(t *testing.T) {
	g := New()
	gate := &fakeGate{allow: false, reason: "should not be used"}
	g.SetGate(gate)

	res := preTool(t, g, context.Background(), "Bash", `{"command":"id"}`)
	if res.Decision == "block" {
		t.Fatalf("background task should not be gated by conversation policy: %+v", res)
	}
	if gate.calls != 0 {
		t.Fatalf("gate called without conversation id")
	}
}
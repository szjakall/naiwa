package tool

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// SubtaskBridge 是"把一个子目标丢给独立 worker 并行推进"的能力。
//
// 为什么要它：单个会话里模型是串行一步接一步跑的，几个互不依赖的子目标
// （扫 A 段、扫 B 段、查资产）只能排队。子任务桥让模型把它们分派出去并发执行，
// 主会话继续推进其它工作，最后 join 收结果。
//
// 边界：
//   - 子任务各自用独立的 transcript 会话，上下文互不污染；
//   - 子任务同样走审批门（guard），不会绕过审批；
//   - 并发上限由 server 侧控制，避免把 provider 打爆。
type SubtaskBridge interface {
	// Spawn 启动一个子任务，立即返回 id。
	SubtaskSpawn(ctx context.Context, title, prompt string) (string, error)
	// Join 等待指定子任务完成（ids 为空表示等全部），返回各自结果。
	SubtaskJoin(ctx context.Context, ids []string, timeout time.Duration) ([]SubtaskResult, error)
	// List 列出本会话当前的子任务状态。
	SubtaskList(ctx context.Context) ([]SubtaskInfo, error)
}

// SubtaskResult 是一个子任务的最终产出。
type SubtaskResult struct {
	ID      string `json:"id"`
	Title   string `json:"title"`
	Status  string `json:"status"` // running | done | error | canceled
	Output  string `json:"output"`
	Error   string `json:"error,omitempty"`
	Seconds int    `json:"seconds"`
}

// SubtaskInfo 是子任务的状态快照。
type SubtaskInfo struct {
	ID      string `json:"id"`
	Title   string `json:"title"`
	Status  string `json:"status"`
	Started string `json:"started"`
}

// NewSubtaskTools 返回子任务工具集；bridge 为 nil 时不挂工具（没有并行能力就不提）。
func NewSubtaskTools(bridge SubtaskBridge) []CoreTool {
	if bridge == nil {
		return nil
	}
	return []CoreTool{newSubtaskSpawn(bridge), newSubtaskJoin(bridge), newSubtaskList(bridge)}
}

func newSubtaskSpawn(bridge SubtaskBridge) CoreTool {
	return Build(Spec{
		Name: "subtask_spawn",
		Description: "把一个**互不依赖**的子目标交给独立 worker 并行执行，立即返回子任务 id。" +
			"适合：分段扫描、并行查多个资产/接口、同时验证多个假设。" +
			"有先后依赖的步骤不要用它（应顺序执行）。",
		Prompt: "subtask_spawn 之后可以立刻做别的事，最后用 subtask_join 收结果。",
		Schema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"title":  map[string]any{"type": "string", "description": "子任务短标题（列表展示用）"},
				"prompt": map[string]any{"type": "string", "description": "交给子任务的完整指令（它看不到主会话上下文，必须自包含）"},
			},
			"required": []string{"prompt"},
		},
		Run: func(ctx context.Context, input json.RawMessage, tc *ToolContext) (Result, error) {
			var args struct {
				Title  string `json:"title"`
				Prompt string `json:"prompt"`
			}
			if err := json.Unmarshal(input, &args); err != nil {
				return Result{}, fmt.Errorf("参数解析失败: %w", err)
			}
			if strings.TrimSpace(args.Prompt) == "" {
				return Result{}, fmt.Errorf("prompt 不能为空")
			}
			id, err := bridge.SubtaskSpawn(ctx, strings.TrimSpace(args.Title), args.Prompt)
			if err != nil {
				return Result{}, err
			}
			return Text(fmt.Sprintf("已启动子任务 %s（并行执行中；用 subtask_join 收结果）", id)), nil
		},
	})
}

func newSubtaskJoin(bridge SubtaskBridge) CoreTool {
	return Build(Spec{
		Name: "subtask_join",
		Description: "等待一个或多个子任务完成并取回结果。ids 省略表示等全部。",
		Schema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"ids":     map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "要等待的子任务 id，省略=全部"},
				"timeout": map[string]any{"type": "number", "description": "最长等待秒数（默认 600）"},
			},
		},
		Run: func(ctx context.Context, input json.RawMessage, tc *ToolContext) (Result, error) {
			var args struct {
				IDs     []string `json:"ids"`
				Timeout float64  `json:"timeout"`
			}
			_ = json.Unmarshal(input, &args)
			timeout := time.Duration(args.Timeout) * time.Second
			if timeout <= 0 {
				timeout = 10 * time.Minute
			}
			results, err := bridge.SubtaskJoin(ctx, args.IDs, timeout)
			if err != nil {
				return Result{}, err
			}
			if len(results) == 0 {
				return Text("没有找到子任务"), nil
			}
			var b strings.Builder
			for _, r := range results {
				fmt.Fprintf(&b, "### %s · %s（%s，%ds）\n", r.ID, r.Title, r.Status, r.Seconds)
				if r.Error != "" {
					fmt.Fprintf(&b, "错误：%s\n", r.Error)
				}
				if r.Output != "" {
					b.WriteString(r.Output)
					b.WriteString("\n")
				}
				b.WriteString("\n")
			}
			return Text(strings.TrimSpace(b.String())), nil
		},
	})
}

func newSubtaskList(bridge SubtaskBridge) CoreTool {
	return Build(Spec{
		Name:        "subtask_list",
		Description: "列出本会话的子任务及其状态。",
		Schema:      map[string]any{"type": "object", "properties": map[string]any{}},
		ReadOnly:    func(json.RawMessage) bool { return true },
		Concurrent:  func(json.RawMessage) bool { return true },
		Run: func(ctx context.Context, input json.RawMessage, tc *ToolContext) (Result, error) {
			items, err := bridge.SubtaskList(ctx)
			if err != nil {
				return Result{}, err
			}
			if len(items) == 0 {
				return Text("当前没有子任务"), nil
			}
			var b strings.Builder
			for _, it := range items {
				fmt.Fprintf(&b, "- %s  %s  %s  %s\n", it.ID, it.Status, it.Title, it.Started)
			}
			return Text(strings.TrimSpace(b.String())), nil
		},
	})
}
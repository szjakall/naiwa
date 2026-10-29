package tool

import (
	"context"
	"encoding/json"
	"fmt"
)

// DeviceBridge 是控制台提供给 agent 的"手机操作面"。
// 放在 tool 包里以接口形式声明，避免 tool → server 的循环依赖；
// 具体实现由 server 包注入（内部转给 droid.Hub）。
type DeviceBridge interface {
	// Devices 列出当前在线设备。
	Devices(ctx context.Context) ([]DeviceSummary, error)
	// Call 在设备上执行一次操作。key 为空表示"由会话决定"（绑定的设备 > 唯一在线）。
	Call(ctx context.Context, key, op string, args map[string]any) (json.RawMessage, error)
}

// DeviceSummary 是给模型看的设备摘要。
type DeviceSummary struct {
	Key     string `json:"key"`
	Name    string `json:"name"`
	Model   string `json:"model"`
	Android string `json:"android"`
	Arch    string `json:"arch"`
	Root    bool   `json:"root"`
}

// NewDeviceTools 返回安卓设备工具集。bridge 为 nil 时返回空（没有设备能力就不挂工具）。
func NewDeviceTools(bridge DeviceBridge) []CoreTool {
	if bridge == nil {
		return nil
	}
	return []CoreTool{
		newDeviceList(bridge),
		newDeviceExec(bridge),
		newDeviceFileList(bridge),
		newDeviceFileRead(bridge),
		newDeviceFileWrite(bridge),
		newDeviceLogcat(bridge),
		newDevicePackages(bridge),
	}
}

func deviceArgDevice() map[string]any {
	return map[string]any{"type": "string", "description": "设备 key（省略则用会话绑定/唯一在线设备）"}
}

func deviceCall(ctx context.Context, bridge DeviceBridge, key, op string, args map[string]any) (string, error) {
	data, err := bridge.Call(ctx, key, op, args)
	if err != nil {
		return "", err
	}
	// 设备端把失败放在 data.error 里（frames 是 ok:true），统一翻成错误，
	// 免得模型把"unsupported op"当成成功结果继续推理。
	var probe struct {
		Error string `json:"error"`
	}
	_ = json.Unmarshal(data, &probe)
	if probe.Error != "" {
		return "", fmt.Errorf("%s", probe.Error)
	}
	return string(data), nil
}

func newDeviceList(bridge DeviceBridge) CoreTool {
	return Build(Spec{
		Name:        "device_list",
		Description: "列出当前在线安卓设备（机型 / Android 版本 / 架构 / root 状态）。安卓会话开始时应先调用它确认设备在线。",
		Prompt:      "不需要参数。没有设备时返回空列表——不要假设设备存在。",
		Schema:      map[string]any{"type": "object", "properties": map[string]any{}},
		ReadOnly:    always,
		Concurrent:  always,
		Permissions: allowReadOnly,
		Run: func(ctx context.Context, _ json.RawMessage, tc *ToolContext) (Result, error) {
			list, err := bridge.Devices(ctx)
			if err != nil {
				return Errorf("列出设备失败：" + err.Error()), nil
			}
			if len(list) == 0 {
				return Text("当前没有在线设备。请让操作员到「安卓设备」页签发令牌并在设备端连接。"), nil
			}
			out, _ := json.MarshalIndent(list, "", "  ")
			return Text(Capture(tc, string(out))), nil
		},
	})
}

func newDeviceExec(bridge DeviceBridge) CoreTool {
	return Build(Spec{
		Name:        "device_exec",
		Description: "在安卓设备上执行一条 shell 命令（adb shell 等价）。有副作用，`review` 审批模式下会排队等操作员放行。",
		Prompt:      "命令在设备上执行，不是在本机。优先只读命令（id / getprop / ls / ps）确认环境，再动数据。",
		Schema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"cmd":    map[string]any{"type": "string", "description": "要执行的命令"},
				"device": deviceArgDevice(),
			},
			"required": []string{"cmd"},
		},
		Run: func(ctx context.Context, input json.RawMessage, tc *ToolContext) (Result, error) {
			var in struct {
				Cmd    string `json:"cmd"`
				Device string `json:"device"`
			}
			if err := json.Unmarshal(input, &in); err != nil {
				return Errorf("参数解析失败：" + err.Error()), nil
			}
			text, err := deviceCall(ctx, bridge, in.Device, "exec", map[string]any{"cmd": in.Cmd})
			if err != nil {
				return Errorf("设备执行失败：" + err.Error()), nil
			}
			return Text(Capture(tc, text)), nil
		},
	})
}

func newDeviceFileList(bridge DeviceBridge) CoreTool {
	return Build(Spec{
		Name:        "device_file_list",
		Description: "列出安卓设备上某个目录的内容。",
		Prompt:      "path 是设备上的绝对路径（如 /sdcard/Download）。",
		Schema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"path":   map[string]any{"type": "string", "description": "设备目录路径"},
				"device": deviceArgDevice(),
			},
			"required": []string{"path"},
		},
		ReadOnly:    always,
		Concurrent:  always,
		Permissions: allowReadOnly,
		Run: func(ctx context.Context, input json.RawMessage, tc *ToolContext) (Result, error) {
			var in struct {
				Path   string `json:"path"`
				Device string `json:"device"`
			}
			if err := json.Unmarshal(input, &in); err != nil {
				return Errorf("参数解析失败：" + err.Error()), nil
			}
			text, err := deviceCall(ctx, bridge, in.Device, "file_list", map[string]any{"path": in.Path})
			if err != nil {
				return Errorf("列目录失败：" + err.Error()), nil
			}
			return Text(Capture(tc, text)), nil
		},
	})
}

func newDeviceFileRead(bridge DeviceBridge) CoreTool {
	return Build(Spec{
		Name:        "device_file_read",
		Description: "读取安卓设备上的一个文件（返回 base64 与大小）。",
		Prompt:      "只读敏感文件前先确认授权范围。大文件可能被设备端拒绝。",
		Schema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"path":   map[string]any{"type": "string", "description": "设备文件路径"},
				"device": deviceArgDevice(),
			},
			"required": []string{"path"},
		},
		ReadOnly:    always,
		Concurrent:  always,
		Permissions: allowReadOnly,
		Run: func(ctx context.Context, input json.RawMessage, tc *ToolContext) (Result, error) {
			var in struct {
				Path   string `json:"path"`
				Device string `json:"device"`
			}
			if err := json.Unmarshal(input, &in); err != nil {
				return Errorf("参数解析失败：" + err.Error()), nil
			}
			text, err := deviceCall(ctx, bridge, in.Device, "file_read", map[string]any{"path": in.Path})
			if err != nil {
				return Errorf("读取失败：" + err.Error()), nil
			}
			return Text(Capture(tc, text)), nil
		},
	})
}

func newDeviceFileWrite(bridge DeviceBridge) CoreTool {
	return Build(Spec{
		Name:        "device_file_write",
		Description: "把内容写到安卓设备上的文件（内容用 base64 传）。有副作用，`review` 模式会排队审批。",
		Prompt:      "写完用 device_exec 的 cat/ls 复核。不要覆盖系统文件。",
		Schema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"path":   map[string]any{"type": "string", "description": "设备文件路径"},
				"b64":    map[string]any{"type": "string", "description": "base64 编码的内容"},
				"device": deviceArgDevice(),
			},
			"required": []string{"path", "b64"},
		},
		Run: func(ctx context.Context, input json.RawMessage, tc *ToolContext) (Result, error) {
			var in struct {
				Path   string `json:"path"`
				B64    string `json:"b64"`
				Device string `json:"device"`
			}
			if err := json.Unmarshal(input, &in); err != nil {
				return Errorf("参数解析失败：" + err.Error()), nil
			}
			text, err := deviceCall(ctx, bridge, in.Device, "file_write", map[string]any{"path": in.Path, "b64": in.B64})
			if err != nil {
				return Errorf("写入失败：" + err.Error()), nil
			}
			return Text(Capture(tc, text)), nil
		},
	})
}

func newDeviceLogcat(bridge DeviceBridge) CoreTool {
	return Build(Spec{
		Name:        "device_logcat",
		Description: "抓取安卓设备最近若干行 logcat。",
		Prompt:      "lines 默认 200，上限由设备端决定。",
		Schema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"lines":  map[string]any{"type": "number", "description": "行数（默认 200）"},
				"device": deviceArgDevice(),
			},
		},
		ReadOnly:    always,
		Concurrent:  always,
		Permissions: allowReadOnly,
		Run: func(ctx context.Context, input json.RawMessage, tc *ToolContext) (Result, error) {
			var in struct {
				Lines  int    `json:"lines"`
				Device string `json:"device"`
			}
			_ = json.Unmarshal(input, &in)
			if in.Lines <= 0 {
				in.Lines = 200
			}
			text, err := deviceCall(ctx, bridge, in.Device, "logcat", map[string]any{"lines": in.Lines})
			if err != nil {
				return Errorf("抓日志失败：" + err.Error()), nil
			}
			return Text(Capture(tc, text)), nil
		},
	})
}

func newDevicePackages(bridge DeviceBridge) CoreTool {
	return Build(Spec{
		Name:        "device_packages",
		Description: "列出安卓设备上已安装的第三方应用包名，用于确定要分析的目标 App。",
		Prompt:      "需要系统应用时用 device_exec 跑 pm list packages -s。",
		Schema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"device": deviceArgDevice(),
			},
		},
		ReadOnly:    always,
		Concurrent:  always,
		Permissions: allowReadOnly,
		Run: func(ctx context.Context, input json.RawMessage, tc *ToolContext) (Result, error) {
			var in struct {
				Device string `json:"device"`
			}
			_ = json.Unmarshal(input, &in)
			text, err := deviceCall(ctx, bridge, in.Device, "packages", map[string]any{})
			if err != nil {
				return Errorf("列出应用失败：" + err.Error()), nil
			}
			return Text(Capture(tc, text)), nil
		},
	})
}
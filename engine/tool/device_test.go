package tool

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

// fakeBridge 记录工具层发出的设备操作，用于验证参数与错误路径。
type fakeBridge struct {
	calls  []string
	ops    map[string]map[string]any
	devs   []DeviceSummary
	err    error
	result string
}

func (f *fakeBridge) Devices(context.Context) ([]DeviceSummary, error) {
	return f.devs, f.err
}

func (f *fakeBridge) Call(_ context.Context, key, op string, args map[string]any) (json.RawMessage, error) {
	f.calls = append(f.calls, key+"|"+op)
	if f.ops == nil {
		f.ops = map[string]map[string]any{}
	}
	f.ops[op] = args
	if f.err != nil {
		return nil, f.err
	}
	return json.RawMessage(f.result), nil
}

func runTool(t *testing.T, tl CoreTool, input string) Result {
	t.Helper()
	res, err := tl.Call(context.Background(), json.RawMessage(input), &ToolContext{})
	if err != nil {
		t.Fatalf("tool returned error: %v", err)
	}
	return res
}

func TestDeviceToolsRegistered(t *testing.T) {
	tools := NewDeviceTools(&fakeBridge{})
	names := map[string]bool{}
	for _, tl := range tools {
		names[tl.Name()] = true
	}
	for _, want := range []string{"device_list", "device_exec", "device_file_list", "device_file_read", "device_file_write", "device_logcat", "device_packages"} {
		if !names[want] {
			t.Fatalf("missing tool %s (have %v)", want, names)
		}
	}
	if NewDeviceTools(nil) != nil {
		t.Fatalf("nil bridge must produce no tools")
	}
}

func TestDeviceExecPassesCommand(t *testing.T) {
	bridge := &fakeBridge{result: `{"stdout":"uid=0(root)","code":0}`}
	tools := NewDeviceTools(bridge)
	var exec CoreTool
	for _, tl := range tools {
		if tl.Name() == "device_exec" {
			exec = tl
		}
	}
	res := runTool(t, exec, `{"cmd":"id"}`)
	if !strings.Contains(res.Flatten(), "uid=0(root)") {
		t.Fatalf("result not passed through: %s", res.Flatten())
	}
	if len(bridge.calls) != 1 || bridge.calls[0] != "|exec" {
		t.Fatalf("unexpected calls: %v", bridge.calls)
	}
	if bridge.ops["exec"]["cmd"] != "id" {
		t.Fatalf("command not forwarded: %v", bridge.ops["exec"])
	}
}

func TestDeviceWriteForwardsBase64(t *testing.T) {
	bridge := &fakeBridge{result: `{"ok":true}`}
	tools := NewDeviceTools(bridge)
	var write CoreTool
	for _, tl := range tools {
		if tl.Name() == "device_file_write" {
			write = tl
		}
	}
	runTool(t, write, `{"path":"/sdcard/a.txt","b64":"aGVsbG8=","device":"dev_x"}`)
	if bridge.calls[0] != "dev_x|file_write" {
		t.Fatalf("device key not forwarded: %v", bridge.calls)
	}
	if bridge.ops["file_write"]["b64"] != "aGVsbG8=" {
		t.Fatalf("payload not forwarded: %v", bridge.ops["file_write"])
	}
}

// 设备端把失败放在 data.error 里：工具层必须翻成错误，否则模型会当成功继续推理。
func TestDeviceErrorSurfaces(t *testing.T) {
	bridge := &fakeBridge{result: `{"error":"unsupported op file_list"}`}
	tools := NewDeviceTools(bridge)
	var list CoreTool
	for _, tl := range tools {
		if tl.Name() == "device_file_list" {
			list = tl
		}
	}
	res := runTool(t, list, `{"path":"/sdcard"}`)
	if !res.IsError {
		t.Fatalf("device error must become a tool error, got %q", res.Flatten())
	}
	if !strings.Contains(res.Flatten(), "unsupported op") {
		t.Fatalf("error text lost: %s", res.Flatten())
	}
}

func TestDeviceListWithoutDevices(t *testing.T) {
	bridge := &fakeBridge{}
	tools := NewDeviceTools(bridge)
	var list CoreTool
	for _, tl := range tools {
		if tl.Name() == "device_list" {
			list = tl
		}
	}
	res := runTool(t, list, `{}`)
	if !strings.Contains(res.Flatten(), "没有在线设备") {
		t.Fatalf("expected empty hint, got %q", res.Flatten())
	}
}
package server

import (
	"context"
	"encoding/json"
	"errors"

	actool "starry/engine/tool"
	"starry/intercept"
)

// deviceBridge 把 droid.Hub 适配成 agent 能用的工具面（engine/tool.DeviceBridge）。
//
// 设备选择规则（从窄到宽）：
//   1. 工具参数显式给了 device key；
//   2. 会话绑定了 device_key；
//   3. 只有一台在线设备时用它；
//   4. 其它情况报错——多台设备时乱猜一台比报错更难查。
func (s *Server) Devices(_ context.Context) ([]actool.DeviceSummary, error) {
	list := s.droid.List()
	out := make([]actool.DeviceSummary, 0, len(list))
	for _, d := range list {
		out = append(out, actool.DeviceSummary{
			Key: d.Key, Name: d.Model, Model: d.Model,
			Android: d.Android, Arch: "", Root: d.Root,
		})
	}
	return out, nil
}

func (s *Server) resolveDeviceKey(ctx context.Context, explicit string) (string, error) {
	if explicit != "" {
		return explicit, nil
	}
	if convID := intercept.ConvIDFromContext(ctx); convID != 0 && s.m.pg != nil {
		if key, err := s.m.pg.GetConversationDeviceKey(convID); err == nil && key != "" {
			return key, nil
		}
	}
	list := s.droid.List()
	switch len(list) {
	case 0:
		return "", errors.New("没有在线设备：请在「安卓设备」页签发令牌并在设备端连接")
	case 1:
		return list[0].Key, nil
	default:
		return "", errors.New("有多台设备在线，请在会话里绑定设备或显式指定 device")
	}
}

// Call 实现 engine/tool.DeviceBridge：与 HTTP 接口共用 deviceOpData。
func (s *Server) Call(ctx context.Context, key, op string, args map[string]any) (json.RawMessage, error) {
	resolved, err := s.resolveDeviceKey(ctx, key)
	if err != nil {
		return nil, err
	}
	data, err := s.deviceOpData(ctx, resolved, op, args)
	if err != nil {
		return nil, err
	}
	return json.Marshal(data)
}

var _ actool.DeviceBridge = (*Server)(nil)
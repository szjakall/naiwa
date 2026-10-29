// Package droid implements the console side of the device bridge: a reverse
// WebSocket the phone dials out on, a live registry, and request/response calls
// over that socket.
//
// 协议与设备端 APK 严格对齐（帧格式见 droid-protocol，字段只增不改）：
//
//	设备 → 控制台：{t:"hello"} → 之后 {t:"hb"} / {t:"data"} / {t:"result"}
//	控制台 → 设备：{t:"welcome"} → 之后 {t:"exec"|"pull"|"push"|"screencap"|"logcat"|"packages"}
//
// 为什么是"设备反连"：手机通常没有公网入口，让设备主动连出来就不需要端口映射；
// 控制台这边只维护一条出站连接的反向通道。
package droid

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

var b64Std = base64.StdEncoding

// Info is one connected device.
type Info struct {
	Key         string    `json:"key"`
	DeviceID    string    `json:"device_id"`
	Model       string    `json:"model"`
	Android     string    `json:"android"`
	SDK         int       `json:"sdk"`
	Root        bool      `json:"root"`
	ConnectedAt time.Time `json:"connected_at"`
	LastSeen    time.Time `json:"last_seen"`
}

// Result is the aggregated answer of one request: the final result frame plus any
// data chunks streamed under the same reqId (screencap / pull).
type Result struct {
	OK     bool
	Code   int
	Stdout string
	Stderr string
	Error  string
	Bytes  []byte
}

type pendingCall struct {
	ch     chan Result
	chunks [][]byte
}

// Device is one live connection. Writes are serialized; calls correlate by reqId.
type Device struct {
	info    Info
	conn    *websocket.Conn
	writeMu sync.Mutex

	mu      sync.Mutex
	pending map[string]*pendingCall
	tunnels map[string]*Tunnel // tcp 隧道：connId → 本地通道
}

func (d *Device) Info() Info {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.info
}

func (d *Device) touch() {
	d.mu.Lock()
	d.info.LastSeen = time.Now()
	d.mu.Unlock()
}

func (d *Device) send(v any) error {
	payload, err := json.Marshal(v)
	if err != nil {
		return err
	}
	d.writeMu.Lock()
	defer d.writeMu.Unlock()
	_ = d.conn.SetWriteDeadline(time.Now().Add(20 * time.Second))
	return d.conn.WriteMessage(websocket.TextMessage, payload)
}

var reqSeq int64

// Call sends one request frame and waits for its result frame (data chunks, if
// any, are appended in seq order inside the read loop).
func (d *Device) Call(ctx context.Context, frame map[string]any, timeout time.Duration) (Result, error) {
	id := fmt.Sprintf("r%d", atomic.AddInt64(&reqSeq, 1))
	frame["reqId"] = id
	pc := &pendingCall{ch: make(chan Result, 1)}
	d.mu.Lock()
	if d.pending == nil {
		d.pending = map[string]*pendingCall{}
	}
	d.pending[id] = pc
	d.mu.Unlock()
	defer func() {
		d.mu.Lock()
		delete(d.pending, id)
		d.mu.Unlock()
	}()

	if err := d.send(frame); err != nil {
		return Result{}, fmt.Errorf("下发失败：%w", err)
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case res := <-pc.ch:
		return res, nil
	case <-timer.C:
		return Result{}, fmt.Errorf("设备在 %s 内未返回结果", timeout)
	case <-ctx.Done():
		return Result{}, ctx.Err()
	}
}

// finish 把流式分片按顺序拼好交付给等待者。
func (d *Device) finish(id string, base Result) {
	d.mu.Lock()
	pc, ok := d.pending[id]
	d.mu.Unlock()
	if !ok {
		return
	}
	if len(pc.chunks) > 0 {
		total := 0
		for _, chunk := range pc.chunks {
			total += len(chunk)
		}
		merged := make([]byte, 0, total)
		for _, chunk := range pc.chunks {
			merged = append(merged, chunk...)
		}
		base.Bytes = merged
	}
	pc.ch <- base
}

// Hub keeps every connected device.
type Hub struct {
	mu      sync.RWMutex
	devices map[string]*Device
}

func NewHub() *Hub { return &Hub{devices: map[string]*Device{}} }

func (h *Hub) List() []Info {
	h.mu.RLock()
	defer h.mu.RUnlock()
	out := make([]Info, 0, len(h.devices))
	for _, d := range h.devices {
		out = append(out, d.Info())
	}
	return out
}

func (h *Hub) Get(key string) (*Device, bool) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	d, ok := h.devices[key]
	return d, ok
}

// helloFrame is the device's first frame; everything else is refused before it.
type helloFrame struct {
	T              string `json:"t"`
	Token          string `json:"token"`
	DeviceID       string `json:"deviceId"`
	Model          string `json:"model"`
	AndroidVersion string `json:"androidVersion"`
	SDKInt         int    `json:"sdkInt"`
	Rooted         bool   `json:"rooted"`
}

// Serve runs the protocol for a freshly upgraded connection. It returns when the
// socket dies; the device is removed from the registry on the way out.
func (h *Hub) Serve(conn *websocket.Conn) {
	defer func() { _ = conn.Close() }()

	// hello 必须第一帧；否则直接关，避免未认证的连接占用通道。
	_ = conn.SetReadDeadline(time.Now().Add(20 * time.Second))
	_, raw, err := conn.ReadMessage()
	if err != nil {
		return
	}
	var hello helloFrame
	if json.Unmarshal(raw, &hello) != nil || hello.T != "hello" || hello.DeviceID == "" {
		_ = conn.WriteMessage(websocket.TextMessage, []byte(`{"t":"error","error":"hello required"}`))
		return
	}

	info := Info{
		Key:         hello.DeviceID,
		DeviceID:    hello.DeviceID,
		Model:       firstNonEmpty(hello.Model, "未知机型"),
		Android:     firstNonEmpty(hello.AndroidVersion, "未知"),
		SDK:         hello.SDKInt,
		Root:        hello.Rooted,
		ConnectedAt: time.Now(),
		LastSeen:    time.Now(),
	}
	device := &Device{info: info, conn: conn, pending: map[string]*pendingCall{}}

	h.mu.Lock()
	// 同一个 deviceId 重连：新连接顶掉旧连接（旧连接可能已经半死但还没超时）。
	if old, ok := h.devices[hello.DeviceID]; ok && old != nil {
		_ = old.conn.Close()
	}
	h.devices[hello.DeviceID] = device
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		if current, ok := h.devices[hello.DeviceID]; ok && current == device {
			delete(h.devices, hello.DeviceID)
		}
		h.mu.Unlock()
	}()

	_ = device.send(map[string]any{"t": "welcome", "deviceId": hello.DeviceID})

	conn.SetReadDeadline(time.Now().Add(70 * time.Second))
	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			return
		}
		conn.SetReadDeadline(time.Now().Add(70 * time.Second))
		device.touch()

		var frame struct {
			T      string          `json:"t"`
			ReqID  string          `json:"reqId"`
			ConnID string          `json:"connId"`
			Seq    int             `json:"seq"`
			B64    string          `json:"b64"`
			Done   bool            `json:"done"`
			OK     bool            `json:"ok"`
			Code   int             `json:"code"`
			Stdout string          `json:"stdout"`
			Stderr string          `json:"stderr"`
			Error  string          `json:"error"`
			Raw    json.RawMessage `json:"-"`
		}
		if json.Unmarshal(raw, &frame) != nil {
			continue
		}
		switch frame.T {
		case "hb":
			// 心跳只刷新 last_seen（touch 已做）。
		case "data":
			chunk, decodeErr := decodeB64(frame.B64)
			if decodeErr != nil {
				continue
			}
			device.mu.Lock()
			if pc, ok := device.pending[frame.ReqID]; ok {
				pc.chunks = append(pc.chunks, chunk)
			}
			device.mu.Unlock()
		case "result":
			device.finish(frame.ReqID, Result{
				OK: frame.OK, Code: frame.Code,
				Stdout: frame.Stdout, Stderr: frame.Stderr, Error: frame.Error,
			})
		case "tcp_opened":
			if t := device.tunnel(frame.ConnID); t != nil {
				var openErr error
				if !frame.OK {
					openErr = fmt.Errorf("设备侧连接失败：%s", firstNonEmpty(frame.Error, "unknown"))
				}
				select {
				case t.opened <- openErr:
				default:
				}
			}
		case "tcp_data":
			if t := device.tunnel(frame.ConnID); t != nil {
				if chunk, err := decodeB64(frame.B64); err == nil && len(chunk) > 0 {
					t.push(chunk)
				}
			}
		case "tcp_closed":
			if t := device.tunnel(frame.ConnID); t != nil {
				_ = t.Close()
			}
		}
	}
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

// Push writes a file on the device in 1MB chunks under one reqId. The device only
// answers the chunk carrying done=true, so one push is still one request/answer.
func (d *Device) Push(ctx context.Context, path string, data []byte, mode string, timeout time.Duration) (Result, error) {
	id := fmt.Sprintf("r%d", atomic.AddInt64(&reqSeq, 1))
	pc := &pendingCall{ch: make(chan Result, 1)}
	d.mu.Lock()
	if d.pending == nil {
		d.pending = map[string]*pendingCall{}
	}
	d.pending[id] = pc
	d.mu.Unlock()
	defer func() {
		d.mu.Lock()
		delete(d.pending, id)
		d.mu.Unlock()
	}()

	const chunk = 1024 * 1024
	for seq := 0; ; seq++ {
		start := seq * chunk
		if start > len(data) {
			break
		}
		end := start + chunk
		if end > len(data) {
			end = len(data)
		}
		last := end == len(data)
		frame := map[string]any{
			"t":     "push",
			"reqId": id,
			"path":  path,
			"seq":   seq,
			"done":  last,
			"b64":   b64Std.EncodeToString(data[start:end]),
		}
		if seq == 0 {
			frame["mode"] = mode
		}
		if err := d.send(frame); err != nil {
			return Result{}, fmt.Errorf("下发失败：%w", err)
		}
		if last {
			break
		}
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case res := <-pc.ch:
		return res, nil
	case <-timer.C:
		return Result{}, fmt.Errorf("设备在 %s 内未完成写入", timeout)
	case <-ctx.Done():
		return Result{}, ctx.Err()
	}
}

// decodeB64 走标准库，避免再引一个 base64 变体。
func decodeB64(s string) ([]byte, error) {
	if s == "" {
		return nil, nil
	}
	return b64Std.DecodeString(s)
}
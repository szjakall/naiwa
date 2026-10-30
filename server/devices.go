package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/gorilla/websocket"

	"starry/db"
	"starry/droid"
)

var b64enc = base64.StdEncoding

// 安卓设备反连：设备带着签发令牌连 /ws/droid?token=…，握手后进入在线表。
// 帧格式与设备端 APK 一致（t / reqId 协议），控制台从这里下发命令与文件操作。

var droidUpgrader = websocket.Upgrader{
	ReadBufferSize:  8192,
	WriteBufferSize: 8192,
	// 设备端不是浏览器，Origin 不可靠；鉴权靠一次性令牌。
	CheckOrigin: func(*http.Request) bool { return true },
}

// droidWS 处理设备反连（GET /ws/droid?token=...）。
func (s *Server) droidWS(w http.ResponseWriter, r *http.Request) {
	pg := s.m.pg
	if pg == nil {
		writeErr(w, 503, "数据库未就绪")
		return
	}
	token := strings.TrimSpace(r.URL.Query().Get("token"))
	if token == "" {
		token = strings.TrimSpace(strings.TrimPrefix(r.Header.Get("authorization"), "Bearer "))
	}
	ok, err := pg.VerifyDeviceToken(token)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	if !ok {
		writeErr(w, 401, "设备令牌无效或已吊销")
		return
	}
	conn, err := droidUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	_ = pg.TouchDeviceToken(db.HashDeviceToken(token))
	s.droid.Serve(conn) // hello 校验、注册、帧循环都在 hub 里
}

// --- 设备 API ---

func (s *Server) deviceList(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{"devices": s.droid.List()})
}

func (s *Server) deviceTokenList(w http.ResponseWriter, r *http.Request) {
	pg := s.pg(w)
	if pg == nil {
		return
	}
	items, err := pg.ListDeviceTokens()
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	if items == nil {
		items = []db.DeviceToken{}
	}
	writeJSON(w, 200, map[string]any{"tokens": items})
}

func (s *Server) deviceTokenCreate(w http.ResponseWriter, r *http.Request) {
	pg := s.pg(w)
	if pg == nil {
		return
	}
	var req struct {
		Label string `json:"label"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	token, row, err := pg.CreateDeviceToken(strings.TrimSpace(req.Label))
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	// 明文只在这里返回一次：之后库里只有哈希。
	writeJSON(w, 200, map[string]any{"token": token, "item": row})
}

func (s *Server) deviceTokenRevoke(w http.ResponseWriter, r *http.Request) {
	pg := s.pg(w)
	if pg == nil {
		return
	}
	id, ok := pathInt(r, "id")
	if !ok {
		writeErr(w, 400, "bad token id")
		return
	}
	if err := pg.RevokeDeviceToken(id); err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

// deviceOps 是允许从控制台下发的操作白名单与超时。
// 白名单而不是透传：设备端实现什么就放什么，避免把任意帧直接送到手机上执行。
var deviceOps = map[string]time.Duration{
	"exec":           30 * time.Second,
	"screencap":      40 * time.Second,
	"file_list":      20 * time.Second,
	"file_read":      60 * time.Second,
	"file_write":     90 * time.Second,
	"logcat":         40 * time.Second,
	"packages":       30 * time.Second,
	"capture_start":  40 * time.Second,
	"capture_stop":   90 * time.Second,
	"capture_status": 15 * time.Second,
}

// callDevice 把一次控制台操作翻译成设备协议请求并等待结果。
func (s *Server) callDevice(ctx context.Context, key, op string, args map[string]any) (droid.Result, error) {
	dev, ok := s.droid.Get(key)
	if !ok {
		return droid.Result{}, errors.New("设备不在线（可能已断开）")
	}
	timeout, allowed := deviceOps[op]
	if !allowed {
		return droid.Result{}, errors.New("不支持的操作：" + op)
	}
	if args == nil {
		args = map[string]any{}
	}
	str := func(name string, fallback string) string {
		if v, ok := args[name].(string); ok && v != "" {
			return v
		}
		return fallback
	}
	num := func(name string, fallback int) int {
		switch v := args[name].(type) {
		case float64:
			return int(v)
		case int:
			return v
		case int64:
			return int(v)
		case json.Number:
			n, _ := v.Int64()
			return int(n)
		}
		return fallback
	}

	switch op {
	case "exec":
		cmd := str("cmd", "")
		if strings.TrimSpace(cmd) == "" {
			return droid.Result{}, errors.New("cmd 不能为空")
		}
		timeoutSec := num("timeout", 30)
		if timeoutSec <= 0 || timeoutSec > 120 {
			timeoutSec = 30
		}
		return dev.Call(ctx, map[string]any{
			"t": "exec", "cmd": cmd, "asRoot": true, "timeoutMs": timeoutSec * 1000,
		}, time.Duration(timeoutSec)*time.Second+5*time.Second)
	case "screencap":
		return dev.Call(ctx, map[string]any{"t": "screencap"}, timeout)
	case "logcat":
		lines := num("lines", 200)
		if lines <= 0 || lines > 5000 {
			lines = 200
		}
		return dev.Call(ctx, map[string]any{"t": "logcat", "lines": lines}, timeout)
	case "packages":
		return dev.Call(ctx, map[string]any{"t": "packages", "thirdPartyOnly": true}, timeout)
	case "file_list":
		path := str("path", "/sdcard")
		// 协议没有单独的 list 帧：用 ls -la 取目录。补一个结尾斜杠，
		// 否则 /sdcard 这类符号链接只会列出链接本身而不是目录内容。
		listing := path
		if !strings.HasSuffix(listing, "/") {
			listing += "/"
		}
		return dev.Call(ctx, map[string]any{
			"t": "exec", "cmd": "ls -la " + shellQuote(listing), "asRoot": true, "timeoutMs": 20000,
		}, timeout)
	case "file_read":
		path := str("path", "")
		if path == "" {
			return droid.Result{}, errors.New("path 不能为空")
		}
		return dev.Call(ctx, map[string]any{"t": "pull", "path": path, "maxBytes": 8 * 1024 * 1024}, timeout)
	case "file_write":
		path := str("path", "")
		b64 := str("b64", "")
		if path == "" {
			return droid.Result{}, errors.New("path 不能为空")
		}
		data, decodeErr := decodeBase64(b64)
		if decodeErr != nil {
			return droid.Result{}, fmt.Errorf("b64 解码失败：%w", decodeErr)
		}
		return dev.Push(ctx, path, data, "0644", timeout)
	case "capture_start":
		iface := str("iface", "any")
		seconds := num("seconds", 30)
		if seconds <= 0 || seconds > 600 {
			seconds = 30
		}
		return dev.Call(ctx, map[string]any{"t": "capture_start", "iface": iface, "seconds": seconds}, timeout)
	case "capture_stop":
		// 设备会先回 result，再以 data 帧流回 pcap；hub 会把分片聚合进 Bytes。
		return dev.Call(ctx, map[string]any{"t": "capture_stop"}, timeout)
	case "capture_status":
		return dev.Call(ctx, map[string]any{"t": "capture_status"}, timeout)
	}
	return droid.Result{}, errors.New("不支持的操作：" + op)
}

// decodeBase64 用标准库，避免再引第三方 base64。
func decodeBase64(s string) ([]byte, error) {
	if s == "" {
		return nil, nil
	}
	return b64enc.DecodeString(s)
}

// deviceExec 在指定设备上执行一条命令（POST /api/devices/{key}/exec）。
func (s *Server) deviceExec(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Cmd     string `json:"cmd"`
		Timeout int    `json:"timeout"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "请求格式错误")
		return
	}
	data, err := s.deviceOpData(r.Context(), r.PathValue("key"), "exec", map[string]any{"cmd": req.Cmd, "timeout": float64(req.Timeout)})
	if err != nil {
		writeErr(w, 502, err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "data": data})
}

// deviceScreencap 抓一张设备截屏（POST /api/devices/{key}/screencap）。
func (s *Server) deviceScreencap(w http.ResponseWriter, r *http.Request) {
	data, err := s.deviceOpData(r.Context(), r.PathValue("key"), "screencap", nil)
	if err != nil {
		writeErr(w, 502, err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "data": data})
}

// deviceOp 通用操作入口（POST /api/devices/{key}/op {op, args}）。
func (s *Server) deviceOp(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Op   string         `json:"op"`
		Args map[string]any `json:"args"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "请求格式错误")
		return
	}
	if _, allowed := deviceOps[req.Op]; !allowed {
		writeErr(w, 400, "不支持的操作："+req.Op)
		return
	}
	data, err := s.deviceOpData(r.Context(), r.PathValue("key"), req.Op, req.Args)
	if err != nil {
		writeErr(w, 502, err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "data": data})
}

// deviceOpData 执行一次设备操作并把结果整理成 JSON 友好的结构（HTTP 与 agent 工具共用）。
func (s *Server) deviceOpData(ctx context.Context, key, op string, args map[string]any) (map[string]any, error) {
	res, err := s.callDevice(ctx, key, op, args)
	if err != nil {
		return nil, err
	}
	if !res.OK && res.Error == "" && res.Stderr != "" {
		res.Error = res.Stderr
	}
	if res.Error != "" && !res.OK {
		return nil, errors.New(res.Error)
	}
	out := map[string]any{"ok": true}
	switch op {
	case "exec":
		out["stdout"] = res.Stdout
		out["code"] = res.Code
		out["stderr"] = res.Stderr
	case "screencap":
		if len(res.Bytes) == 0 {
			return nil, errors.New("设备没有返回图像")
		}
		out["image_b64"] = b64enc.EncodeToString(res.Bytes)
		out["mime"] = "image/png"
		out["size"] = len(res.Bytes)
	case "file_read":
		if len(res.Bytes) == 0 {
			return nil, errors.New("设备没有返回文件内容")
		}
		out["b64"] = b64enc.EncodeToString(res.Bytes)
		out["size"] = len(res.Bytes)
	case "file_write":
		out["stdout"] = res.Stdout
	case "file_list", "logcat":
		out["text"] = res.Stdout
	case "packages":
		out["text"] = res.Stdout
		var list []string
		for _, line := range strings.Split(res.Stdout, "\n") {
			line = strings.TrimSpace(line)
			if strings.HasPrefix(line, "package:") {
				list = append(list, strings.TrimPrefix(line, "package:"))
			}
		}
		out["packages"] = list
	case "capture_start", "capture_status":
		out["text"] = res.Stdout
		out["code"] = res.Code
	case "capture_stop":
		// pcap 走 data 帧回流，落盘而不是塞进 JSON：一个抓包几十 MB，
		// base64 进响应体会把浏览器和日志一起拖垮。
		if len(res.Bytes) == 0 {
			return nil, errors.New("设备没有返回抓包数据（tcpdump 可能不可用）")
		}
		dir := filepath.Join(s.dataDir, "captures")
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, err
		}
		name := fmt.Sprintf("cap-%s.pcap", time.Now().Format("20060102-150405"))
		full := filepath.Join(dir, name)
		if err := os.WriteFile(full, res.Bytes, 0o644); err != nil {
			return nil, err
		}
		out["path"] = full
		out["name"] = name
		out["size"] = len(res.Bytes)
	}
	return out, nil
}

var _ = strconv.Itoa
package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"sync"
	"time"
)

// 设备 TCP 隧道：设备上的服务（frida-server、调试端口）通常只监听本机回环，
// 控制台不能直连。这里在服务端起一个本地监听端口，把每个进来的连接经反连通道
// 桥接到设备侧的 host:port——frida-cli 之类工具就能连本机端口。
//
// 隧道是有生命周期的资源：必须能列出、能关闭，否则进程重启前会一直占着端口。

type deviceTunnel struct {
	ID     string
	Device string
	Target string
	Addr   string
	ln     net.Listener
	stop   chan struct{}
	once   sync.Once
	conns  sync.WaitGroup
}

func (t *deviceTunnel) close() {
	t.once.Do(func() {
		close(t.stop)
		_ = t.ln.Close()
	})
}

// tunnelStart 开始一条隧道（POST /api/devices/{key}/tunnel）。
func (s *Server) tunnelStart(w http.ResponseWriter, r *http.Request) {
	key := r.PathValue("key")
	dev, ok := s.droid.Get(key)
	if !ok {
		writeErr(w, 404, "设备不在线")
		return
	}
	var req struct {
		Host string `json:"host"`
		Port int    `json:"port"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "请求格式错误")
		return
	}
	if req.Host == "" {
		req.Host = "127.0.0.1"
	}
	if req.Port <= 0 || req.Port > 65535 {
		writeErr(w, 400, "port 不合法")
		return
	}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		writeErr(w, 500, "本地监听失败："+err.Error())
		return
	}
	id := fmt.Sprintf("tn-%d", time.Now().UnixNano())
	tunnel := &deviceTunnel{
		ID: id, Device: key, Target: req.Host + ":" + strconv.Itoa(req.Port),
		Addr: ln.Addr().String(), ln: ln, stop: make(chan struct{}),
	}
	s.tunnelMu.Lock()
	if s.tunnels == nil {
		s.tunnels = map[string]*deviceTunnel{}
	}
	s.tunnels[id] = tunnel
	s.tunnelMu.Unlock()

	go func() {
		for {
			client, err := ln.Accept()
			if err != nil {
				return
			}
			tunnel.conns.Add(1)
			go func() {
				defer tunnel.conns.Done()
				defer client.Close()
				tunnelCtx, cancel := context.WithTimeout(s.ctx, 30*time.Second)
				link, err := dev.OpenTunnel(tunnelCtx, req.Host, req.Port, 20*time.Second)
				cancel()
				if err != nil {
					_, _ = client.Write([]byte("tunnel: " + err.Error() + "\n"))
					return
				}
				defer link.Close()
				done := make(chan struct{}, 2)
				go func() { _, _ = io.Copy(link, client); done <- struct{}{} }()
				go func() { _, _ = io.Copy(client, link); done <- struct{}{} }()
				<-done
			}()
		}
	}()

	writeJSON(w, 200, map[string]any{"ok": true, "id": id, "addr": tunnel.Addr, "target": tunnel.Target})
}

// tunnelList 列出当前隧道（GET /api/devices/{key}/tunnel 或全局）。
func (s *Server) tunnelList(w http.ResponseWriter, r *http.Request) {
	key := r.PathValue("key")
	s.tunnelMu.Lock()
	defer s.tunnelMu.Unlock()
	out := []map[string]any{}
	for _, t := range s.tunnels {
		if key != "" && t.Device != key {
			continue
		}
		out = append(out, map[string]any{"id": t.ID, "device": t.Device, "target": t.Target, "addr": t.Addr})
	}
	writeJSON(w, 200, map[string]any{"tunnels": out})
}

// tunnelStop 关闭一条隧道（DELETE /api/devices/{key}/tunnel/{id}）。
func (s *Server) tunnelStop(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	s.tunnelMu.Lock()
	t, ok := s.tunnels[id]
	if ok {
		delete(s.tunnels, id)
	}
	s.tunnelMu.Unlock()
	if !ok {
		writeErr(w, 404, "隧道不存在")
		return
	}
	t.close()
	writeJSON(w, 200, map[string]any{"ok": true})
}

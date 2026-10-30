package server

import (
	"encoding/json"
	"net/http"
	"strings"
)

// 流量出口：抓包代理默认直连目标，操作员可指定一个上游出口（HTTP/HTTPS/SOCKS5），
// 让"只能经代理才可达"的目标也能被录制；同时可给一批主机后缀开直连例外。
//
// 只影响 MITM 转发链路，不改宿主环境变量——不然同机其它进程会被一起带偏。

// GET /api/traffic/upstream
func (s *Server) getTrafficUpstream(w http.ResponseWriter, r *http.Request) {
	if s.m == nil {
		writeErr(w, 503, "服务未就绪")
		return
	}
	upstream, bypass := s.m.TrafficUpstream()
	viaUp, viaBypass, viaDirect := s.m.TrafficUpstreamStats()
	writeJSON(w, 200, map[string]any{
		"upstream": upstream,
		"bypass":   bypass,
		"enabled":  s.m.Traffic() != nil,
		"stats": map[string]int64{
			"via_upstream": viaUp,
			"via_bypass":   viaBypass,
			"via_direct":   viaDirect,
		},
	})
}

// POST /api/traffic/upstream {upstream, bypass[]}
func (s *Server) setTrafficUpstream(w http.ResponseWriter, r *http.Request) {
	if s.m == nil {
		writeErr(w, 503, "服务未就绪")
		return
	}
	var req struct {
		Upstream string   `json:"upstream"`
		Bypass   []string `json:"bypass"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "请求格式错误")
		return
	}
	if err := s.m.SetTrafficUpstream(strings.TrimSpace(req.Upstream), req.Bypass); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	upstream, bypass := s.m.TrafficUpstream()
	writeJSON(w, 200, map[string]any{"ok": true, "upstream": upstream, "bypass": bypass})
}
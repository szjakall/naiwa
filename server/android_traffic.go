package server

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"starry/pcapsum"
)

// 安卓流量：设备端 tcpdump 抓到的 pcap 落在 <data>/captures，这里做列表与解析。
//
// 与 Web 流量页的区别是数据来源：Web 流量来自内置 MITM（已解密），安卓流量来自
// 设备抓包（多为密文），所以这里只呈现"可读的 HTTP 交换 + 其余流量计数"，不假装
// 能解密。

type captureEntry struct {
	Name    string    `json:"name"`
	Size    int64     `json:"size"`
	ModTime time.Time `json:"mod_time"`
	Device  string    `json:"device,omitempty"`
}

func (s *Server) capturesDir() string {
	return filepath.Join(s.dataDir, "captures")
}

// GET /api/android/captures
func (s *Server) androidCaptures(w http.ResponseWriter, r *http.Request) {
	dir := s.capturesDir()
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			writeJSON(w, 200, map[string]any{"captures": []captureEntry{}})
			return
		}
		writeErr(w, 500, err.Error())
		return
	}
	out := make([]captureEntry, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".pcap") {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		item := captureEntry{Name: entry.Name(), Size: info.Size(), ModTime: info.ModTime()}
		// 可选 sidecar：抓包时写下的设备信息
		if meta, err := os.ReadFile(filepath.Join(dir, entry.Name()+".json")); err == nil {
			var m struct {
				Device string `json:"device"`
			}
			if json.Unmarshal(meta, &m) == nil {
				item.Device = m.Device
			}
		}
		out = append(out, item)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ModTime.After(out[j].ModTime) })
	writeJSON(w, 200, map[string]any{"captures": out})
}

// GET /api/android/captures/{name}/flows?limit=500
func (s *Server) androidCaptureFlows(w http.ResponseWriter, r *http.Request) {
	name := filepath.Base(r.PathValue("name"))
	if !strings.HasSuffix(name, ".pcap") {
		writeErr(w, 400, "只支持 .pcap")
		return
	}
	path := filepath.Join(s.capturesDir(), name)
	if _, err := os.Stat(path); err != nil {
		writeErr(w, 404, "抓包不存在")
		return
	}
	limit := 500
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 5000 {
			limit = n
		}
	}
	sum, err := pcapsum.Summarize(path, limit)
	if err != nil {
		writeErr(w, 400, "解析失败："+err.Error())
		return
	}
	writeJSON(w, 200, sum)
}

// POST /api/android/captures/pull {device} —— 抓包进行中先拉一份快照。
// 设备侧 tcpdump 仍在写，这里只是把当前文件读回来；文件名用 live- 前缀区分。
func (s *Server) androidCapturePull(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Device string `json:"device"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	key := strings.TrimSpace(req.Device)
	if key == "" {
		writeErr(w, 400, "缺少 device")
		return
	}
	data, err := s.deviceOpData(r.Context(), key, "capture_pull", nil)
	if err != nil {
		writeErr(w, 502, err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "capture": data})
}

// DELETE /api/android/captures/{name}
func (s *Server) androidCaptureDelete(w http.ResponseWriter, r *http.Request) {
	name := filepath.Base(r.PathValue("name"))
	if !strings.HasSuffix(name, ".pcap") {
		writeErr(w, 400, "只支持 .pcap")
		return
	}
	path := filepath.Join(s.capturesDir(), name)
	if err := os.Remove(path); err != nil {
		writeErr(w, 404, "删除失败："+err.Error())
		return
	}
	_ = os.Remove(path + ".json")
	writeJSON(w, 200, map[string]any{"ok": true})
}

// GET /api/android/captures/{name}/download — 原始 pcap
func (s *Server) androidCaptureDownload(w http.ResponseWriter, r *http.Request) {
	name := filepath.Base(r.PathValue("name"))
	if !strings.HasSuffix(name, ".pcap") {
		writeErr(w, 400, "只支持 .pcap")
		return
	}
	http.ServeFile(w, r, filepath.Join(s.capturesDir(), name))
}
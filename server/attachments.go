package server

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// 附件上传。
//
// 设计取舍：
//   - 先上传到 pending 区（此时可能还没有会话 id），发送消息时再"认领"进会话目录，
//     这样"新建对话 + 上传文件"不需要为了拿 id 先建一条空会话；
//   - 落盘位置在 data 目录下，agent 用 Read / Bash 直接按绝对路径读取（不额外做解析，
//     PDF/图片/压缩包都能拿到原文件）；
//   - 消息正文里附上文件清单（路径 + 大小），让模型知道有什么可读。

const (
	maxAttachmentBytes = 32 << 20 // 单文件 32MB
	pendingDirName     = "pending"
)

// safeFileName 只保留文件名，去掉路径分隔符与控制字符。
func safeFileName(name string) string {
	name = filepath.Base(strings.TrimSpace(name))
	name = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f || r == '/' || r == '\\' {
			return '-'
		}
		return r
	}, name)
	if name == "" || name == "." || name == ".." {
		name = "attachment"
	}
	return name
}

func randomHex(n int) string {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return fmt.Sprintf("%d", os.Getpid())
	}
	return hex.EncodeToString(buf)
}

// POST /api/attachments  (multipart/form-data, field "file")
func (s *Server) uploadAttachment(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxAttachmentBytes+1<<20)
	file, header, err := r.FormFile("file")
	if err != nil {
		writeErr(w, 400, "读取上传内容失败："+err.Error())
		return
	}
	defer file.Close()
	if header.Size > maxAttachmentBytes {
		writeErr(w, 413, fmt.Sprintf("文件超过 %d MB 限制", maxAttachmentBytes>>20))
		return
	}

	id := randomHex(8)
	name := safeFileName(header.Filename)
	dir := filepath.Join(s.dataDir, "attachments", pendingDirName, id)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		writeErr(w, 500, "创建目录失败："+err.Error())
		return
	}
	full := filepath.Join(dir, name)
	dst, err := os.Create(full)
	if err != nil {
		writeErr(w, 500, "写入失败："+err.Error())
		return
	}
	written, err := io.Copy(dst, io.LimitReader(file, maxAttachmentBytes+1))
	_ = dst.Close()
	if err != nil {
		writeErr(w, 500, "写入失败："+err.Error())
		return
	}
	if written > maxAttachmentBytes {
		_ = os.Remove(full)
		writeErr(w, 413, fmt.Sprintf("文件超过 %d MB 限制", maxAttachmentBytes>>20))
		return
	}

	writeJSON(w, 200, map[string]any{
		"id":   id,
		"name": name,
		"size": written,
		"path": full,
	})
}

// claimAttachments 把 pending 区的附件移进会话目录，并返回"给模型看的清单"。
// 路径不合法（已删除 / 不在 pending 下）的条目直接跳过，不让它变成任意文件读取入口。
func (s *Server) claimAttachments(convID int64, paths []string) []string {
	if len(paths) == 0 {
		return nil
	}
	pendRoot := filepath.Join(s.dataDir, "attachments", pendingDirName)
	convDir := filepath.Join(s.dataDir, "attachments", fmt.Sprintf("conv-%d", convID))
	out := make([]string, 0, len(paths))
	for _, p := range paths {
		clean := filepath.Clean(p)
		rel, err := filepath.Rel(pendRoot, clean)
		if err != nil || strings.HasPrefix(rel, "..") {
			continue
		}
		if err := os.MkdirAll(convDir, 0o700); err != nil {
			continue
		}
		target := filepath.Join(convDir, filepath.Base(clean))
		if _, err := os.Stat(target); err == nil {
			// 同名文件：加随机前缀，避免覆盖上一份
			target = filepath.Join(convDir, randomHex(4)+"-"+filepath.Base(clean))
		}
		if err := os.Rename(clean, target); err != nil {
			continue
		}
		out = append(out, target)
		// pending 子目录空了就顺手删掉
		_ = os.Remove(filepath.Dir(clean))
	}
	return out
}

// attachmentNote 生成追加到用户消息末尾的附件清单。
func attachmentNote(paths []string) string {
	if len(paths) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("\n\n[附件]（需要时用 Read 或 Bash 打开，均为本地绝对路径）")
	for _, p := range paths {
		size := int64(0)
		if info, err := os.Stat(p); err == nil {
			size = info.Size()
		}
		fmt.Fprintf(&b, "\n- %s（%s）", p, humanSize(size))
	}
	return b.String()
}

func humanSize(n int64) string {
	switch {
	case n >= 1<<20:
		return fmt.Sprintf("%.1f MB", float64(n)/(1<<20))
	case n >= 1<<10:
		return fmt.Sprintf("%.1f KB", float64(n)/(1<<10))
	default:
		return fmt.Sprintf("%d B", n)
	}
}
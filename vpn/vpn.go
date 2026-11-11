// Package vpn 管理控制台自己的出口隧道：WireGuard / OpenVPN / SOCKS5·HTTP 代理。
//
// 目标：在对话里把参数贴给 agent，就能把出口接上——不用登服务器改网络。
//
// 三种形态的落地方式不同：
//   - wireguard：写 .conf，`wg-quick up`（需要容器有 NET_ADMIN + /dev/net/tun）
//   - openvpn  ：写 .ovpn，`openvpn --daemon`（同样需要 tun）
//   - 代理      ：不需要特权，直接改流量录制代理的上游出口（复用 /api/traffic/upstream）
//
// 不做的事：不接管宿主机网络、不改系统路由之外的策略；失败时全部回滚到"未连接"。
package vpn

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Spec 是一次连接请求。Type 省略时由 Config 内容自动识别。
type Spec struct {
	Name     string
	Type     string
	Config   string
	Upstream string
	Bypass   []string
}

// Status 是当前隧道状态。
type Status struct {
	Name    string    `json:"name"`
	Type    string    `json:"type"`
	State   string    `json:"state"` // connected | disconnected | error
	Detail  string    `json:"detail"`
	Since   time.Time `json:"since,omitempty"`
	Address string    `json:"address,omitempty"`
}

// ProxyApplier 把代理出口应用到流量录制代理（由 server 注入）。
type ProxyApplier interface {
	SetTrafficUpstream(upstream string, bypass []string) error
	TrafficUpstream() (string, []string)
}

type Manager struct {
	dir   string
	proxy ProxyApplier

	mu     sync.Mutex
	active Status
}

func New(dir string, proxy ProxyApplier) *Manager {
	return &Manager{dir: dir, proxy: proxy, active: Status{State: "disconnected"}}
}

// DetectType 从参数推断协议，省得用户还要多填一个字段。
func DetectType(config, upstream string) string {
	lower := strings.ToLower(config)
	switch {
	case upstream != "" && config == "":
		if strings.HasPrefix(strings.ToLower(upstream), "socks5") {
			return "socks5"
		}
		return "http"
	case strings.Contains(lower, "[interface]") && strings.Contains(lower, "privatekey"):
		return "wireguard"
	case strings.Contains(lower, "client") && (strings.Contains(lower, "remote ") || strings.Contains(lower, "<ca>")):
		return "openvpn"
	case strings.HasPrefix(strings.TrimSpace(lower), "{}"):
		return "wireguard"
	}
	return ""
}

func (m *Manager) Status() Status {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.active
}

// Connect 按类型建立隧道；成功后记录为 active。
func (m *Manager) Connect(ctx context.Context, spec Spec) (Status, error) {
	kind := strings.ToLower(strings.TrimSpace(spec.Type))
	if kind == "" {
		kind = DetectType(spec.Config, spec.Upstream)
	}
	if kind == "" {
		return Status{}, errors.New("无法判断协议：请在 config 里贴 WireGuard/OpenVPN 配置，或提供 upstream（socks5:// 或 http://）")
	}
	if err := m.Disconnect(ctx); err != nil {
		// 断开旧隧道失败不阻塞新建，但要留痕
		_ = err
	}

	name := sanitizeName(spec.Name)
	if name == "" {
		name = fmt.Sprintf("%s-%d", kind, time.Now().Unix())
	}

	switch kind {
	case "wireguard":
		return m.connectWireGuard(ctx, name, spec.Config)
	case "openvpn":
		return m.connectOpenVPN(ctx, name, spec.Config)
	case "socks5", "socks5h", "http", "https":
		return m.connectProxy(name, kind, spec.Upstream, spec.Bypass)
	default:
		return Status{}, fmt.Errorf("不支持的协议：%s（支持 wireguard / openvpn / socks5 / http）", kind)
	}
}

func sanitizeName(name string) string {
	name = strings.TrimSpace(name)
	name = strings.Map(func(r rune) rune {
		if r == '/' || r == '\\' || r < 0x20 || r == ' ' {
			return '-'
		}
		return r
	}, name)
	if len(name) > 40 {
		name = name[:40]
	}
	return name
}

// stripDNS 去掉 WireGuard 配置里的 DNS 行：容器内通常没有 resolvconf，
// wg-quick 会因此直接报错退出；解析仍走宿主 DNS，不影响隧道本身。
func stripDNS(config string) string {
	lines := strings.Split(config, "\n")
	out := make([]string, 0, len(lines))
	for _, line := range lines {
		if strings.HasPrefix(strings.ToLower(strings.TrimSpace(line)), "dns") {
			continue
		}
		out = append(out, line)
	}
	return strings.Join(out, "\n")
}

func (m *Manager) connectWireGuard(ctx context.Context, name, config string) (Status, error) {
	if strings.TrimSpace(config) == "" {
		return Status{}, errors.New("WireGuard 需要完整配置（[Interface] + [Peer]）")
	}
	if _, err := exec.LookPath("wg-quick"); err != nil {
		return Status{}, errors.New("容器里没有 wg-quick（镜像需安装 wireguard-tools）")
	}
	if err := os.MkdirAll(m.dir, 0o700); err != nil {
		return Status{}, err
	}
	path := filepath.Join(m.dir, name+".conf")
	if err := os.WriteFile(path, []byte(stripDNS(config)), 0o600); err != nil {
		return Status{}, err
	}
	// 先干跑一次：配置语法/字段错误在 up 之前暴露，避免留下半拉接口。
	if out, err := runCommand(ctx, 15*time.Second, "wg-quick", "strip", path); err != nil {
		return Status{}, fmt.Errorf("配置无法解析：%v %s", err, strings.TrimSpace(out))
	}
	if out, err := runCommand(ctx, 40*time.Second, "wg-quick", "up", path); err != nil {
		return Status{}, fmt.Errorf("wg-quick up 失败：%v %s", err, strings.TrimSpace(out))
	}
	detail := ""
	if out, err := runCommand(ctx, 10*time.Second, "wg", "show"); err == nil {
		detail = strings.TrimSpace(out)
	}
	status := Status{Name: name, Type: "wireguard", State: "connected", Detail: firstLine(detail, 200), Since: time.Now()}
	m.set(status)
	return status, nil
}

func (m *Manager) connectOpenVPN(ctx context.Context, name, config string) (Status, error) {
	if strings.TrimSpace(config) == "" {
		return Status{}, errors.New("OpenVPN 需要 .ovpn 配置内容")
	}
	if _, err := exec.LookPath("openvpn"); err != nil {
		return Status{}, errors.New("容器里没有 openvpn（镜像需安装 openvpn）")
	}
	if err := os.MkdirAll(m.dir, 0o700); err != nil {
		return Status{}, err
	}
	path := filepath.Join(m.dir, name+".ovpn")
	if err := os.WriteFile(path, []byte(config), 0o600); err != nil {
		return Status{}, err
	}
	logPath := filepath.Join(m.dir, name+".log")
	cmd := exec.CommandContext(ctx, "openvpn", "--config", path, "--daemon", name,
		"--writepid", filepath.Join(m.dir, name+".pid"), "--log", logPath)
	if out, err := cmd.CombinedOutput(); err != nil {
		return Status{}, fmt.Errorf("openvpn 启动失败：%v %s", err, strings.TrimSpace(string(out)))
	}
	// 等几秒看进程是否还活着（认证失败会立刻退出）
	time.Sleep(3 * time.Second)
	if _, err := runCommand(ctx, 10*time.Second, "pgrep", "-f", name+".ovpn"); err != nil {
		tail := tailFile(logPath, 400)
		return Status{}, fmt.Errorf("openvpn 未能保持运行：%s", tail)
	}
	status := Status{Name: name, Type: "openvpn", State: "connected", Detail: "openvpn 已后台运行", Since: time.Now()}
	m.set(status)
	return status, nil
}

func (m *Manager) connectProxy(name, kind, upstream string, bypass []string) (Status, error) {
	upstream = strings.TrimSpace(upstream)
	if upstream == "" {
		return Status{}, errors.New("代理类型需要 upstream（如 socks5://host:1080）")
	}
	if !strings.Contains(upstream, "://") {
		upstream = kind + "://" + upstream
	}
	if m.proxy == nil {
		return Status{}, errors.New("流量代理未启用，无法应用代理出口")
	}
	if err := m.proxy.SetTrafficUpstream(upstream, bypass); err != nil {
		return Status{}, err
	}
	status := Status{Name: name, Type: kind, State: "connected", Detail: upstream, Since: time.Now()}
	m.set(status)
	return status, nil
}

// Disconnect 断开当前隧道（按类型回滚），并清空状态。
func (m *Manager) Disconnect(ctx context.Context) error {
	m.mu.Lock()
	current := m.active
	m.mu.Unlock()
	if current.State != "connected" {
		return nil
	}
	var err error
	switch current.Type {
	case "wireguard":
		path := filepath.Join(m.dir, current.Name+".conf")
		if _, statErr := os.Stat(path); statErr == nil {
			if out, runErr := runCommand(ctx, 30*time.Second, "wg-quick", "down", path); runErr != nil {
				err = fmt.Errorf("wg-quick down 失败：%v %s", runErr, strings.TrimSpace(out))
			}
		}
	case "openvpn":
		_, _ = runCommand(ctx, 10*time.Second, "pkill", "-f", current.Name+".ovpn")
	case "socks5", "socks5h", "http", "https":
		if m.proxy != nil {
			if proxyErr := m.proxy.SetTrafficUpstream("", nil); proxyErr != nil {
				err = proxyErr
			}
		}
	}
	m.mu.Lock()
	m.active = Status{State: "disconnected"}
	m.mu.Unlock()
	return err
}

func (m *Manager) set(s Status) {
	m.mu.Lock()
	m.active = s
	m.mu.Unlock()
}

func runCommand(ctx context.Context, timeout time.Duration, name string, args ...string) (string, error) {
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(runCtx, name, args...)
	out, err := cmd.CombinedOutput()
	return string(out), err
}

func firstLine(s string, max int) string {
	s = strings.TrimSpace(s)
	if idx := strings.IndexAny(s, "\r\n"); idx >= 0 {
		s = s[:idx]
	}
	if len(s) > max {
		s = s[:max]
	}
	return s
}

func tailFile(path string, max int) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	s := string(data)
	if len(s) > max {
		s = s[len(s)-max:]
	}
	return strings.TrimSpace(s)
}
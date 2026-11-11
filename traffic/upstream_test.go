package traffic

import (
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// upstreamFor 是"这条请求走直连还是走出口"的唯一判定点，规则错了会静默把流量
// 送到错误链路，所以按行为逐条钉住。
func TestUpstreamFor(t *testing.T) {
	tr := &Traffic{}

	// 1) 未配出口：一律直连
	req := httptest.NewRequest(http.MethodGet, "http://example.com/a", nil)
	got, err := tr.upstreamFor(req)
	if err != nil || got != nil {
		t.Fatalf("未配出口应直连，得到 %v err=%v", got, err)
	}

	// 2) 配了出口：默认走出口
	if err := tr.SetUpstream("socks5://127.0.0.1:1080", nil); err != nil {
		t.Fatalf("SetUpstream: %v", err)
	}
	got, err = tr.upstreamFor(httptest.NewRequest(http.MethodGet, "http://example.com/a", nil))
	if err != nil || got == nil || got.String() != "socks5://127.0.0.1:1080" {
		t.Fatalf("应走出出口，得到 %v err=%v", got, err)
	}

	// 3) 命中绕过后缀：直连（含子域）
	if err := tr.SetUpstream("socks5://127.0.0.1:1080", []string{"internal.corp"}); err != nil {
		t.Fatalf("SetUpstream bypass: %v", err)
	}
	for _, host := range []string{"internal.corp", "a.internal.corp", "deep.a.internal.corp"} {
		got, _ = tr.upstreamFor(httptest.NewRequest(http.MethodGet, "http://"+host+"/x", nil))
		if got != nil {
			t.Fatalf("%s 应命中绕过表直连，得到 %v", host, got)
		}
	}
	// 后缀撞车不应误判
	got, _ = tr.upstreamFor(httptest.NewRequest(http.MethodGet, "http://evil-internal.corp/x", nil))
	if got == nil {
		t.Fatalf("evil-internal.corp 不该命中 internal.corp 后缀")
	}

	// 4) 统计计数
	viaUp, viaBypass, viaDirect := tr.UpstreamStats()
	if viaDirect != 1 || viaUp == 0 || viaBypass == 0 {
		t.Fatalf("统计异常 up=%d bypass=%d direct=%d", viaUp, viaBypass, viaDirect)
	}

	// 5) 清空回直连
	if err := tr.SetUpstream("", nil); err != nil {
		t.Fatalf("SetUpstream empty: %v", err)
	}
	got, _ = tr.upstreamFor(httptest.NewRequest(http.MethodGet, "http://example.com/a", nil))
	if got != nil {
		t.Fatalf("清空后应直连，得到 %v", got)
	}
}

func TestSetUpstreamValidation(t *testing.T) {
	tr := &Traffic{}
	for _, bad := range []string{"ftp://127.0.0.1:21", "socks5://:1080", "://nohost"} {
		if err := tr.SetUpstream(bad, nil); err == nil {
			t.Fatalf("%q 应被拒绝", bad)
		}
	}
	// 不带 scheme 时按 http 处理
	if err := tr.SetUpstream("127.0.0.1:8080", nil); err != nil {
		t.Fatalf("裸地址应被接受: %v", err)
	}
	up, _ := tr.Upstream()
	if up != "http://127.0.0.1:8080" {
		t.Fatalf("裸地址应补全为 http://，得到 %q", up)
	}
}

// ProbeUpstream：TCP 不通要拒绝；SOCKS5 端口但不说 SOCKS5 也要拒绝。
func TestProbeUpstream(t *testing.T) {
	if err := ProbeUpstream("", time.Second); err != nil {
		t.Fatalf("空地址不应探测/报错: %v", err)
	}

	// 一个只说 HTTP 的监听：SOCKS5 探测必须失败
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			_, _ = c.Write([]byte("HTTP/1.1 400 Bad Request\r\n\r\n"))
			_ = c.Close()
		}
	}()
	if err := ProbeUpstream("socks5://"+ln.Addr().String(), time.Second); err == nil {
		t.Fatalf("非 SOCKS5 端口应探测失败")
	}
	if err := ProbeUpstream("http://"+ln.Addr().String(), time.Second); err != nil {
		t.Fatalf("HTTP 出口只需 TCP 可达: %v", err)
	}

	// 关闭的端口：直接失败
	closed, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	addr := closed.Addr().String()
	_ = closed.Close()
	probeErr := ProbeUpstream("http://"+addr, time.Second)
	if probeErr == nil || !strings.Contains(probeErr.Error(), "出口不可达") {
		t.Fatalf("关闭端口应报不可达，得到 %v", probeErr)
	}
}
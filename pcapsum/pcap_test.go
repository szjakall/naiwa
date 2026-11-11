package pcapsum

import (
	"encoding/binary"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

// buildPCAP 造一个最小的 Ethernet/IPv4/TCP pcap：一次 HTTP 请求 + 响应。
// 注意方向：响应必须把源/目的 IP 反过来，否则解析器会把它当成另一条流
// （第一版夹具就是栽在这，导致"每条请求都多一条流"的假象）。
func buildPCAP(t *testing.T, request, response []byte) string {
	t.Helper()

	const (
		clientIP = "10.0.0.1"
		serverIP = "93.184.216.34"
		clientPt = 44000
		serverPt = 80
	)

	ipPacket := func(payload []byte, src, dst string, srcPort, dstPort uint16) []byte {
		total := 20 + 20 + len(payload)
		ip := make([]byte, 20)
		ip[0] = 0x45
		binary.BigEndian.PutUint16(ip[2:4], uint16(total))
		ip[8] = 64
		ip[9] = 6
		copy(ip[12:16], parseIPv4(src))
		copy(ip[16:20], parseIPv4(dst))
		tcp := make([]byte, 20)
		binary.BigEndian.PutUint16(tcp[0:2], srcPort)
		binary.BigEndian.PutUint16(tcp[2:4], dstPort)
		tcp[12] = 5 << 4
		return append(append(ip, tcp...), payload...)
	}

	frame := func(payload []byte, src, dst string, srcPort, dstPort uint16) []byte {
		eth := make([]byte, 14)
		copy(eth[0:6], []byte{0, 1, 2, 3, 4, 5})
		copy(eth[6:12], []byte{6, 7, 8, 9, 10, 11})
		binary.BigEndian.PutUint16(eth[12:14], 0x0800)
		return append(eth, ipPacket(payload, src, dst, srcPort, dstPort)...)
	}

	var out []byte
	header := make([]byte, 24)
	binary.LittleEndian.PutUint32(header[0:4], 0xa1b2c3d4)
	binary.LittleEndian.PutUint16(header[4:6], 2)
	binary.LittleEndian.PutUint16(header[6:8], 4)
	binary.LittleEndian.PutUint32(header[16:20], 65535)
	binary.LittleEndian.PutUint32(header[20:24], 1) // Ethernet
	out = append(out, header...)

	add := func(packet []byte, sec uint32) {
		rec := make([]byte, 16)
		binary.LittleEndian.PutUint32(rec[0:4], sec)
		binary.LittleEndian.PutUint32(rec[8:12], uint32(len(packet)))
		binary.LittleEndian.PutUint32(rec[12:16], uint32(len(packet)))
		out = append(out, rec...)
		out = append(out, packet...)
	}

	add(frame(request, clientIP, serverIP, clientPt, serverPt), 1700000000)
	add(frame(response, serverIP, clientIP, serverPt, clientPt), 1700000001)

	path := filepath.Join(t.TempDir(), "sample.pcap")
	if err := os.WriteFile(path, out, 0o600); err != nil {
		t.Fatalf("write pcap: %v", err)
	}
	return path
}

func parseIPv4(text string) []byte {
	var a, b, c, d byte
	_, _ = fmt.Sscanf(text, "%d.%d.%d.%d", &a, &b, &c, &d)
	return []byte{a, b, c, d}
}

func TestSummarizeHTTP(t *testing.T) {
	req := []byte("GET /login?id=1 HTTP/1.1\r\nHost: example.org\r\nUser-Agent: t\r\n\r\n")
	resp := []byte("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 2\r\n\r\nok")

	sum, err := Summarize(buildPCAP(t, req, resp), 0)
	if err != nil {
		t.Fatalf("Summarize: %v", err)
	}
	if sum.Packets != 2 {
		t.Fatalf("包数=%d", sum.Packets)
	}
	if len(sum.Flows) != 1 {
		t.Fatalf("流数=%d", len(sum.Flows))
	}
	f := sum.Flows[0]
	if f.Method != "GET" || f.Path != "/login?id=1" || f.Name != "example.org" {
		t.Fatalf("请求解析错误: %+v", f)
	}
	if f.Status != "200" || f.ContentType != "text/html" {
		t.Fatalf("响应解析错误: %+v", f)
	}
	if f.ReqBytes != len(req) || f.RespBytes != len(resp) {
		t.Fatalf("字节数 req=%d resp=%d", f.ReqBytes, f.RespBytes)
	}
}

func TestSummarizeTruncatedFile(t *testing.T) {
	path := buildPCAP(t, []byte("GET / HTTP/1.1\r\nHost: a\r\n\r\n"), []byte("HTTP/1.1 204 No Content\r\n\r\n"))
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	// 砍掉最后 8 字节，模拟抓包被中断
	if err := os.WriteFile(path, data[:len(data)-8], 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	sum, err := Summarize(path, 0)
	if err != nil {
		t.Fatalf("截断文件不应报错: %v", err)
	}
	if !sum.Truncated {
		t.Fatalf("应标记截断")
	}
}

func TestSummarizeRejectsNonPCAP(t *testing.T) {
	path := filepath.Join(t.TempDir(), "x.pcap")
	_ = os.WriteFile(path, []byte("not a pcap at all, padding to 24 bytes....."), 0o600)
	if _, err := Summarize(path, 0); err == nil {
		t.Fatalf("非 pcap 应报错")
	}
}

// buildClientHello 造一个带 SNI 的 TLS ClientHello（足够解析器取到 server_name）。
func buildClientHello(host string) []byte {
	name := []byte(host)
	// server_name 扩展体：list_len(2) + type(1) + name_len(2) + name
	listLen := 3 + len(name)
	serverName := append([]byte{byte(listLen >> 8), byte(listLen), 0x00, byte(len(name) >> 8), byte(len(name))}, name...)
	ext := append([]byte{0x00, 0x00, byte(len(serverName) >> 8), byte(len(serverName))}, serverName...)
	extensions := append([]byte{byte(len(ext) >> 8), byte(len(ext))}, ext...)

	body := []byte{0x03, 0x03}
	body = append(body, make([]byte, 32)...)          // random
	body = append(body, 32)                            // session id len
	body = append(body, make([]byte, 32)...)           // session id
	body = append(body, 0x00, 0x04, 0x13, 0x01, 0x13, 0x02) // cipher suites
	body = append(body, 0x01, 0x00)                    // compression
	body = append(body, extensions...)

	handshake := append([]byte{0x01, byte(len(body) >> 16), byte(len(body) >> 8), byte(len(body))}, body...)
	record := append([]byte{0x16, 0x03, 0x01, byte(len(handshake) >> 8), byte(len(handshake))}, handshake...)
	return record
}

func TestTLSSNI(t *testing.T) {
	hello := buildClientHello("example.org")
	if got := tlsSNI(hello); got != "example.org" {
		t.Fatalf("SNI 解析失败: %q", got)
	}
	if got := tlsSNI([]byte{0x16, 0x03, 0x01, 0, 5, 0x02}); got != "" {
		t.Fatalf("非 ClientHello 应返回空，得到 %q", got)
	}
}

func TestSummarizeTLSFlow(t *testing.T) {
	hello := buildClientHello("api.example.org")
	path := buildPCAP(t, hello, []byte{0x16, 0x03, 0x03, 0x00, 0x04, 0x0e, 0x00, 0x00, 0x00})
	sum, err := Summarize(path, 0)
	if err != nil {
		t.Fatalf("Summarize: %v", err)
	}
	if len(sum.Flows) != 1 {
		t.Fatalf("流数=%d", len(sum.Flows))
	}
	flow := sum.Flows[0]
	if flow.Kind != "tls" || !flow.TLS {
		t.Fatalf("应识别为 TLS: %+v", flow)
	}
	if flow.Name != "api.example.org" {
		t.Fatalf("SNI 名称=%q", flow.Name)
	}
	if sum.TLSFlows != 1 {
		t.Fatalf("TLS 计数=%d", sum.TLSFlows)
	}
}

// DNS 查询应作为独立条目出现，并能给同 IP 的连接补上域名。
func TestSummarizeDNS(t *testing.T) {
	query := []byte{
		0x12, 0x34, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
		0x07, 'e', 'x', 'a', 'm', 'p', 'l', 'e',
		0x03, 'c', 'o', 'm', 0x00,
		0x00, 0x01, 0x00, 0x01,
	}
	frame := udpFrame(query, 55555, 53)
	path := buildRawPCAP(t, frame)
	sum, err := Summarize(path, 0)
	if err != nil {
		t.Fatalf("Summarize: %v", err)
	}
	if sum.DNSQueries != 1 {
		t.Fatalf("DNS 计数=%d", sum.DNSQueries)
	}
	if len(sum.Flows) != 1 || sum.Flows[0].Name != "example.com" {
		t.Fatalf("DNS 记录=%+v", sum.Flows)
	}
}

// udpFrame 造一个 IPv4/UDP 帧（Ethernet 头）。
func udpFrame(payload []byte, srcPort, dstPort uint16) []byte {
	total := 20 + 8 + len(payload)
	ip := make([]byte, 20)
	ip[0] = 0x45
	binary.BigEndian.PutUint16(ip[2:4], uint16(total))
	ip[8] = 64
	ip[9] = 17
	copy(ip[12:16], parseIPv4("10.0.0.1"))
	copy(ip[16:20], parseIPv4("8.8.8.8"))
	udp := make([]byte, 8)
	binary.BigEndian.PutUint16(udp[0:2], srcPort)
	binary.BigEndian.PutUint16(udp[2:4], dstPort)
	binary.BigEndian.PutUint16(udp[4:6], uint16(8+len(payload)))
	eth := make([]byte, 14)
	binary.BigEndian.PutUint16(eth[12:14], 0x0800)
	return append(append(eth, ip...), append(udp, payload...)...)
}

// buildRawPCAP 把单帧写成 pcap（Ethernet 链路层）。
func buildRawPCAP(t *testing.T, frame []byte) string {
	t.Helper()
	out := make([]byte, 24)
	binary.LittleEndian.PutUint32(out[0:4], 0xa1b2c3d4)
	binary.LittleEndian.PutUint16(out[4:6], 2)
	binary.LittleEndian.PutUint16(out[6:8], 4)
	binary.LittleEndian.PutUint32(out[16:20], 65535)
	binary.LittleEndian.PutUint32(out[20:24], 1)
	rec := make([]byte, 16)
	binary.LittleEndian.PutUint32(rec[0:4], 1700000200)
	binary.LittleEndian.PutUint32(rec[8:12], uint32(len(frame)))
	binary.LittleEndian.PutUint32(rec[12:16], uint32(len(frame)))
	out = append(out, rec...)
	out = append(out, frame...)
	path := filepath.Join(t.TempDir(), "udp.pcap")
	if err := os.WriteFile(path, out, 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	return path
}

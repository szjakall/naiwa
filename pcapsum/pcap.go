// Package pcapsum 把设备端 tcpdump 抓到的 pcap 归纳成"能看的流量"。
//
// 设备抓包只拿到链路层原始字节；控制台需要的是一行一条连接：谁连了谁、什么协议、
// 多少字节、能读出什么（HTTP 的方法/路径、TLS 的 SNI、DNS 的域名）。
//
// 明确不做的事：TLS 解密。现代 App 与浏览器几乎全是 HTTPS，要求"抓包页面必须有内容"
// 又不许解密的前提下，正确做法是把连接本身完整呈现（SNI + 字节数 + 时序），而不是
// 因为没有明文就显示空白。
package pcapsum

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"os"
	"sort"
	"strings"
	"time"
)

// Flow 是一条连接（HTTP 交换、TLS 会话、DNS 查询或普通 TCP）。
type Flow struct {
	Time        time.Time `json:"time"`
	Last        time.Time `json:"last"`
	Src         string    `json:"src"`
	Dst         string    `json:"dst"`
	SrcPort     int       `json:"src_port"`
	DstPort     int       `json:"dst_port"`
	Kind        string    `json:"kind"` // http | tls | dns | quic | tcp
	Name        string    `json:"name"` // SNI / DNS 域名 / HTTP Host
	Method      string    `json:"method"`
	Path        string    `json:"path"`
	Status      string    `json:"status"`
	ContentType string    `json:"content_type"`
	ReqBytes    int       `json:"req_bytes"`
	RespBytes   int       `json:"resp_bytes"`
	Packets     int       `json:"packets"`
	TLS         bool      `json:"tls"`
	// 分方向展示：请求包 = 客户端→服务端，响应包 = 服务端→客户端。
	// 之前只有一份合并预览，二进制协议时看不出哪半边是请求，改成两栏。
	Preview     string    `json:"preview"`
	Hex         string    `json:"hex,omitempty"`
	ReqPreview  string    `json:"req_preview"`
	RespPreview string    `json:"resp_preview"`
	ReqHex      string    `json:"req_hex,omitempty"`
	RespHex     string    `json:"resp_hex,omitempty"`
}

// Summary 是整份抓包的统计。
type Summary struct {
	Flows      []Flow `json:"flows"`
	Packets    int    `json:"packets"`
	HTTPFlows  int    `json:"http_flows"`
	TLSFlows   int    `json:"tls_flows"`
	DNSQueries int    `json:"dns_queries"`
	QUICFlows  int    `json:"quic_flows"`
	OtherTCP   int    `json:"other_tcp"`
	Truncated  bool   `json:"truncated"`
}

const (
	linkTypeEthernet = 1
	linkTypeRaw      = 101
	linkTypeSLL      = 113
	linkTypeSLL2     = 276
	previewLimit     = 2048
	maxFlows         = 5000
)

// Summarize 解析一个 pcap 文件，最多返回 limit 条流（limit<=0 用默认值）。
func Summarize(path string, limit int) (*Summary, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	if limit <= 0 || limit > maxFlows {
		limit = maxFlows
	}
	return parse(bufio.NewReaderSize(file, 1<<20), limit)
}

// dnsNames 记录观察到的 IP → 域名（来自 DNS 应答）与查询记录。
type dnsNames struct {
	byIP    map[string]string
	queries []Flow
}

func parse(reader *bufio.Reader, limit int) (*Summary, error) {
	header := make([]byte, 24)
	if _, err := io.ReadFull(reader, header); err != nil {
		return nil, fmt.Errorf("读取 pcap 头失败: %w", err)
	}
	var order binary.ByteOrder
	switch binary.LittleEndian.Uint32(header[0:4]) {
	case 0xa1b2c3d4:
		order = binary.LittleEndian
	case 0xd4c3b2a1:
		order = binary.BigEndian
	case 0xa1b23c4d, 0x4d3cb2a1:
		return nil, fmt.Errorf("暂不支持纳秒精度 pcap（请用 tcpdump -w 默认精度）")
	default:
		return nil, fmt.Errorf("不是 pcap 文件（magic=%x）", header[0:4])
	}
	linkType := order.Uint32(header[20:24])

	sum := &Summary{Flows: []Flow{}}
	names := &dnsNames{byIP: map[string]string{}}
	streams := map[string]*stream{}

	recordHeader := make([]byte, 16)
	for {
		if _, err := io.ReadFull(reader, recordHeader); err != nil {
			break // EOF 或截断，按已解析的数据返回
		}
		tsSec := order.Uint32(recordHeader[0:4])
		tsUsec := order.Uint32(recordHeader[4:8])
		inclLen := order.Uint32(recordHeader[8:12])
		if inclLen == 0 || inclLen > 262144 {
			sum.Truncated = true
			break
		}
		packet := make([]byte, inclLen)
		if _, err := io.ReadFull(reader, packet); err != nil {
			sum.Truncated = true
			break
		}
		sum.Packets++

		pkt, ok := decode(packet, linkType)
		if !ok {
			continue
		}
		ts := time.Unix(int64(tsSec), int64(tsUsec)*1000)

		if pkt.proto == 17 { // UDP
			switch {
			case pkt.dstPort == 53 && len(pkt.payload) > 12:
				if flow, ok := parseDNS(pkt, ts); ok {
					sum.DNSQueries++
					names.queries = append(names.queries, flow)
					collectAnswers(pkt.payload, names.byIP)
				}
			case pkt.dstPort == 443 || pkt.srcPort == 443:
				sum.QUICFlows++
			}
			continue
		}
		if pkt.proto != 6 || len(pkt.payload) == 0 { // TCP
			continue
		}

		key := fmt.Sprintf("%s:%d>%s:%d", pkt.srcIP, pkt.srcPort, pkt.dstIP, pkt.dstPort)
		pair := fmt.Sprintf("%s:%d>%s:%d", pkt.dstIP, pkt.dstPort, pkt.srcIP, pkt.srcPort)
		st, exists := streams[key]
		if !exists {
			if peer, hasPeer := streams[pair]; hasPeer {
				peer.accumulate(pkt.payload, ts, false)
				continue
			}
			st = &stream{
				src: pkt.srcIP, dst: pkt.dstIP,
				srcPort: pkt.srcPort, dstPort: pkt.dstPort,
				first: ts,
			}
			streams[key] = st
		}
		st.accumulate(pkt.payload, ts, true)
	}

	for _, st := range streams {
		flow, ok := st.finish(names.byIP)
		if !ok {
			continue
		}
		switch flow.Kind {
		case "http":
			sum.HTTPFlows++
		case "tls":
			sum.TLSFlows++
		default:
			sum.OtherTCP++
		}
		sum.Flows = append(sum.Flows, flow)
	}
	sum.Flows = append(sum.Flows, names.queries...)
	sort.Slice(sum.Flows, func(i, j int) bool { return sum.Flows[i].Time.Before(sum.Flows[j].Time) })
	if len(sum.Flows) > limit {
		sum.Flows = sum.Flows[:limit]
		sum.Truncated = true
	}
	return sum, nil
}

type decoded struct {
	proto            uint8
	srcIP, dstIP     string
	srcPort, dstPort uint16
	payload          []byte
}

type stream struct {
	src, dst         string
	srcPort, dstPort uint16
	req, resp        []byte
	first, last      time.Time
	requestHit       bool
	responseHit      bool
	sni              string
	packets          int
}

// accumulate 记录一段载荷。fromClient 决定它归到请求还是响应：
// 二进制协议没有请求行可嗅探，只能靠方向——之前按内容猜，导致响应被塞进请求、
// 页面显示"↓0 B"。
func (s *stream) accumulate(payload []byte, ts time.Time, fromClient bool) {
	if s.first.IsZero() {
		s.first = ts
	}
	s.last = ts
	s.packets++

	if fromClient {
		s.req = appendLimited(s.req, payload)
		if looksLikeRequest(payload) {
			s.requestHit = true
		}
	} else {
		s.resp = appendLimited(s.resp, payload)
		if looksLikeResponse(payload) {
			s.responseHit = true
		}
	}
	if s.sni == "" && looksLikeTLS(payload) {
		s.sni = tlsSNI(payload)
	}
}

func appendLimited(dst, src []byte) []byte {
	const limit = 64 << 10
	if len(dst) >= limit {
		return dst
	}
	room := limit - len(dst)
	if len(src) > room {
		src = src[:room]
	}
	return append(dst, src...)
}

func (s *stream) finish(byIP map[string]string) (Flow, bool) {
	if s.packets == 0 {
		return Flow{}, false
	}
	flow := Flow{
		Time: s.first, Last: s.last,
		Src: s.src, Dst: s.dst, SrcPort: int(s.srcPort), DstPort: int(s.dstPort),
		ReqBytes: len(s.req), RespBytes: len(s.resp), Packets: s.packets,
		Kind: "tcp",
		ReqPreview:  preview(s.req),
		RespPreview: preview(s.resp),
	}
	if flow.ReqPreview == "" && len(s.req) > 0 {
		flow.ReqHex = hexDump(s.req)
	}
	if flow.RespPreview == "" && len(s.resp) > 0 {
		flow.RespHex = hexDump(s.resp)
	}

	switch {
	case s.requestHit:
		method, path, host := parseRequestLine(s.req)
		flow.Kind = "http"
		flow.Method, flow.Path, flow.Name = method, path, host
		if s.responseHit {
			flow.Status, flow.ContentType = parseResponseHead(s.resp)
		}
		head := append([]byte{}, s.req[:min(len(s.req), 1024)]...)
		head = append(head, s.resp[:min(len(s.resp), 512)]...)
		flow.Preview = preview(bytes.TrimSpace(head))
		if flow.Preview == "" {
			flow.Hex = hexDump(bytes.TrimSpace(head))
		}
	case looksLikeTLS(s.req) || looksLikeTLS(s.resp):
		flow.Kind = "tls"
		flow.TLS = true
		flow.Name = s.sni
		if flow.Name == "" {
			flow.Name = byIP[s.dst]
		}
	default:
		flow.Name = byIP[s.dst]
		if len(s.req)+len(s.resp) < 32 {
			return Flow{}, false
		}
	}

	// 兼容字段：合并预览取请求优先，供旧调用方/旧前端使用。
	if flow.Preview == "" {
		flow.Preview = flow.ReqPreview
	}
	if flow.Hex == "" {
		flow.Hex = flow.ReqHex
	}
	return flow, true
}

// ---------- 协议识别 ----------

func looksLikeRequest(payload []byte) bool {
	for _, method := range []string{"GET ", "POST ", "PUT ", "HEAD ", "DELETE ", "PATCH ", "OPTIONS ", "CONNECT ", "TRACE "} {
		if bytes.HasPrefix(payload, []byte(method)) {
			return true
		}
	}
	return false
}

func looksLikeResponse(payload []byte) bool {
	return bytes.HasPrefix(payload, []byte("HTTP/"))
}

func looksLikeTLS(payload []byte) bool {
	if len(payload) < 5 || payload[1] != 0x03 {
		return false
	}
	// 0x16 握手 / 0x14 变更密码套件 / 0x17 应用数据：都属 TLS 记录层。
	switch payload[0] {
	case 0x14, 0x15, 0x16, 0x17:
		return true
	}
	return false
}

// tlsSNI 从 ClientHello 里取 server_name。取不到就返回空串（不猜域名）。
func tlsSNI(data []byte) string {
	if len(data) < 5+4+2+32 {
		return ""
	}
	offset := 5
	if data[offset] != 0x01 { // handshake: client_hello
		return ""
	}
	offset += 4      // handshake header
	offset += 2 + 32 // version + random
	if offset >= len(data) {
		return ""
	}
	sessionLen := int(data[offset])
	offset += 1 + sessionLen
	if offset+2 > len(data) {
		return ""
	}
	cipherLen := int(binary.BigEndian.Uint16(data[offset : offset+2]))
	offset += 2 + cipherLen
	if offset >= len(data) {
		return ""
	}
	compLen := int(data[offset])
	offset += 1 + compLen
	if offset+2 > len(data) {
		return ""
	}
	extLen := int(binary.BigEndian.Uint16(data[offset : offset+2]))
	offset += 2
	end := offset + extLen
	if end > len(data) {
		end = len(data)
	}
	for offset+4 <= end {
		extType := binary.BigEndian.Uint16(data[offset : offset+2])
		extSize := int(binary.BigEndian.Uint16(data[offset+2 : offset+4]))
		offset += 4
		if offset+extSize > end {
			return ""
		}
		if extType == 0x0000 { // server_name
			body := data[offset : offset+extSize]
			if len(body) < 5 {
				return ""
			}
			nameLen := int(binary.BigEndian.Uint16(body[3:5]))
			if 5+nameLen > len(body) {
				return ""
			}
			return string(body[5 : 5+nameLen])
		}
		offset += extSize
	}
	return ""
}

func parseRequestLine(data []byte) (method, path, host string) {
	lines := headerLines(data)
	if len(lines) == 0 {
		return "", "", ""
	}
	parts := strings.SplitN(lines[0], " ", 3)
	if len(parts) >= 2 {
		method, path = parts[0], parts[1]
	}
	for _, line := range lines[1:] {
		if len(line) > 5 && strings.EqualFold(line[:5], "Host:") {
			host = strings.TrimSpace(line[5:])
			break
		}
	}
	return method, path, host
}

func parseResponseHead(data []byte) (status, contentType string) {
	lines := headerLines(data)
	if len(lines) == 0 {
		return "", ""
	}
	parts := strings.SplitN(lines[0], " ", 3)
	if len(parts) >= 2 && strings.HasPrefix(parts[0], "HTTP/") {
		status = parts[1]
	}
	for _, line := range lines[1:] {
		if len(line) > 13 && strings.EqualFold(line[:13], "Content-Type:") {
			contentType = strings.TrimSpace(line[13:])
			break
		}
	}
	return status, contentType
}

// headerLines 返回头部区域的各行（到空行为止），避免在正文里误匹配 "Host:"。
func headerLines(data []byte) []string {
	text := string(data)
	if idx := strings.Index(text, "\r\n\r\n"); idx >= 0 {
		text = text[:idx]
	} else if idx := strings.Index(text, "\n\n"); idx >= 0 {
		text = text[:idx]
	}
	raw := strings.Split(text, "\n")
	out := make([]string, 0, len(raw))
	for _, line := range raw {
		out = append(out, strings.TrimSuffix(line, "\r"))
	}
	return out
}

// ---------- DNS ----------

func parseDNS(pkt decoded, ts time.Time) (Flow, bool) {
	if pkt.srcPort == 53 { // 应答方向会重复同一次查询
		return Flow{}, false
	}
	name, qtype := dnsQuestion(pkt.payload)
	if name == "" {
		return Flow{}, false
	}
	return Flow{
		Time: ts, Last: ts,
		Src: pkt.srcIP, Dst: pkt.dstIP,
		SrcPort: int(pkt.srcPort), DstPort: int(pkt.dstPort),
		Kind: "dns", Name: name, Packets: 1,
		Preview: fmt.Sprintf("DNS query %s (type %d)", name, qtype),
	}, true
}

// dnsQuestion 解析查询名（问题区不使用压缩指针）。
func dnsQuestion(payload []byte) (string, int) {
	if len(payload) < 13 {
		return "", 0
	}
	offset := 12
	var labels []string
	for offset < len(payload) {
		length := int(payload[offset])
		offset++
		if length == 0 {
			break
		}
		if length > 63 || offset+length > len(payload) {
			return "", 0
		}
		labels = append(labels, string(payload[offset:offset+length]))
		offset += length
	}
	if offset+2 > len(payload) {
		return "", 0
	}
	qtype := int(binary.BigEndian.Uint16(payload[offset : offset+2]))
	return strings.Join(labels, "."), qtype
}

// collectAnswers 从 DNS 应答里取 A/AAAA 记录，建立 IP → 域名映射。
func collectAnswers(payload []byte, byIP map[string]string) {
	if len(payload) < 12 {
		return
	}
	flags := binary.BigEndian.Uint16(payload[2:4])
	if flags&0x8000 == 0 { // 不是应答
		return
	}
	qd := int(binary.BigEndian.Uint16(payload[4:6]))
	an := int(binary.BigEndian.Uint16(payload[6:8]))
	if an == 0 {
		return
	}
	offset := 12
	for i := 0; i < qd; i++ {
		for offset < len(payload) {
			length := int(payload[offset])
			offset++
			if length == 0 {
				break
			}
			offset += length
		}
		offset += 4
	}
	for i := 0; i < an && offset+12 <= len(payload); i++ {
		name := ""
		if payload[offset]&0xC0 == 0xC0 {
			pointer := int(binary.BigEndian.Uint16(payload[offset:offset+2]) & 0x3FFF)
			name = dnsNameAt(payload, pointer)
			offset += 2
		} else {
			start := offset
			for offset < len(payload) {
				length := int(payload[offset])
				offset++
				if length == 0 {
					break
				}
				offset += length
			}
			name = dnsNameAt(payload, start)
		}
		if offset+10 > len(payload) {
			return
		}
		rtype := binary.BigEndian.Uint16(payload[offset : offset+2])
		rdLength := int(binary.BigEndian.Uint16(payload[offset+8 : offset+10]))
		offset += 10
		if offset+rdLength > len(payload) {
			return
		}
		switch rtype {
		case 1: // A
			if rdLength == 4 && name != "" {
				byIP[net.IP(payload[offset:offset+4]).String()] = name
			}
		case 28: // AAAA
			if rdLength == 16 && name != "" {
				byIP[net.IP(payload[offset:offset+16]).String()] = name
			}
		}
		offset += rdLength
	}
}

func dnsNameAt(payload []byte, offset int) string {
	var labels []string
	for offset < len(payload) {
		length := int(payload[offset])
		offset++
		if length == 0 {
			break
		}
		if length > 63 || offset+length > len(payload) {
			return ""
		}
		labels = append(labels, string(payload[offset:offset+length]))
		offset += length
	}
	return strings.Join(labels, ".")
}

// preview 只对"像文本"的载荷返回可读内容；二进制/密文返回空串，
// 由 hexDump 给出十六进制视图——把密文渲染成一屏点号既看不懂也误导人。
func preview(data []byte) string {
	if len(data) > previewLimit {
		data = data[:previewLimit]
	}
	if len(data) == 0 || printableRatio(data) < 0.7 {
		return ""
	}
	var b strings.Builder
	for _, c := range data {
		if c == '\n' || c == '\r' || c == '\t' || (c >= 0x20 && c < 0x7f) {
			b.WriteByte(c)
		} else {
			b.WriteByte('.')
		}
	}
	return b.String()
}

func printableRatio(data []byte) float64 {
	if len(data) == 0 {
		return 0
	}
	printable := 0
	for _, c := range data {
		if c == '\n' || c == '\r' || c == '\t' || (c >= 0x20 && c < 0x7f) {
			printable++
		}
	}
	return float64(printable) / float64(len(data))
}

// hexDump 输出 16 字节一行的经典十六进制视图（最多 512 字节）。
func hexDump(data []byte) string {
	const limit = 512
	if len(data) > limit {
		data = data[:limit]
	}
	if len(data) == 0 {
		return ""
	}
	var b strings.Builder
	for offset := 0; offset < len(data); offset += 16 {
		end := offset + 16
		if end > len(data) {
			end = len(data)
		}
		b.WriteString(fmt.Sprintf("%08x  ", offset))
		for i := offset; i < offset+16; i++ {
			if i < end {
				b.WriteString(fmt.Sprintf("%02x ", data[i]))
			} else {
				b.WriteString("   ")
			}
			if (i-offset)%8 == 7 {
				b.WriteString(" ")
			}
		}
		b.WriteString(" |")
		for i := offset; i < end; i++ {
			c := data[i]
			if c >= 0x20 && c < 0x7f {
				b.WriteByte(c)
			} else {
				b.WriteByte('.')
			}
		}
		b.WriteString("|\n")
	}
	return strings.TrimRight(b.String(), "\n")
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// ---------- 链路层 ----------

func decode(packet []byte, linkType uint32) (decoded, bool) {
	var offset int
	switch linkType {
	case linkTypeEthernet:
		if len(packet) < 14 {
			return decoded{}, false
		}
		offset = 14
		etherType := binary.BigEndian.Uint16(packet[12:14])
		for etherType == 0x8100 && len(packet) >= offset+4 {
			etherType = binary.BigEndian.Uint16(packet[offset+2 : offset+4])
			offset += 4
		}
		if etherType != 0x0800 {
			return decoded{}, false
		}
	case linkTypeSLL:
		if len(packet) < 16 {
			return decoded{}, false
		}
		offset = 16
		if binary.BigEndian.Uint16(packet[14:16]) != 0x0800 {
			return decoded{}, false
		}
	case linkTypeSLL2:
		if len(packet) < 20 {
			return decoded{}, false
		}
		offset = 20
		if binary.BigEndian.Uint16(packet[0:2]) != 0x0800 {
			return decoded{}, false
		}
	case linkTypeRaw:
		offset = 0
	default:
		offset = 14
	}

	ip := packet[offset:]
	if len(ip) < 20 || ip[0]>>4 != 4 {
		return decoded{}, false
	}
	ihl := int(ip[0]&0x0f) * 4
	if ihl < 20 || len(ip) < ihl {
		return decoded{}, false
	}
	totalLen := int(binary.BigEndian.Uint16(ip[2:4]))
	if totalLen > 0 && totalLen < len(ip) {
		ip = ip[:totalLen]
	}
	out := decoded{
		proto: ip[9],
		srcIP: fmt.Sprintf("%d.%d.%d.%d", ip[12], ip[13], ip[14], ip[15]),
		dstIP: fmt.Sprintf("%d.%d.%d.%d", ip[16], ip[17], ip[18], ip[19]),
	}
	transport := ip[ihl:]
	switch out.proto {
	case 6: // TCP
		if len(transport) < 20 {
			return decoded{}, false
		}
		out.srcPort = binary.BigEndian.Uint16(transport[0:2])
		out.dstPort = binary.BigEndian.Uint16(transport[2:4])
		dataOffset := int(transport[12]>>4) * 4
		if dataOffset < 20 || len(transport) < dataOffset {
			return decoded{}, false
		}
		out.payload = transport[dataOffset:]
		return out, true
	case 17: // UDP
		if len(transport) < 8 {
			return decoded{}, false
		}
		out.srcPort = binary.BigEndian.Uint16(transport[0:2])
		out.dstPort = binary.BigEndian.Uint16(transport[2:4])
		out.payload = transport[8:]
		return out, true
	}
	return decoded{}, false
}
package droid

import (
	"context"
	"log"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"sync"
	"sync/atomic"
	"time"
)

// Tunnel 是一条到设备侧服务的双向字节通道（frida-server 之类）。
//
// 用途：设备上的服务只监听本机回环，控制台不能直连；由设备反连通道承载字节流，
// 服务端在本地起一个监听端口，把连上来的客户端与设备侧 socket 对接。
//
// 数据帧不带 reqId（协议规定），按 connId 寻址，所以隧道复用同一批帧格式。
type Tunnel struct {
	device *Device
	connID string

	mu     sync.Mutex
	buf    []byte
	closed bool
	err    error

	dataCh  chan []byte
	closeCh chan struct{}
	opened  chan error
	once    sync.Once
}

func newTunnel(device *Device, connID string) *Tunnel {
	return &Tunnel{
		device:  device,
		connID:  connID,
		dataCh:  make(chan []byte, 64),
		closeCh: make(chan struct{}),
		opened:  make(chan error, 1),
	}
}

// Read 从设备侧读（阻塞直到有数据或通道关闭）。
func (t *Tunnel) Read(p []byte) (int, error) {
	for {
		t.mu.Lock()
		if len(t.buf) > 0 {
			n := copy(p, t.buf)
			t.buf = t.buf[n:]
			t.mu.Unlock()
			return n, nil
		}
		closed, err := t.closed, t.err
		t.mu.Unlock()
		if closed {
			if err == nil {
				err = io.EOF
			}
			return 0, err
		}
		select {
		case chunk := <-t.dataCh:
			t.mu.Lock()
			t.buf = append(t.buf, chunk...)
			t.mu.Unlock()
		case <-t.closeCh:
			// 标记关闭后把剩余缓冲读完再返回 EOF。
			t.mu.Lock()
			t.closed = true
			t.mu.Unlock()
		}
	}
}

// Write 把字节发到设备侧 socket。
func (t *Tunnel) Write(p []byte) (int, error) {
	select {
	case <-t.closeCh:
		return 0, io.ErrClosedPipe
	default:
	}
	log.Printf("[tunnel] send conn=%s bytes=%d", t.connID, len(p))
	if err := t.device.send(map[string]any{
		"t": "tcp_send", "tunnelId": tunnelID, "connId": t.connID,
		"b64": b64Std.EncodeToString(p),
	}); err != nil {
		log.Printf("[tunnel] send failed conn=%s err=%v", t.connID, err)
		return 0, err
	}
	return len(p), nil
}

// Close 关闭隧道两端。
func (t *Tunnel) Close() error {
	t.once.Do(func() {
		close(t.closeCh)
		_ = t.device.send(map[string]any{"t": "tcp_close", "tunnelId": tunnelID, "connId": t.connID})
		t.device.dropTunnel(t.connID)
	})
	return nil
}

func (t *Tunnel) push(chunk []byte) {
	select {
	case t.dataCh <- chunk:
	case <-t.closeCh:
	}
}

const tunnelID = "starry"

var connSeq int64

// OpenTunnel 让设备连到 host:port，并返回双向通道。
func (d *Device) OpenTunnel(ctx context.Context, host string, port int, timeout time.Duration) (*Tunnel, error) {
	if d.conn == nil {
		return nil, errors.New("设备不在线")
	}
	raw := make([]byte, 6)
	_, _ = rand.Read(raw)
	connID := hex.EncodeToString(raw)

	tunnel := newTunnel(d, connID)
	d.mu.Lock()
	if d.tunnels == nil {
		d.tunnels = map[string]*Tunnel{}
	}
	d.tunnels[connID] = tunnel
	d.mu.Unlock()

	reqID := fmt.Sprintf("t%d", atomic.AddInt64(&reqSeq, 1))
	if err := d.send(map[string]any{
		"t": "tcp_open", "reqId": reqID, "tunnelId": tunnelID,
		"connId": connID, "host": host, "port": port,
	}); err != nil {
		d.dropTunnel(connID)
		return nil, fmt.Errorf("下发失败：%w", err)
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case err := <-tunnel.opened:
		if err != nil {
			d.dropTunnel(connID)
			return nil, err
		}
		return tunnel, nil
	case <-timer.C:
		d.dropTunnel(connID)
		return nil, fmt.Errorf("设备在 %s 内未确认隧道", timeout)
	case <-ctx.Done():
		d.dropTunnel(connID)
		return nil, ctx.Err()
	}
}

func (d *Device) dropTunnel(connID string) {
	d.mu.Lock()
	delete(d.tunnels, connID)
	d.mu.Unlock()
}

func (d *Device) tunnel(connID string) *Tunnel {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.tunnels[connID]
}
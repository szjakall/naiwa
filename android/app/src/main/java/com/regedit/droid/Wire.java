package com.regedit.droid;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URI;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;
import java.util.concurrent.atomic.AtomicBoolean;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/**
 * 最小 WebSocket 客户端（RFC 6455）。
 *
 * 为什么不用 OkHttp：APK 里多一个几百 KB 的依赖只为一条长连接不值当；而且把协议
 * 换成自研之后，同一份代码能在 PC 上跑（只依赖 java.base），协议行为可以被端到端
 * 测试，而不是"装到手机上再说"。
 *
 * 支持：握手校验、掩码发帧、分片收帧、ping 回 pong、close 握手、wss（自签证书放行）。
 * 不支持：permessage-deflate（regedit 网关本来也不协商扩展）。
 */
public final class Wire {

    /** 收帧回调。回调跑在读线程上，不要在里面做长耗时操作。 */
    public interface Listener {
        void onOpen();

        void onText(String text);

        void onClosed(int code, String reason);

        void onError(String message);
    }

    private static final int OP_TEXT = 0x1;
    private static final int OP_BINARY = 0x2;
    private static final int OP_CLOSE = 0x8;
    private static final int OP_PING = 0x9;
    private static final int OP_PONG = 0xA;

    private final URI uri;
    private final String token;
    private final String deviceId;
    private final Listener listener;
    private final SecureRandom random = new SecureRandom();

    private Socket socket;
    private InputStream in;
    private OutputStream out;
    private final AtomicBoolean closed = new AtomicBoolean(false);
    private final AtomicBoolean open = new AtomicBoolean(false);

    public Wire(String url, String token, String deviceId, Listener listener) {
        this.uri = URI.create(url);
        this.token = token;
        this.deviceId = deviceId;
        this.listener = listener;
    }

    public boolean isOpen() {
        return open.get() && !closed.get();
    }

    // ---------------------------------------------------------------- 连接

    /** 建连 + 握手。失败抛 IOException，由上层退避重试。 */
    public void connect(int timeoutMs) throws IOException {
        String scheme = uri.getScheme() == null ? "ws" : uri.getScheme().toLowerCase();
        boolean tls = scheme.equals("wss") || scheme.equals("https");
        String host = uri.getHost();
        int port = uri.getPort() > 0 ? uri.getPort() : (tls ? 443 : 80);
        if (host == null) throw new IOException("地址缺少主机名");

        Socket raw = new Socket();
        raw.connect(new InetSocketAddress(host, port), timeoutMs);
        raw.setTcpNoDelay(true);
        raw.setSoTimeout(0);
        socket = tls ? wrapTls(raw, host, port) : raw;
        in = socket.getInputStream();
        out = socket.getOutputStream();

        String key = newKey();
        String path = (uri.getRawPath() == null || uri.getRawPath().isEmpty()) ? "/" : uri.getRawPath();
        String query = uri.getRawQuery();
        if (query != null && !query.isEmpty()) path = path + "?" + query;
        path = appendParam(path, "token", token);
        path = appendParam(path, "deviceId", deviceId);

        String hostHeader = (port == 80 || port == 443) ? host : host + ":" + port;
        String request = "GET " + path + " HTTP/1.1\r\n"
                + "Host: " + hostHeader + "\r\n"
                + "Upgrade: websocket\r\n"
                + "Connection: Upgrade\r\n"
                + "Sec-WebSocket-Key: " + key + "\r\n"
                + "Sec-WebSocket-Version: 13\r\n"
                + "\r\n";
        out.write(request.getBytes("UTF-8"));
        out.flush();

        String statusLine = readHeaderLine();
        if (statusLine == null) throw new IOException("握手无响应");
        if (!statusLine.contains(" 101")) {
            // 401 说明 token 不对：把状态行原样带回，界面上一眼能看懂。
            throw new IOException(statusLine.trim());
        }
        String accept = null;
        for (int i = 0; i < 64; i++) {
            String line = readHeaderLine();
            if (line == null || line.isEmpty()) break;
            int colon = line.indexOf(':');
            if (colon > 0 && "sec-websocket-accept".equalsIgnoreCase(line.substring(0, colon).trim())) {
                accept = line.substring(colon + 1).trim();
            }
        }
        String expected;
        try {
            expected = B64.encode(MessageDigest.getInstance("SHA-1")
                    .digest((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").getBytes("UTF-8")));
        } catch (java.security.NoSuchAlgorithmException error) {
            // SHA-1 是 JLS 强制要求的算法；真拿不到说明运行环境坏了，直接失败更好。
            closeQuietly();
            throw new IOException("无法计算握手校验值：" + error.getMessage());
        }
        if (accept == null || !accept.equals(expected)) {
            throw new IOException("握手校验失败：accept 不匹配");
        }
        open.set(true);
        startReader();
        listener.onOpen();
    }

    private Socket wrapTls(Socket raw, String host, int port) throws IOException {
        try {
            // 渗透场景常见自签证书：这里放行，与 regedit 网关的 TLS 策略一致。
            TrustManager[] trustAll = new TrustManager[]{
                    new X509TrustManager() {
                        public void checkClientTrusted(X509Certificate[] chain, String authType) {
                        }

                        public void checkServerTrusted(X509Certificate[] chain, String authType) {
                        }

                        public X509Certificate[] getAcceptedIssuers() {
                            return new X509Certificate[0];
                        }
                    }
            };
            SSLContext context = SSLContext.getInstance("TLS");
            context.init(null, trustAll, new SecureRandom());
            SSLSocket ssl = (SSLSocket) context.getSocketFactory().createSocket(raw, host, port, true);
            ssl.startHandshake();
            return ssl;
        } catch (Exception error) {
            throw new IOException("TLS 握手失败：" + error.getMessage());
        }
    }

    private static String appendParam(String path, String name, String value) {
        if (value == null || value.isEmpty()) return path;
        return path + (path.contains("?") ? "&" : "?") + name + "=" + urlEncode(value);
    }

    private static String urlEncode(String value) {
        try {
            return java.net.URLEncoder.encode(value, "UTF-8");
        } catch (Exception ignored) {
            return value;
        }
    }

    private String newKey() {
        byte[] bytes = new byte[16];
        random.nextBytes(bytes);
        return B64.encode(bytes);
    }

    private String readHeaderLine() throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        int previous = -1;
        while (true) {
            int c = in.read();
            if (c < 0) return buffer.size() == 0 ? null : buffer.toString("UTF-8");
            if (c == '\n' && previous == '\r') break;
            buffer.write(c);
            previous = c;
            if (buffer.size() > 8192) throw new IOException("握手响应头过长");
        }
        String line = buffer.toString("UTF-8");
        return line.endsWith("\r") ? line.substring(0, line.length() - 1) : line;
    }

    // ---------------------------------------------------------------- 收

    private void startReader() {
        Thread reader = new Thread(new Runnable() {
            public void run() {
                readLoop();
            }
        }, "regedit-ws-reader");
        reader.setDaemon(true);
        reader.start();
    }

    private void readLoop() {
        try {
            ByteArrayOutputStream fragments = null;
            int fragmentOpcode = 0;
            while (!closed.get()) {
                int b0 = in.read();
                if (b0 < 0) break;
                int b1 = in.read();
                if (b1 < 0) break;
                boolean fin = (b0 & 0x80) != 0;
                int opcode = b0 & 0x0f;
                boolean masked = (b1 & 0x80) != 0;
                long length = b1 & 0x7f;
                if (length == 126) {
                    length = ((long) readByte() << 8) | readByte();
                } else if (length == 127) {
                    length = 0;
                    for (int i = 0; i < 8; i++) length = (length << 8) | readByte();
                }
                if (length > 64L * 1024 * 1024) throw new IOException("单帧过大：" + length);
                byte[] mask = null;
                if (masked) {
                    mask = new byte[4];
                    readFully(mask, 4);
                }
                byte[] payload = new byte[(int) length];
                readFully(payload, (int) length);
                if (mask != null) {
                    for (int i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
                }

                if (opcode == OP_PING) {
                    sendFrame(OP_PONG, payload);
                    continue;
                }
                if (opcode == OP_PONG) continue;
                if (opcode == OP_CLOSE) {
                    int code = payload.length >= 2 ? (((payload[0] & 0xff) << 8) | (payload[1] & 0xff)) : 1005;
                    String reason = payload.length > 2 ? new String(payload, 2, payload.length - 2, "UTF-8") : "";
                    closeQuietly();
                    listener.onClosed(code, reason);
                    return;
                }
                if (opcode == OP_TEXT || opcode == OP_BINARY) {
                    if (!fin) {
                        fragmentOpcode = opcode;
                        fragments = new ByteArrayOutputStream();
                        fragments.write(payload);
                        continue;
                    }
                    listener.onText(new String(payload, "UTF-8"));
                    continue;
                }
                if (opcode == 0x0 && fragments != null) {
                    fragments.write(payload);
                    if (fin) {
                        byte[] whole = fragments.toByteArray();
                        fragments = null;
                        if (fragmentOpcode == OP_TEXT) listener.onText(new String(whole, "UTF-8"));
                    }
                }
            }
            closeQuietly();
            listener.onClosed(1006, "连接结束");
        } catch (IOException error) {
            if (!closed.get()) {
                closeQuietly();
                listener.onError(error.getMessage() == null ? "读取失败" : error.getMessage());
            }
        }
    }

    private int readByte() throws IOException {
        int c = in.read();
        if (c < 0) throw new IOException("连接已断开");
        return c & 0xff;
    }

    private void readFully(byte[] buffer, int length) throws IOException {
        int filled = 0;
        while (filled < length) {
            int n = in.read(buffer, filled, length - filled);
            if (n < 0) throw new IOException("连接已断开");
            filled += n;
        }
    }

    // ---------------------------------------------------------------- 发

    public void send(String text) throws IOException {
        sendFrame(OP_TEXT, text.getBytes("UTF-8"));
    }

    private synchronized void sendFrame(int opcode, byte[] payload) throws IOException {
        if (socket == null || socket.isClosed()) throw new IOException("连接已关闭");
        ByteArrayOutputStream frame = new ByteArrayOutputStream(payload.length + 14);
        frame.write(0x80 | opcode);
        int length = payload.length;
        if (length < 126) {
            frame.write(0x80 | length);
        } else if (length < 65536) {
            frame.write(0x80 | 126);
            frame.write((length >> 8) & 0xff);
            frame.write(length & 0xff);
        } else {
            frame.write(0x80 | 127);
            for (int shift = 56; shift >= 0; shift -= 8) frame.write((int) (((long) length >> shift) & 0xff));
        }
        // 客户端必须掩码，否则服务端会直接断链。
        byte[] mask = new byte[4];
        random.nextBytes(mask);
        frame.write(mask, 0, 4);
        for (int i = 0; i < payload.length; i++) frame.write(payload[i] ^ mask[i & 3]);
        out.write(frame.toByteArray());
        out.flush();
    }

    // ---------------------------------------------------------------- 关闭

    public void close(int code, String reason) {
        if (closed.getAndSet(true)) return;
        open.set(false);
        try {
            byte[] reasonBytes = reason == null ? new byte[0] : reason.getBytes("UTF-8");
            int use = Math.min(reasonBytes.length, 120);
            byte[] payload = new byte[2 + use];
            payload[0] = (byte) ((code >> 8) & 0xff);
            payload[1] = (byte) (code & 0xff);
            System.arraycopy(reasonBytes, 0, payload, 2, use);
            sendFrame(OP_CLOSE, payload);
        } catch (IOException ignored) {
            // 已经断了就算了
        }
        closeQuietly();
    }

    private void closeQuietly() {
        open.set(false);
        closed.set(true);
        try {
            if (socket != null) socket.close();
        } catch (IOException ignored) {
            // 忽略
        }
    }
}
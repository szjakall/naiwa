package com.regedit.droid;

import java.io.File;
import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 反连通道：连上 regedit 网关，发 hello，每 15s 心跳，收帧后分派给 Handlers。
 *
 * 三条硬性约束（都是原实现用事故换来的，这里照做）：
 *
 * 1. hello 必须最先发。抢在握手帧前面发 hb，网关会以 4001 关连接。
 * 2. root 探测不能占住读帧线程。探测里要跑 su，第一次会弹授权框、可能几十秒；
 *    读线程同时负责收 pong 与心跳，堵住它等于把一条健康连接判成断开。所以
 *    探测 + hello 放在独立线程里。
 * 3. 重连闩只能由"断开"放行。原实现用"当前连接还是空的"提前放行，而连接对象
 *    在 onOpen 里才赋值、建连又是异步的，于是每次都立即放行——循环退化成每秒
 *    拨一条新连接，网关只好用 4003 顶掉旧连接，手机侧就是"在线/已关闭"每秒闪。
 *    这里闩只由 onClosed / onError 放行。
 *
 * 这个类不 import android.*，同一份代码可以在 PC 上跑端到端测试。
 */
public final class DroidClient implements Handlers.Sender {

    /** 宿主平台差异：机型信息、临时目录、状态回调。 */
    public interface Platform {
        String model();

        String androidVersion();

        int sdkInt();

        File workDir();

        void log(String line);

        /** state: 连接中 / 在线 / 断开 / 已停止 */
        void onState(String state, String detail);
    }

    private static final int HEARTBEAT_MS = 15_000;
    private static final long BACKOFF_START_MS = 1000;
    private static final long BACKOFF_MAX_MS = 30_000;

    private final String url;
    private final String token;
    private final String deviceId;
    private final Platform platform;
    private final Handlers handlers;

    private final AtomicBoolean stopped = new AtomicBoolean(false);
    private volatile Wire wire;
    private volatile boolean rooted;
    private volatile String state = "未启动";
    private Thread loopThread;

    public DroidClient(String url, String token, String deviceId, Platform platform) {
        this.url = normalizeUrl(url);
        this.token = token == null ? "" : token.trim();
        this.deviceId = deviceId;
        this.platform = platform;
        this.handlers = new Handlers(platform.workDir());
    }

    /**
     * 补全用户填的地址。
     *
     * 真机踩过：操作员在应用里填 `203.0.113.10:9945/ws/droid`（只有主机端口，
     * 没有协议），URI.create 会把 "203.0.113.10" 当成 scheme 解析并抛
     * "Illegal character in scheme name at index 0" —— 连接一步都没发出去，
     * 界面上却只有一句看不出所以然的英文。
     *
     * 规则：http→ws、https→wss、无协议→ws；去掉结尾斜杠；缺 /ws/droid 就补上。
     */
    public static String normalizeUrl(String raw) {
        String url = raw == null ? "" : raw.trim();
        if (url.isEmpty()) return url;
        String lower = url.toLowerCase();
        if (lower.startsWith("http://")) url = "ws://" + url.substring(7);
        else if (lower.startsWith("https://")) url = "wss://" + url.substring(8);
        else if (!lower.startsWith("ws://") && !lower.startsWith("wss://")) url = "ws://" + url;
        while (url.endsWith("/")) url = url.substring(0, url.length() - 1);
        if (!url.toLowerCase().endsWith("/ws/droid")) url = url + "/ws/droid";
        return url;
    }

    public String state() {
        return state;
    }

    public boolean online() {
        Wire current = wire;
        return current != null && current.isOpen();
    }

    public boolean rooted() {
        return rooted;
    }

    // ---------------------------------------------------------------- 生命周期

    public synchronized void start() {
        if (loopThread != null) return;
        stopped.set(false);
        loopThread = new Thread(new Runnable() {
            public void run() {
                reconnectLoop();
            }
        }, "regedit-droid-loop");
        loopThread.setDaemon(true);
        loopThread.start();
    }

    public synchronized void stop() {
        stopped.set(true);
        Wire current = wire;
        if (current != null) current.close(1000, "bye");
        handlers.abortAllPushes();
        setState("已停止", "");
        loopThread = null;
    }

    private void setState(String next, String detail) {
        state = next;
        platform.onState(next, detail == null ? "" : detail);
    }

    // ---------------------------------------------------------------- 重连

    private void reconnectLoop() {
        long backoff = BACKOFF_START_MS;
        while (!stopped.get()) {
            setState("连接中", "退避 " + (backoff / 1000) + "s");
            final CountDownLatch finished = new CountDownLatch(1);
            // 用一格数组把"这条连接"带进匿名回调：监听器在构造时就要引用它，
            // 而构造完才有对象本身。
            final Wire[] slot = new Wire[1];
            Wire connection;
            try {
                connection = new Wire(url, token, deviceId, new Wire.Listener() {
                    public void onOpen() {
                        // 这里什么都不能做重活：读线程马上就要开始收帧。
                        Thread setup = new Thread(new Runnable() {
                            public void run() {
                                onOpenWorker(slot[0]);
                            }
                        }, "regedit-droid-hello");
                        setup.setDaemon(true);
                        setup.start();
                    }

                    public void onText(String text) {
                        handleFrame(text);
                    }

                    public void onClosed(int code, String reason) {
                        if (slot[0] != null && slot[0] == wire) {
                            platform.log("连接关闭 " + code + " " + reason);
                            setState("断开", code + " " + reason);
                        }
                        finished.countDown();
                    }

                    public void onError(String message) {
                        if (slot[0] != null && slot[0] == wire && !stopped.get()) {
                            setState("断开", message);
                        }
                        finished.countDown();
                    }
                });
            } catch (RuntimeException error) {
                setState("断开", error.getMessage() == null ? "地址不合法" : error.getMessage());
                sleepQuietly(backoff);
                backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
                continue;
            }

            slot[0] = connection;
            wire = connection;
            try {
                connection.connect(15000);
            } catch (IOException error) {
                // 401 时 error 里带着状态行，直接显示出来，操作员一眼知道是 token 不对。
                setState("断开", error.getMessage() == null ? "连接失败" : error.getMessage());
                sleepQuietly(backoff);
                backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
                continue;
            }
            backoff = BACKOFF_START_MS;

            // 卡在这里，直到这条连接真的断开（只能由 onClosed / onError 放行）。
            try {
                while (!stopped.get() && finished.getCount() > 0) {
                    if (finished.await(200, TimeUnit.MILLISECONDS)) break;
                }
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                break;
            }
            if (stopped.get()) break;
            sleepQuietly(backoff);
            backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
        }
    }

    private void sleepQuietly(long ms) {
        long waited = 0;
        while (!stopped.get() && waited < ms) {
            try {
                Thread.sleep(200);
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                return;
            }
            waited += 200;
        }
    }

    /** 握手成功后：探测 root（可能很慢）→ 发 hello → 起心跳。 */
    private void onOpenWorker(Wire connection) {
        if (connection == null || stopped.get() || connection != wire) return;
        rooted = handlers.rootAvailable();
        platform.log("root=" + rooted);

        Map<String, Object> hello = new LinkedHashMap<String, Object>();
        hello.put("t", "hello");
        hello.put("token", token);
        hello.put("deviceId", deviceId);
        hello.put("model", platform.model());
        hello.put("androidVersion", platform.androidVersion());
        hello.put("sdkInt", platform.sdkInt());
        hello.put("rooted", rooted);
        try {
            connection.send(Json.write(hello));
        } catch (IOException error) {
            platform.log("hello 发送失败：" + error.getMessage());
            connection.close(1011, "hello failed");
            return;
        }
        setState("在线", "");
        startHeartbeat(connection);
    }

    private void startHeartbeat(final Wire connection) {
        Thread heartbeat = new Thread(new Runnable() {
            public void run() {
                while (!stopped.get() && connection == wire && connection.isOpen()) {
                    try {
                        Thread.sleep(HEARTBEAT_MS);
                    } catch (InterruptedException error) {
                        Thread.currentThread().interrupt();
                        return;
                    }
                    if (stopped.get() || connection != wire) return;
                    Map<String, Object> beat = new LinkedHashMap<String, Object>();
                    beat.put("t", "hb");
                    try {
                        connection.send(Json.write(beat));
                    } catch (IOException error) {
                        // 发送失败说明 socket 已废：交给读线程走重连
                        return;
                    }
                }
            }
        }, "regedit-droid-heartbeat");
        heartbeat.setDaemon(true);
        heartbeat.start();
    }

    // ---------------------------------------------------------------- 分派

    private void handleFrame(String text) {
        Map<String, Object> frame;
        try {
            frame = Json.asObject(Json.parse(text));
        } catch (RuntimeException error) {
            platform.log("收到无法解析的帧：" + error.getMessage());
            return;
        }
        String type = Json.str(frame, "t", "");
        String reqId = Json.str(frame, "reqId", "");
        try {
            dispatch(type, reqId, frame);
        } catch (Exception error) {
            platform.log("处理 " + type + " 失败：" + error);
            if (!reqId.isEmpty()) {
                sendJson(Handlers.resultFrame(reqId, false, -1, "", "设备侧异常：" + error.getMessage()));
            }
        }
    }

    private void dispatch(String type, String reqId, Map<String, Object> frame) throws IOException {
        if ("welcome".equals(type)) {
            platform.log("网关已接受 hello");
            return;
        }
        if ("exec".equals(type)) {
            String cmd = Json.str(frame, "cmd", "");
            boolean asRoot = Json.bool(frame, "asRoot", false);
            int timeout = (int) Json.num(frame, "timeoutMs", 30000);
            platform.log("$ " + cmd);
            sendJson(Handlers.resultOf(reqId, handlers.exec(cmd, asRoot, timeout)));
            return;
        }
        if ("pull".equals(type)) {
            String path = Json.str(frame, "path", "");
            long maxBytes = Json.num(frame, "maxBytes", 0);
            platform.log("pull " + path);
            handlers.pull(reqId, path, maxBytes, this);
            return;
        }
        if ("push".equals(type)) {
            String path = Json.str(frame, "path", "");
            String b64 = Json.str(frame, "b64", "");
            int seq = (int) Json.num(frame, "seq", 0);
            boolean done = Json.bool(frame, "done", true);
            String mode = Json.str(frame, "mode", "0700");
            if (seq == 0) {
                handlers.pushOpen(reqId, seq, b64);
            } else {
                handlers.pushAppend(reqId, seq, b64);
            }
            if (done) {
                long total = handlers.pushFinish(reqId, path, mode);
                sendJson(Handlers.resultFrame(reqId, true, 0, path + ": " + total + " bytes written\n", ""));
            }
            return;
        }
        if ("screencap".equals(type)) {
            handlers.screencap(reqId, this);
            return;
        }
        if ("logcat".equals(type)) {
            int lines = (int) Json.num(frame, "lines", 200);
            String filter = Json.str(frame, "filter", null);
            sendJson(Handlers.resultOf(reqId, handlers.logcat(lines, filter)));
            return;
        }
        if ("packages".equals(type)) {
            boolean thirdPartyOnly = Json.bool(frame, "thirdPartyOnly", true);
            sendJson(Handlers.resultOf(reqId, handlers.packages(thirdPartyOnly)));
            return;
        }
        if ("capture_start".equals(type)) {
            String iface = Json.str(frame, "iface", "any");
            int seconds = (int) Json.num(frame, "seconds", 30);
            sendJson(Handlers.resultOf(reqId, handlers.captureStart(iface, seconds)));
            return;
        }
        if ("capture_stop".equals(type)) {
            handlers.captureStop();
            // 停止后把 pcap 直接流回去：服务端负责落盘，设备侧不长期保存。
            handlers.pull(reqId, Handlers.CAPTURE_PATH, 0, this);
            return;
        }
        if ("capture_status".equals(type)) {
            sendJson(Handlers.resultOf(reqId, handlers.captureStatus()));
            return;
        }
        if ("tcp_open".equals(type)) {
            handlers.tcpOpen(Json.str(frame, "tunnelId", ""), Json.str(frame, "connId", ""),
                    Json.str(frame, "host", "127.0.0.1"), (int) Json.num(frame, "port", 0), this);
            return;
        }
        if ("tcp_send".equals(type)) {
            handlers.tcpSend(Json.str(frame, "tunnelId", ""), Json.str(frame, "connId", ""), Json.str(frame, "b64", ""));
            return;
        }
        if ("tcp_close".equals(type)) {
            handlers.tcpClose(Json.str(frame, "tunnelId", ""), Json.str(frame, "connId", ""));
            return;
        }
        platform.log("忽略未知帧：" + type);
    }

    // ---------------------------------------------------------------- Sender

    public void sendJson(Map<String, Object> frame) {
        Wire current = wire;
        if (current == null || !current.isOpen()) return;
        try {
            current.send(Json.write(frame));
        } catch (IOException error) {
            platform.log("发送失败：" + error.getMessage());
        }
    }

    public void sendData(String reqId, int seq, byte[] chunk, int length, boolean done) {
        // 缓冲区是复用的，只有前 length 个字节属于这一片。
        if (length < 0) length = 0;
        if (length > chunk.length) length = chunk.length;
        byte[] slice;
        if (length == chunk.length) {
            slice = chunk;
        } else {
            slice = new byte[length];
            System.arraycopy(chunk, 0, slice, 0, length);
        }
        Map<String, Object> frame = new LinkedHashMap<String, Object>();
        frame.put("t", "data");
        frame.put("reqId", reqId);
        frame.put("seq", seq);
        frame.put("b64", B64.encode(slice));
        frame.put("done", done);
        sendJson(frame);
    }
}
package com.starry.droid;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

/**
 * 设备侧的命令实现：把一条请求变成 result 帧，或变成一串 data 分片。
 *
 * 全部基于 shell + root（这是"测试机必须 root"换来的简单性），只有三处例外：
 * 推送落盘、TCP 隧道、以及直读自己有权访问的文件。
 *
 * 这个类刻意不 import 任何 android.*：同一份代码在 PC 上跑端到端测试。
 */
public final class Handlers {

    /** 帧出口：DroidClient 实现它，把结果写回 WebSocket。 */
    public interface Sender {
        void sendJson(Map<String, Object> frame);

        /**
         * @param chunk  复用的缓冲区（容量可能大于 length，不能整块发出去）
         * @param length 本次真正的字节数
         */
        void sendData(String reqId, int seq, byte[] chunk, int length, boolean done);
    }

    /** 一次命令的产出。exitCode 124 表示超时（沿用 coreutils 的习惯）。 */
    public static final class Result {
        public final int code;
        public final String stdout;
        public final String stderr;

        public Result(int code, String stdout, String stderr) {
            this.code = code;
            this.stdout = stdout == null ? "" : stdout;
            this.stderr = stderr == null ? "" : stderr;
        }

        public boolean ok() {
            return code == 0;
        }
    }

    /** 分片大小：256KB 原始字节，base64 后约 350KB，远低于服务端 8MB 的单帧上限。 */
    public static final int CHUNK = 256 * 1024;
    public static final String CAPTURE_PATH = "/data/local/tmp/starry-capture.pcap";

    private final File workDir;
    private final Map<String, PushState> pushes = new ConcurrentHashMap<String, PushState>();
    private final Map<String, Tunnel> tunnels = new ConcurrentHashMap<String, Tunnel>();
    private final Map<Socket, String> socketTunnel = new ConcurrentHashMap<Socket, String>();
    private final Map<Socket, String> socketConn = new ConcurrentHashMap<Socket, String>();

    /**
     * @param workDir 可写的临时目录（Android 传 getCacheDir()，PC 上随便一个临时目录）
     */
    public Handlers(File workDir) {
        this.workDir = workDir;
        if (!workDir.exists()) workDir.mkdirs();
    }

    // ---------------------------------------------------------------- shell

    /** 执行一条 shell 命令。asRoot 走 su，否则走 sh。 */
    public Result run(String cmd, boolean asRoot, int timeoutMs) {
        List<String> argv = new ArrayList<String>();
        if (asRoot) {
            argv.add("su");
            argv.add("-c");
        } else {
            argv.add("sh");
            argv.add("-c");
        }
        argv.add(cmd);
        Process process;
        try {
            process = new ProcessBuilder(argv).start();
        } catch (IOException error) {
            // su 不存在时给一句人话，别把 IOException 直接甩给操作员
            String hint = asRoot ? "无法执行 su（设备可能未 root）" : "无法启动 sh";
            return new Result(127, "", hint + "：" + error.getMessage());
        }
        final StringBuilder out = new StringBuilder();
        final StringBuilder err = new StringBuilder();
        Thread outThread = drain(process.getInputStream(), out);
        Thread errThread = drain(process.getErrorStream(), err);

        // 不能用 Process.waitFor(timeout, TimeUnit)：那是 API 26 才有的方法，
        // 在 Android 7.x 上会抛 NoSuchMethodError 把整个进程打崩（实机踩过）。
        // 这里用"等一个守护线程"的写法，API 1 起就有。
        final Process target = process;
        Thread waiter = new Thread(new Runnable() {
            public void run() {
                try {
                    target.waitFor();
                } catch (InterruptedException ignored) {
                    Thread.currentThread().interrupt();
                }
            }
        }, "starry-wait");
        waiter.setDaemon(true);
        waiter.start();
        boolean finished;
        try {
            waiter.join(timeoutMs);
            finished = !waiter.isAlive();
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            finished = false;
        }
        if (!finished) killQuietly(process);
        try {
            outThread.join(2000);
            errThread.join(2000);
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        }
        int code = finished ? process.exitValue() : 124;
        return new Result(code, out.toString(), err.toString());
    }

    /**
     * 强杀子进程。
     *
     * destroyForcibly() 同样是 API 26+，所以走一次反射；拿不到就退回 destroy()。
     * 反射在这里不是"花活"：这是 API 21 兼容的唯一办法，且失败路径明确。
     */
    private static void killQuietly(Process process) {
        try {
            process.getClass().getMethod("destroyForcibly").invoke(process);
            return;
        } catch (Throwable ignored) {
            // 老系统没有这个方法，或反射被限制
        }
        try {
            process.destroy();
        } catch (Throwable ignored) {
            // 忽略
        }
    }

    private Thread drain(final InputStream stream, final StringBuilder sink) {
        Thread thread = new Thread(new Runnable() {
            public void run() {
                byte[] buffer = new byte[8192];
                try {
                    int n;
                    while ((n = stream.read(buffer)) >= 0) {
                        synchronized (sink) {
                            sink.append(new String(buffer, 0, n, "UTF-8"));
                        }
                    }
                } catch (IOException ignored) {
                    // 进程被杀时读会失败，已读到的内容仍然有用
                } finally {
                    try {
                        stream.close();
                    } catch (IOException ignored) {
                        // 忽略
                    }
                }
            }
        }, "starry-shell-drain");
        thread.setDaemon(true);
        thread.start();
        return thread;
    }

    /**
     * root 可用性：`su -c id -u` 输出 0。
     *
     * 第一次 su 会弹 Magisk 授权框，人可能不在旁边，所以重试三次、每次 8 秒——
     * 但探测只在后台线程跑，绝不占住读帧线程（原实现踩过：堵住读线程会让心跳超时）。
     */
    public boolean rootAvailable() {
        // 本身就以 root 跑（PC 测试、或应用被装进 system 分区）时不用 su。
        Result self = run("id -u", false, 5000);
        if (self.ok() && self.stdout.trim().startsWith("0")) return true;
        // 首次 su 会弹授权框（Magisk 等），人在旁边就会点「允许」，因此给两次机会、
        // 每次 6 秒；再长就会把 hello 拖得太久，控制台上设备迟迟不出现。
        for (int attempt = 0; attempt < 2; attempt++) {
            Result result = run("id -u", true, 6000);
            if (result.ok() && result.stdout.trim().startsWith("0")) return true;
            if (attempt < 1) {
                try {
                    Thread.sleep(1000);
                } catch (InterruptedException ignored) {
                    Thread.currentThread().interrupt();
                    break;
                }
            }
        }
        return false;
    }

    // ---------------------------------------------------------------- 各命令

    public Result exec(String cmd, boolean asRoot, int timeoutMs) {
        Result result = run(cmd, asRoot, timeoutMs);
        if (!result.ok() && asRoot && result.stderr.contains("su")) {
            // su 失败时退一次非 root，至少让常见只读命令还能用
            Result fallback = run(cmd, false, timeoutMs);
            if (fallback.ok()) {
                return new Result(fallback.code, fallback.stdout,
                        fallback.stderr + "\n（root 不可用，已降级为非 root 执行）");
            }
        }
        return result;
    }

    public Result logcat(int lines, String filter) {
        StringBuilder cmd = new StringBuilder("logcat -d -t ").append(lines);
        if (filter != null && !filter.trim().isEmpty()) {
            cmd.append(" | grep -i '").append(filter.replace("'", "")).append("'");
        }
        return run(cmd.toString(), true, 20000);
    }

    public Result packages(boolean thirdPartyOnly) {
        // 必须用 root 跑：应用身份受包可见性限制，pm list packages 只会看到自己。
        return run(thirdPartyOnly ? "pm list packages -3" : "pm list packages", true, 20000);
    }

    public Result captureStart(String iface, int seconds) {
        log("[starry] capture requested for " + seconds + "s (stop is driven by capture_stop)");
        // 先确认设备上真有 tcpdump：`nohup tcpdump ... &` 即使命令不存在也会返回 0
        // （后台进程的退出码不会回传），不检查就会给操作员一个"抓包已开始"的假象。
        Result probe = run("command -v tcpdump || which tcpdump", true, 5000);
        String tcpdumpPath = probe.stdout.trim();
        if (tcpdumpPath.isEmpty()) {
            Result probeNoRoot = run("command -v tcpdump || which tcpdump", false, 5000);
            tcpdumpPath = probeNoRoot.stdout.trim();
        }
        if (tcpdumpPath.isEmpty()) {
            return new Result(127, "",
                    "设备上没有 tcpdump，无法抓包。可先推送一个 tcpdump 到 /data/local/tmp 再重试。");
        }
        run("pkill -f " + CAPTURE_PATH, true, 5000);
        StringBuilder cmd = new StringBuilder();
        cmd.append("nohup '").append(tcpdumpPath).append("' -i '")
                .append(iface == null || iface.isEmpty() ? "any" : iface)
                .append("' -s0 -w '").append(CAPTURE_PATH).append("' >/dev/null 2>&1 &");
        Result started = run(cmd.toString(), true, 5000);
        if (!started.ok()) {
            // 没有 root 时试一次非 root（部分定制系统 tcpdump 可用）
            Result fallback = run(cmd.toString(), false, 5000);
            if (fallback.ok()) return fallback;
            return new Result(fallback.code, fallback.stdout,
                    "启动 tcpdump 失败：" + (fallback.stderr.isEmpty() ? "可能缺少 root 权限" : fallback.stderr));
        }
        return started;
    }

    public Result captureStop() {
        return run("pkill -f " + CAPTURE_PATH, true, 5000);
    }

    public Result captureStatus() {
        return run("ls -l '" + CAPTURE_PATH + "' 2>/dev/null || echo none", true, 5000);
    }

    // ---------------------------------------------------------------- 拉文件

    /**
     * 把设备上的文件流式回传：边读边发，内存里只留一个分片。
     *
     * 这是原实现踩过的最狠的坑：先 readBytes() 整个文件再切片，20MB 的包要摊
     * 20MB 源数组 + 两千多万个装箱引用（约 80MB），还没发出第一帧就被 OOM 杀掉，
     * 服务端只看到"设备连接已断开"。所以这里用双缓冲，稳态占用约为 2 个分片。
     */
    public void pull(String reqId, String path, long maxBytes, Sender sender) {
        Source source;
        try {
            source = openSource(path, maxBytes);
        } catch (IOException error) {
            sender.sendJson(resultFrame(reqId, false, -1, "", error.getMessage()));
            return;
        }
        byte[][] buffers = new byte[][]{new byte[CHUNK], new byte[CHUNK]};
        int slot = 0;
        byte[] pending = null;
        int pendingLength = 0;
        long total = 0;
        int seq = 0;
        try {
            while (true) {
                byte[] current = buffers[slot];
                int n = readChunk(source.input, current);
                if (n < 0) break;
                total += n;
                if (maxBytes > 0 && total > maxBytes) {
                    throw new IOException("文件超过上限：" + total + " > " + maxBytes);
                }
                if (pending != null) {
                    sender.sendData(reqId, seq++, pending, pendingLength, false);
                }
                pending = current;
                pendingLength = n;
                slot = 1 - slot;
            }
            // 走 su cat 的源要在这里对账：`cat` 成功启动但文件不存在时，
            // 标准输出就是空的、退出码非 0。不检查的话会把"读取失败"当成
            // 一个 0 字节的空文件返回给操作员（实机踩过）。
            String failure = source.check(total);
            if (failure != null) {
                sender.sendJson(resultFrame(reqId, false, -1, "", failure));
                return;
            }
            // 空文件也要发一片 done，服务端才有 seq=0 可收。
            sender.sendData(reqId, seq++, pending == null ? new byte[0] : pending, pendingLength, true);
            sender.sendJson(resultFrame(reqId, true, 0, "", ""));
        } catch (IOException error) {
            sender.sendJson(resultFrame(reqId, false, -1, "", error.getMessage()));
        } finally {
            source.close();
        }
    }

    /** 直读优先，读不到（root-only 文件）再用 su cat 拿原始字节流。 */
    private Source openSource(String path, long maxBytes) throws IOException {
        File file = new File(path);
        if (file.isFile() && file.canRead()) {
            if (maxBytes > 0 && file.length() > maxBytes) {
                throw new IOException("文件超过上限：" + file.length() + " > " + maxBytes);
            }
            return new Source(new FileInputStream(file), null, null);
        }
        final Process process;
        try {
            process = new ProcessBuilder("su", "-c", "cat '" + path.replace("'", "'\\''") + "'").start();
        } catch (IOException error) {
            throw new IOException("读取失败：文件不存在或无权限（" + error.getMessage() + "）");
        }
        return new Source(process.getInputStream(), new Runnable() {
            public void run() {
                killQuietly(process);
            }
        }, new Check() {
            public String run(long total) {
                if (total > 0) return null;
                try {
                    Thread waiter = new Thread(new Runnable() {
                        public void run() {
                            try {
                                process.waitFor();
                            } catch (InterruptedException ignored) {
                                Thread.currentThread().interrupt();
                            }
                        }
                    });
                    waiter.setDaemon(true);
                    waiter.start();
                    waiter.join(5000);
                    int code = waiter.isAlive() ? -1 : process.exitValue();
                    if (code == 0) return null;
                    String err = "";
                    try {
                        java.io.ByteArrayOutputStream buffer = new java.io.ByteArrayOutputStream();
                        byte[] chunk = new byte[512];
                        int n = process.getErrorStream().read(chunk);
                        if (n > 0) err = new String(chunk, 0, n, "UTF-8").trim();
                    } catch (IOException ignored) {
                        // 忽略
                    }
                    return "读取失败：" + (err.isEmpty() ? "文件不存在或无权限" : err);
                } catch (InterruptedException error) {
                    Thread.currentThread().interrupt();
                    return "读取失败：等待 su 时被中断";
                }
            }
        });
    }

    /** 读完之后的对账钩子：返回 null 表示正常，返回字符串表示错误原因。 */
    private interface Check {
        String run(long total);
    }

    private static final class Source {
        final InputStream input;
        final Runnable onClose;
        final Check check;

        Source(InputStream input, Runnable onClose, Check check) {
            this.input = input;
            this.onClose = onClose;
            this.check = check;
        }

        String check(long total) {
            return check == null ? null : check.run(total);
        }

        void close() {
            try {
                input.close();
            } catch (IOException ignored) {
                // 忽略
            }
            if (onClose != null) onClose.run();
        }
    }

    /** 管道一次只给 64KB，不填满缓冲区会退化成几百个小分片。 */
    private int readChunk(InputStream input, byte[] buffer) throws IOException {
        int filled = 0;
        while (filled < buffer.length) {
            int n = input.read(buffer, filled, buffer.length - filled);
            if (n < 0) break;
            filled += n;
        }
        return filled == 0 ? -1 : filled;
    }

    // ---------------------------------------------------------------- 截屏

    /** 截屏并回传 PNG：先落到临时文件（screencap 自己写文件最稳），再走同一条流式路径。 */
    public void screencap(String reqId, Sender sender) {
        File tmp = new File(workDir, "shot-" + System.currentTimeMillis() + ".png");
        Result result = run("screencap -p '" + tmp.getAbsolutePath() + "'", true, 20000);
        if (!result.ok() || !tmp.isFile()) {
            // 非 root 设备上 screencap 缺 READ_FRAME_BUFFER 权限，这里要给出可读的原因
            tmp.delete();
            sender.sendJson(resultFrame(reqId, false, -1, "",
                    "截屏失败：" + (result.stderr.isEmpty()
                            ? "screencap 无输出（通常需要 root 或系统权限）"
                            : result.stderr)));
            return;
        }
        try {
            pull(reqId, tmp.getAbsolutePath(), 0, sender);
        } finally {
            tmp.delete();
        }
    }

    // ---------------------------------------------------------------- 推送

    private static final class PushState {
        final File tmp;
        final OutputStream out;
        int nextSeq = 0;
        long bytes = 0;

        PushState(File tmp, OutputStream out) {
            this.tmp = tmp;
            this.out = out;
        }
    }

    /** seq=0：开（截断）目标对应的临时文件并写入第一片。 */
    public long pushOpen(String reqId, int seq, String b64) throws IOException {
        if (seq != 0) throw new IOException("推送分片乱序：期望 0，收到 " + seq);
        pushAbort(reqId);
        File tmp = new File(workDir, "push-" + reqId.replaceAll("[^A-Za-z0-9_.-]", "_") + ".part");
        pushes.put(reqId, new PushState(tmp, new FileOutputStream(tmp)));
        return pushAppend(reqId, seq, b64);
    }

    /** 追加一片，返回累计字节数。乱序即失败，绝不写歪。 */
    public long pushAppend(String reqId, int seq, String b64) throws IOException {
        PushState state = pushes.get(reqId);
        if (state == null) throw new IOException("推送分片丢失了打开状态");
        if (seq != state.nextSeq) throw new IOException("推送分片乱序：期望 " + state.nextSeq + "，收到 " + seq);
        state.nextSeq += 1;
        byte[] bytes = B64.decode(b64 == null ? "" : b64);
        state.out.write(bytes);
        state.bytes += bytes.length;
        return state.bytes;
    }

    /** done：关流并把临时文件搬到目标路径（应用写不了就走 su）。 */
    public long pushFinish(String reqId, String path, String mode) throws IOException {
        PushState state = pushes.remove(reqId);
        if (state == null) throw new IOException("推送分片丢失了打开状态");
        state.out.close();
        String chmod = mode == null || mode.isEmpty() ? "0700" : mode;
        try {
            boolean direct = false;
            File target = new File(path);
            try {
                File parent = target.getParentFile();
                if (parent != null && !parent.exists()) parent.mkdirs();
                copy(state.tmp, target);
                run("chmod " + chmod + " '" + path.replace("'", "'\\''") + "'", false, 10000);
                direct = target.isFile();
            } catch (IOException ignored) {
                direct = false;
            }
            if (!direct) {
                String dir = path.lastIndexOf('/') > 0 ? path.substring(0, path.lastIndexOf('/')) : "";
                StringBuilder cmd = new StringBuilder();
                if (!dir.isEmpty()) cmd.append("mkdir -p '").append(dir).append("'; ");
                cmd.append("cat '").append(state.tmp.getAbsolutePath()).append("' > '").append(path).append("'; ");
                cmd.append("chmod ").append(chmod).append(" '").append(path).append("'; ");
                cmd.append("ls -l '").append(path).append("'");
                Result result = run(cmd.toString(), true, 120000);
                if (!result.ok()) {
                    throw new IOException(result.stderr.isEmpty() ? "写入失败（退出码 " + result.code + "）" : result.stderr);
                }
            }
            return state.bytes;
        } finally {
            state.tmp.delete();
        }
    }

    private void copy(File from, File to) throws IOException {
        InputStream in = new FileInputStream(from);
        OutputStream out = new FileOutputStream(to);
        try {
            byte[] buffer = new byte[64 * 1024];
            int n;
            while ((n = in.read(buffer)) >= 0) out.write(buffer, 0, n);
        } finally {
            try {
                in.close();
            } catch (IOException ignored) {
                // 忽略
            }
            out.close();
        }
    }

    public void pushAbort(String reqId) {
        PushState state = pushes.remove(reqId);
        if (state == null) return;
        try {
            state.out.close();
        } catch (IOException ignored) {
            // 忽略
        }
        state.tmp.delete();
    }

    public void abortAllPushes() {
        for (String reqId : new ArrayList<String>(pushes.keySet())) pushAbort(reqId);
    }

    // ---------------------------------------------------------------- TCP 隧道

    /**
     * 服务端把一个本地端口桥到设备端口（frida-server 就是这条路上的）。
     * 每条连接一个 Tunnel：设备侧 Socket，加一个把 socket 数据转成 tcp_data 帧的读线程。
     */
    public void tcpOpen(String tunnelId, String connId, String host, int port, final Sender sender) {
        try {
            final Socket socket = new Socket();
            log("[tcp] open tunnel=" + tunnelId + " conn=" + connId + " -> " + host + ":" + port);
            socket.connect(new InetSocketAddress(host, port), 8000);
            socket.setTcpNoDelay(true);
            tunnels.put(tunnelId + "/" + connId, new Tunnel(socket));
            socketTunnel.put(socket, tunnelId);
            socketConn.put(socket, connId);

            Map<String, Object> opened = new LinkedHashMap<String, Object>();
            opened.put("t", "tcp_opened");
            opened.put("tunnelId", tunnelId);
            opened.put("connId", connId);
            opened.put("ok", true);
            sender.sendJson(opened);

            Thread reader = new Thread(new Runnable() {
                public void run() {
                    byte[] buffer = new byte[32 * 1024];
                    try {
                        int n;
                        while ((n = socket.getInputStream().read(buffer)) >= 0) {
                            Map<String, Object> frame = new LinkedHashMap<String, Object>();
                            frame.put("t", "tcp_data");
                            frame.put("tunnelId", socketTunnel.get(socket));
                            frame.put("connId", socketConn.get(socket));
                            byte[] slice = new byte[n];
                            System.arraycopy(buffer, 0, slice, 0, n);
                            frame.put("b64", B64.encode(slice));
                            sender.sendJson(frame);
                        }
                    } catch (IOException ignored) {
                        // 对端关闭
                    }
                    String id = socketTunnel.remove(socket);
                    String cid = socketConn.remove(socket);
                    tunnels.remove(id + "/" + cid);
                    Map<String, Object> closed = new LinkedHashMap<String, Object>();
                    closed.put("t", "tcp_closed");
                    closed.put("tunnelId", id);
                    closed.put("connId", cid);
                    sender.sendJson(closed);
                }
            }, "starry-tcp-" + connId);
            reader.setDaemon(true);
            reader.start();
        } catch (IOException error) {
            log("[tcp] open failed tunnel=" + tunnelId + " conn=" + connId + " err=" + error);
            Map<String, Object> opened = new LinkedHashMap<String, Object>();
            opened.put("t", "tcp_opened");
            opened.put("tunnelId", tunnelId);
            opened.put("connId", connId);
            opened.put("ok", false);
            opened.put("error", error.getMessage());
            sender.sendJson(opened);
        }
    }

    public void tcpSend(String tunnelId, String connId, String b64) {
        Tunnel tunnel = tunnels.get(tunnelId + "/" + connId);
        byte[] payload = B64.decode(b64 == null ? "" : b64);
        log("[tcp] send tunnel=" + tunnelId + " conn=" + connId + " bytes=" + payload.length
                + " found=" + (tunnel != null));
        if (tunnel == null) return;
        try {
            tunnel.socket.getOutputStream().write(payload);
            tunnel.socket.getOutputStream().flush();
            log("[tcp] send flushed " + payload.length + " bytes");
        } catch (IOException error) {
            tcpClose(tunnelId, connId);
        }
    }

    public void tcpClose(String tunnelId, String connId) {
        Tunnel tunnel = tunnels.remove(tunnelId + "/" + connId);
        if (tunnel == null) return;
        try {
            tunnel.socket.close();
        } catch (IOException ignored) {
            // 忽略
        }
    }

    private static final class Tunnel {
        final Socket socket;

        Tunnel(Socket socket) {
            this.socket = socket;
        }
    }

    // ---------------------------------------------------------------- 帧构造

    public static Map<String, Object> resultFrame(String reqId, boolean ok, int code, String stdout, String stderr) {
        Map<String, Object> frame = new LinkedHashMap<String, Object>();
        frame.put("t", "result");
        frame.put("reqId", reqId);
        frame.put("ok", ok);
        if (code >= 0) frame.put("code", code);
        if (stdout != null && !stdout.isEmpty()) frame.put("stdout", stdout);
        if (stderr != null && !stderr.isEmpty()) frame.put("stderr", stderr);
        if (!ok && (stderr == null || stderr.isEmpty())) frame.put("error", "执行失败");
        return frame;
    }

    /** 把命令结果直接转成 result 帧。 */
    public static Map<String, Object> resultOf(String reqId, Result result) {
        return resultFrame(reqId, result.ok(), result.code, result.stdout, result.stderr);
    }

    /** 子类/测试可覆盖的日志出口。 */
    protected void log(String line) {
        System.out.println(line);
    }
}
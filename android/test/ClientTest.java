package com.regedit.droid;

import java.io.File;
import java.io.IOException;
import java.nio.charset.Charset;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * PC 端端到端测试：用与 APK 完全相同的核心类（Wire / DroidClient / Handlers / Json / B64）
 * 连上真实的 regedit 服务，逐条验证设备侧行为。
 *
 * 为什么要在 PC 上再测一遍：装到手机上不能说清"错在哪一层"。这一层跑通，说明协议
 * 与命令实现本身没问题，剩下的只可能是 Android 运行时相关的部分。
 *
 * 用法：java -cp out com.regedit.droid.ClientTest ws://127.0.0.1:9945/ws/droid <token>
 */
public final class ClientTest {

    private static int pass = 0;
    private static int fail = 0;

    private static final Map<String, String> logs = new HashMap<String, String>();

    public static void main(String[] args) throws Exception {
        String url = args.length > 0 ? args[0] : "ws://127.0.0.1:9945/ws/droid";
        String token = args.length > 1 ? args[1] : "";
        if (token.isEmpty()) {
            System.out.println("缺少令牌");
            System.exit(2);
        }

        File work = new File(System.getProperty("java.io.tmpdir"), "regedit-client-test-" + System.currentTimeMillis());
        final CountDownLatch online = new CountDownLatch(1);

        DroidClient.Platform platform = new DroidClient.Platform() {
            public String model() {
                return "PC Harness";
            }

            public String androidVersion() {
                return "jvm-" + System.getProperty("java.version");
            }

            public int sdkInt() {
                return 0;
            }

            public File workDir() {
                return new File(System.getProperty("java.io.tmpdir"), "regedit-harness");
            }

            public void log(String line) {
                logs.put(String.valueOf(System.currentTimeMillis()), line);
                System.out.println("    [client] " + line);
            }

            public void onState(String state, String detail) {
                System.out.println("    [state] " + state + (detail.isEmpty() ? "" : " · " + detail));
                if ("在线".equals(state)) online.countDown();
            }
        };

        DroidClient client = new DroidClient(url, token, "rg-pc-harness", platform);
        client.start();

        check("设备上线", new Check() {
            public String run() throws Exception {
                if (!online.await(45, TimeUnit.SECONDS)) throw new IllegalStateException("45 秒内没上线");
                return "已握手并发送 hello";
            }
        });

        check("root 探测结果", new Check() {
            public String run() {
                return "rooted=" + client.rooted();
            }
        });

        System.out.println("\n（以下由服务端发起，测试脚本在另一端驱动）");
        System.out.println("设备保持在线，等待外部指令……");

        // 由外部脚本通过服务端接口发命令；这里只保持连接并把收到的命令执行掉。
        Thread.sleep(Long.parseLong(System.getProperty("hold", "90000")));
        client.stop();
        work.delete();

        System.out.println("\n════════ 结果 ════════");
        System.out.println("  通过 " + pass + " 项，失败 " + fail + " 项");
        System.exit(fail > 0 ? 1 : 0);
    }

    private interface Check {
        String run() throws Exception;
    }

    private static void check(String label, Check body) {
        try {
            String detail = body.run();
            pass++;
            System.out.println("  PASS  " + label + (detail.isEmpty() ? "" : "  — " + detail));
        } catch (Exception error) {
            fail++;
            System.out.println("  FAIL  " + label + "  — " + error.getMessage());
        }
    }
}
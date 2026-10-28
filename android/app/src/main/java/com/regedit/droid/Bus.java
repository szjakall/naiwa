package com.regedit.droid;

/**
 * 极简事件总线：Service 把日志/状态推给 Activity。
 *
 * 不用 LocalBroadcastManager（那是 AndroidX 的），也不用 Intent 广播（跨进程没必要，
 * 还会把设备日志广播给别的应用）。这里就是一次静态引用赋值，够用且没有依赖。
 */
public final class Bus {

    public interface Listener {
        void onLog(String line);

        void onState(String state, String detail);
    }

    private static volatile Listener listener;

    private Bus() {
    }

    public static void register(Listener target) {
        listener = target;
    }

    public static void unregister(Listener target) {
        if (listener == target) listener = null;
    }

    static void log(String line) {
        Listener current = listener;
        if (current != null) current.onLog(line);
    }

    static void state(String state, String detail) {
        Listener current = listener;
        if (current != null) current.onState(state, detail == null ? "" : detail);
    }
}
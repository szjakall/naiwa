package com.regedit.droid;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import java.io.File;

/**
 * 前台服务：反连必须活在服务里。
 *
 * 放在 Activity 里的话，切到后台几分钟就被系统杀掉；前台服务带常驻通知，进程优先级
 * 不同，这也是"设备一直在线"的前提。通知本身就是状态显示（连接中/在线/断开）。
 */
public final class BridgeService extends Service implements DroidClient.Platform {

    public static final String ACTION_START = "com.regedit.droid.START";
    public static final String ACTION_STOP = "com.regedit.droid.STOP";

    private static final int NOTIFICATION_ID = 0x5247;
    private static final String CHANNEL_ID = "regedit-bridge";

    private DroidClient client;
    private String currentState = "未启动";

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? ACTION_START : intent.getAction();
        if (ACTION_STOP.equals(action)) {
            stopBridge();
            stopSelf();
            return START_NOT_STICKY;
        }
        enterForeground("连接中", "准备中");
        startBridge();
        // 被系统杀掉后尽量自己回来：反连断了对操作员来说就是设备凭空消失。
        // Android 12+ 对后台启动前台服务有限制，所以真被拦时也要优雅降级（见 capture）。
        return START_STICKY;
    }

    /**
     * 进入前台并声明服务类型。
     *
     * Android 14 起：清单里声明了 foregroundServiceType，startForeground 必须传同一个
     * 类型（不传会按 manifest 推断，但传错类型直接抛 IllegalArgumentException）。
     * Android 12 起：从后台启动前台服务会抛 ForegroundServiceStartNotAllowedException，
     * 这里接住并提示，而不是让应用崩掉。
     */
    private void enterForeground(String state, String detail) {
        Notification notification = buildNotification(state, detail);
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
            } else {
                startForeground(NOTIFICATION_ID, notification);
            }
        } catch (RuntimeException error) {
            // 典型是 Android 12+ 的 ForegroundServiceStartNotAllowedException：
            // 用户从后台/开机自启拉起时会被拦，提示他手动打开应用即可。
            Bus.log("无法进入前台服务：" + error.getMessage());
            Bus.state("未启动", "系统阻止了后台启动，请打开应用后点「启动反连」");
        }
    }

    private void startBridge() {
        if (client != null) return;
        Prefs prefs = new Prefs(this);
        if (!prefs.configured()) {
            currentState = "未配置";
            Bus.state("未配置", "请先填写控制台地址与令牌");
            updateNotification("未配置", "请先在应用里填写地址与令牌");
            return;
        }
        client = new DroidClient(prefs.url(), prefs.token(), prefs.deviceId(), this);
        client.start();
    }

    private void stopBridge() {
        if (client != null) {
            client.stop();
            client = null;
        }
        currentState = "已停止";
        Bus.state("已停止", "");
        if (Build.VERSION.SDK_INT >= 24) {
            stopForeground(true);
        } else {
            stopForeground(true);
        }
    }

    @Override
    public void onDestroy() {
        stopBridge();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    // ---------------------------------------------------------------- Platform

    public String model() {
        return (Build.MANUFACTURER + " " + Build.MODEL).trim();
    }

    public String androidVersion() {
        return Build.VERSION.RELEASE;
    }

    public int sdkInt() {
        return Build.VERSION.SDK_INT;
    }

    public File workDir() {
        return getCacheDir();
    }

    public void log(String line) {
        // 同时写 logcat：出问题时操作员可以用 `adb logcat -s regedit` 拿到完整链路，
        // 而不是只能盯着应用界面上那一行字（真机排障时就吃过这个亏）。
        android.util.Log.i("regedit", line);
        Bus.log(line);
    }

    public void onState(String state, String detail) {
        currentState = state;
        lastState = state;
        android.util.Log.i("regedit", "state=" + state + (detail == null || detail.isEmpty() ? "" : " detail=" + detail));
        Bus.state(state, detail);
        updateNotification(state, detail);
    }

    // ---------------------------------------------------------------- 通知

    private void createChannel() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager == null) return;
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID, getString(R.string.channel_name), NotificationManager.IMPORTANCE_LOW);
        channel.setDescription(getString(R.string.channel_desc));
        channel.setShowBadge(false);
        manager.createNotificationChannel(channel);
    }

    private Notification buildNotification(String state, String detail) {
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent content = PendingIntent.getActivity(
                this, 0, open, Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);

        Intent stop = new Intent(this, BridgeService.class);
        stop.setAction(ACTION_STOP);
        PendingIntent stopIntent = PendingIntent.getService(
                this, 1, stop, Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);

        Notification.Builder builder = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
        builder.setContentTitle("regedit 设备端 · " + state)
                .setContentText(detail == null || detail.isEmpty() ? "反连通道" : detail)
                .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
                .setOngoing(true)
                .setContentIntent(content)
                .addAction(0, "停止反连", stopIntent);
        if (Build.VERSION.SDK_INT >= 21) builder.setShowWhen(false);
        return builder.build();
    }

    private void updateNotification(String state, String detail) {
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager == null) return;
        manager.notify(NOTIFICATION_ID, buildNotification(state, detail));
    }

    /** 给 Activity 用：当前状态（Activity 重建后要能立刻显示对）。 */
    public static String lastState = "未启动";
}
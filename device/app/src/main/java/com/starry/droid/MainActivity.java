package com.starry.droid;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

/**
 * 主界面：填控制台地址与令牌 → 启动反连；下面是实时日志。
 *
 * 界面全部用代码搭（不写 XML 布局）：这个应用只有一屏三个控件，多一个 res 文件
 * 就要多一份维护成本。同时支持用 intent 直接拉起（测试与批量部署用）：
 *
 *   adb shell am start -n com.starry.droid/.MainActivity \
 *       --es url ws://10.0.2.2:9945/ws/droid --es token XXX --ez auto true
 */
public final class MainActivity extends Activity implements Bus.Listener {

    private EditText urlField;
    private EditText tokenField;
    private TextView stateView;
    private TextView logView;
    private Button startButton;
    private Button stopButton;

    private final StringBuilder logBuffer = new StringBuilder();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(buildUi());

        Prefs prefs = new Prefs(this);
        urlField.setText(prefs.url());
        tokenField.setText(prefs.token());
        stateView.setText("未启动");

        requestNotificationPermission();
        handleIntent(getIntent());
        Bus.register(this);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIntent(intent);
    }

    @Override
    protected void onDestroy() {
        Bus.unregister(this);
        super.onDestroy();
    }

    /** 支持 adb / 扫码器直接把地址与令牌塞进来，并可选自动连接。 */
    private void handleIntent(Intent intent) {
        if (intent == null) return;
        String url = intent.getStringExtra("url");
        String token = intent.getStringExtra("token");
        boolean auto = intent.getBooleanExtra("auto", false);
        Prefs prefs = new Prefs(this);
        if (url != null || token != null) {
            prefs.save(url != null ? url : prefs.url(), token != null ? token : prefs.token());
            urlField.setText(prefs.url());
            tokenField.setText(prefs.token());
        }
        // 只带 auto、不带地址令牌时用已保存的配置：进程被系统杀掉后重新打开应用，
        // 用户期望的就是"自己连回去"，而不是再点一次启动。
        if (auto && prefs.configured()) startBridge();
    }

    // ---------------------------------------------------------------- 界面

    private View buildUi() {
        int pad = dp(16);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.parseColor("#0B1218"));
        // Android 15/16 对 targetSdk 35+ 强制 edge-to-edge：内容会顶到状态栏底下。
        // 这里自己吃掉系统栏 inset，保证标题和输入框不被刘海/状态栏盖住。
        root.setFitsSystemWindows(true);
        if (Build.VERSION.SDK_INT >= 20) {
            root.setOnApplyWindowInsetsListener(new View.OnApplyWindowInsetsListener() {
                public android.view.WindowInsets onApplyWindowInsets(View view, android.view.WindowInsets insets) {
                    int top = insets.getSystemWindowInsetTop();
                    int bottom = insets.getSystemWindowInsetBottom();
                    view.setPadding(pad, pad + top, pad, pad + bottom);
                    return insets;
                }
            });
        } else {
            root.setPadding(pad, pad, pad, pad);
        }

        TextView title = new TextView(this);
        title.setText("Starry 设备端");
        title.setTextSize(20);
        title.setTextColor(Color.parseColor("#E6F4FF"));
        root.addView(title);

        TextView hint = new TextView(this);
        hint.setText("在控制台「安卓设备」页创建令牌，把拨号地址与令牌填在这里。设备主动反连，"
                + "控制台不需要对手机开放任何端口。");
        hint.setTextSize(12);
        hint.setTextColor(Color.parseColor("#8FA6BB"));
        hint.setPadding(0, dp(6), 0, dp(12));
        root.addView(hint);

        urlField = new EditText(this);
        urlField.setHint("ws://<控制台地址>:9945/ws/droid");
        urlField.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        urlField.setTextSize(13);
        urlField.setTextColor(Color.parseColor("#DDE8F4"));
        root.addView(urlField, rowParams());

        tokenField = new EditText(this);
        tokenField.setHint("设备令牌");
        tokenField.setInputType(InputType.TYPE_CLASS_TEXT);
        tokenField.setTextSize(13);
        tokenField.setTextColor(Color.parseColor("#DDE8F4"));
        root.addView(tokenField, rowParams());

        LinearLayout buttons = new LinearLayout(this);
        buttons.setOrientation(LinearLayout.HORIZONTAL);
        buttons.setPadding(0, dp(10), 0, dp(10));

        startButton = new Button(this);
        startButton.setText("启动反连");
        startButton.setOnClickListener(new View.OnClickListener() {
            public void onClick(View view) {
                startBridge();
            }
        });
        buttons.addView(startButton, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        stopButton = new Button(this);
        stopButton.setText("停止");
        stopButton.setOnClickListener(new View.OnClickListener() {
            public void onClick(View view) {
                stopBridge();
            }
        });
        buttons.addView(stopButton, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        root.addView(buttons);

        // 息屏后系统会冻结网络，反连就断了。这里给一个直达系统设置的入口，
        // 让操作员把本应用加进电池优化白名单（一次设置，长期有效）。
        Button batteryButton = new Button(this);
        batteryButton.setText("允许后台常驻（忽略电池优化）");
        batteryButton.setTextSize(12);
        batteryButton.setOnClickListener(new View.OnClickListener() {
            public void onClick(View view) {
                requestIgnoreBatteryOptimization();
            }
        });
        root.addView(batteryButton);

        stateView = new TextView(this);
        stateView.setTextSize(13);
        stateView.setTextColor(Color.parseColor("#3FE0A6"));
        stateView.setPadding(0, 0, 0, dp(8));
        root.addView(stateView);

        ScrollView scroll = new ScrollView(this);
        logView = new TextView(this);
        logView.setTextSize(11);
        logView.setTextColor(Color.parseColor("#9DB0C4"));
        logView.setTypeface(android.graphics.Typeface.MONOSPACE);
        scroll.addView(logView);
        root.addView(scroll, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        return root;
    }

    private LinearLayout.LayoutParams rowParams() {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        params.bottomMargin = dp(8);
        return params;
    }

    private int dp(int value) {
        return (int) (value * getResources().getDisplayMetrics().density);
    }

    // ---------------------------------------------------------------- 动作

    private void startBridge() {
        String rawUrl = urlField.getText().toString().trim();
        String token = tokenField.getText().toString().trim();
        if (rawUrl.isEmpty() || token.isEmpty()) {
            Toast.makeText(this, "请先填写地址与令牌", Toast.LENGTH_SHORT).show();
            return;
        }
        // 必须补全协议：只填 host:port 时 URI 解析会把主机名当 scheme 直接抛异常，
        // 连接一步都发不出去（真机就是这么卡住的）。
        String url = DroidClient.normalizeUrl(rawUrl);
        String original = rawUrl;
        if (!url.equals(original)) {
            urlField.setText(url);
            appendLog("地址已补全：" + original + " → " + url);
        }
        new Prefs(this).save(url, token);
        appendLog("目标：" + url);

        Intent intent = new Intent(this, BridgeService.class);
        intent.setAction(BridgeService.ACTION_START);
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(intent);
        else startService(intent);
    }

    private void stopBridge() {
        Intent intent = new Intent(this, BridgeService.class);
        intent.setAction(BridgeService.ACTION_STOP);
        startService(intent);
        stateView.setText("已停止");
        stateView.setTextColor(Color.parseColor("#8FA6BB"));
    }

    /**
     * 引导用户把本应用加入电池优化白名单。
     *
     * Android 6+ 的 Doze 在息屏后会冻结 CPU 与网络：前台服务只能保住进程，
     * 保不住网络（实测息屏 20 分钟设备就从控制台"离线"了，抓包自然失败）。
     * 已白名单时直接提示，不再反复弹系统对话框。
     */
    private void requestIgnoreBatteryOptimization() {
        android.os.PowerManager power = (android.os.PowerManager) getSystemService(POWER_SERVICE);
        String pkg = getPackageName();
        if (power != null && power.isIgnoringBatteryOptimizations(pkg)) {
            Toast.makeText(this, "已经在电池优化白名单里，息屏也能保持连接", Toast.LENGTH_LONG).show();
            appendLog("电池优化：已忽略（后台不受 Doze 限制）");
            return;
        }
        try {
            Intent intent = new Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            intent.setData(android.net.Uri.parse("package:" + pkg));
            startActivity(intent);
            appendLog("已弹出电池优化设置，请选择「允许」——否则息屏后连接会被系统掐断");
        } catch (RuntimeException error) {
            // 部分 ROM 没有这个 Activity，退回总列表页
            try {
                startActivity(new Intent(android.provider.Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
                appendLog("已打开电池优化列表，请手动找到本应用并设为「不优化」");
            } catch (RuntimeException ignored) {
                Toast.makeText(this, "这台设备没有开放电池优化设置，请到系统设置里手动允许后台运行", Toast.LENGTH_LONG).show();
            }
        }
    }

    private void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT < 33) return;
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return;
        requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1);
    }

    // ---------------------------------------------------------------- Bus

    public void onLog(final String line) {
        runOnUiThread(new Runnable() {
            public void run() {
                appendLog(line);
            }
        });
    }

    public void onState(final String state, final String detail) {
        runOnUiThread(new Runnable() {
            public void run() {
                stateView.setText(detail == null || detail.isEmpty() ? state : state + " · " + detail);
                stateView.setTextColor("在线".equals(state)
                        ? Color.parseColor("#3FE0A6")
                        : "断开".equals(state) || "未配置".equals(state)
                                ? Color.parseColor("#FF8A7A")
                                : Color.parseColor("#FFD489"));
            }
        });
    }

    private void appendLog(String line) {
        if (logBuffer.length() > 20000) logBuffer.delete(0, logBuffer.length() - 12000);
        logBuffer.append(line).append('\n');
        logView.setText(logBuffer.toString());
    }
}
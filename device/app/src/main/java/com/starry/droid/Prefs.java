package com.starry.droid;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import java.util.UUID;

/** 本地设置：控制台地址、令牌、以及一次生成后不再变化的设备 id。 */
public final class Prefs {

    private static final String FILE = "starry-device";
    private static final String KEY_URL = "url";
    private static final String KEY_TOKEN = "token";
    private static final String KEY_DEVICE_ID = "deviceId";

    private final SharedPreferences prefs;

    public Prefs(Context context) {
        this.prefs = context.getApplicationContext().getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    public String url() {
        return prefs.getString(KEY_URL, "");
    }

    public String token() {
        return prefs.getString(KEY_TOKEN, "");
    }

    /**
     * 设备 id：一次生成、永久复用。
     *
     * 不能每次连接重新生成——网关按 deviceId 合并设备记录，换 id 就等于在控制台里
     * 多出一台"新设备"，历史记录全断。
     */
    public String deviceId() {
        String existing = prefs.getString(KEY_DEVICE_ID, "");
        if (existing != null && !existing.isEmpty()) return existing;
        String generated = "rg-" + Build.MANUFACTURER.toLowerCase() + "-" + UUID.randomUUID().toString().replace("-", "").substring(0, 12);
        prefs.edit().putString(KEY_DEVICE_ID, generated).apply();
        return generated;
    }

    public void save(String url, String token) {
        prefs.edit().putString(KEY_URL, url == null ? "" : url.trim())
                .putString(KEY_TOKEN, token == null ? "" : token.trim())
                .apply();
    }

    public boolean configured() {
        return !url().isEmpty() && !token().isEmpty();
    }
}
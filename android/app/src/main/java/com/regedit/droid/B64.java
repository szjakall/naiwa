package com.regedit.droid;

/**
 * 极简 Base64。
 *
 * 为什么要自己写：`android.util.Base64` 只有 Android 有（核心类要在 PC 上跑测试），
 * `java.util.Base64` 又要 API 26（很多测试机是 7.x/8.0）。自己实现 40 行，两个问题
 * 一起消失，minSdk 也不必被迫抬高。
 */
final class B64 {

    private static final char[] ALPHABET =
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".toCharArray();

    private static final int[] INDEX = new int[128];

    static {
        for (int i = 0; i < INDEX.length; i++) INDEX[i] = -1;
        for (int i = 0; i < ALPHABET.length; i++) INDEX[ALPHABET[i]] = i;
    }

    private B64() {
    }

    static String encode(byte[] data) {
        if (data == null || data.length == 0) return "";
        StringBuilder out = new StringBuilder(((data.length + 2) / 3) * 4);
        int i = 0;
        while (i + 2 < data.length) {
            int triple = ((data[i] & 0xff) << 16) | ((data[i + 1] & 0xff) << 8) | (data[i + 2] & 0xff);
            out.append(ALPHABET[(triple >> 18) & 0x3f]);
            out.append(ALPHABET[(triple >> 12) & 0x3f]);
            out.append(ALPHABET[(triple >> 6) & 0x3f]);
            out.append(ALPHABET[triple & 0x3f]);
            i += 3;
        }
        int rest = data.length - i;
        if (rest == 1) {
            int chunk = (data[i] & 0xff) << 16;
            out.append(ALPHABET[(chunk >> 18) & 0x3f]);
            out.append(ALPHABET[(chunk >> 12) & 0x3f]);
            out.append("==");
        } else if (rest == 2) {
            int chunk = ((data[i] & 0xff) << 16) | ((data[i + 1] & 0xff) << 8);
            out.append(ALPHABET[(chunk >> 18) & 0x3f]);
            out.append(ALPHABET[(chunk >> 12) & 0x3f]);
            out.append(ALPHABET[(chunk >> 6) & 0x3f]);
            out.append('=');
        }
        return out.toString();
    }

    /** 解码；非法字符直接跳过，避免 half-broken 输入把整条流带崩。 */
    static byte[] decode(String text) {
        if (text == null || text.isEmpty()) return new byte[0];
        int length = text.length();
        int padding = 0;
        if (length >= 2 && text.charAt(length - 1) == '=') padding++;
        if (length >= 2 && text.charAt(length - 2) == '=') padding++;
        byte[] out = new byte[(length / 4) * 3 + 3];
        int written = 0;
        int buffer = 0;
        int bits = 0;
        for (int i = 0; i < length; i++) {
            char c = text.charAt(i);
            if (c == '=' || c == '\n' || c == '\r' || c == ' ') continue;
            int value = c < 128 ? INDEX[c] : -1;
            if (value < 0) continue;
            buffer = (buffer << 6) | value;
            bits += 6;
            if (bits >= 8) {
                bits -= 8;
                out[written++] = (byte) ((buffer >> bits) & 0xff);
            }
        }
        int resultLength = written - padding;
        if (resultLength < 0) resultLength = 0;
        byte[] result = new byte[resultLength];
        System.arraycopy(out, 0, result, 0, resultLength);
        return result;
    }
}
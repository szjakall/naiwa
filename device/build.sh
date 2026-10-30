#!/usr/bin/env bash
#
# starry 设备端 APK 构建脚本（不依赖 Gradle / AGP / 任何网络依赖）。
#
# 只用到 Android SDK 自带的四个工具：
#   aapt2     编译资源 + 链接清单
#   javac     编译（-source 8，兼容到 API 21）
#   d8        class → dex
#   apksigner 签名（首次自动生成调试密钥）
#
# 目标：minSdk 21（Android 5.0）到 targetSdk 36（Android 16）。
# Android 14/15/16 对前台服务的类型与权限有硬性要求，清单里已按 connectedDevice 声明。
#
# 用法：ANDROID_SDK_ROOT=/opt/android-sdk ./build.sh
# 产物：build/starry-droid.apk

set -euo pipefail

SDK="${ANDROID_SDK_ROOT:-/opt/android-sdk}"
# Android 16 = API 36。用 36 编译 + 36 目标，才能在 16 上走正常路径而不是兼容模式。
PLATFORM="${PLATFORM:-android-36}"
BUILD_TOOLS="${BUILD_TOOLS:-36.0.0}"
MIN_SDK="${MIN_SDK:-21}"
TARGET_SDK="${TARGET_SDK:-36}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$HERE/app"
OUT="$HERE/build"
BT="$SDK/build-tools/$BUILD_TOOLS"
ANDROID_JAR="$SDK/platforms/$PLATFORM/android.jar"

for tool in "$BT/aapt2" "$BT/d8" "$BT/apksigner" "$BT/zipalign"; do
    [ -x "$tool" ] || { echo "缺少构建工具：$tool（先跑 sdkmanager 装 build-tools;$BUILD_TOOLS）" >&2; exit 1; }
done
[ -f "$ANDROID_JAR" ] || { echo "缺少 android.jar：$ANDROID_JAR（先装 platforms;$PLATFORM）" >&2; exit 1; }
command -v javac >/dev/null || { echo "缺少 javac（需要 JDK 17）" >&2; exit 1; }

rm -rf "$OUT"
mkdir -p "$OUT/res" "$OUT/gen" "$OUT/obj" "$OUT/dex"

echo "[1/6] 编译资源"
"$BT/aapt2" compile --dir "$APP/src/main/res" -o "$OUT/res/" >/dev/null

echo "[2/6] 链接清单与资源（targetSdk $TARGET_SDK）"
"$BT/aapt2" link \
    -o "$OUT/base.apk" \
    -I "$ANDROID_JAR" \
    --manifest "$APP/src/main/AndroidManifest.xml" \
    --java "$OUT/gen" \
    --min-sdk-version "$MIN_SDK" \
    --target-sdk-version "$TARGET_SDK" \
    --version-code 9 \
    --version-name 1.0.0 \
    "$OUT/res"/*.flat

echo "[3/6] 编译 Java"
find "$APP/src/main/java" "$OUT/gen" -name '*.java' > "$OUT/sources.txt"
# javac 失败必须立刻停：之前用管道吞掉退出码，结果编译失败还照样打出了
# 一个缺类的 APK，装到设备上才开始报 NoClassDefFoundError。
if ! javac -source 8 -target 8 -encoding UTF-8 -nowarn \
    -bootclasspath "$ANDROID_JAR" \
    -classpath "$ANDROID_JAR" \
    -d "$OUT/obj" \
    @"$OUT/sources.txt" > "$OUT/javac.log" 2>&1; then
    grep -v 'bootstrap class path' "$OUT/javac.log" >&2 || true
    echo "Java 编译失败" >&2
    exit 1
fi
grep -v 'bootstrap class path' "$OUT/javac.log" 2>/dev/null | head -5 || true

echo "[4/6] 生成 dex"
find "$OUT/obj" -name '*.class' > "$OUT/classes.txt"
if [ ! -s "$OUT/classes.txt" ]; then
    echo "没有编译产物，检查源码路径" >&2
    exit 1
fi
"$BT/d8" --lib "$ANDROID_JAR" --min-api "$MIN_SDK" --output "$OUT/dex" @"$OUT/classes.txt" || {
    echo "d8 生成 dex 失败" >&2
    exit 1
}

echo "[5/6] 打包"
cp "$OUT/base.apk" "$OUT/unsigned.apk"
(cd "$OUT/dex" && zip -q -j "$OUT/unsigned.apk" classes*.dex)
"$BT/zipalign" -f -p 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"

echo "[6/6] 签名（v1+v2+v3，Android 14+ 只认 v2 以上）"
# 优先用项目内的 debug.keystore：这样同一份仓库在任何机器上重编出来的包都能
# 覆盖安装（升级要求签名一致），不会出现 INSTALL_FAILED_UPDATE_INCOMPATIBLE。
# 没有就退回 $HOME，最后才现场生成一把新的。
for candidate in "$HERE/debug.keystore" "$HOME/.starry-debug.keystore"; do
    if [ -f "$candidate" ]; then
        KEYSTORE="$candidate"
        break
    fi
done
KEYSTORE="${STARRY_KEYSTORE:-${KEYSTORE:-$HERE/debug.keystore}}"
if [ ! -f "$KEYSTORE" ]; then
    keytool -genkeypair -keystore "$KEYSTORE" -storepass starry -keypass starry \
        -alias starry -keyalg RSA -keysize 2048 -validity 10000 \
        -dname "CN=starry, OU=device, O=starry, L=., S=., C=CN" >/dev/null 2>&1
fi
echo "    使用密钥库：$KEYSTORE"
"$BT/apksigner" sign --ks "$KEYSTORE" --ks-pass pass:starry --key-pass pass:starry \
    --v1-signing-enabled true --v2-signing-enabled true --v3-signing-enabled true \
    --out "$OUT/starry-droid.apk" "$OUT/aligned.apk"
"$BT/apksigner" verify --print-certs "$OUT/starry-droid.apk" | head -3

echo
echo "== 产物信息 =="
"$BT/aapt2" dump badging "$OUT/starry-droid.apk" | grep -E "^(package|sdkVersion|targetSdkVersion|application-label)" || true
ls -lh "$OUT/starry-droid.apk"
sha256sum "$OUT/starry-droid.apk"
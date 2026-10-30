# Starry 设备端（Android）

对着控制台的**安卓反连 APK**：装在测试机上后主动拨回控制台，服务器不需要对手机开放任何端口。

- **minSdk 21（Android 5.0）／targetSdk 36（Android 16）**，在真机 Android 16 / arm64 / Magisk root 上验证
- 纯 Java、**零第三方依赖**（没有 OkHttp / AndroidX），APK 约 41KB
- 构建脚本只用 Android SDK 自带工具（aapt2 + javac + d8 + apksigner），**不需要 Gradle**

## 快速开始

```bash
# 直接用（仓库里已带编译好的包）
adb install -r starry-droid.apk

# 或者重新编译：需要 JDK 17 与 Android SDK（platforms;android-36 + build-tools;36.0.0）
export ANDROID_SDK_ROOT=/opt/android-sdk
./build.sh
# 产物：build/starry-droid.apk
```

> 仓库里带了一份 `debug.keystore`，`build.sh` 会优先用它签名——同一份代码在任何机器上
> 编出来的包签名一致，才能覆盖安装已有 App。要换自己的密钥：删掉它，或设 `STARRY_KEYSTORE`
> 指到别处；注意换密钥后必须卸载重装，手机上原有的配置会丢。

装到手机后：

1. 控制台「功能 → 安卓设备」新建令牌（明文只显示一次）
2. 打开 App，填地址与令牌，点「启动反连」
3. 控制台「在线设备」出现该设备，面板上就能执行命令、截屏、拉日志

**地址怎么填**：`ws://203.0.113.10:8787/ws/droid` 是完整写法，**只填 `203.0.113.10:8787` 也行**——
App 会自动补 `ws://` 和 `/ws/droid`（`http://`→`ws://`、`https://`→`wss://`）。
控制台端口取决于你的部署（默认 `8787`，可以改成 `8848` 之类，端口对上即可）。

> 这条自动补全是真机踩出来的：最初只填了 `203.0.113.10:8787/ws/droid`，`URI.create()` 把
> `203.0.113.10` 当成 scheme 解析，抛 `Illegal character in scheme name at index 0`，
> 而界面上只有这一句英文，连接一步都没发出去。现在 `DroidClient.normalizeUrl()` 统一补全，
> 并在界面上显示"地址已补全：xxx → ws://xxx"。

也可以用 adb 直接带参拉起（批量部署 / 自动化测试用）：

```bash
adb shell am start -n com.starry.droid/.MainActivity \
    --es url ws://10.0.2.2:8787/ws/droid --es token <令牌> --ez auto true
```

只带 `--ez auto true` 时用已保存的配置，适合"进程被杀后重新打开自动连回去"。

### 排障

App 的连接状态与每一步动作都会写 logcat，出问题先看这个：

```bash
adb logcat -s starry
# I starry : state=连接中 detail=退避 1s
# I starry : root=true
# I starry : state=在线
# I starry : 网关已接受 hello
```

连接断开后 App 自己会按 1s → 30s 指数退避重连，不需要人工干预；长时间离线才需要重开。

常见的 `state=断开` 原因：

| detail | 原因 | 处理 |
| --- | --- | --- |
| `401 Unauthorized` | 令牌无效或已吊销 | 控制台重新签发令牌 |
| `ECONNREFUSED` / 超时 | 端口不通或被防火墙拦 | 确认控制台监听 `0.0.0.0`、端口与 App 里一致 |
| `Illegal character in scheme name` | 地址没带协议 | 已自动补全，升级到当前版本即可 |
| `设备无响应`（控制台侧） | 进程被系统冻结 | 见下方"已知限制" |

没有公网可达地址时，用 `adb reverse` 把手机回环接到电脑上（控制台仍需可达）：

```bash
adb reverse tcp:8787 tcp:8787     # 手机 127.0.0.1:8787 → 电脑 8787
# App 里填 ws://127.0.0.1:8787/ws/droid
```

> 注意：这种方式依赖电脑上的转发链路（`adb reverse` 或你自己的中继进程）。
> 中继一断设备就掉线，且服务端看不到任何握手日志——排障时先确认链路是否存在。
> 条件允许时优先让设备直连控制台地址。

## 能做什么

| 能力 | 说明 | 依赖 |
| --- | --- | --- |
| `exec` | 执行任意 shell，可选 root（走 su） | 普通命令无需 root |
| 文件推送 | 分片写入（1MB/片），先落临时文件再搬位 | 目标目录可写或 root |
| 文件拉取 | **流式**回传，稳态内存约 2 个分片 | 只读即可 |
| 截屏 | `screencap` → 流式回传 PNG | root / 系统权限 |
| logcat | 最近 N 行，可带过滤 | root（Android 4.1 起限制） |
| 应用列表 | `pm list packages [-3]` | 已申请 QUERY_ALL_PACKAGES |
| 抓包 | tcpdump → pcap 回传；**启动前先探测 tcpdump 是否存在** | root + 设备有 tcpdump |
| TCP 隧道 | 服务端本机端口 ↔ 设备端口（frida-server 走这条） | 无 |

控制台侧对应的 agent 工具：`device_list` `device_exec` `device_file_list` `device_file_read`
`device_file_write` `device_logcat` `device_packages`。

## 实现取舍

| 项 | 取舍 |
| --- | --- |
| 语言/依赖 | **纯 Java，零依赖**（不引 OkHttp / AndroidX / zxing） |
| 构建 | aapt2 / javac / d8 / apksigner，离线可编，不需要 Gradle |
| 目标 SDK | **显式 targetSdk 36（Android 16）** |
| 前台服务类型 | `connectedDevice`（`dataSync` 在 Android 15+ 有 6 小时/日上限） |
| 包可见性 | 声明 `QUERY_ALL_PACKAGES`（Android 11+ 否则只看到自己） |
| 断线重连 | 1s → 30s 指数退避，前台服务常驻 |
| 扫码填入 | 未做（用 adb intent 带参拉起，或手动粘贴） |

## Android 14 / 15 / 16 适配点

这些都是"不改就装不上或跑不起来"的硬要求：

1. **前台服务类型**：Android 14 起 `startForeground` 必须与清单里的 `foregroundServiceType` 一致，并单独申请
   `FOREGROUND_SERVICE_CONNECTED_DEVICE`。代码里显式传类型，不靠系统推断。
2. **不用 dataSync**：Android 15 给 `dataSync` 加了每 24 小时 6 小时的上限，到点强停——反连会"自己消失"。
   改用 `connectedDevice`（无时限，语义也更贴）。
3. **包可见性**：Android 11+ 不声明 `QUERY_ALL_PACKAGES`，`pm list packages` 只会返回自己。
4. **edge-to-edge**：targetSdk 35+ 强制全屏铺开，界面自己吃掉状态栏 inset，否则标题被压在状态栏下面。
5. **签名**：Android 14+ 只认 v2 以上签名方案，构建脚本显式开启 v1+v2+v3。
6. **通知权限**：Android 13+ 需要运行时申请 `POST_NOTIFICATIONS`，拒绝也不影响连接（只是看不到常驻通知）。
7. **后台启动前台服务**：Android 12+ 会抛 `ForegroundServiceStartNotAllowedException`，已接住并提示用户手动打开。

## 实测记录（真机 Android 16 + root）

```
设备反连并出现在控制台      Android 16 · arm64 · root=true
exec（普通/root）           uid=10323… / id -u → 0
packages                    410 个包
logcat                      51 行
文件推送 → 设备端校验一致     33 字节
文件拉取                    33 字节
截屏                        202933 字节 PNG
抓包（tcpdump）             1167 字节，pcap 头正确
大文件流式拉取              46.8MB / 4988ms（服务端落盘下载）
10 条命令并发               10/10 不串号
TCP 隧道                    本机 :52823 → 设备 127.0.0.1:19099
失败信息透传                 读取失败：cat: … No such file
心跳 30 秒                   仍在线（idle 1s）
杀进程后重开                 自动连回
令牌吊销                     设备立即离线
```

## 已知限制

- **没有守护进程**：进程被系统杀掉后要等用户重开 App（连接状态会显示在面板上）。
- 抓包依赖设备自带 tcpdump；没有时会明确报错（不会假装在抓）。
- `screencap` / `logcat` 在非 root 设备上会被系统拒绝，错误信息会原样带回控制台。
- 未做扫码填入，令牌用复制粘贴。
- 仓库内的 `debug.keystore` 是调试密钥，正式分发请换自己的 keystore 并先卸载重装。
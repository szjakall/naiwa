/**
 * 设备端 APK 与 regedit 设备网关之间的线上协议。
 *
 * 这是本项目的自有协议：帧类型、字段名、streaming 分片规则都由这里定义，
 * 服务端与 `android/` 里的设备端实现共同遵守同一个约定。
 *
 * 全 JSON 帧；二进制载荷（截屏、拉取的文件、pcap）双向都按 reqId 分片走
 * `data` / `push` 帧——一条 WS 消息塞不进 300MB 的 pcap，而且手机才是那个
 * 要把整个载荷攒在内存里的角色。所有请求都带 id、设备原样回显，因此可以
 * 同时有多个请求在飞，一条慢命令不会堵住通道。
 */

/** 单条流式载荷上限（256MB）。 */
export const DROID_MAX_STREAM_BYTES = 256 * 1024 * 1024;

/** 单帧上限：一个 base64 分片必须小于它。 */
export const DROID_MAX_FRAME_BYTES = 8 * 1024 * 1024;

/** push 的原始字节分片大小：1MB 文件约 1.37MB base64，远低于单帧上限。 */
export const DROID_PUSH_CHUNK_BYTES = 1024 * 1024;

/** 心跳间隔口径：设备 15s 一帧，连续三帧没来判定进程被冻结。 */
export const DROID_STALE_MS = 45_000;
export const DROID_WATCHDOG_TICK_MS = 5_000;

/** 请求/响应超时的默认值与下限。 */
export const DROID_DEFAULT_TIMEOUT_MS = 30_000;

export const DROID_PATH = "/ws/droid";
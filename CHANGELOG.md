# Starry 变更记录

Starry 是自主渗透测试控制台：会话 → 项目（任务）→ 资产 → 漏洞 → 报告，
配套 AI 守门（审批）、安卓设备反连与 MCP 工具生态。

## [1.0.3] — 2026-10-30

体验修复、目标推进语义调整、安卓流量独立页面，以及《代理能力融合方案》的后续增量。
（口令一致性修复原本单独占一个版本号，已并入本版，避免版本号跳到 v1.0.4。）

### 修复

- **对话页滚动（第二次）**：外壳给工作区页面的高度从 `100svh` 改成 `100dvh`，并让对话页
  外层内边距归零、留给页面内部处理；页面根节点改为 `h-full` + 栅格 `overflow-hidden`。
  上一版虽然给了高度，但被外层 padding 撑破，左栏仍然没有可滚动空间
- **口令漂移**：`change-password` 现在把新哈希同步写回 `settings.auth.password_hash`，
  两处不再分叉（此前改密只更新 `rbac_users`，排查时看起来像"服务端自己把口令改了"）

### 变更

- **取消"某轮没有工具调用即停止"**：目标推进不再据此收敛。不限轮次就是一直推进，
  退出只剩：手动停止、轮次预算用尽、运行出错
- 目标推进的活动流不再输出"第 N 轮无工具调用"的暂停原因

### 新增

- **安卓流量页**（`功能 → 安卓流量`）：把设备端 `capture_start/stop` 抓到的 pcap
  按"一份抓包 → 多条 HTTP 交换"展示，视觉与 Web 流量页一致（左列表 + 右明细）
  - 后端 `pcapsum`：pcap → 链路层（Ethernet/VLAN/SLL/SLL2/raw）→ IPv4 → TCP 载荷，
    按四元组配对请求/响应，识别方法、Host、路径、状态码、Content-Type、字节数与正文预览
  - 接口：`GET /api/android/captures`、`GET /api/android/captures/{name}/flows`、
    `GET .../download`、`DELETE .../{name}`
  - 明确不假装解密：TLS 只统计字节并标记"密文"
  - 单元测试：`pcapsum/pcap_test.go`（HTTP 解析、截断文件、非 pcap 拒绝）

### 安卓流量详情：请求包 / 响应包分开

- 按**方向**归类载荷（客户端→服务端 = 请求，服务端→客户端 = 响应），不再按内容猜。
  二进制协议没有请求行可嗅探，之前会把响应塞进请求，页面显示成 ↓0 B
- 详情面板改成左右两栏：请求包 / 响应包，各自文本优先、二进制给十六进制，并显示各自字节数
- 实测同一份抓包：111.30.187.245:8080 ↑436 B ↓200 B、211.95.34.130:443 ↑1016 B ↓824 B
  （修前第二条是 ↓0 B）

### 安卓流量：抓包不再"看不见"

- **根因**：设备端 tcpdump 把 pcap 写在手机上，只有 `capture_stop` 时才拉回控制台；
  抓包进行中不点停止，列表里就没有任何记录
- 新增 `POST /api/android/captures/pull` 与设备操作 `capture_pull`：**不打断抓包**，
  先拉一份当前快照（文件名 `live-<时间>.pcap`）
- 安卓流量页顶部加抓包控制条：选设备 → 开始抓包 / 拉取当前 / 停止并保存，
  并提示"要拉取或停止后才会出现在列表"
- 实测同一份设备抓包（286 报文）：DNS 解析出 `neverssl.com`、`example.com`；
  TLS 通过 SNI 解析出 `security.browser.miui.com`、`neverssl.com`、`example.com`

### 部署

- **默认 Docker 部署**：`Dockerfile` 改成多阶段（Node 22 构建前端 → Go 1.26 编单二进制 →
  Python 3.12 运行时），`docker compose up -d --build` 一条命令从源码起，不再要求预先准备
  `dist/<arch>/starry`
  - `docker-compose.yml` 默认 `build: .`（保留 `image:` 以便切回预构建镜像）
  - 数据卷固定 `/app/data`，`HEALTHCHECK` 打 `/api/health`
  - `.dockerignore` 瘦身构建上下文（排除 node_modules / next 产物 / data / dist）
  - `.env.example` 补 `STARRY_IMAGE` / `STARRY_PORT` / `STARRY_PROXY_PORT` / `GOPROXY`
- README 中英文均改为「Docker 优先」，补端口、数据卷、常用命令与「不用 Docker 的单二进制」路径

### 代理能力融合（续 1.0.2）

按《代理能力融合方案》的后续增量做优化。

### 新增

- **出口连通性自检**：保存出口前先探一次（TCP 可达；SOCKS5 还要完成握手），
  打不通直接 400 并给出原因。此前只校验格式，配了个不可达的代理会让操作员误判
  "抓不到包是目标的问题"
- **分流统计**：`GET /api/traffic/upstream` 返回 `via_upstream / via_bypass / via_direct`，
  UI 面板上直接显示——"配了出口到底有没有在用"一眼可见
- **流量页出口面板**：折叠面板，填地址 + 绕过列表，保存即生效；「改回直连」一键复位
- **单元测试**：`traffic/upstream_test.go` 覆盖分流判定（直连/出口/绕过后缀/后缀撞车）、
  配置校验（非法 scheme、裸地址补全）、探测（关端口、非 SOCKS5 端口）

### 实测

```
保存不可达出口   → 400 出口不可达（127.0.0.1:11080）: connection refused
起 SOCKS5 后保存 → 200，bypass=["internal.corp"]
请求 example.net → stats.via_upstream=1
请求 internal.corp → stats.via_bypass=1
go test ./traffic -run 'Upstream|Probe' → ok
```

### 待办（方案里未做的）

- 按任务指定出口：需要每个任务独立的 MITM 实例（端口/CA 分叉），
  属于架构改动，先不塞进补丁版本
- h2 经 SOCKS5 的回归用例：路由与探测已覆盖，h2 链路待补

## [1.0.2] — 2026-10-30

体验修复 + 代理出口能力融合。

### 修复

- **对话页滚动**：外壳给工作区页面一个确定高度（`100svh - header`）并改为 flex 列，页面根节点用
  `flex-1`；左栏会话列表恢复独立滚动。此前 `h-full` 在 auto 高度父级里退化为 auto，整页跟着变高，
  滚轮只作用在右侧内容上
- **不限轮次＝真不限**：删掉 50 轮硬上限，退出只靠"某一轮没有工具调用"、手动停止、运行出错
- **停止判定**：`runConversationSync` 结束会清掉 `chatCancel`，原先的"是否还在跑"判断永远为假，
  导致第一轮后误标"已手动停止"；改为 `/stop` 打独立标记，循环据此退出
- **任务/对话里的工具调用显示**：折叠行从单行截断改成两行折行 + 禁止横向溢出；
  结构化参数（`insert_assets` / `record_fact` / `insert_finding` 等）改为一行人话摘要，
  不再把整段 JSON 塞进一行

### 新增

- **流量出口代理**（融合 Sentinel 2.2.7 的出口治理）：`GET/POST /api/traffic/upstream`
  - 支持 `http` / `https` / `socks5` / `socks5h`，空串表示直连
  - `bypass` 后缀匹配表：命中的主机仍走直连
  - 落库持久化（`traffic_upstream` / `traffic_bypass`），重启自动恢复；校验失败保持原配置
  - 实测：经录制代理请求 `example.org` → 上游出现 `SOCKS5 CONNECT example.org:80`；
    加入 bypass 后 CONNECT 计数不变
  - 方案与取舍见 [docs/proxy-fusion.md](docs/proxy-fusion.md)
- **`-reset-admin` 命令行**：离线重置管理员口令（`./starry -reset-admin '新口令'`，
  传 `random` 自动生成），同时刷新 `settings` 里的兼容副本。此前口令漂移只能进数据库手工改

### 已知待办

- 出口代理目前只有 API，流量页表单未做

## [1.0.1] — 2026-10-30

按使用反馈修的五处问题。

### 修复

- **目标轮次支持"不限"**：下拉新增 `不限`（`round_limit=0`），循环不再被 3 轮写死；
  仍保留硬止损——不限轮次时最多 50 轮，且"某一轮没有工具调用"立即收敛
  - 真机验证：不限轮次 + "直接回答 OK 不调用工具" → 第 1 轮即暂停，原因"判定已给出结论"
- **安卓连接**：设备端不再依赖本机 SSH 中继（中继进程一断设备就掉线），改为直连
  `ws://<控制台>:8848/ws/droid`；设备端本身带 1s→30s 指数退避重连
- **已删除的设备令牌不再显示**：`ListDeviceTokens` 只返回未吊销令牌，吊销记录留库审计
- **对话页布局**：去掉重复内边距与写死的高度计算，改由外壳统一控制（聊天页外边距
  `p-2/md:p-3`），会话列表 17rem、栅格间距 `gap-3`，两侧空白明显收窄
- 语言包补齐 `chat.goal.unlimited`
- **构建可离线**：前端字体由 `next/font/google` 改成 `globals.css` 里的本机字体栈，
  静态导出不再在构建期下载字体（此前拉取失败会直接让构建挂掉）；产物因此小了约 2.8MB

### 文档

- `README.md` / `README.en.md` 按实际功能重写：能力矩阵（会话编排、目标轮次、审批门、设备通道、
  MCP、报告、知识库、RBAC、自更新）、三种安装方式、首次使用流程、安卓接入步骤、目录结构、
  配置项、排障清单
- `CONTRIBUTING.md` 补齐真实构建链（`npm run build:static` → 内嵌 UI/skills → `-tags embedui`）、
  `go vet` / `go test`、设备端 APK 构建与签名注意点
- `device/README.md` 对齐当前实现：产物名 `starry-droid.apk`、默认端口 `8787`、logcat 标签
  `starry`、断线退避重连、中继链路排查提示
- `docker-compose.yml` 注释里"SQLite"的旧说法改成实际的数据目录内容

## [1.0.0] — 2026-10-30

第一个可用版本：会话编排、审批、设备通道、目标推进四条主线全部闭环，接管 8848。

### 本版收口

- **设备 TCP 隧道**数据面打通：服务端本地监听 → 设备 `host:port` 双向透传。
  真机验证：设备端 `cat` 回显服务端发送的 `PING-ECHO-123`，两端日志对得上
  （`[tunnel] send conn=… bytes=17` ↔ `[tcp] send … found=true` / `flushed`）
- **目标推进（自主续跑）**：每轮自动继续，停止条件三条——本轮无工具调用（判定收敛）、
  轮次预算用尽、运行出错或手动停止；轮次与停止原因写进 `goal_state` 与会话活动流
  - 真机端到端：目标「确认 root + 列出前 3 个第三方应用」，2 轮共 9 次设备工具调用，
    结束后状态 `paused`，原因「达到轮次上限 2」
  - 前端对话页新增目标条：输入目标 → 自主推进 → 实时显示「运行中 · 2/3」，结束显示原因
- 版本号统一：二进制 `1.0.0`（`-X main.version`），前端 package.json 同步

### 已知限制（不打包成"已完成"）

- 目标收尾靠"本轮无工具调用"判定，没有独立的 `goal_complete` 工具；模型若在同一轮里
  既做完事又说"没做完"，判定会偏保守（暂停而不是继续）
- 设备端 App 的抓包/隧道功能已具备，但 `tcpdump` 与隧道都依赖 root；非 root 设备上
  抓包会明确报错而不是静默失败

## [0.9.2] — 2026-10-30

修掉两处真正的品牌残留（之前只替换了整词，没覆盖拆开写的名字）。

### 修复

- 登录页品牌名：原先硬编码成 `Anti<span>Fox</span>` 两个文本节点，整词替换匹配不到；
  改为 `Star<span>ry</span>`（渐变落在 ry 上），页面显示 Starry
- 站点图标：此前没有 favicon，浏览器只能用默认/缓存的旧图标；新增
  `src/app/icon.png`（512 五角星）与 `public/favicon.ico`（16/32/48/64 多尺寸），
  metadata 声明 `icons`，并给 `/favicon.ico`、`/logo.png`、`/login.jpg` 加 `?v=1` 破缓存

### 验证（服务端实测）

```
login HTML title      → Starry — 自主渗透测试控制台
18 个 JS chunk        → "Anti/Fox" 片段 0 处，"Starry" 14 处
<link rel=icon>       → /favicon.ico?v=1（9,553 字节，星形多尺寸）
/logo.png?v=1         → 512×512 五角星 73,460 字节
二进制                → 旧品牌字符串 0 处
```

## [0.9.1] — 2026-10-30

接管 8848（空库）并修正品牌遗留：图标与标题现在确定是 Starry + 五角星。

### 变更

- `starry` 以 systemd 服务接管 **8848**（0.0.0.0），原控制台服务停止并 disable
- 数据库重建为空库：首次初始化管理员、重新配置模型档案、重新签发设备令牌
- 品牌残留清理：`deploy/` 下的服务单元文件改名并换文案、
  `report/pybuilder/report_builder.py` 注释、`.gitignore` / `.dockerignore`；
  重新编译后二进制内旧品牌字符串为 **0**
- 登录页背景换成自绘星图（1600×900），侧栏图标沿用五角星 `logo.png`（512×512）
- 新增 TCP 隧道：`POST/GET/DELETE /api/devices/{key}/tunnel`，
  服务端本地监听 → 设备侧 `host:port`（控制面已验证：开/列/关、目标端口拒绝时错误可回传）

## [0.9.0] — 2026-10-30

守门 AI 判定与抓包上线，两项都在真机上跑通。

### 新增

- `ai` 审批模式接入守门模型：工具调用先落审计记录，再由模型裁决（只输出
  `{"allow":…,"reason":…}`），放行/拒绝都写进对话活动；模型不可用时 **fail-closed**
  （拒绝并说明原因），不出现"AI 模式却无人把关"
- 抓包操作进网关：`capture_start` / `capture_stop` / `capture_status`
  - pcap 走 data 帧回流后在服务端落盘到 `data/captures/cap-<时间>.pcap`，
    不把几十 MB 的 base64 塞进 JSON 响应
- 设备操作白名单扩到 10 项（exec / screencap / file_list / file_read / file_write /
  logcat / packages / capture_start / capture_stop / capture_status）

### 真机验证

```
capture_status  → /data/local/tmp/starry-capture.pcap（设备上有 /system/bin/tcpdump）
capture_start   → 启动成功
capture_stop    → 落盘 cap-20261029-171709.pcap（856 字节）
AI 判定（ai 模式会话）:
  线索 device_exec {"cmd":"id"} → 「🤖 AI 判定 #2 → 放行」，随后 agent 正常拿到 stdout
```

## [0.8.0] — 2026-10-30

设备端自有化并跑通真机：`device/` 编译出 `com.starry.droid`，真机全操作验证通过。

### 新增

- 设备端 App 改名与重签：`com.starry.droid` / 版本 0.8.0 / 应用名「Starry 设备端」，
  自带 `debug.keystore`（同仓库重编签名一致），`STARRY_KEYSTORE` 可覆盖
- 设备端能力与网关对齐：exec / pull / push（1MB 分片）/ screencap / logcat / packages /
  capture（tcpdump 生命周期）/ tcp 隧道（frida 场景）

### 修复

- `packages` 以 root 执行：非 root 身份受包可见性限制，`pm list packages` 只会看到自己
- `file_list` 自动补结尾斜杠：`/sdcard` 是符号链接，否则只列出链接本身而不是目录内容

### 真机验证（某安卓真机 / Android 16 / sdk 36）

```
设备上线   root=true，日志「网关已接受 hello」
exec       uid=0(root) … / 2407FRK8EC / 16
packages   77 个第三方应用
file_list  /sdcard 真实目录内容（304 项）
screencap  223KB PNG
logcat     正常返回
```

## [0.7.0] — 2026-10-30

品牌收口：只清理"别的仓库的名字"，功能与代码一律保留。

### 变更

- `db/schema.sql` 注释里的旧产品名改为 Starry
- 代码注释里借用外部项目名的技术词改成中性表述，行为不变
- 文档中不再出现其它仓库/产品的名字；`integrations/rea` 与 `device/` 的**代码保留**
- 设备网关按自有协议描述注释（帧格式不变：`hello / welcome / hb / exec / pull / push / data / result`）

### 现状

- 设备通道（反连 + 令牌 + exec / 截屏 / 文件 / logcat / packages）网关侧已实现并验证
- 设备端 App 源码保留在 `device/`，可继续编译与联调

## [0.6.0] — 2026-10-30

会话接入设备：安卓形态的对话里，agent 自己能列设备、执行命令、看文件与日志。
用真实模型 + 假设备跑通了完整闭环。

### 新增

- `engine/tool/device.go`：7 个设备工具
  `device_list` / `device_exec` / `device_file_list` / `device_file_read` /
  `device_file_write` / `device_logcat` / `device_packages`
  - 设备端把失败放在 `data.error` 时，工具层翻成 tool error，避免模型把
    "unsupported op" 当成功结果继续推理
  - `device_exec` / `device_file_write` 属有副作用工具，`review` 审批模式下同样排队
- `ChatAgent.SetDeviceBridge`：设备工具与基础工具同层挂载，模型不需要"切换模式"
- 设备选择顺序：工具显式指定 → 会话绑定 `device_key` → 唯一在线设备 → 多台时报错
  （多台时乱猜一台比报错更难查）
- 单测 `engine/tool/device_test.go`：注册、命令透传、base64 透传、设备错误转 tool error、
  无设备时的提示（`go test ./engine/tool/ ./guard/` 通过）

### 端到端验证（真实模型 + 假设备）

```
会话: platform=android / approval_mode=auto
用户: 请先在设备上执行 id 命令确认权限，然后只回答：设备返回了什么
agent: device_list {}                       → 1 台在线（Pixel 6 (fake) / Android 14）
       device_exec {"cmd":"id"}             → {"stdout":"uid=0(root) gid=0(root) # id","code":0}
最终答复: "设备返回：\n```\nuid=0(root) gid=0(root) # id\n```\n（stdout 原样引用如上，设备当前以 root 权限执行。）"
```

同轮的另一次运行里，收尾那次模型调用被上游 503 打断（`model_error`），
但设备调用与结果回传已完成——说明链路本身不依赖收尾是否成功。

### 待办

- 设备端 APK：按 `hello / call / result` 实现并打包（当前用假设备验证协议）
- 设备页把 `device_exec` 的审批接入（现在页面直接调用 HTTP，不经过 agent 的审批闸门）

## [0.5.0] — 2026-10-29

设备页 + 统一操作通道：签发令牌、看在线设备、跑命令/截屏/日志/文件，都在一个页面里。

### 新增

- `POST /api/devices/{key}/op {op, args}`：白名单式统一入口
  （`exec` / `screencap` / `file_list` / `file_read` / `file_write` / `logcat` / `packages`），
  非法 op 直接 400——不把任意操作透传给手机
- 设备页 `/function/devices`：左侧令牌（签发/吊销、明文只显示一次），右侧在线设备与操作面板
  （命令、截屏预览、logcat、应用列表、文件浏览）；设备状态每 5 秒刷新
- 侧边栏新增「安卓设备」入口；zh-CN / zh-TW / en-US 三套文案

### 已验证

```
POST /api/devices/{key}/op {"op":"exec","args":{"cmd":"id"}}
  → {"data":{"stdout":"uid=0(root)…","code":0},"ok":true}
POST … {"op":"file_list"}   → 设备端未实现时返回其自身错误（"unsupported op file_list"）
POST … {"op":"rm_rf"}       → HTTP 400（白名单拒绝）
GET  /function/devices      → 200（页面已编进二进制）
```

### 待办

- 会话接入：`platform=android` 的会话自动挑选设备，并把设备操作注册成 agent 工具
  （现在设备操作只有 HTTP API 与页面，agent 还不会自己用）
- 设备端 APK 按 `hello / call / result` 协议实现，替换假设备

## [0.4.0] — 2026-10-29

安卓设备反连网关打通（第一阶段）：设备主动连出来，控制台能列设备、下发命令、抓截屏。
用假设备做过闭环验证——真机 APK 协议对齐是下一步。

### 新增

- `device_tokens` 表：**只存 sha256 哈希**，明文仅在签发时返回一次；支持标签与吊销
- `droid` 包：
  - WS 反连 `/ws/droid?token=…`（设备令牌鉴权，不走操作员 JWT）
  - 握手 `hello` 上报机型 / Android 版本 / 架构 / root 状态，服务端落在线表并回 `welcome`
  - 请求/响应通道：`call` → `result`，按 id 关联，单次调用独立超时
  - 心跳与死连接清理：70 秒无帧即断开，避免僵尸连接占用设备名额
- API：`GET /api/devices`、`GET|POST /api/devices/tokens`、`DELETE /api/devices/tokens/{id}`、
  `POST /api/devices/{key}/exec`、`POST /api/devices/{key}/screencap`
- 路由修正：`/ws/` 单独指向 API 树（否则 WebSocket 升级会落到静态前端返回 200 HTML，
  客户端报 "Unexpected server response: 200"）

### 已验证（假设备闭环）

```
签发令牌 → 设备连接 ws://…/ws/droid?token=… → hello → welcome key=dev_a3a8982a20ee
GET  /api/devices          → 1 台在线（Pixel 6 (fake) / Android 14 / arm64 / root）
POST /api/devices/{key}/exec  {"cmd":"id"} → {"stdout":"uid=0(root) gid=0(root) # id","code":0}
POST /api/devices/{key}/screencap          → {"image_b64":"iVBORw0…","mime":"image/png"}
```

### 待办（阶段 3 剩余）

- 设备操作扩展：`file_list` / `file_read` / `file_write` / `logcat` / `packages`
- 设备页：在线列表、连通性、截屏预览、只读命令面板
- 会话接入：`platform=android` 的会话自动挑设备，并把设备操作注册成 agent 工具
- 设备端 APK：与网关协议对齐（当前只有假设备验证过）

## [0.3.0] — 2026-10-29

审批模式从"只注入提示词"变成**真的拦**：review 模式下有副作用的工具调用原地排队，
操作员在既有审批页放行后才执行，拒绝则把理由交回模型改道。

### 新增

- `guard.Gate` 接口 + `SetGate`：PreToolUse 钩子在破坏性规则之前先问会话策略
  - 只对**有副作用**的工具生效（Bash / shell_open / shell_send / Write / Edit / MultiEdit / NotebookEdit）；
    只读工具（fetch、dns、list…）不进队列，避免把等待时间浪费在无害调用上
  - 没有会话上下文的调用（后台任务引擎）不经过会话策略，行为与之前一致
- 服务端闸门 `Server.Ask`：读会话 `approval_mode`（3 秒缓存，避免每次调用查库）
  - `auto` 立即放行；`review` 落一条 `intercept_pending`（rule_id 为 NULL）并**阻塞等待**，
    上限 10 分钟，超时/取消都会把记录标成 timeout，动作不执行
  - `ai` 目前转人工队列并在提示与拒绝理由里写明"AI 判定未配置模型"，不假装有自动判定
- 等待审批时往对话里写一条活动（"⏸ 等待审批 #12 · Bash …"），界面不再是静止的
- 复用既有审批设施：仪表盘待审批卡片、`/system/intercept/approvals` 页、审计流水、
  `POST /api/intercept/pending/{id}/decide` —— 决策后会唤醒等待中的工具调用
- 单测 `guard/gate_test.go`：拒绝拦截、放行后仍过破坏性规则、只读工具不进队列、
  无会话上下文不触发（`go test ./guard/` 通过）

### 说明

- `ai` 模式的模型判定在阶段 4 接（守门提示词 + 结构化裁决），现在会明确降级为人工；
  不做"看起来自动、其实没人管"的假实现。

## [0.2.0] — 2026-10-29

会话编排落地：新建对话（以及已有对话）的输入框下方新增三个选择器——代理、审批模式、
Web/安卓形态；三项都是**按会话**保存，不再只有全局开关。

### 新增

- 数据模型：`conversations` 增加 `approval_mode`（auto/review/ai）、`platform`（web/android）、
  `device_key`；`schema.sql` 用 `ADD COLUMN IF NOT EXISTS` 原地升级，老库启动即迁移
- 接口：`POST /api/conversations` 接受三项；`PATCH /api/conversations/{id}` 支持部分更新
  （不传 = 保持不变，与"传 null 清空 LLM 档案"的语义区分开）；非法枚举值直接 400，
  不静默回落默认值
- 前端：输入框下方一行三个选择器（代理 / 审批模式 / 形态）；新建对话时作为初始值，
  已有对话里改动即时 PATCH 并回显；安卓形态旁给出"设备网关接入后可用"的说明
- 提示词注入：`platform=android` 时告诉模型优先走设备/移动端工具、没有设备要明说；
  `review`/`ai` 时说明按钮动作会进审批或由守门判定——同一句话在不同形态下不会走错路
- i18n：zh-CN / zh-TW / en-US 三套文案

### 待办

- 审批模式目前只注入提示词，**尚未接入审批队列与守门判定**（下一阶段做 guard 三档 + 队列）
- 安卓形态目前只影响提示词，**设备网关（反连 + 工具）尚未接入**（下一阶段）

## [0.1.0] — 2026-10-29

从上游 2.0.2 源码建立独立分支，完成品牌与资产剥离，作为后续功能开发的基线。

### 完成

- 代码库整体改名：Go 模块路径、命令目录（`cmd/starry`）、环境变量前缀（`STARRY_*`）、
  配置示例、启动脚本、系统服务名、前端文案与 i18n 全部指向 Starry
- 新图标：五角星 + 蓝紫渐变 + 外侧描边，透明底 512×512，深浅色主题通用
- 文档清洗：仓库内所有 Markdown 不含其它项目名
- 组件收录：`integrations/rea`（二进制分析 / 逆向工程 MCP 工具集）以源码形式随仓库分发，
  运行时通过 MCP 服务器配置登记为 `stdio` 传输；`device/` 存放设备端 App 源码

### 待办（按优先级）

1. **安卓设备**：设备反连网关（WebSocket + 令牌）、命令 / 文件 / 截屏 / logcat / 抓包 / Frida、
   APK 静态分析；会话与项目都要能绑定设备
2. **AI 守门**：三档模式（人工审批 / AI 判定 / 自动执行）、审批队列、判定流水与审计
3. **会话编排**：新建对话时选择代理（Agent）、审批模式、形态（Web / 安卓）；
   形态为安卓时会话直接使用绑定设备
4. **代理机制**：吸收主代理 + 规划 + 轮次/目标（goal）语义，工具调用走统一预算与收尾
5. 前端重建（Next 静态导出）与 Go 二进制打包（`-tags embedui`），系统服务切换

### 构建

```bash
# 后端（需要 Go 1.26+）
go build -o starry ./cmd/starry

# 前端（静态导出后放进 server/webui/dist，再用 embedui 标签编译进二进制）
cd web && npm ci && npm run build:static
```

### 许可

沿用上游 MIT 许可；`integrations/rea` 保留其自身 LICENSE。
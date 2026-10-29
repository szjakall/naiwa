# regedit

**安全评估控制台**：任务 → 资产 → 漏洞 → 报告的主链，加上安卓设备反连调试与守门（AI 审批）。

纯 Node（>= 20）、**零外部依赖**、**无需构建**：解压即跑。

```
node server/index.mjs
# 打开 http://127.0.0.1:8848/
```

> 首次启动会让你设置口令（scrypt 哈希落本机 `data/`），没有预置默认密码。

---

## 1. 功能

### 1.1 作业框架

- **任务引擎**：给一个授权范围内的域名/URL 清单，串行跑只读 GET —— 解析 DNS、抓首屏、读响应头与 TLS 证书、
  探测几个通用暴露点；每一步写任务事件与流量流水。
- **资产库**：域名 / IP / URL 自动登记，带**公司 / 项目归属**；按类型与公司过滤、加备注、切状态；
  同一资产跨任务合并；点行下钻到它关联的漏洞与请求流水。
- **公司（客户维度）**：公司 → 项目 → 资产 → 发现 逐层展开；改项目归属时，它名下的资产、发现、
  流量一起跟着走（不会出现"计数有、点进去空"）。
- **漏洞**：远程判定、对话 Agent 与 APK 静态结论汇到同一张表。每条带**编号、等级 + CVSS 3.1
  （含向量）、四态状态、类型、平台、原始请求/响应包、复现步骤、证据、修复建议、参考与处理时间线**；
  等级与分数不一致会显式标出，不给分就写「未评分」。可导出 Markdown，报告取材于同一份字段。
- **报告**：按任务或"全部未关闭发现"生成 Markdown（范围 / 概览 / 资产 / 发现 / 请求流水），
  也可以在生成时**勾选具体漏洞**（支持"仅高危以上"），只写选中的条目、资产也只带它们所属的；
  每条漏洞含「原始数据包（请求 / 响应）」「复现步骤」「参考」「处理时间线」，概览统计未评分与等级不一致的条数。
- **技能库**：扫描 `skills/*/SKILL.md`（可在设置里追加目录），卡片式浏览、全文渲染；同名技能以先命中的为准。
- **流量 / 审计日志**：每一次出网交互都留痕——HTTP、DNS、WHOIS、设备抓包。
  每条可展开看**原始请求包与响应包**（逐字报文：请求行 + 全部头 + 正文），也可单条复制；
  可按类型、项目、公司、会话过滤并实时刷新。报告里的"请求流水"与漏洞里的"原始数据包"都取自这里。

### 1.2 安卓模式

- **反连网关**：设备主动拨 `ws://<host>:<port>/ws/droid?token=…`，服务器不对手机开端口，NAT 后面也能用。
- **令牌即身份**：控制台创建令牌 → 贴在设备上 → 删除令牌立即踢下线且无法再认证。
- **冻结判定**：心跳 15s，超过 45s 没帧判"无响应"（不是离线！socket 还开着，只是进程被 SIGSTOP），
  在飞的请求立刻失败，第一次收到帧自动恢复。
- **设备工作台**：控制台（exec，root 可选）/ 文件（ls、拉取、推送）/ 屏幕（截屏、可选自动刷新）/
  日志（logcat）/ 抓包（tcpdump，pcap 落盘可下载）/ frida（模板脚本、推送、起 frida-server、TCP 隧道）/
  应用（包名列表）。
- **对话也能操作设备**：Agent 有 6 个设备工具（列设备 / exec / 截屏 / logcat / 拉文件 / 应用列表），
  命令过守门；会话或项目绑定哪台，就默认操作哪台。抓包落盘后同样进「流量」页。
- **APK 静态分析**（不需要设备）：纯 Node 解 ZIP → 解析二进制 AndroidManifest（AXML）→ 读 `classes*.dex`
  字符串表 → 给出包名/版本/权限/组件导出状态/签名方案/debuggable/allowBackup/cleartext，
  以及 URL、IP、邮箱、疑似密钥等线索；结论自动写进漏洞库。

### 1.3 设备端 APK（`android/`）

控制台的配套安卓 App，**自己实现、零依赖、源码可构建**：

- **targetSdk 36（Android 16）**，minSdk 21；已在真机（Xiaomi / Android 16 / Magisk root）上实测通过
- 纯 Java（无 OkHttp / AndroidX），APK 约 41KB，`android/build.sh` 只用 SDK 自带工具，**不需要 Gradle**
- 能力：exec（含 root）/ 文件推送拉取（流式）/ 截屏 / logcat / 应用列表 / tcpdump 抓包 / TCP 隧道
- 地址只填 `主机:端口` 也能连：会自动补 `ws://` 与 `/ws/droid`；`http://`→`ws://`、`https://`→`wss://`

细节见 [android/README.md](android/README.md)。

**已编译好的安装包**：`android/regedit-droid.apk`，与当前源码一致，`adb install -r` 或直接拷进手机安装。
重新编译用 `android/build.sh`，产物落在 `android/build/regedit-droid.apk`；签名密钥优先用项目内的
`android/debug.keystore`（这样任何机器重编的包都能覆盖安装），没有才会现场生成一把新的。

### 1.4 守门（AI 审批）

守门员判定的是 regedit 真能执行的三类动作：**设备命令**（含 root）、**文件推送**、**Frida 动作**
（起 frida-server / 写脚本），另可选用**任务引擎**。

三档模式（全局默认，立即生效）：

| 模式 | 行为 |
| --- | --- |
| `review` 人工审批 | 动作进队列，操作员在「守门」页点**批准**才在设备上执行；拒绝则不执行 |
| `ai` AI 审批 | 先交给守门模型判定：`ALLOW` 才执行，`BLOCK: 理由` 则拒绝并把理由回给调用方 |
| `auto` 自动执行 | 不判定，直接跑，记一条 `approval=auto` 的审计 |

三条刻意的行为：

1. **守门员只看这一次调用**（工具、来源、目标、参数），不看会话历史与目标情报——会推演"这可能是攻击
   第一步"的守门员会把侦察全拦掉。
2. **判定失败一律放行**（超时、端点 500、回复无法解析），记 `failed` 并在「守门」页顶部挂横幅。
   无人值守作业不能因为守门端点挂了就卡死。
3. **没配端点就拒绝切到 AI 审批**（而不是静默退化成 auto）。

判定提示词按设备语汇写：`rm -rf /sdcard/DCIM`、`pm clear`、`settings put`、`reboot`、`pm uninstall`
这类直接破坏数据/配置/可用性的动作 BLOCK；`id`、`cat /data/.../token.xml`、起 frida-server、抓包、
往 `/data/local/tmp` 推工具一律 ALLOW——只读即放行，无论多敏感。

审计：每次判定都落一条（含放行的），可按判定/方式/关键字过滤、分页、查看完整内容与 token 消耗。
「设置 → 账号」里配判定端点（OpenAI 兼容）、超时（1–120s）、并发上限、受守门类别，并有
**测试判定**按钮真跑一次端点确认可用。

### 1.5 其余页面

| 分组 | 页面 | 说明 |
| --- | --- | --- |
| 作业 | 总览 / 对话 / 任务 / 资产 / 漏洞 / 报告 / 公司 | 对话走真实模型调用并绑定项目；公司是客户维度 |
| 移动端 | 安卓设备 | 见 1.2 |
| 情报 | 探索图 / 知识库 / POC 库 / 资产测绘 | 见下 |
| 管控 | 守门 / 工具 / Agent / 权限 | 工具与权限是两道独立闸门 |
| 资料 | 流量 / 技能 / 代理 / 通知 / 审计日志 / 设置 | 设置分 9 个标签页（含「对话」） |

**探索图**：把评估画成 `目标 → 意图 → 事实 → 发现` 的图，按类型分列而非力导向
（力导向每次刷新都变位置，记不住）；「前沿」列出可执行的探索方向；写入按标题归一化去重，只累加
"观察次数"；删节点级联清边。

**知识库**：文档按段落切块（300–800 字，重叠 80 字），BM25 检索。中文用二元组分词，不依赖词典，
也不需要外部向量库。

**工具 / 权限双层闸门**：工具开关决定能力是否挂载（关掉后对应接口 **403**，不是藏按钮）；
角色权限决定这个人能不能用。两者都要过。

**模型与 token**：模型档案里配**上下文窗口（K tokens，0/留空=200K，上限 1000K）**与**最大输出**。
输入按"窗口减去输出预留"算预算，超出就从最旧一轮开始裁剪，并在回复里标注省略了多少条；
每条回复分开记**输入 / 输出** token（兼容 OpenAI 与 Anthropic 两种 usage 口径），
「设置 → 模型」的调用统计同样按输入/输出分列。

**对话是 Agent，不是聊天框**：模型可以调用 16 个工具真干活——查项目现状（任务/资产/漏洞/流量）、
真实 WHOIS（43 端口）与 DNS 解析、**子域批量枚举**、发起只读侦察（过守门）、把确认的漏洞落库
（含复现步骤与原始包）、按选中的漏洞生成报告，以及直接操作安卓设备（列设备 / 执行 shell / 截屏 /
logcat / 拉文件 / 应用列表，全部过守门）。
每次工具调用的参数与结果在对话里折叠展示。端点不支持 `tools` 时会自动退回纯聊天并说明。

**工具循环有兜底**：同名同参调用本轮只执行一次；每轮最多 8 个、整轮最多 24 个工具；
超限或模型还想继续查时，会再要一次**不带工具**的答复——所以"查了一堆、最后一句话没有"
不会再发生；万一仍为空，就用工具结果拼一条可读摘要。

**对话是流式的**：发送后用户气泡立刻出现，服务端用 SSE 把「建了项目 / 第几轮 / 哪个工具跑完 /
收尾原因 / 最终结果」逐步推回来；回复期间只有"正在回复"那一条气泡更新，输入框与历史消息不动，
所以连续对话不会卡。可以随时点「停止」中断（客户端断开也会中止上游请求）。

**对话即项目**：第一句里出现域名 / IP / URL 就自动建任务并开跑（开关在「设置 → 对话」），
同会话后续目标并进同一项目；目标是 App 时把会话形态切到「安卓」，项目按 App 建（认包名，
不发站点侦察），漏洞自动带包名与版本。页面顶部有项目条（状态 / 阶段 / 资产 / 发现 / 流量），
右侧是实时流量与本会话默认操作的安卓设备。资产、发现、流量都带 `taskId / companyId / conversationId`，
所以「流量」能按会话筛、「公司」能展开到项目与资产。

**POC 库**：Nuclei YAML 逐行解析索引字段（id/name/severity/tags/protocols），原文完整保存；
同 id 覆盖而非重复。

**资产测绘**：FOFA / 360 Quake / 奇安信 Hunter，保留各自查询语法，结果归一化成统一字段；
密钥掩码、每次查询记流水；只有「启用 + 有密钥 + 验证通过」才真正可用。

**Web 搜索**：Tavily，多 Key 号池按使用次数轮换。

**代理**：档案 CRUD + **真实连通性测试**（TCP 握手 + HTTP CONNECT）+ 订阅解析（base64 分享链接 /
Clash YAML / host:port 列表）。

**通知**：Webhook 与 SMTP 邮件，自实现 SMTP 状态机（零依赖）；三个触发点（守门拦截 / 任务完成 /
设备离线）；可发测试消息。

### 1.6 图标与标识

- 品牌名、页面标题、登录页、侧栏、报告页脚、脚本模板、`User-Agent`、数据目录命名全部是 **regedit**。
- **图标全部自绘**：`web/logo.svg`、`web/favicon.svg` 与 `web/js/icons.js` 里的 40 余个线性图标，
  统一 24×24 网格 / 1.7 描边 / 圆头圆角，造型是"注册表 + 钥匙孔"的几何语汇。

## 2. 快速开始

```bash
# 需要 Node.js >= 20（不需要 npm install，没有依赖）
node server/index.mjs
```

Windows 也可以双击 `start.cmd`，macOS/Linux 用 `./start.sh`。

启动日志会打印：

```
  regedit v1.1.0 —— 安全评估控制台
  ───────────────────────────────────────────
  控制台   http://127.0.0.1:8848/
  数据目录 <项目目录>\data
  会话     首次启动，按页面提示设置口令
  安卓反连 ws://0.0.0.0:9944/ws/droid
```

环境变量：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `REGEDIT_PORT` | `8848` | 控制台端口 |
| `REGEDIT_HOST` | `0.0.0.0` | 控制台绑定地址（只给本机用就设 `127.0.0.1`） |
| `REGEDIT_DATA` | `<项目>/data` | 数据目录（状态、报告、APK 产物） |

## 3. 目录结构

```
regedit/
├── server/
│   ├── index.mjs          进程入口：HTTP + REST + WS 升级 + 启动横幅
│   ├── api.mjs            REST 路由表（全部接口）
│   ├── config.mjs         路径、默认设置、settings.json 读写
│   ├── store.mjs          状态文档 + 250ms 防抖落盘 + 审计日志
│   ├── auth.mjs           scrypt 口令、内存会话、登录限速
│   ├── http.mjs           JSON/裸字节收发、静态文件（防目录穿越）
│   ├── ws.mjs             自研 RFC 6455 服务端（握手/掩码/分片/背压）
│   ├── droid.mjs          ★ 设备网关：注册表、令牌、请求/流、TCP 隧道
│   ├── droid-protocol.mjs ★ 设备协议常量
│   ├── apk.mjs            ★ APK 静态分析：ZIP / AXML / DEX
│   ├── recon.mjs          任务引擎：只读侦察 → 资产 → 发现
│   ├── reports.mjs        Markdown 报告
│   ├── gatekeeper.mjs     ★ 守门：三档模式、判定、审批队列、审计
│   ├── exploration.mjs    探索图：节点、边、前沿、活动流
│   ├── knowledge.mjs      知识库：分块 + BM25 检索
│   ├── pocs.mjs           POC 库：Nuclei 模板索引
│   ├── intel.mjs          资产测绘：FOFA / Quake / Hunter
│   ├── websearch.mjs      Web 搜索：Tavily
│   ├── tools.mjs          工具目录与开关
│   ├── rbac.mjs           角色与权限
│   ├── agents.mjs         Agent 定义、模型档案与角色绑定
│   ├── mcp.mjs            MCP 服务器配置与连通性测试
│   ├── proxies.mjs        代理档案与连通性测试
│   ├── notify.mjs         通知渠道（Webhook / SMTP）
│   ├── chat.mjs           对话与会话存储、项目绑定、自动建项目
│   ├── chat-tools.mjs     ★ 对话可调用的 15 个工具（含 6 个安卓设备工具）
│   ├── org.mjs            公司维度（含详情下钻）、报告模板与设置
│   ├── skills.mjs         技能库索引
│   └── selfcheck.mjs      离线自检
├── android/               ★ 设备端 APK（纯 Java，targetSdk 36）
│   ├── build.sh           一套 aapt2/javac/d8/apksigner 构建（无 Gradle）
│   └── app/src/main/java/com/regedit/droid/
│       ├── Json/B64/Wire  JSON、Base64、自研 WebSocket 客户端（协议核心）
│       ├── DroidClient    反连循环、hello、心跳、分帧分派
│       ├── Handlers       exec / 文件流式 / 截屏 / logcat / 抓包 / 隧道
│       └── MainActivity / BridgeService / Prefs   界面、前台服务、设置
├── web/
│   ├── index.html
│   ├── styles.css
│   ├── logo.svg / favicon.svg
│   └── js/
│       ├── app.js         外壳、哈希路由、登录/首次设置
│       ├── core.js        请求封装、安全模板、弹层、Markdown 渲染
│       ├── ui.js          卡片/统计/空态等布局件
│       ├── icons.js       图标集
│       ├── android-api.js 设备操作 API 封装
│       └── views/         22 个页面视图
├── skills/                项目自有技能（可选，存在即优先）
└── data/                  运行时生成：state.json / settings.json / artifacts/
```

## 4. 安卓模式：协议与接入

### 4.1 设备拨号

```
ws://<控制台或独立监听地址>:<端口>/ws/droid?token=<令牌>
```

设备端连上后必须先发 `hello`，否则网关关连接：

```json
{ "t": "hello", "token": "...", "deviceId": "稳定设备 id", "model": "Pixel 6",
  "androidVersion": "14", "sdkInt": 34, "rooted": true }
```

### 4.2 帧一览

| 方向 | 帧 | 说明 |
| --- | --- | --- |
| 服务端 → 设备 | `exec` | 执行 shell（`asRoot` 决定是否走 root） |
| | `pull` | 拉文件，回 `data` 分片 |
| | `push` | 写文件，`seq:0` 截断、`done:true` 收尾，1MB 一片 |
| | `screencap` | 截屏 PNG，回 `data` 分片 |
| | `logcat` | 最近 N 行，可带过滤 |
| | `packages` | 已装应用 |
| | `capture_start/stop/status` | 抓包生命周期 |
| | `tcp_open/send/close` | TCP 隧道：服务器本机端口 ↔ 设备端口 |
| 设备 → 服务端 | `hello` / `hb` | 握手 / 心跳（15s） |
| | `data` | 流式载荷分片（按 reqId 顺序校验） |
| | `result` | 请求最终结果（含退出码/stdout/stderr） |
| | `tcp_opened/tcp_data/tcp_closed` | 隧道事件 |

护栏：单帧 ≤ 8MB、单条流 ≤ 256MB、分片乱序即失败、push 逐片等 drain，
这些数值集中在 `server/droid-protocol.mjs`。

### 4.3 三步接入

1. 「安卓设备 → 连接令牌」新建令牌（自动复制）。
2. 设备装 `android/build.sh` 产出的 APK，打开后填上面的拨号地址 + 令牌。
3. 心跳进来即出现在「在线设备」，点卡片进工作台。

### 4.4 frida

- 工作台「Frida」页内置三个模板：SSL Pinning 绕过、root/模拟器检测绕过、签名/加密入口追踪。
- 「推送到设备」把脚本写到 `/data/local/tmp/<名字>`；
- 「在设备上启动」用 nohup 起 `frida-server`；
- 「开隧道」在本机监听一个端口并桥到设备 `127.0.0.1:27042`，主机上 `frida -H 127.0.0.1:<端口> -U` 即可。

> 隧道和 frida-server 都需要设备侧具备条件（root、已推送可执行文件）。工具只负责搬运，不判断设备是否"干净"。

## 5. 安全与授权

- 本项目是**攻击性安全工具**，只能用于已获书面授权的目标。未授权访问他人系统在多数司法辖区违法。
- 首次启动需设置口令；口令 scrypt 哈希存本机，**忘记无法找回**（删 `data/state.json` 会清空账号与业务数据）。
- 会话只在内存：重启即需重新登录。登录失败 8 次锁 10 分钟。
- 设备令牌等同口令：删除即失效，不要贴进公开渠道。反连监听绑 `0.0.0.0` 时同网段可达。
- 状态与产物全在 `data/`（`state.json` 单文件 + `artifacts/` 下的报告、pcap、APK）。备份拷这个目录即可。
- 静态文件服务做了路径归一 + 前缀校验，`/api/android/artifacts/:name` 只接受单层文件名。

## 6. 已知限制

- APK 分析是静态的：加固壳会掩盖 dex 真实内容，结论里会显式提示。
- 抓包依赖设备侧 `tcpdump` + root；截屏/文件读写的权限边界由设备端决定。
- 报告是 Markdown；要 Word/PDF 请套模板另转（避免把 OOXML 塞进这个零依赖工程）。
- 守门审计存在 `state.json` 里，按条数封顶 10000 条。
- `recon` 这个守门类别是"一次任务一次判定"，不是每个 GET 一次——后者会把一次侦察拖成几十次模型往返。
- 不含 iOS 设备模式；不含容器编排与 Agent 自动执行循环，探索图等能力以人工/API 驱动为主。
- 安卓端没有守护进程，进程被系统冻结后需重开应用（控制台会显示"无响应"并快速失败）。

## 7. 自检

```bash
node server/selfcheck.mjs
```

不启服务、秒级跑完，覆盖：

- 26 个服务端模块能否加载（循环依赖、语法错会立刻暴露）
- APK 解析器：现场构造一个合成 APK 走一遍 ZIP / AXML / DEX 全路径
- 守门判定解析：`ALLOW / BLOCK / BLOCKED / 拦截 / 无法解析` 五类样本
- 知识库入库与检索、POC 模板解析、探索图去重与级联删除

## 8. 服务器部署

参考流程（把占位地址换成自己的）：

| 项 | 建议值 |
| --- | --- |
| 代码目录 | `/opt/regedit` |
| 控制台端口 | `8848`（`0.0.0.0:8848`） |
| 安卓反连端口 | `9945`（`0.0.0.0:9945`；被占用就在设置里换一个） |
| 进程托管 | systemd，`Restart=on-failure` + `enable` 开机自启 |
| 日志 | `/opt/regedit/regedit.log` |
| 数据 | `/opt/regedit/data`（`state.json` / `settings.json` / `artifacts`） |

systemd 单元示例：

```ini
[Unit]
Description=regedit security console
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/regedit
ExecStart=/usr/bin/node /opt/regedit/server/index.mjs
Restart=on-failure
RestartSec=3
Environment=REGEDIT_PORT=8848
StandardOutput=append:/opt/regedit/regedit.log
StandardError=append:/opt/regedit/regedit.log

[Install]
WantedBy=multi-user.target
```

```bash
tar -xzf regedit.tar.gz -C /opt/regedit
systemctl daemon-reload && systemctl enable --now regedit
```

更新时解包覆盖再 `systemctl restart regedit`；`data/` 不在包里，账号与业务数据不会被动到。

想用 80/443 走域名访问，在 nginx 上加一个 server 块反代到 `127.0.0.1:8848`，
并给 `/ws/droid` 放行 `Upgrade` / `Connection` 头——本项目本身不需要改配置。

反代**必须关掉缓冲**，否则对话的流式事件会被攒到结束才一次性到达（表现就是"发送后没反应，
过很久才刷出来"）：

```nginx
location / {
    proxy_pass http://127.0.0.1:8848;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_buffering off;          # SSE 关键
    proxy_cache off;
    proxy_read_timeout 300s;
}
```

服务端已经带了 `X-Accel-Buffering: no`，nginx 会据此自动关闭该响应的缓冲；但显式写上更稳。

## 9. 许可证

MIT。
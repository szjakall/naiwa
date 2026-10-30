<div align="center">

# ✦ Starry

**AI 自主渗透测试控制台** · 单二进制 · 对话驱动

<img src="web/public/logo.png" alt="Starry" width="160" />

侦察到报告全程可介入 · Web 站点与安卓设备同一套编排 · 每个动作都有审批与留痕

中文 | [English](README.en.md)

[![License](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/szjakall/naiwa?color=success)](https://github.com/szjakall/naiwa/releases/latest)
[![Go](https://img.shields.io/badge/Go-1.24+-00ADD8?logo=go&logoColor=white)](go.mod)

</div>

---

## 这是什么

Starry 是一个自托管的渗透测试控制台：**Go 单二进制内嵌 Next.js 前端**，数据落 PostgreSQL。
你在「对话」页给一名 agent 一句话，它在目标上执行动作——Web 站点走 HTTP/MITM 流量，安卓设备走反连通道——
选中的动作先过审批门（自动放行 / 人工审批 / AI 判定），产生的资产、发现、报文、报告全部落库。

它不等同于"全自动扫描器"：默认每个有副作用的动作都要过审批，产物是可复核的链路而不是一堆标题。

## 能力概览

| 模块 | 实际做什么 |
| --- | --- |
| 对话编排 | 每条对话独立设置 **Agent / 审批模式 / 形态（Web·安卓）/ 绑定设备**；同一操作员可一条全自动、另一条逐条审批 |
| 目标推进 | 一句话目标 + 轮次预算（1/2/3/5/8/10 或**不限**）自动续跑；收敛条件：某轮无工具调用、预算用尽、出错或手动停止 |
| 审批门 | `auto` 全放行 / `review` 阻塞等人工（10 分钟超时）/ `ai` 由模型判定，异常一律拒绝；覆盖 Bash、文件写入、设备命令等副作用工具 |
| 安卓设备 | 设备端 App 反连控制台；agent 可调 7 个设备工具；面板上可执行命令、截屏、拉日志、列应用、读写文件、抓包与 TCP 隧道 |
| MCP | stdio / HTTP 两种传输，工具自动发现；内置示例已接 170 项逆向工程工具、浏览器、文件系统、GitHub |
| 任务 / 资产 / 发现 | 任务下挂资产与发现，严重度四级、复现步骤与真实报文关联 |
| 流量 | 内置 MITM 录制（默认 `:8788`），请求响应落库、可在页面检索 |
| 报告 | AI 叙述 + Python 渲染成交付级 `.docx`（封面/目录/页码/属性表），支持简 / 繁 / 英 |
| 知识库 | pgvector 可用时语义检索，不可用自动降级关键词检索 |
| 用户与合规 | RBAC 多用户、权限矩阵、登录审计、拦截规则、审批记录、实时日志 |
| 自更新 | 二进制内一键升级，带校验与回滚位 |

## 快速开始

前置：**PostgreSQL 14+**、**LLM 凭据**（Anthropic / OpenAI 兼容接口任选，也可在 UI 里配）。
生成 `.docx` 报告需要 `python3` + `python-docx`（Docker 镜像已内置）。

### 方式一：Docker（推荐）

```bash
curl -O https://raw.githubusercontent.com/szjakall/naiwa/main/docker-compose.yml
curl -O https://raw.githubusercontent.com/szjakall/naiwa/main/.env.example
cp .env.example .env          # 至少改 POSTGRES_PASSWORD
docker compose up -d
```

打开 `http://localhost:8787`，首次进入 `/setup` 设置管理员密码。
镜像自带 Chromium 与 Playwright，浏览器类 MCP 开箱可用。

### 方式二：预编译二进制

到 [Releases](https://github.com/szjakall/naiwa/releases/latest) 下载对应平台包，解压后：

```bash
cp config.example.json config.json   # 填 database 连接
./starry -addr :8787 -data ./data
```

数据库连接也可用环境变量覆盖：`STARRY_PG_DSN=postgres://user:pass@host:5432/starry?sslmode=disable`。

### 方式三：从源码构建

前置 Go 1.24+、Node 20+、PostgreSQL：

```bash
cd web
npm install
npm run build:static                 # 静态导出到 web/out（构建期不访问外网）
cd ..

rm -rf server/webui/dist && mkdir -p server/webui/dist
cp -r web/out/. server/webui/dist/   # 前端内嵌

rm -rf server/skillsdist && mkdir -p server/skillsdist
cp -r skills/. server/skillsdist/    # 内置 skill 内嵌

CGO_ENABLED=0 go build -tags embedui -trimpath -o starry ./cmd/starry
./starry -addr :8787 -data ./data
```

完整步骤与开发约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 首次使用

1. `/setup` 设置管理员密码 → 登录
2. **系统 → LLM**：填接口地址、模型、密钥，设为默认档案
3. **对话 → 新建对话**：目标条上选 Agent、审批模式、形态
4. 输入目标，选轮次预算，点「自主推进」；运行中可在活动流里看到每一步工具调用
5. 产物在 **任务 / 资产 / 发现 / 流量** 里，报告在 **系统 → 报告管理** 生成

## 接入安卓设备

设备端是一个独立 APK（`device/`，约 41KB），通过 WebSocket 反连控制台。

```bash
# 1. 签发令牌（控制台 → 功能 → 安卓设备 → 接入令牌）
#    明文只显示一次，服务端只存 sha256

# 2. 构建设备端 APK（需要 Android SDK + build-tools）
cd device
ANDROID_SDK_ROOT=/opt/android-sdk ./build.sh     # 产物 build/starry-droid.apk
adb install -r build/starry-droid.apk

# 3. App 里填控制台地址与令牌
#    ws://<控制台地址>:8787/ws/droid
```

设备在线后，面板上可直接执行命令、截屏、拉日志、列应用、读写文件、抓包；
对话里把形态选成「安卓设备」，agent 就会走设备通道而不是 HTTP。

已能对齐的协议动作：`exec` `pull` `push` `screencap` `logcat` `packages`
`capture_start/stop/status` `tcp_open/send/close`。

## 目录结构

```
cmd/starry/      入口与命令行参数
server/          HTTP API、路由、审批门、设备通道、MCP 接入、更新
agent/           agent 运行时（对话、工具装配、记忆）
engine/          事件驱动引擎与工具实现（含 device 工具）
guard/           副作用动作的审批与危险命令拦截
droid/           安卓反连协议（帧编解码、设备注册表、TCP 隧道）
db/              PostgreSQL schema 与数据访问
config/          配置加载（config.json / 环境变量）
report/          报告模型与 .docx 渲染（调用 python-docx）
integrations/    内置 MCP 集成（rea）
web/             Next.js 前端（静态导出后内嵌进二进制）
skills/          内置 skill 库（内嵌进二进制）
device/          安卓设备端源码与构建脚本
deploy/          systemd 单元示例
```

## 配置

| 来源 | 说明 |
| --- | --- |
| `config.json` | 数据库连接（分字段或 `database.dsn`） |
| `STARRY_PG_DSN` | 环境变量优先级高于 `config.json` |
| `-addr` | 监听地址，默认 `:8787` |
| `-proxy` | MITM 录制端口，默认 `:8788`；传空串关闭 |
| `-data` | 数据目录（JWT 密钥、流量、抓包、报告），默认可执行文件旁的 `data/` |
| `STARRY_LLM_*` | LLM 默认值（provider / model / base_url / proxy），也可在 UI 配置 |

## 常见问题

**构建时前端报 `module not found` 与字体相关**：本项目前端已改为本机字体栈，构建期不访问外网；若你改动过 `web/src/lib/fonts`，请保持无网络依赖。

**前端构建被 OOM kill**：TypeScript 检查吃内存，`NODE_OPTIONS=--max-old-space-size=3072`；内存小于 4G 的机器建议加 swap。

**设备连不上**：确认 App 里填的是 `ws://<地址>:8787/ws/droid`（不是页面地址），令牌未被吊销，服务端日志里有对应握手记录。

**令牌列表为空但有设备在线**：列表只显示未吊销令牌；吊销记录留在库里做审计。

**报告生成失败**：检查宿主机是否有 `python3` 与 `python-docx`。

## 安全与合规

- 仅用于**已获授权**的目标。默认审批门就是为这个设计的：不要为了省事把全站都设成 `auto`。
- 设备通道与抓包能力等价于设备上的命令行权限，令牌泄露即等于设备失守；请按凭据管理对待。
- 发现的问题请按流程修复并在复测后关闭，报告里的证据（报文、截图）可能含敏感数据。

## 许可

**AGPL-3.0**，详见 [LICENSE](LICENSE)。使用、修改、再分发（含以网络服务形式提供）须遵守该协议条款。

本项目在开源社区既有成果之上持续二次开发，感谢上游作者与所有贡献者。

## 免责声明

本项目按"现状（AS IS）"提供，不附带任何明示或默示担保。
使用者须自行遵守所在国家 / 地区关于网络安全与数据保护的法律法规，并对使用行为及其后果负责。
严禁将本项目用于未授权测试、非法入侵、数据窃取或任何破坏性活动。
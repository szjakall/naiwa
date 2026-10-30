# Contributing to Starry

[中文](#中文) | [English](#english)

---

## 中文

欢迎贡献代码、文档、翻译与问题反馈。

### 环境要求

| 依赖 | 版本 | 用途 |
| --- | --- | --- |
| Go | 1.24+ | 后端与单二进制 |
| Node.js | 20+ | 前端构建 |
| PostgreSQL | 14+ | 全部数据 |
| Python 3 | 3.10+，含 `python-docx` | `.docx` 报告渲染（子进程调用） |
| Android SDK + build-tools | 34+ | 仅在改设备端 APK 时需要 |

### 从源码构建

```bash
# 1. 前端静态导出（构建期不访问外网；字体走本机字体栈）
cd web
npm install
npm run build:static                      # 产物在 web/out
cd ..

# 2. 前端内嵌进二进制
rm -rf server/webui/dist && mkdir -p server/webui/dist
cp -r web/out/. server/webui/dist/

# 3. 内置 skill 内嵌
rm -rf server/skillsdist && mkdir -p server/skillsdist
cp -r skills/. server/skillsdist/

# 4. 编译
CGO_ENABLED=0 go build -tags embedui -trimpath -o starry ./cmd/starry

# 5. 运行（数据库用环境变量，dataDir 用持久目录）
export STARRY_PG_DSN="postgres://starry:starry@localhost:5432/starry?sslmode=disable"
./starry -addr :8787 -data ./data
```

打开 `http://localhost:8787`，首次进入 `/setup` 设置管理员密码。

不带 `-tags embedui` 时不会内嵌前端，二进制会以 API-only 模式运行（调试后端接口时更快）。

### 数据库

`db/schema.sql` 在每次启动时幂等执行（`CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`），
改完重启即生效，不引入独立迁移工具。新增列请沿用 `IF NOT EXISTS` 写法，保证老库能平滑升级。

### 测试与自查

```bash
go build ./...                 # 编译
go vet ./...                   # 静态检查
go test ./...                  # 单元测试
node scripts/check-i18n-keys.mjs   # 三语键对账（改 i18n 后必须跑）
```

前端改动后请重新执行"静态导出 → 内嵌 → 重编二进制"，否则跑的是上一次的产物。
排查这类问题最快的方式是看二进制的构建时间：`ls -l starry`。

### 设备端 APK

```bash
cd device
ANDROID_SDK_ROOT=/opt/android-sdk ./build.sh    # 产物 build/starry-droid.apk
```

签名用的是仓库内的 `device/debug.keystore`（口令 `starry`）。要换自己的密钥：删掉该文件，
或用 `STARRY_KEYSTORE` 指向你的 keystore。**签名变了就无法覆盖安装**，需要先卸载旧 App。

设备端协议（帧格式、字段名）与服务端 `droid/` 目录一一对应，改动时两边必须同步。

### 提交约定

- 提交信息简洁，说明"改了什么 + 为什么"
- 涉及行为变化（默认值、审批语义、协议字段）时同步更新 `CHANGELOG.md`
- 不要提交 `data/`、`web/node_modules`、`web/.next`、`web/out`、`server/webui/dist`、`server/skillsdist`

### 贡献流程

1. Fork 仓库，基于 `main` 建分支
2. 改动后保持 `go build ./...` 与 `go test ./...` 通过
3. 发起 Pull Request，说明动机与影响范围

### 协议

本项目采用 **AGPL-3.0**。提交贡献即表示你同意你的贡献以相同协议授权。

---

## English

Contributions of code, docs, translations and issue reports are welcome.

### Requirements

| Dependency | Version | Purpose |
| --- | --- | --- |
| Go | 1.24+ | backend and the single binary |
| Node.js | 20+ | frontend build |
| PostgreSQL | 14+ | all data |
| Python 3 | 3.10+ with `python-docx` | `.docx` report rendering (spawned subprocess) |
| Android SDK + build-tools | 34+ | only when changing the device APK |

### Build from source

```bash
# 1. Static export (no network at build time; fonts are local stacks)
cd web
npm install
npm run build:static                      # output in web/out
cd ..

# 2. Embed the UI
rm -rf server/webui/dist && mkdir -p server/webui/dist
cp -r web/out/. server/webui/dist/

# 3. Embed the bundled skills
rm -rf server/skillsdist && mkdir -p server/skillsdist
cp -r skills/. server/skillsdist/

# 4. Build
CGO_ENABLED=0 go build -tags embedui -trimpath -o starry ./cmd/starry

# 5. Run (database via env, persistent dataDir)
export STARRY_PG_DSN="postgres://starry:starry@localhost:5432/starry?sslmode=disable"
./starry -addr :8787 -data ./data
```

Open `http://localhost:8787`; the first visit goes to `/setup`.

Without `-tags embedui` the binary runs API-only (handy while iterating on the backend).

### Database

`db/schema.sql` runs idempotently on every start (`CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`),
so there is no separate migration tool. New columns must use `IF NOT EXISTS` so existing databases upgrade in place.

### Checks

```bash
go build ./...
go vet ./...
go test ./...
node scripts/check-i18n-keys.mjs   # required after i18n edits
```

After frontend changes, re-run the export → embed → rebuild chain; otherwise you are running the previous bundle.
`ls -l starry` is the quickest way to spot a stale build.

### Device APK

```bash
cd device
ANDROID_SDK_ROOT=/opt/android-sdk ./build.sh    # -> build/starry-droid.apk
```

Signing uses the in-repo `device/debug.keystore` (password `starry`). To use your own, delete that file or point
`STARRY_KEYSTORE` at yours. **A different signature cannot upgrade-install over the old app** — uninstall first.

The device protocol (frames, field names) mirrors the `droid/` package; change both sides together.

### Commit conventions

- Concise messages: what changed and why
- Update `CHANGELOG.md` for behaviour changes (defaults, approval semantics, protocol fields)
- Never commit `data/`, `web/node_modules`, `web/.next`, `web/out`, `server/webui/dist`, `server/skillsdist`

### Workflow

1. Fork the repo and branch off `main`
2. Keep `go build ./...` and `go test ./...` green
3. Open a Pull Request describing the motivation and scope

### License

**AGPL-3.0**. By contributing you agree that your contributions are licensed under the same terms.
<div align="center">

# ✦ Starry

**AI-driven pentest console** · single binary · conversation-first

<img src="web/public/logo.png" alt="Starry" width="160" />

Recon to report with a human in the loop · one orchestration for web targets and Android devices · every side effect is gated and logged

[中文](README.md) | English

[![License](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/szjakall/naiwa?color=success)](https://github.com/szjakall/naiwa/releases/latest)
[![Go](https://img.shields.io/badge/Go-1.24+-00ADD8?logo=go&logoColor=white)](go.mod)

</div>

---

## What it is

Starry is a self-hosted pentest console: a **single Go binary with an embedded Next.js UI**, backed by PostgreSQL.
You type one sentence into a conversation; the agent acts on the target — HTTP and MITM traffic for web,
a reverse WebSocket channel for Android devices. Side-effecting actions pass an approval gate
(auto / human review / AI judgement), and assets, findings, packets and reports are persisted as they happen.

It is not a fire-and-forget scanner: by default every side-effecting action is gated, and the output is a
reviewable chain rather than a pile of titles.

## Capabilities

| Area | What it actually does |
| --- | --- |
| Conversations | Per-conversation **agent / approval mode / platform (web·android) / bound device**; one operator can keep one chat fully automatic and another fully reviewed |
| Goal loop | One-line goal plus a round budget (1/2/3/5/8/10 or **unlimited**); stops when a round makes no tool calls, the budget runs out, or it errors / is stopped |
| Approval gate | `auto` allow, `review` blocks for a human (10 min timeout), `ai` asks a model and fails closed; covers Bash, file writes and device commands |
| Android | Device app dials back to the console; the agent gets 7 device tools, the UI offers shell, screenshot, logcat, packages, file I/O, capture and TCP tunnels |
| MCP | stdio and HTTP transports with tool discovery; the bundled example wires 170 reverse-engineering tools plus browser, filesystem and GitHub |
| Tasks / assets / findings | Findings hang off tasks, four severity levels, steps linked to the real packets |
| Traffic | Built-in MITM recorder (default `:8788`), requests and responses persisted and searchable |
| Reports | AI narration rendered to delivery-grade `.docx` (cover, TOC, page numbers, attribute tables) in Simplified Chinese, Traditional Chinese or English |
| Knowledge | pgvector semantic search when available, keyword search as automatic fallback |
| Users & audit | RBAC, permission matrix, login audit, intercept rules, approval history, live logs |
| Self-update | In-binary upgrade with verification and a rollback slot |

## Quick start (Docker)

Docker is the recommended deployment: one command builds the UI and backend and starts PostgreSQL.

```bash
git clone https://github.com/szjakall/naiwa.git && cd naiwa
cp .env.example .env          # at least change POSTGRES_PASSWORD
docker compose up -d --build  # first build takes ~3-8 min
```

Open `http://localhost:8787`; the first visit goes to `/setup`.

| Port | Purpose |
| --- | --- |
| `8787` | Console (Web UI + API) |
| `8788` | MITM recording proxy |

State lives in `./data` on the host (JWT key, traffic recordings, captures, reports,
materialized skills); the database lives in the `pgdata` volume. `docker compose down`
keeps everything, and rebuilding the container does not lose data.

```bash
docker compose logs -f starry          # logs
docker compose up -d --build           # rebuild after code changes
docker compose down                    # stop (data kept)
docker compose down -v                 # also drop the database volume
```

The image ships Python 3.12 + `python-docx` (report rendering) and the usual recon tools
(`curl`, `rg`, `nmap`, `dnsutils`), so the host needs no runtime.

### Reusing an existing PostgreSQL (host network)

Running a single container outside compose is common when the database already lives on the host.
A bridge network cannot reach the host's `127.0.0.1`, so `--network host` is the simplest option:

```bash
docker run -d --name starry --network host --restart unless-stopped \
  -v /opt/starry/data:/app/data \
  -e STARRY_PG_DSN="postgres://user:pass@127.0.0.1:5432/starry?sslmode=disable" \
  -e STARRY_HEALTH_PORT=8848 \
  starry:latest -addr :8848 -proxy 127.0.0.1:18889 -data /app/data
```

- If you change `-addr`, set `STARRY_HEALTH_PORT` accordingly or the container reports unhealthy
  while the service is actually fine
- With `--network host` the container owns host ports directly — make sure nothing else is bound
- Mounting the data directory keeps `jwt.key`, captures and reports across image upgrades

### Without Docker: single binary

Grab a build from [Releases](https://github.com/szjakall/naiwa/releases/latest), point it at a PostgreSQL, then:

```bash
cp config.example.json config.json   # fill in the database block
./starry -addr :8787 -data ./data
```

The database can also come from `STARRY_PG_DSN=postgres://user:pass@host:5432/starry?sslmode=disable`.

### Building from source

Frontend changes must be re-exported and re-embedded; see [CONTRIBUTING.md](CONTRIBUTING.md):

```bash
cd web && npm install && npm run build:static && cd ..
rm -rf server/webui/dist && mkdir -p server/webui/dist && cp -r web/out/. server/webui/dist/
rm -rf server/skillsdist && mkdir -p server/skillsdist && cp -r skills/. server/skillsdist/
CGO_ENABLED=0 go build -tags embedui -trimpath -o starry ./cmd/starry
```

## First run

1. `/setup` to set the admin password, then sign in
2. **System → LLM**: endpoint, model, key; mark it as the active profile
3. **Chat → New chat**: pick agent, approval mode and platform on the goal bar
4. Enter the goal, pick a round budget, hit **Auto-run**; the activity stream shows every tool call
5. Products live under **Tasks / Assets / Findings / Traffic**; reports come from **System → Reports**

## Connecting an Android device

The device side is a standalone APK (`device/`, ~41 KB) that dials back over WebSocket.

```bash
# 1. Issue a token (Function → Android devices → tokens). Plaintext shows once;
#    the server only stores a sha256.

# 2. Build the APK (needs Android SDK + build-tools)
cd device
ANDROID_SDK_ROOT=/opt/android-sdk ./build.sh     # -> build/starry-droid.apk
adb install -r build/starry-droid.apk

# 3. In the app: console address + token
#    ws://<console-host>:8787/ws/droid
```

Once online, the panel exposes shell, screenshot, logcat, packages, file I/O, capture and TCP tunnels.
Set the conversation platform to **Android** and the agent will use the device channel instead of HTTP.

Protocol actions supported today: `exec` `pull` `push` `screencap` `logcat` `packages`
`capture_start/stop/status` `tcp_open/send/close`.

## Layout

```
cmd/starry/      entrypoint and flags
server/          HTTP API, routes, approval gate, device channel, MCP, updates
agent/           agent runtime (conversations, tool wiring, memory)
engine/          event-driven engine and tool implementations (incl. device)
guard/           approval gate and dangerous-command blocking
droid/           Android reverse protocol (framing, device registry, TCP tunnels)
db/              PostgreSQL schema and data access
config/          config loading (config.json / env)
report/          report model and .docx rendering (python-docx)
integrations/    bundled MCP integration (rea)
web/             Next.js frontend (static export embedded into the binary)
skills/          bundled skill library (embedded into the binary)
device/          Android device app sources and build script
deploy/          sample systemd unit
```

## Configuration

| Source | Meaning |
| --- | --- |
| `config.json` | database block (fields or a single `database.dsn`) |
| `STARRY_PG_DSN` | environment variable, wins over `config.json` |
| `-addr` | listen address, default `:8787` |
| `-proxy` | MITM recorder port, default `:8788`; empty string disables |
| `-data` | data directory (JWT key, traffic, captures, reports); defaults to `data/` next to the binary |
| `STARRY_LLM_*` | default LLM settings (provider / model / base_url / proxy); can also be set in the UI |

## Troubleshooting

**Frontend build fails with `module not found` around fonts** — the UI uses local font stacks and never fetches fonts at build time; keep `web/src/lib/fonts` network-free.

**Frontend build gets OOM-killed** — the TypeScript check is memory hungry: `NODE_OPTIONS=--max-old-space-size=3072`, and add swap on machines under 4 GB.

**Device will not connect** — the app must use `ws://<host>:8787/ws/droid` (not the page URL), the token must not be revoked, and the server log shows the handshake.

**Token list is empty although a device is online** — the list only shows active tokens; revoked rows stay in the database for audit.

**Report generation fails** — check `python3` and `python-docx` on the host.

## Security notes

- Use it only against targets you are authorised to test. The approval gate exists for that reason — do not set everything to `auto`.
- The device channel is equivalent to a shell on the phone; a leaked token means a compromised device.
- Findings and evidence (packets, screenshots) may contain sensitive data.

## License

**AGPL-3.0**, see [LICENSE](LICENSE). Use, modification and redistribution (including as a network service) must follow its terms.

This project continues to be developed on top of prior open-source work; thanks to the original authors and all contributors.

## Disclaimer

Provided "as is", without warranty of any kind. You are responsible for complying with the laws and
regulations of your jurisdiction. Do not use it for unauthorised testing, intrusion, data theft or any
destructive activity.
# syntax=docker/dockerfile:1
#
# Starry 多阶段构建：前端静态导出 → Go 单二进制（内嵌 UI 与 skills）→ 精简运行镜像。
#
# 为什么在镜像里编译：早期版本假设 CI 先给好 dist/<arch>/starry，本地 `docker build`
# 直接失败。现在 `docker compose up -d --build` 一条命令就能从源码起。
#
#   1) web     node:22  → npm ci → next build（静态导出，产物在 web/out）
#   2) build   golang:1.26 → web/out 塞进 server/webui/dist、skills 塞进 server/skillsdist，
#              go build -tags embedui 出单二进制
#   3) runtime python:3.12-slim（报告 .docx 需要 python-docx）+ 常用探测工具

# ---------- 1. 前端 ----------
FROM node:22-alpine AS web
WORKDIR /src/web
# 先只拷依赖清单，命中缓存时不必重装
COPY web/package.json web/package-lock.json* ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund
COPY web/ ./
# 构建期不访问外网字体（已改为本机字体栈）
RUN NODE_OPTIONS=--max-old-space-size=3072 npm run build:static

# ---------- 2. 后端 ----------
FROM golang:1.26-alpine AS build
RUN apk add --no-cache git ca-certificates
WORKDIR /src
# 依赖单独一层，改代码不必重下模块
COPY go.mod go.sum ./
ARG GOPROXY=https://proxy.golang.org,direct
ENV GOPROXY=${GOPROXY} GOTOOLCHAIN=auto CGO_ENABLED=0
RUN go mod download
COPY . .
COPY --from=web /src/web/out ./server/webui/dist
# 内置 skill：运行时会物化到 <data>/skills
RUN rm -rf ./server/skillsdist && mkdir -p ./server/skillsdist && cp -r ./skills/. ./server/skillsdist/
ARG VERSION=dev
RUN go build -tags embedui -trimpath \
      -ldflags "-s -w -X main.version=${VERSION} -X starry/server.BuildVersion=${VERSION}" \
      -o /out/starry ./cmd/starry

# ---------- 3. 运行 ----------
FROM python:3.12-slim-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates tzdata curl ripgrep jq unzip \
      dnsutils iputils-ping netcat-openbsd whois nmap \
    && pip install --no-cache-dir python-docx \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /out/starry /app/starry
RUN chmod +x /app/starry

# 数据目录：JWT 密钥、流量录制、抓包、报告、skills 物化产物
ENV TZ=Asia/Shanghai
VOLUME ["/app/data"]
EXPOSE 8787 8788

# 监听端口可被 -addr 覆盖（例如直接跑宿主端口 8848 时），
# 健康检查跟着 STARRY_HEALTH_PORT 走，避免"服务正常但容器 unhealthy"。
ENV STARRY_HEALTH_PORT=8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD sh -c 'curl -fsS http://127.0.0.1:${STARRY_HEALTH_PORT}/api/health || exit 1'

ENTRYPOINT ["/app/starry"]
CMD ["-addr", ":8787", "-proxy", ":8788", "-data", "/app/data"]
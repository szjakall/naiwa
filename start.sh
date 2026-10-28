#!/bin/sh
# regedit 启动脚本：零依赖，只需要 node 20+
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
	echo "[regedit] 未找到 node，请安装 Node.js 20+：https://nodejs.org/" >&2
	exit 1
fi

exec node server/index.mjs
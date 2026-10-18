#!/bin/sh
set -eu

# Resolve relative configuration paths from the project, not the caller's directory.
CDPATH= cd -- "$(dirname -- "$0")"

if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' '找不到 Node.js，請先安裝 Node.js 22 或更新版本。' >&2
  exit 1
fi

node -e 'if (Number(process.versions.node.split(".")[0]) < 22) { console.error("需要 Node.js 22 或更新版本。"); process.exit(1); }'

if ! node --input-type=module -e 'await import("ws"); await import("yaml");' >/dev/null 2>&1; then
  printf '%s\n' '缺少或無法載入依賴，請在專案目錄執行 npm ci 後重試。' >&2
  exit 1
fi

exec node src/main.js "$@"

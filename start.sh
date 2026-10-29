#!/bin/sh
set -eu

# Resolve relative configuration paths from the project, not the caller's directory.
CDPATH= cd -- "$(dirname -- "$0")"

if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' '找不到 Node.js，請先安裝 Node.js 22 或更新版本。' >&2
  exit 1
fi

node -e 'if (Number(process.versions.node.split(".")[0]) < 22) { console.error("需要 Node.js 22 或更新版本。"); process.exit(1); }'

if ! node --input-type=module -e 'await import("ws"); await import("yaml"); await import("@resvg/resvg-js"); await import("pdfkit"); import.meta.resolve("@types/node/package.json"); import.meta.resolve("@types/ws/package.json"); import.meta.resolve("@types/pdfkit/package.json");' >/dev/null 2>&1 \
  || ! ./node_modules/.bin/tsc --version >/dev/null 2>&1; then
  if ! command -v npm >/dev/null 2>&1; then
    printf '%s\n' '找不到 npm，無法自動安裝依賴；請先安裝 npm 後重試。' >&2
    exit 1
  fi
  printf '%s\n' '依賴無法載入，正在依照 lockfile 自動安裝…'
  npm ci --include=dev --ignore-scripts
  node --input-type=module -e 'await import("ws"); await import("yaml"); await import("@resvg/resvg-js"); await import("pdfkit");'
fi

./node_modules/.bin/tsc -p tsconfig.json
exec node dist/src/main.js "$@"

#!/usr/bin/env bash
# 幂等激活本仓库 git hooks（统一约定：core.hooksPath 指向入库的 .githooks/）。
#
# 背景：.githooks/ 是受版本管理的钩子真源（入库可跟踪），Git 原生
#       core.hooksPath 激活 — 零复制、零漂移。.git/hooks/ 不再放置业务钩子。
# 设计：docs/superpowers/specs/2026-08-06-git-hooks-version-control-design.md
# 用法（任意 git 仓库根，含子仓）：
#   bash .githooks/install.sh
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
SRC="$REPO_ROOT/.githooks"
if [ ! -d "$SRC" ]; then
  echo "⚠ .githooks/ not found in $REPO_ROOT — skipped"
  exit 0
fi

# 已激活则跳过（幂等）
if [ "$(git config core.hooksPath 2>/dev/null)" = ".githooks" ]; then
  echo "✅ hooksPath already set to .githooks ($REPO_ROOT)"
  exit 0
fi

git config core.hooksPath .githooks
echo "✅ git config core.hooksPath .githooks — $REPO_ROOT"

# 打印版本清单（若有）
if [ -f "$SRC/HOOK_VERSION" ]; then
  echo "   hooks version: $(grep -v '^#' "$SRC/HOOK_VERSION" | tr '\n' ' ')"
fi

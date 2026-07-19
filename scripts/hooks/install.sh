#!/usr/bin/env bash
# 将本目录钩子模板安装到当前 git 仓库的 .git/hooks/。
# 用法（在子仓根执行）：
#   bash scripts/hooks/install.sh
set -euo pipefail

HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HOOKS_DIR/../.." && pwd)"
GIT_DIR="$(git -C "$REPO_ROOT" rev-parse --git-dir)"
if [[ "$GIT_DIR" != /* ]]; then
  GIT_DIR="$REPO_ROOT/$GIT_DIR"
fi
TARGET_DIR="$GIT_DIR/hooks"

mkdir -p "$TARGET_DIR"
for name in pre-commit; do
  src="$HOOKS_DIR/$name"
  dst="$TARGET_DIR/$name"
  if [[ ! -f "$src" ]]; then
    echo "skip missing template: $src" >&2
    continue
  fi
  cp "$src" "$dst"
  chmod +x "$dst"
  echo "installed $dst"
done

echo "hooks install complete."

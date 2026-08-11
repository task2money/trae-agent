#!/usr/bin/env bash
# ensure_commit_git_tag：禁止复用 HEAD 上过期的 arch_日期 tag；同分钟可幂等复用。
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LIB_SH="${SCRIPT_DIR}/../docker/buildDocker.lib.sh"

assert_eq() {
  local got="$1" want="$2" label="$3"
  if [[ "$got" != "$want" ]]; then
    echo "FAIL $label: got='$got' want='$want'" >&2
    exit 1
  fi
  echo "PASS $label"
}

assert_match() {
  local got="$1" pattern="$2" label="$3"
  if [[ ! "$got" =~ $pattern ]]; then
    echo "FAIL $label: got='$got' pattern='$pattern'" >&2
    exit 1
  fi
  echo "PASS $label"
}

TMP="$(mktemp -d)"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

git init -q "$TMP/repo"
git -C "$TMP/repo" config user.email "test@example.com"
git -C "$TMP/repo" config user.name "test"
echo ok > "$TMP/repo/README"
git -C "$TMP/repo" add README
git -C "$TMP/repo" commit -q -m "init"

# shellcheck source=../docker/buildDocker.lib.sh
SCRIPT_DIR="$SCRIPT_DIR" REPO_ROOT="$TMP/repo" source "$LIB_SH"

OLD_TAG="x86_64_2026-08-10_22-07"
git -C "$TMP/repo" tag "$OLD_TAG"
assert_eq "$(git -C "$TMP/repo" tag --points-at HEAD | head -1)" "$OLD_TAG" "fixture-old-tag-on-head"

TODAY_PREFIX="x86_64_$(date '+%Y-%m-%d')"
GOT="$(REPO_ROOT="$TMP/repo" ensure_commit_git_tag "x86_64")"
assert_match "$GOT" "^${TODAY_PREFIX}_[0-9]{2}-[0-9]{2}$" "stale-tag-not-reused-uses-today"
if [[ "$GOT" == "$OLD_TAG" ]]; then
  echo "FAIL stale-tag-not-reused: still returned old tag '$OLD_TAG'" >&2
  exit 1
fi
echo "PASS stale-tag-not-reused-differs-from-old"

GOT2="$(REPO_ROOT="$TMP/repo" ensure_commit_git_tag "x86_64")"
assert_eq "$GOT2" "$GOT" "same-minute-idempotent"

# 已有精确当前候选 tag 时直接复用（不新建）
assert_eq "$(git -C "$TMP/repo" tag --points-at HEAD | awk -v t="$GOT" '$0 == t { print; exit }')" "$GOT" "new-tag-points-at-head"

echo "OK buildDocker.git_tag"

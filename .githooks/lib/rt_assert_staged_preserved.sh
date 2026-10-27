#!/usr/bin/env bash
# OPT-20261002-005: assert staged index unchanged before pre-commit exits.
# Long random-test windows race with parallel Agent / Session Hub / auto-commit
# that may `git reset` / clear the index; without this guard git can create an
# empty commit once the hook returns success.
#
# OPT-20261014-013: 判据从「条目数未减少」升级为「条目集合完全相等」。
# 只查删不查增会静默放行钩子期间的**新增**条目：并发会话在长随机测试窗口里
# `git add` 的文件会被裹挟进本人提交（2026-10-14 实测两起：本人提交 6a5c18c8
# 卷走他会话 9 个文件，反向亦然），双方门禁全绿、无人察觉，污染历史与 blame。
#
# Usage (sourced from pre-commit.node before tests pass):
#   STAGED_COUNT_AT_START=N            # 只做「被清空」判据（未提供快照的调用方）
#   STAGED_SET_AT_START=$'a\nb'        # 钩子开始时的 `git diff --cached --name-only | sort`
#   PRECOMMIT_STAGED_GUARD_ALLOW_ADD   # 允许新增的**精确路径**（换行分隔）；
#                                      # 给「钩子自身合法写索引」的仓库用
#   rt_assert_staged_preserved
#
# Env:
#   PRECOMMIT_SKIP_STAGED_GUARD=1  — emergency bypass (documented only)
#
# 适用边界：本守卫要求「门禁期间索引只能原样不动」。**meta 仓不要用集合判据**——
# 它的 pre-commit 自身就会改索引（发布指针 hook 在钩子内改写并 git add
# conf.example/releases.yaml；pre-commit framework 的 auto-fix 会重新暂存生成物），
# 一律判失败会把每一次正常提交都拦下。meta 的「并发裹挟」问题需要另一种机制，
# 不能靠把这条判据复制过去解决（OPT-20261014-013 的 Action(2) 因此未做）。

# 一次索引快照：排序去重，供集合比对使用（LC_ALL=C 保证两次排序口径一致）。
rt_staged_guard_snapshot() {
  git diff --cached --name-only 2>/dev/null | grep -v '^$' | LC_ALL=C sort -u || true
}

rt_assert_staged_preserved() {
  if [ "${PRECOMMIT_SKIP_STAGED_GUARD:-}" = "1" ]; then
    echo "WARN: PRECOMMIT_SKIP_STAGED_GUARD=1 — skipping staged-index guard" >&2
    return 0
  fi
  local start="${STAGED_COUNT_AT_START:-0}"
  case "$start" in
    ''|*[!0-9]*) start=0 ;;
  esac
  local now
  now="$(git diff --cached --name-only 2>/dev/null | wc -l | tr -d '[:space:]')"
  case "$now" in
    ''|*[!0-9]*) now=0 ;;
  esac
  if [ "$start" -gt 0 ] && [ "$now" -le 0 ]; then
    echo "ERROR: staged index was cleared during pre-commit (had ${start} path(s), now empty)." >&2
    echo "       Aborting to avoid an empty commit (OPT-20261002-005)." >&2
    echo "       Likely race: parallel Agent/Session Hub/auto-commit ran git reset" >&2
    echo "       while this hook's random tests were still running." >&2
    echo "       Re-stage your files and commit again; avoid concurrent git reset" >&2
    echo "       in the same worktree during long pre-commit windows." >&2
    return 1
  fi

  # 集合比对：仅在调用方提供了快照时启用（未提供快照的调用方 → 保持原行为）。
  if [ -z "${STAGED_SET_AT_START+x}" ]; then
    return 0
  fi
  local before_file after_file removed added
  before_file="$(mktemp)"
  after_file="$(mktemp)"
  printf '%s\n' "${STAGED_SET_AT_START}" | grep -v '^$' | LC_ALL=C sort -u > "$before_file" || true
  rt_staged_guard_snapshot > "$after_file"
  removed="$(comm -23 "$before_file" "$after_file" || true)"
  added="$(comm -13 "$before_file" "$after_file" || true)"
  if [ -n "$added" ] && [ -n "${PRECOMMIT_STAGED_GUARD_ALLOW_ADD:-}" ]; then
    added="$(printf '%s\n' "$added" | grep -vxFf <(printf '%s\n' "${PRECOMMIT_STAGED_GUARD_ALLOW_ADD}") || true)"
  fi
  if [ -n "$removed" ] || [ -n "$added" ]; then
    echo "ERROR: 索引在门禁期间被并发会话修改，本提交会被裹挟他人的（或丢失自己的）暂存条目。" >&2
    echo "       请在独占窗口重试：先确认工作区归属，再重新 git add 并提交。" >&2
    if [ -n "$removed" ]; then
      echo "       期间被移出暂存（前 10 条）：" >&2
      printf '%s\n' "$removed" | head -n 10 | sed 's/^/         - /' >&2
    fi
    if [ -n "$added" ]; then
      echo "       期间被追加进暂存（前 10 条）：" >&2
      printf '%s\n' "$added" | head -n 10 | sed 's/^/         + /' >&2
      echo "       若某条是钩子自身合法写入的产物，请把它的**完整路径**加入" >&2
      echo "       PRECOMMIT_STAGED_GUARD_ALLOW_ADD 后再提交（OPT-20261014-013）。" >&2
    fi
    rm -f "$before_file" "$after_file"
    return 1
  fi
  rm -f "$before_file" "$after_file"
  return 0
}

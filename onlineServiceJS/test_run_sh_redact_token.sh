#!/usr/bin/env bash
# OPT-20260829-019: run.sh 控制台 URL 不得把完整 ACCESS_TOKEN 打到 stderr。
# 断言:
#   - bash -n 语法通过
#   - _console_token_label: dev 默认值原样、空值回退默认、真实令牌 -> <redacted>
#   - 用 prod-like 令牌跑控制台 echo 段，stderr 不含令牌明文，但含 <redacted>
#   - 完整可点击地址（含令牌）只写 gitignored runtime 文件
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUN_SH="$SCRIPT_DIR/run.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# 1. 语法检查
bash -n "$RUN_SH" || fail "bash -n $RUN_SH"

# 2. 提取 _console_token_label 函数并载入
FN="$(sed -n '/^_console_token_label() {/,/^}/p' "$RUN_SH")"
[[ -n "$FN" ]] || fail "找不到 _console_token_label 函数"
eval "$FN"

[[ "$(ACCESS_TOKEN=dev-local-token _console_token_label)" == "dev-local-token" ]] \
  || fail "dev-local-token 应原样显示"
[[ "$(ACCESS_TOKEN= _console_token_label)" == "dev-local-token" ]] \
  || fail "空令牌应回退 dev-local-token"
[[ "$(ACCESS_TOKEN=prod-like-token-xyz _console_token_label)" == "<redacted>" ]] \
  || fail "真实令牌应脱敏为 <redacted>"

# 3. 跑控制台 echo 段（Docker 模式分支的等价体），断言 stderr 不含明文
err="$({
  _console_token="$(ACCESS_TOKEN=prod-like-token-xyz _console_token_label)"
  _ui_scope_t="t1"
  _ui_scope_w="w1"
  _ui_scope_task="task1"
  if [[ -n "$_ui_scope_t" && -n "$_ui_scope_w" && -n "$_ui_scope_task" ]]; then
    echo "[run.sh] 控制台: http://127.0.0.1:9876/ui/tenant/${_ui_scope_t}/workspace/${_ui_scope_w}/task/${_ui_scope_task}/${_console_token}" >&2
  else
    echo "[run.sh] 控制台: http://127.0.0.1:9876/ui/${_console_token}" >&2
  fi
} 2>&1)"

if grep -q 'prod-like-token-xyz' <<<"$err"; then
  fail "stderr 泄漏完整 ACCESS_TOKEN: $err"
fi
grep -q '<redacted>' <<<"$err" || fail "stderr 应含 <redacted>: $err"

# 4. runtime 文件写入完整可点击地址（含真实令牌）——仅此一处
runtime_dir="$(mktemp -d)"
trap 'rm -rf "$runtime_dir"' EXIT
mkdir -p "$runtime_dir/runtime"
printf '%s\n' "http://127.0.0.1:9876/ui/tenant/t1/workspace/w1/task/task1/prod-like-token-xyz" > "$runtime_dir/runtime/.console_url"
grep -q 'prod-like-token-xyz' "$runtime_dir/runtime/.console_url" || fail "runtime .console_url 应含真实令牌"

echo "ok  test_run_sh_redact_token"

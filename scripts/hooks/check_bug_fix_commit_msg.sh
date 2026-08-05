#!/usr/bin/env bash
# Bug-fix 提交必须携带对应回归单元测试 — 子仓 commit-msg 门禁（bash 移植）
#
# SSOT: .ai/01_project_constraints/41_bug_fix_unit_test_required.md
# 根仓权威版: .githooks/commit-msg → db/scripts/ci/check_bug_fix_unit_tests.py（Python）
# 本版本: 无 Python 依赖的 bash 移植，随子仓模板分发（db/scripts/hooks/templates/，
#         由 deploy_repo_random_precommit.sh 复制到各子仓 scripts/hooks/，install.sh 安装）。
#
# 判定：commit message 首行属于 bug 修复类（fix:/hotfix:/bugfix: 前缀、中文
# "修复"/"修正"/"修 bug" 前缀、或 fix/bug 关键字），且暂存区包含业务源码时，
# 必须存在与被修源码对应（同目录 / tests 镜像 / 文件名 stem 重叠）的单元测试，
# 否则 exit 1 阻断提交。豁免：消息含 no-test:、无源码变更、仅测试变更。
#
# 调用方式：
#   check_bug_fix_commit_msg.sh [消息文件]          # commit-msg 钩子（$1）
#   check_bug_fix_commit_msg.sh --message M --staged-files F  # 合成输入（CI/自测）
#   check_bug_fix_commit_msg.sh --self-test         # 内置用例自测
set -uo pipefail

# ── 消息判定正则（case-insensitive）──────────────────────────────────────────
# 注意：避免 \b（BSD/macOS regcomp 不支持 ERE \b），用字符类模拟词边界
NON_FIX_PREFIX_RE='^(feat|feature|docs|refactor|refact|test|tests|chore|ci|style|perf|build|revert|merge|release|deps?)(\([^)]*\))?[:：]'
FIX_PREFIX_RE='^(fix|hotfix|bugfix|patch)(\([^)]*\))?[:：]'
FIX_CN_RE='^(修复|修正|修[[:space:]]?bug|bug[[:space:]]?修复|补丁)([:：[:space:]])'
FIX_KEYWORD_RE='(^|[^[:alnum:]_])(fix(es|ed)?|bug|bugfix|hotfix)([^[:alnum:]_]|$)'

# ── 暂存文件分类 ─────────────────────────────────────────────────────────────
SOURCE_SUFFIX_RE='\.(go|py|js|jsx|ts|tsx|vue)$'
NON_UNIT_DIR_SEGMENTS='node_modules|\.git|vendor|venv|\.venv|site-packages|__pycache__|playwright|e2e|e2e-tests|end_to_end_tests|testdata|mocks'
NON_UNIT_NAME_MARKERS='\.playwright\.test\.|\.e2e\.test\.|\.integration\.test\.|\.spec\.e2e\.'
UNIT_JS_RE='\.(unit\.)?(test|spec)\.(js|jsx|ts|tsx)$'

is_bug_fix_message() {
  local first="$1"
  [ -n "$first" ] || return 1
  if [[ "$first" =~ $NON_FIX_PREFIX_RE ]]; then return 1; fi
  if [[ "$first" =~ $FIX_PREFIX_RE ]]; then return 0; fi
  if [[ "$first" =~ $FIX_CN_RE ]]; then return 0; fi
  if [[ "$first" =~ $FIX_KEYWORD_RE ]]; then return 0; fi
  return 1
}

is_unit_test_file() {
  local rel="$1" name="" low=""
  name="$(basename "$rel")"
  if [[ "$rel" =~ (^|/)(node_modules|\.git|vendor|venv|\.venv|site-packages|__pycache__|playwright|e2e|e2e-tests|end_to_end_tests|testdata|mocks)(/|$) ]]; then
    return 1
  fi
  low="$(printf '%s' "$rel" | tr '[:upper:]' '[:lower:]')"
  if [[ "$low" =~ \.(playwright\.test\.|e2e\.test\.|integration\.test\.|spec\.e2e\.) ]]; then
    return 1
  fi
  if [[ "$name" == *_test.go ]]; then return 0; fi
  if [[ "$name" == *.py ]] && { [[ "$name" == test_* ]] || [[ "$name" == *_test.py ]]; }; then
    return 0
  fi
  if [[ "$name" =~ \.(unit\.)?(test|spec)\.(js|jsx|ts|tsx)$ ]]; then return 0; fi
  return 1
}

is_source_file() {
  local rel="$1"
  if is_unit_test_file "$rel"; then return 1; fi
  local low
  low="$(printf '%s' "$rel" | tr '[:upper:]' '[:lower:]')"
  [[ "$low" =~ \.(go|py|js|jsx|ts|tsx|vue)$ ]]
}

# src 是否与某个测试对应：同目录 / tests 镜像目录 / 测试文件名含 src stem
has_matching_test() {
  local src="$1"; shift
  local src_dir="" src_stem="" t_dir=""
  src_dir="$(dirname "$src")"
  src_stem="$(basename "$src")"
  src_stem="${src_stem%.*}"
  local t
  for t in "$@"; do
    t_dir="$(dirname "$t")"
    if [ "$t_dir" = "$src_dir" ]; then return 0; fi
    if [ "$t_dir" = "${src_dir}/tests" ]; then return 0; fi
    case "$(basename "$t")" in
      *"$src_stem"*) return 0 ;;
    esac
  done
  return 1
}

# ── 门禁主逻辑 ───────────────────────────────────────────────────────────────
# 输入: $1 = 消息文本, $2 = 换行分隔的暂存文件列表
# 输出: 0=通过 1=阻断
run_gate() {
  local message="$1" staged="$2"
  local first=""
  first="$(printf '%s' "$message" | sed -n '1p')"

  if [ -z "$staged" ]; then
    echo "OK: no staged files to check."
    return 0
  fi
  if ! is_bug_fix_message "$first"; then
    echo "OK: not a bug-fix commit (first line: ${first:-<empty>})."
    return 0
  fi

  local source_files=() test_files=() f
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    if is_source_file "$f"; then
      source_files+=("$f")
    elif is_unit_test_file "$f"; then
      test_files+=("$f")
    fi
  done <<< "$staged"

  if [ "${#source_files[@]}" -eq 0 ]; then
    echo "OK: bug-fix commit touches no business source (docs/config/scripts/tests only) — exempt."
    return 0
  fi
  if [[ "$message" == *"no-test:"* ]]; then
    local reason=""
    reason="$(printf '%s' "$message" | grep 'no-test:' | head -1 | sed 's/.*no-test:[[:space:]]*//')"
    echo "OK: explicit waiver \`no-test:\` present (${reason:-reason}) — exempt."
    return 0
  fi
  if [ "${#test_files[@]}" -eq 0 ]; then
    echo "⛔ VIOLATION (rule .ai/01_project_constraints/41_bug_fix_unit_test_required.md): bug-fix commit without a matching regression unit test."
    echo "  Staged source files: ${source_files[*]}"
    echo "  Fix: add a regression unit test that reproduces the defect (it must fail before the fix and pass after), then stage it together with the fix."
    echo "  Waiver: if this is a documented exception, add \`no-test: <reason>\` to the commit message."
    return 1
  fi

  local unmatched=() s
  for s in "${source_files[@]}"; do
    if ! has_matching_test "$s" "${test_files[@]}"; then
      unmatched+=("$s")
    fi
  done
  if [ "${#unmatched[@]}" -gt 0 ]; then
    echo "⛔ VIOLATION (rule .ai/01_project_constraints/41_bug_fix_unit_test_required.md): bug-fix commit without a matching regression unit test."
    echo "  Staged unit tests do not correspond to the modified source:"
    echo "    sources without a matching test: ${unmatched[*]}"
    echo "    staged tests: ${test_files[*]}"
    echo "  Fix: add a test in the same directory/package as the modified source (or a tests/ mirror), e.g. parser.go -> parser_test.go, models.py -> tests/test_models.py."
    return 1
  fi

  echo "OK: bug-fix commit carries a matching regression unit test."
  return 0
}

# ── 自测（--self-test / CI 冒烟）────────────────────────────────────────────
self_test() {
  local failures=0 n=0
  check_case() {
    n=$((n + 1))
    local expect="$1" desc="$2"; shift 2
    local got="" code=0
    got="$(run_gate "$@")"
    code=$?
    if [ "$code" != "$expect" ]; then
      failures=$((failures + 1))
      echo "FAIL [$n] $desc (expect=$expect got=$code)"
      printf '%s\n' "$got" | sed 's/^/      /'
    else
      echo "PASS [$n] $desc"
    fi
  }

  check_case 0 "feat 提交无需测试" "feat: add user profile endpoint" $'app/profile.py'
  check_case 1 "fix 无测试被阻断" "fix: NPE on empty input" $'app/parser.go'
  check_case 0 "fix + 同目录 _test.go 通过" "fix(parser): NPE on empty input" $'app/parser.go\napp/parser_test.go'
  check_case 1 "fix + 无关测试被阻断" "fix(parser): NPE on empty input" $'app/parser.go\nother/thing_test.go'
  check_case 1 "中文 修复 前缀被识别" "修复：空输入 NPE" $'app/parser.go'
  check_case 1 "中文 修正 前缀被识别" "修正: 空输入崩溃" $'app/parser.go'
  check_case 0 "fix + tests 镜像目录通过" "fix: 空输入 NPE" $'app/parser.go\napp/tests/test_parser.py'
  check_case 0 "fix + 前端 unit.test 通过" "fix: 按钮重复触发" $'app/Button.tsx\napp/Button.unit.test.ts'
  check_case 0 "no-test 豁免" "fix: 手工验证场景 no-test: legacy vendor patch" $'app/parser.go'
  check_case 0 "仅文档变更豁免" "fix: 更新部署说明" $'README.md'
  check_case 0 "chore 前缀不被误伤" "chore: update deps" $'app/parser.go'
  check_case 0 "仅测试变更豁免" "fix: 补充用例" $'app/parser_test.go'
  check_case 1 "e2e 测试不算单测" "fix: NPE on empty input" $'app/parser.go\ne2e/parser.playwright.test.ts'
  check_case 0 "vue 源码 + 同名 spec 通过" "fix: 弹窗关闭异常" $'src/Modal.vue\nsrc/Modal.spec.ts'
  check_case 0 "feat + fix 关键字但非 fix 前缀" "feat: fix traceId propagation" $'app/trace.go'

  echo ""
  if [ "$failures" -gt 0 ]; then
    echo "self-test: $failures/$n cases FAILED"
    return 1
  fi
  echo "self-test: all $n cases passed"
  return 0
}

# ── 入口 ─────────────────────────────────────────────────────────────────────
MESSAGE=""
STAGED=""
MSG_FILE=""

if [ "${1:-}" = "--self-test" ]; then
  self_test
  exit $?
fi

if [ "${1:-}" = "--message" ]; then
  MESSAGE="${2:-}"
  STAGED="${4:-}"
else
  MSG_FILE="${1:-}"
  if [ -z "$MSG_FILE" ]; then
    MSG_FILE="$(git rev-parse --git-path COMMIT_EDITMSG 2>/dev/null || true)"
  fi
  if [ -n "$MSG_FILE" ] && [ -f "$MSG_FILE" ]; then
    MESSAGE="$(cat "$MSG_FILE")"
  fi
  STAGED="$(git diff --cached --name-only --diff-filter=ACMR 2>/dev/null || true)"
fi

run_gate "$MESSAGE" "$STAGED"
exit $?

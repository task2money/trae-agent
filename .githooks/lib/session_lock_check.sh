#!/usr/bin/env bash
# ============================================================================
# session_lock_check.sh — pre-commit 提交锁校验（agent-session-coordination v14/v66）
# ============================================================================
# 用途: pre-commit 钩子 source 本库并调用 session_hub_lock_check [repo]。
# 当仓库锁被他会话（非本会话自身）持有时阻断提交并提示 holder。
# 自我识别: 提交进程链（git→pre-commit→本脚本）的祖先链中包含锁持有者的
# 注册 pid 时视为「自己」，放行。
#
# 依赖: 可选 — claude-agent 二进制缺失时静默放行（门禁不阻塞工具链缺失）。
# 设计: docs/superpowers/specs/2026-08-06-agent-session-coordination-design.md
# ============================================================================

session_hub_lock_check() {
    local repo="${1:-}"
    local meta_root="${SESSION_META_ROOT:-}"
    local bin="${CLAUDE_AGENT_BIN:-}"

    if [ -z "$meta_root" ]; then
        # 向上发现 meta root（含 .gitmodules 的仓库根）
        local d
        d="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
        while [ "$d" != "/" ]; do
            if [ -f "$d/.gitmodules" ]; then
                meta_root="$d"
                break
            fi
            d="$(dirname "$d")"
        done
    fi
    [ -z "$meta_root" ] && return 0
    if [ -z "$repo" ]; then
        repo="$(basename "$meta_root")"
        # cwd 在子仓内时用子仓名
        local cwd_rel
        cwd_rel="$(pwd | sed "s|^$meta_root/||")"
        case "$cwd_rel" in
            ""|".") ;;
            *) repo="${cwd_rel%%/*}" ;;
        esac
    fi
    [ -z "$bin" ] && [ -x "$meta_root/claude-agent/bin/claude-agent" ] && bin="$meta_root/claude-agent/bin/claude-agent"
    [ -z "$bin" ] || [ ! -x "$bin" ] && return 0

    local status
    status="$("$bin" session check "$repo" 2>/dev/null || echo FREE)"
    case "$status" in
        FREE|HELD_BY_SELF) return 0 ;;
        HELD_BY*)
            echo ""
            echo "╔══════════════════════════════════════════════════════════════╗"
            echo "║  ⛔ 提交锁校验 [HOOK v1.1.0]: 仓库 $repo 被其他会话持有      ║"
            echo "║     $status"
            echo "╠══════════════════════════════════════════════════════════════╣"
            echo "║  详情: claude-agent session list --repo $repo               ║"
            echo "║  等待对方释放，或确认后暂停对方:                              ║"
            echo "║    claude-agent session pause <sid>  → 提交 → resume <sid>  ║"
            echo "╚══════════════════════════════════════════════════════════════╝"
            echo ""
            exit 1
            ;;
        *) return 0 ;;
    esac
}

# Copyright (c) 2025 ByteDance Ltd. and/or its affiliates
# SPDX-License-Identifier: MIT


from dataclasses import dataclass

from trae_agent.tools.base import ToolCall, ToolResult


@dataclass
class LLMMessage:
    """Standard message format."""

    role: str
    content: str | None = None
    tool_call: ToolCall | None = None
    tool_result: ToolResult | None = None


@dataclass
class LLMUsage:
    """LLM usage format."""

    input_tokens: int
    output_tokens: int
    cache_creation_input_tokens: int = 0
    cache_read_input_tokens: int = 0
    reasoning_tokens: int = 0

    def __add__(self, other: "LLMUsage") -> "LLMUsage":
        return LLMUsage(
            input_tokens=self.input_tokens + other.input_tokens,
            output_tokens=self.output_tokens + other.output_tokens,
            cache_creation_input_tokens=self.cache_creation_input_tokens
            + other.cache_creation_input_tokens,
            cache_read_input_tokens=self.cache_read_input_tokens + other.cache_read_input_tokens,
            reasoning_tokens=self.reasoning_tokens + other.reasoning_tokens,
        )

    def __str__(self) -> str:
        return f"LLMUsage(input_tokens={self.input_tokens}, output_tokens={self.output_tokens}, cache_creation_input_tokens={self.cache_creation_input_tokens}, cache_read_input_tokens={self.cache_read_input_tokens}, reasoning_tokens={self.reasoning_tokens})"


# 日志/审计固定带上的五个分量。少写一个就是「缓存命中率不可算」——
# 而命中率是 prompt 缓存优化与成本回归的唯一判据（硬约束 78）。
USAGE_FIELDS = (
    "input_tokens",
    "output_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
    "reasoning_tokens",
)


def _usage_int(value: object) -> int:
    """provider 回包里的 token 计数：None / 缺失 / 非整数一律当 0（审计不因缺字段崩）。"""
    if value is None:
        return 0
    try:
        return int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 0


def _usage_details(raw: object, container: str, field: str) -> int:
    """取 `<container>.<field>`（OpenAI 把缓存/推理放在嵌套的 details 里）。"""
    details = getattr(raw, container, None)
    if details is None:
        return 0
    return _usage_int(getattr(details, field, None))


def usage_from_openai_usage(raw: object) -> LLMUsage | None:
    """OpenAI 兼容回包的 usage → LLMUsage（缓存/推理不丢，口径与本仓 exclusive 约定对齐）。

    OpenAI 系（chat.completions 与 responses）的 prompt/input 计数**含**缓存命中，
    而本仓 `LLMUsage.input_tokens` 是不含缓存的那部分 —— Anthropic 客户端与平台网关的
    normalizeAuditUsage 都是这个口径。不减去命中数，同一份用量在两个 provider 上会一个
    记 100、一个记 60，跨 provider 的成本对比与缓存收益核算直接失真。

    DeepSeek 不返回 `prompt_tokens_details`，命中数在 `prompt_cache_hit_tokens`；
    `reasoning_tokens` 仍是 completion 的子集，本仓约定把它作为**附加信息**单列
    （与 openai_client / google_client 一致），不从 output 里扣。
    """
    if raw is None:
        return None
    prompt_raw = getattr(raw, "prompt_tokens", None)
    if prompt_raw is None:
        prompt_raw = getattr(raw, "input_tokens", None)  # Responses API 命名
    completion_raw = getattr(raw, "completion_tokens", None)
    if completion_raw is None:
        completion_raw = getattr(raw, "output_tokens", None)
    prompt = _usage_int(prompt_raw)
    completion = _usage_int(completion_raw)

    cached = _usage_details(raw, "prompt_tokens_details", "cached_tokens")
    if not cached:
        cached = _usage_details(raw, "input_tokens_details", "cached_tokens")
    if not cached:
        cached = _usage_int(getattr(raw, "prompt_cache_hit_tokens", None))
    reasoning = _usage_details(raw, "completion_tokens_details", "reasoning_tokens")
    if not reasoning:
        reasoning = _usage_details(raw, "output_tokens_details", "reasoning_tokens")

    return LLMUsage(
        input_tokens=max(prompt - cached, 0),
        output_tokens=completion,
        cache_creation_input_tokens=0,  # OpenAI 系不报缓存写入
        cache_read_input_tokens=cached,
        reasoning_tokens=reasoning,
    )


def usage_log_fields(usage: LLMUsage | None) -> dict[str, int]:
    """日志用的 usage 视图：五个分量一个都不丢（此前日志侧只带 input/output）。"""
    if usage is None:
        return dict.fromkeys(USAGE_FIELDS, 0)
    return {name: _usage_int(getattr(usage, name, 0)) for name in USAGE_FIELDS}


@dataclass
class LLMResponse:
    """Standard LLM response format."""

    content: str
    usage: LLMUsage | None = None
    model: str | None = None
    finish_reason: str | None = None
    tool_calls: list[ToolCall] | None = None

# Copyright (c) 2025 ByteDance Ltd. and/or its affiliates
# SPDX-License-Identifier: MIT

"""LLM 用量审计字段：缓存/推理不许丢，且 input 口径必须跨 provider 一致（约束 78）。

背景（OPT-20261015-020）：OpenAI 兼容客户端的 usage 解析只填 input/output，日志侧更是
只带这两项 —— 上游回的 `prompt_tokens_details.cached_tokens` 当场被丢掉，命中率在数据
层不可算；而 OpenAI 的 prompt 计数**含**缓存命中，本仓（Anthropic 客户端、平台网关
normalizeAuditUsage）却是不含的口径，不减命中数会让同一份用量在两个 provider 上对不上。
"""

import unittest
from pathlib import Path
from types import SimpleNamespace

from trae_agent.utils.llm_clients.llm_basics import (
    USAGE_FIELDS,
    LLMUsage,
    usage_from_google_usage,
    usage_from_openai_usage,
    usage_log_fields,
)


class TestUsageFromOpenAIUsage(unittest.TestCase):
    def test_chat_completions_parses_cache_and_subtracts_it_from_input(self):
        raw = SimpleNamespace(
            prompt_tokens=100,
            completion_tokens=20,
            prompt_tokens_details=SimpleNamespace(cached_tokens=40),
        )
        usage = usage_from_openai_usage(raw)
        assert usage is not None
        self.assertEqual(usage.input_tokens, 60)  # 100 含 40 命中 → exclusive 口径
        self.assertEqual(usage.output_tokens, 20)
        self.assertEqual(usage.cache_read_input_tokens, 40)
        self.assertEqual(usage.cache_creation_input_tokens, 0)  # OpenAI 系不报
        self.assertEqual(usage.reasoning_tokens, 0)

    def test_chat_completions_parses_reasoning_tokens(self):
        raw = SimpleNamespace(
            prompt_tokens=10,
            completion_tokens=20,
            completion_tokens_details=SimpleNamespace(reasoning_tokens=7),
        )
        usage = usage_from_openai_usage(raw)
        assert usage is not None
        self.assertEqual(usage.reasoning_tokens, 7)
        # 与既有 openai_client / google_client 一致：推理是附加信息，不从 output 扣
        self.assertEqual(usage.output_tokens, 20)

    def test_responses_api_field_names(self):
        raw = SimpleNamespace(
            input_tokens=100,
            output_tokens=20,
            input_tokens_details=SimpleNamespace(cached_tokens=40),
            output_tokens_details=SimpleNamespace(reasoning_tokens=5),
        )
        usage = usage_from_openai_usage(raw)
        assert usage is not None
        self.assertEqual((usage.input_tokens, usage.cache_read_input_tokens), (60, 40))
        self.assertEqual((usage.output_tokens, usage.reasoning_tokens), (20, 5))

    def test_deepseek_cache_hit_field(self):
        raw = SimpleNamespace(prompt_tokens=100, completion_tokens=20, prompt_cache_hit_tokens=30)
        usage = usage_from_openai_usage(raw)
        assert usage is not None
        self.assertEqual((usage.input_tokens, usage.cache_read_input_tokens), (70, 30))

    def test_missing_details_are_zero_not_an_error(self):
        usage = usage_from_openai_usage(SimpleNamespace(prompt_tokens=5, completion_tokens=3))
        assert usage is not None
        self.assertEqual(usage, LLMUsage(input_tokens=5, output_tokens=3))

    def test_none_usage_stays_none(self):
        self.assertIsNone(usage_from_openai_usage(None))

    def test_cache_hits_never_make_input_negative(self):
        raw = SimpleNamespace(
            prompt_tokens=10,
            completion_tokens=1,
            prompt_tokens_details=SimpleNamespace(cached_tokens=99),
        )
        usage = usage_from_openai_usage(raw)
        assert usage is not None
        self.assertEqual(usage.input_tokens, 0)
        self.assertEqual(usage.cache_read_input_tokens, 99)  # 原样上报，不替上游掩盖坏数据

    def test_non_numeric_fields_degrade_to_zero(self):
        raw = SimpleNamespace(prompt_tokens="n/a", completion_tokens=None)
        usage = usage_from_openai_usage(raw)
        assert usage is not None
        self.assertEqual((usage.input_tokens, usage.output_tokens), (0, 0))


class TestUsageLogFields(unittest.TestCase):
    def test_all_five_components_are_logged(self):
        usage = LLMUsage(
            input_tokens=1,
            output_tokens=2,
            cache_creation_input_tokens=3,
            cache_read_input_tokens=4,
            reasoning_tokens=5,
        )
        self.assertEqual(usage_log_fields(usage), {name: getattr(usage, name) for name in USAGE_FIELDS})

    def test_none_usage_logs_zeroed_fields_not_missing_keys(self):
        fields = usage_log_fields(None)
        self.assertEqual(sorted(fields), sorted(USAGE_FIELDS))
        self.assertEqual(set(fields.values()), {0})


class TestUsageFromGoogleUsage(unittest.TestCase):
    """Google 的 prompt_token_count 同样**含**缓存命中，直接当 input 是双重计数。"""

    def test_cached_content_is_subtracted_from_input(self):
        raw = SimpleNamespace(
            prompt_token_count=100,
            candidates_token_count=20,
            cached_content_token_count=40,
        )
        usage = usage_from_google_usage(raw)
        assert usage is not None
        self.assertEqual(usage.input_tokens, 60)
        self.assertEqual(usage.output_tokens, 20)
        self.assertEqual(usage.cache_read_input_tokens, 40)
        self.assertEqual(usage.cache_creation_input_tokens, 0)  # Google 不报缓存写入
        self.assertEqual(usage.reasoning_tokens, 0)  # 不单列推理

    def test_missing_metadata_is_none_not_zero_usage(self):
        self.assertIsNone(usage_from_google_usage(None))

    def test_cached_greater_than_prompt_does_not_go_negative(self):
        raw = SimpleNamespace(
            prompt_token_count=10,
            candidates_token_count=1,
            cached_content_token_count=99,
        )
        usage = usage_from_google_usage(raw)
        assert usage is not None
        self.assertEqual(usage.input_tokens, 0)
        self.assertEqual(usage.cache_read_input_tokens, 99)

    def test_missing_fields_degrade_to_zero(self):
        usage = usage_from_google_usage(SimpleNamespace())
        assert usage is not None
        self.assertEqual(
            (usage.input_tokens, usage.output_tokens, usage.cache_read_input_tokens), (0, 0, 0)
        )


def missing_response_logging(sources: dict[str, str]) -> list[str]:
    """返回「有 LLM 出站却没留调用日志」的文件名。

    判据两条，缺一不可：写 response 行（证明有日志）、走 `usage_log_fields`（证明 token
    五分量没被截成 input/output 两项）。后者正是本条 OPT 的病根，故必须一起断言。
    """
    missing = []
    for name, text in sources.items():
        if "self.logger.log_response(" not in text or "usage_log_fields(" not in text:
            missing.append(name)
    return missing


class TestEveryLlmClientLogsResponses(unittest.TestCase):
    """每个 LLM 客户端都必须写调用日志，且 token 口径统一（约束 78）。"""

    CLIENT_FILES = (
        "openai_compatible_base.py",
        "openai_client.py",
        "deepseek_client.py",
        "anthropic_client.py",
        "google_client.py",
        "ollama_client.py",
    )

    def _sources(self) -> dict[str, str]:
        root = Path(__file__).resolve().parents[3] / "trae_agent" / "utils" / "llm_clients"
        return {name: (root / name).read_text(encoding="utf-8") for name in self.CLIENT_FILES}

    def test_all_clients_log_responses_with_full_usage(self):
        missing = missing_response_logging(self._sources())
        self.assertEqual(missing, [], f"这些客户端没写调用日志或丢了 usage 分量：{missing}")

    def test_checker_flags_client_without_response_logging(self):
        # 负向对照：把 log_response 摘掉必须被抓出来（否则本判据在漂移后依然假绿）。
        sources = self._sources()
        sources["openai_client.py"] = sources["openai_client.py"].replace(
            "self.logger.log_response(", "pass  # "
        )
        self.assertIn("openai_client.py", missing_response_logging(sources))

    def test_checker_flags_logging_that_dropped_usage_fields(self):
        # 负向对照：只写日志、不带 usage 五分量（本条 OPT 的病根形态）同样要红。
        sources = {name: text for name, text in self._sources().items()}
        sources["google_client.py"] = sources["google_client.py"].replace(
            "usage=usage_log_fields(llm_response.usage),", "usage={'input_tokens': 1},"
        )
        self.assertIn("google_client.py", missing_response_logging(sources))


if __name__ == "__main__":
    unittest.main()

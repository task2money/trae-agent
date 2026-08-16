# Copyright (c) 2025 ByteDance Ltd. and/or its affiliates
# SPDX-License-Identifier: MIT

"""LLMClient provider selection tests (OPT-20260816-049).

OpenAI provider 在非官方 base_url（SaaS 代理/兼容网关）下必须回退到 chat.completions 客户端，
而不是固定走 Responses API 的 OpenAIClient。
"""

import unittest
from unittest.mock import patch

from trae_agent.utils.config import ModelConfig, ModelProvider
from trae_agent.utils.llm_clients.llm_client import LLMClient
from trae_agent.utils.llm_clients.openai_client import OpenAIClient, OpenAICompatClient


def _openai_model_config(base_url):
    return ModelConfig(
        model="gpt-4o",
        model_provider=ModelProvider(
            api_key="test-api-key",
            provider="openai",
            base_url=base_url,
        ),
        max_tokens=4096,
        temperature=0.5,
        top_p=1,
        top_k=0,
        parallel_tool_calls=False,
        max_retries=10,
    )


class TestLLMClientOpenAIProviderSelection(unittest.TestCase):
    @patch("trae_agent.utils.llm_clients.openai_client.openai.OpenAI")
    def test_custom_base_url_uses_chat_completions_fallback(self, mock_openai):
        client = LLMClient(_openai_model_config("https://proxy.example.com/v1"))

        self.assertIsInstance(client.client, OpenAICompatClient)
        self.assertNotIsInstance(client.client, OpenAIClient)
        # 自定义 base_url 走 chat.completions 实现，绝不触碰 responses API
        self.assertFalse(mock_openai.return_value.responses.create.called)

    @patch("trae_agent.utils.llm_clients.openai_client.openai.OpenAI")
    def test_official_base_url_uses_responses_api(self, mock_openai):
        client = LLMClient(_openai_model_config("https://api.openai.com/v1"))

        self.assertIsInstance(client.client, OpenAIClient)

    @patch("trae_agent.utils.llm_clients.openai_client.openai.OpenAI")
    def test_missing_base_url_uses_responses_api(self, mock_openai):
        client = LLMClient(_openai_model_config(None))

        self.assertIsInstance(client.client, OpenAIClient)

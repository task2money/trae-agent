# Copyright (c) 2025 ByteDance Ltd. and/or its affiliates
# SPDX-License-Identifier: MIT

"""OpenAI provider base_url fallback tests (OPT-20260816-049).

OpenAIClient 固定走 Responses API（`/v1/responses`）；SaaS LLM 代理与多数兼容网关只实现
`/v1/chat/completions`。当 base_url 不是 api.openai.com 时必须改用 chat.completions，
否则自定义 base_url 会得到永久 404。
"""

import unittest
from types import SimpleNamespace
from unittest.mock import patch

from trae_agent.utils.config import ModelConfig, ModelProvider
from trae_agent.utils.llm_clients.llm_basics import LLMMessage
from trae_agent.utils.llm_clients.llm_client import LLMClient
from trae_agent.utils.llm_clients.openai_client import (
    OpenAICompatClient,
    should_use_openai_responses_api,
)


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


class TestOpenAIResponsesApiDetection(unittest.TestCase):
    def test_official_hosts_use_responses_api(self):
        self.assertTrue(should_use_openai_responses_api(None))
        self.assertTrue(should_use_openai_responses_api(""))
        self.assertTrue(should_use_openai_responses_api("https://api.openai.com/v1"))
        self.assertTrue(should_use_openai_responses_api("https://api.openai.com.cn/v1"))

    def test_non_official_hosts_fall_back_to_chat_completions(self):
        self.assertFalse(should_use_openai_responses_api("https://proxy.example.com/v1"))
        self.assertFalse(should_use_openai_responses_api("https://proxy.example.com"))
        self.assertFalse(should_use_openai_responses_api("not-a-url"))


class TestOpenAICompatClientChatPath(unittest.TestCase):
    @patch("trae_agent.utils.llm_clients.openai_client.openai.OpenAI")
    def test_custom_base_url_chat_never_calls_responses_create(self, mock_openai):
        client = LLMClient(_openai_model_config("https://proxy.example.com/v1"))
        self.assertIsInstance(client.client, OpenAICompatClient)

        choice = SimpleNamespace(
            message=SimpleNamespace(tool_calls=None, content="hello"),
            finish_reason="stop",
        )
        fake_response = SimpleNamespace(
            choices=[choice],
            model="gpt-4o",
            usage=SimpleNamespace(prompt_tokens=5, completion_tokens=3),
        )
        with patch.object(
            client.client, "_create_response", return_value=fake_response
        ) as mock_create:
            resp = client.chat([LLMMessage(role="user", content="hi")], client.model_config)

        mock_create.assert_called_once()
        self.assertEqual(resp.content, "hello")
        # chat.completions 路径不会触碰 responses API
        mock_openai.return_value.responses.create.assert_not_called()

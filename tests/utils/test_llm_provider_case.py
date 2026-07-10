"""LLMProvider 解析应对供应商标识大小写不敏感。"""

from unittest.mock import MagicMock, patch

from trae_agent.utils.config import ModelConfig, ModelProvider
from trae_agent.utils.llm_clients.llm_client import LLMClient, LLMProvider


def test_llm_provider_enum_accepts_canonical_deepseek():
    assert LLMProvider("deepseek") is LLMProvider.DEEPSEEK


def test_llm_client_accepts_camel_case_deepseek_provider():
    model_config = ModelConfig(
        model="deepseek-v4-pro",
        model_provider=ModelProvider(
            api_key="sk-test",
            provider="deepSeek",
            base_url="https://api.deepseek.com",
        ),
        temperature=0.1,
        top_p=1.0,
        top_k=0,
        parallel_tool_calls=True,
        max_retries=1,
        max_tokens=128,
    )
    with patch(
        "trae_agent.utils.llm_clients.deepseek_client.DeepSeekClient",
        return_value=MagicMock(),
    ):
        client = LLMClient(model_config)
    assert client.provider is LLMProvider.DEEPSEEK

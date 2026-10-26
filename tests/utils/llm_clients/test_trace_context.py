# Copyright (c) 2025 ByteDance Ltd. and/or its affiliates
# SPDX-License-Identifier: MIT

"""Trajectory 关联标识与请求头下传（硬约束 78，OPT-20261015-020）。

平台侧日志按 trace_id 串联；agent 轨迹若没有同一个 id，「某次任务花了 3 倍 token」
就只能靠时间戳猜。这里锁定四件事：

1. 显式注入 > 环境变量 > 新生成，空串一律视为未提供；
2. trajectory 顶层与每条 LLM interaction 都带 trace_id，租户/任务标识可注入；
3. provider 请求携带 ``X-Trace-Id``（OpenAI 兼容 / Responses / Anthropic /
   DeepSeek / Google 各一条）；
4. 没有 recorder 时不编造请求头。
"""

import json
import os
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, Mock, patch

from google.genai import types as genai_types

from trae_agent.utils.config import ModelConfig, ModelProvider
from trae_agent.utils.llm_clients.anthropic_client import AnthropicClient
from trae_agent.utils.llm_clients.base_client import BaseLLMClient
from trae_agent.utils.llm_clients.deepseek_client import DeepSeekClient
from trae_agent.utils.llm_clients.google_client import GoogleClient
from trae_agent.utils.llm_clients.llm_basics import LLMMessage, LLMResponse, LLMUsage
from trae_agent.utils.llm_clients.llm_client import LLMClient
from trae_agent.utils.trace_context import (
    TASK_ID_ENV,
    TENANT_ID_ENV,
    TRACE_HEADER,
    TRACE_ID_ENV,
    resolve_trace_id,
    resolve_trace_identity,
)
from trae_agent.utils.trajectory_recorder import TrajectoryRecorder


def _model_config(provider: str = "openai", base_url: str | None = None) -> ModelConfig:
    return ModelConfig(
        model="gpt-4o",
        model_provider=ModelProvider(
            api_key="test-api-key",
            provider=provider,
            base_url=base_url,
        ),
        temperature=0.5,
        top_p=1,
        top_k=0,
        parallel_tool_calls=False,
        max_retries=1,
        max_tokens=1024,
    )


class _StubClient(BaseLLMClient):
    """只测 trace_headers 的最小实现（BaseLLMClient 是抽象类）。"""

    def __init__(self) -> None:  # noqa: D401 - test stub
        self.trajectory_recorder = None

    def set_chat_history(self, messages: list[LLMMessage]) -> None:
        pass

    def chat(self, messages, model_config, tools=None, reuse_history=True):
        raise NotImplementedError


class TestResolveTraceIdentity(unittest.TestCase):
    def test_explicit_value_wins_over_env(self):
        with patch.dict(os.environ, {TRACE_ID_ENV: "from-env"}, clear=False):
            identity = resolve_trace_identity(trace_id="explicit")
        self.assertEqual(identity["trace_id"], "explicit")

    def test_env_used_when_no_explicit_value(self):
        with patch.dict(
            os.environ,
            {TRACE_ID_ENV: "env-trace", TENANT_ID_ENV: "env-tenant", TASK_ID_ENV: "env-task"},
            clear=False,
        ):
            identity = resolve_trace_identity()
        self.assertEqual(
            identity,
            {"trace_id": "env-trace", "tenant_id": "env-tenant", "task_id": "env-task"},
        )

    def test_generated_when_nothing_provided(self):
        with patch.dict(os.environ, {}, clear=True):
            first = resolve_trace_id()
            second = resolve_trace_id()
        self.assertTrue(first)
        self.assertNotEqual(first, second)
        self.assertEqual(len(first), 32)  # uuid4().hex

    def test_whitespace_only_counts_as_missing(self):
        with patch.dict(os.environ, {TRACE_ID_ENV: "   "}, clear=True):
            self.assertNotEqual(resolve_trace_id("  "), "   ")
            self.assertTrue(resolve_trace_id("  "))

    def test_tenant_and_task_are_empty_when_unknown(self):
        with patch.dict(os.environ, {}, clear=True):
            identity = resolve_trace_identity()
        self.assertEqual(identity["tenant_id"], "")
        self.assertEqual(identity["task_id"], "")


class TestTrajectoryIdentity(unittest.TestCase):
    def test_trace_and_tenant_ids_are_written_to_trajectory(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "trajectory.json")
            recorder = TrajectoryRecorder(path, trace_id="trace-1")
            recorder.start_recording(
                task="do the thing",
                provider="openai",
                model="gpt-4o",
                max_steps=3,
                tenant_id="tenant-9",
                task_id="task-7",
            )
            recorder.record_llm_interaction(
                messages=[LLMMessage(role="user", content="hi")],
                response=LLMResponse(
                    content="ok",
                    usage=LLMUsage(input_tokens=1, output_tokens=2),
                ),
                provider="openai",
                model="gpt-4o",
            )
            recorder.finalize_recording(success=True, final_result="ok")

            with open(path, encoding="utf-8") as fh:
                data = json.load(fh)

        self.assertEqual(data["trace_id"], "trace-1")
        self.assertEqual(data["tenant_id"], "tenant-9")
        self.assertEqual(data["task_id"], "task-7")
        interaction = data["llm_interactions"][0]
        self.assertEqual(interaction["trace_id"], "trace-1")
        self.assertEqual(interaction["response"]["usage"]["cache_read_tokens"], 0)
        audit = interaction["audit"]
        self.assertEqual(audit["agent_source"], "unknown")
        self.assertTrue(audit["usage_ok"])
        self.assertEqual(audit["usage_schema"], "trae_exclusive_v1")
        self.assertEqual(audit["outcome"], "success")
        self.assertEqual(audit["idempotency_key"], "trae-trace-1-1")
        self.assertEqual(audit["tenant_id"], "tenant-9")
        self.assertEqual(audit["task_id"], "task-7")

    def test_start_recording_overrides_constructor_trace_id(self):
        with tempfile.TemporaryDirectory() as tmp:
            recorder = TrajectoryRecorder(os.path.join(tmp, "t.json"), trace_id="outer")
            recorder.start_recording(
                task="x", provider="openai", model="m", max_steps=1, trace_id="inner"
            )
            self.assertEqual(recorder.trace_id, "inner")
            self.assertEqual(recorder.trajectory_data["trace_id"], "inner")

    def test_constructor_reads_env_identifiers(self):
        with (
            tempfile.TemporaryDirectory() as tmp,
            patch.dict(
                os.environ,
                {TRACE_ID_ENV: "env-trace", TENANT_ID_ENV: "env-tenant", TASK_ID_ENV: "env-task"},
                clear=True,
            ),
        ):
            recorder = TrajectoryRecorder(os.path.join(tmp, "t.json"))
        self.assertEqual(
            (recorder.trace_id, recorder.tenant_id, recorder.task_id),
            ("env-trace", "env-tenant", "env-task"),
        )


class _RecorderTestCase(unittest.TestCase):
    """所有 recorder 都写临时目录：默认路径会在仓库里生成 .trajectories/（约束 44）。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self._seq = 0

    def recorder(self, trace_id: str | None = None) -> TrajectoryRecorder:
        self._seq += 1
        return TrajectoryRecorder(
            os.path.join(self._tmp.name, f"trajectory_{self._seq}.json"), trace_id=trace_id
        )


class TestTraceHeaders(_RecorderTestCase):
    def test_headers_include_trace_id(self):
        client = _StubClient()
        client.trajectory_recorder = self.recorder(trace_id="trace-header")
        self.assertEqual(client.trace_headers(), {TRACE_HEADER: "trace-header"})

    def test_no_recorder_means_no_header(self):
        client = _StubClient()
        self.assertEqual(client.trace_headers(), {})


class TestCredentialRef(unittest.TestCase):
    """约束 78：只存凭据标识（sha256 前 16 位），不得出现明文。"""

    def test_hashes_key_without_leaking_it(self):
        client = _StubClient()
        client.api_key = "sk-secret-value"
        ref = client.credential_ref()
        self.assertTrue(ref.startswith("sha256:"))
        self.assertEqual(len(ref), len("sha256:") + 16)
        self.assertNotIn("sk-secret-value", ref)

    def test_empty_key_yields_empty_ref(self):
        client = _StubClient()
        client.api_key = ""
        self.assertEqual(client.credential_ref(), "")


class TestProviderRequestHeaders(_RecorderTestCase):
    """每个 provider 的请求都必须真的带上头，而不是只在 trajectory 里记一笔。"""

    @patch("trae_agent.utils.llm_clients.openai_client.openai.OpenAI")
    def test_openai_compatible_chat_passes_trace_header(self, _mock_openai):
        cfg = _model_config(base_url="https://proxy.example.com/v1")
        client = LLMClient(cfg).client
        client.set_trajectory_recorder(self.recorder(trace_id="trace-compat"))

        captured: dict = {}

        def fake_create(model_config, tool_schemas, extra_headers=None):
            captured["extra_headers"] = extra_headers
            return SimpleNamespace(
                choices=[
                    SimpleNamespace(
                        message=SimpleNamespace(tool_calls=None, content="hello"),
                        finish_reason="stop",
                    )
                ],
                model="gpt-4o",
                usage=SimpleNamespace(prompt_tokens=5, completion_tokens=3),
            )

        with patch.object(client, "_create_response", side_effect=fake_create):
            client.chat([LLMMessage(role="user", content="hi")], cfg)

        self.assertEqual(captured["extra_headers"][TRACE_HEADER], "trace-compat")

    @patch("trae_agent.utils.llm_clients.openai_client.openai.OpenAI")
    def test_openai_responses_passes_trace_header(self, _mock_openai):
        cfg = _model_config()
        client = LLMClient(cfg).client
        client.set_trajectory_recorder(self.recorder(trace_id="trace-responses"))
        client.client.responses.create = Mock(return_value=SimpleNamespace())

        client._create_openai_response([], cfg, None)

        kwargs = client.client.responses.create.call_args.kwargs
        self.assertEqual(kwargs["extra_headers"], {TRACE_HEADER: "trace-responses"})

    @patch("trae_agent.utils.llm_clients.anthropic_client.anthropic.Anthropic")
    def test_anthropic_passes_trace_header(self, _mock_anthropic):
        cfg = _model_config(provider="anthropic")
        client = AnthropicClient(cfg)
        client.set_trajectory_recorder(self.recorder(trace_id="trace-anthropic"))
        client.client.messages.create = Mock(return_value=SimpleNamespace())

        client._create_anthropic_response(cfg, None)

        kwargs = client.client.messages.create.call_args.kwargs
        self.assertEqual(kwargs["extra_headers"], {TRACE_HEADER: "trace-anthropic"})

    @patch("trae_agent.utils.llm_clients.deepseek_client.openai.OpenAI")
    def test_deepseek_passes_trace_header(self, _mock_openai):
        cfg = _model_config(provider="deepseek")
        client = DeepSeekClient(cfg)
        client.set_trajectory_recorder(self.recorder(trace_id="trace-deepseek"))
        client.client.chat.completions.create = Mock(return_value=SimpleNamespace())

        client._create_deepseek_response([{"role": "user", "content": "hi"}], cfg, None)

        kwargs = client.client.chat.completions.create.call_args.kwargs
        self.assertEqual(kwargs["extra_headers"], {TRACE_HEADER: "trace-deepseek"})

    @patch("trae_agent.utils.llm_clients.google_client.genai.Client")
    def test_google_request_config_carries_trace_header(self, _mock_genai):
        cfg = _model_config(provider="google")
        client = GoogleClient(cfg)
        client.set_trajectory_recorder(self.recorder(trace_id="trace-google"))
        captured: dict = {}
        client.client.models.generate_content = MagicMock(
            side_effect=lambda **kwargs: captured.update(kwargs) or SimpleNamespace()
        )
        generation_config = genai_types.GenerateContentConfig(temperature=0.2)

        client._create_google_response(cfg, [], generation_config)

        config = captured["config"]
        self.assertEqual(config.http_options.headers[TRACE_HEADER], "trace-google")
        self.assertEqual(config.temperature, 0.2)  # 其它生成参数不被头部合并丢掉

    @patch("trae_agent.utils.llm_clients.google_client.genai.Client")
    def test_google_merges_existing_http_headers(self, _mock_genai):
        cfg = _model_config(provider="google")
        client = GoogleClient(cfg)
        client.set_trajectory_recorder(self.recorder(trace_id="trace-google"))
        captured: dict = {}
        client.client.models.generate_content = MagicMock(
            side_effect=lambda **kwargs: captured.update(kwargs) or SimpleNamespace()
        )
        generation_config = genai_types.GenerateContentConfig(
            http_options=genai_types.HttpOptions(headers={"X-Custom": "1"})
        )

        client._create_google_response(cfg, [], generation_config)

        headers = captured["config"].http_options.headers
        self.assertEqual(headers, {"X-Custom": "1", TRACE_HEADER: "trace-google"})

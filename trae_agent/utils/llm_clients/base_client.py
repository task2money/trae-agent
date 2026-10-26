# Copyright (c) 2025 ByteDance Ltd. and/or its affiliates
# SPDX-License-Identifier: MIT


import hashlib
from abc import ABC, abstractmethod

from trae_agent.tools.base import Tool
from trae_agent.utils.config import ModelConfig
from trae_agent.utils.llm_clients.llm_basics import LLMMessage, LLMResponse
from trae_agent.utils.trace_context import TRACE_HEADER
from trae_agent.utils.trajectory_recorder import TrajectoryRecorder


class BaseLLMClient(ABC):
    """Base class for LLM clients."""

    def __init__(self, model_config: ModelConfig):
        self.api_key: str = model_config.model_provider.api_key
        self.base_url: str | None = model_config.model_provider.base_url
        self.api_version: str | None = model_config.model_provider.api_version
        self.trajectory_recorder: TrajectoryRecorder | None = None  # TrajectoryRecorder instance

    def set_trajectory_recorder(self, recorder: TrajectoryRecorder | None) -> None:
        """Set the trajectory recorder for this client."""
        self.trajectory_recorder = recorder

    def trace_headers(self) -> dict[str, str]:
        """Correlation headers for provider requests (硬约束 78).

        Provider 的访问日志/网关只有收到同一个 trace_id 才能与本地 trajectory
        join；recorder 为空时不编造标识，返回空字典。
        """
        trace_id = (
            getattr(self.trajectory_recorder, "trace_id", "") if self.trajectory_recorder else ""
        )
        return {TRACE_HEADER: str(trace_id)} if trace_id else {}

    def credential_ref(self) -> str:
        """凭据标识：sha256 前 16 位，禁止明文/Bearer 全量（约束 78）。"""
        if not self.api_key:
            return ""
        return "sha256:" + hashlib.sha256(self.api_key.encode("utf-8")).hexdigest()[:16]

    @abstractmethod
    def set_chat_history(self, messages: list[LLMMessage]) -> None:
        """Set the chat history."""
        pass

    @abstractmethod
    def chat(
        self,
        messages: list[LLMMessage],
        model_config: ModelConfig,
        tools: list[Tool] | None = None,
        reuse_history: bool = True,
    ) -> LLMResponse:
        """Send chat messages to the LLM."""
        pass

    def supports_tool_calling(self, model_config: ModelConfig) -> bool:
        """Check if the current model supports tool calling."""
        return model_config.supports_tool_calling

# Copyright (c) 2025 ByteDance Ltd. and/or its affiliates
# SPDX-License-Identifier: MIT

"""OpenAI API client wrapper with tool integration."""

import json
import urllib.parse
from typing import override

import httpx
import openai
from openai.types.responses import (
    EasyInputMessageParam,
    FunctionToolParam,
    Response,
    ResponseFunctionToolCallParam,
    ResponseInputParam,
    ToolParam,
)
from openai.types.responses.response_input_param import FunctionCallOutput

from trae_agent.tools.base import Tool, ToolCall, ToolResult
from trae_agent.utils.config import ModelConfig
from trae_agent.utils.llm_clients.base_client import BaseLLMClient
from trae_agent.utils.llm_clients.llm_basics import LLMMessage, LLMResponse, LLMUsage
from trae_agent.utils.llm_clients.openai_compatible_base import (
    OpenAICompatibleClient,
    ProviderConfig,
)
from trae_agent.utils.llm_clients.retry_utils import retry_with
from trae_agent.utils.llm_clients.tool_call_json import parse_tool_call_arguments


def should_use_openai_responses_api(base_url: str | None) -> bool:
    """Official OpenAI endpoints use the Responses API.

    SaaS LLM 代理与多数兼容网关只实现 `/v1/chat/completions`；当 base_url 指向
    非官方主机时必须改用 chat.completions，否则会得到永久 404。base_url 为空时
    SDK 默认指向 `api.openai.com`，仍走 Responses API。
    """
    raw = str(base_url or "").strip()
    if not raw:
        return True
    try:
        host = urllib.parse.urlparse(raw).netloc.lower()
    except ValueError:
        return False
    if not host:
        return False
    return host == "api.openai.com" or host.endswith(".openai.com") or host.endswith(".openai.com.cn")


class OpenAICompatProvider(ProviderConfig):
    """OpenAI provider speaking chat.completions (non-official / SaaS proxy base_url)."""

    def create_client(
        self,
        api_key: str,
        base_url: str | None,
        api_version: str | None,
        timeout: float | None = None,
    ) -> openai.OpenAI:
        """Create an OpenAI client configured for chat.completions."""
        effective_timeout = timeout or 120.0
        http_client = httpx.Client(timeout=httpx.Timeout(effective_timeout, connect=60.0))
        return openai.OpenAI(api_key=api_key, base_url=base_url, http_client=http_client)

    def get_service_name(self) -> str:
        """Get the service name for retry logging."""
        return "OpenAI-compatible"

    def get_provider_name(self) -> str:
        """Get the provider name for trajectory recording."""
        return "openai"

    def get_extra_headers(self) -> dict[str, str]:
        """Get any extra headers needed for the API call."""
        return {}

    def supports_tool_calling(self, model_name: str) -> bool:
        """OpenAI-compatible endpoints generally support tool calling."""
        return True


class OpenAICompatClient(OpenAICompatibleClient):
    """OpenAI chat.completions client used when base_url is not api.openai.com.

    Keeps the same public surface as OpenAIClient but speaks `/v1/chat/completions`,
    which SaaS LLM proxies and compatible gateways implement.
    """

    def __init__(self, model_config: ModelConfig):
        super().__init__(model_config, OpenAICompatProvider())


class OpenAIClient(BaseLLMClient):
    """OpenAI client wrapper with tool schema generation."""

    DEFAULT_TIMEOUT = 120.0

    def __init__(self, model_config: ModelConfig):
        super().__init__(model_config)

        timeout = getattr(model_config, "timeout", None) or self.DEFAULT_TIMEOUT
        http_client = httpx.Client(timeout=httpx.Timeout(timeout, connect=60.0))
        self.client: openai.OpenAI = openai.OpenAI(
            api_key=self.api_key, base_url=self.base_url, http_client=http_client
        )
        self.message_history: ResponseInputParam = []

    @override
    def set_chat_history(self, messages: list[LLMMessage]) -> None:
        """Set the chat history."""
        self.message_history = self.parse_messages(messages)

    def _create_openai_response(
        self,
        api_call_input: ResponseInputParam,
        model_config: ModelConfig,
        tool_schemas: list[ToolParam] | None,
    ) -> Response:
        """Create a response using OpenAI API. This method will be decorated with retry logic."""
        return self.client.responses.create(
            input=api_call_input,
            model=model_config.model,
            tools=tool_schemas if tool_schemas else openai.NOT_GIVEN,
            temperature=model_config.temperature
            if "o3" not in model_config.model
            and "o4-mini" not in model_config.model
            and "gpt-5" not in model_config.model
            else openai.NOT_GIVEN,
            top_p=model_config.top_p,
            max_output_tokens=model_config.max_tokens,
        )

    @override
    def chat(
        self,
        messages: list[LLMMessage],
        model_config: ModelConfig,
        tools: list[Tool] | None = None,
        reuse_history: bool = True,
    ) -> LLMResponse:
        """Send chat messages to OpenAI with optional tool support."""
        openai_messages: ResponseInputParam = self.parse_messages(messages)

        if reuse_history:
            self.message_history = self.message_history + openai_messages
        else:
            self.message_history = openai_messages

        tool_schemas = None
        if tools:
            tool_schemas = [
                FunctionToolParam(
                    name=tool.name,
                    description=tool.description,
                    parameters=tool.get_input_schema(),
                    strict=True,
                    type="function",
                )
                for tool in tools
            ]

        api_call_input: ResponseInputParam = self.message_history

        # Apply retry decorator to the API call
        retry_decorator = retry_with(
            func=self._create_openai_response,
            provider_name="OpenAI",
            max_retries=model_config.max_retries,
        )
        response = retry_decorator(api_call_input, model_config, tool_schemas)

        content = ""
        tool_calls: list[ToolCall] = []
        for output_block in response.output:
            if output_block.type == "function_call":
                tool_calls.append(
                    ToolCall(
                        call_id=output_block.call_id,
                        name=output_block.name,
                        arguments=parse_tool_call_arguments(output_block.arguments),
                        id=output_block.id,
                    )
                )
                tool_call_param = ResponseFunctionToolCallParam(
                    arguments=output_block.arguments,
                    call_id=output_block.call_id,
                    name=output_block.name,
                    type="function_call",
                )
                if output_block.status:
                    tool_call_param["status"] = output_block.status
                if output_block.id:
                    tool_call_param["id"] = output_block.id
                self.message_history.append(tool_call_param)
            elif output_block.type == "message":
                content = "".join(
                    content_block.text
                    for content_block in output_block.content
                    if content_block.type == "output_text"
                )

        if content != "":
            self.message_history.append(
                EasyInputMessageParam(content=content, role="assistant", type="message")
            )

        usage = None
        if response.usage:
            usage = LLMUsage(
                input_tokens=response.usage.input_tokens or 0,
                output_tokens=response.usage.output_tokens or 0,
                cache_read_input_tokens=response.usage.input_tokens_details.cached_tokens or 0,
                reasoning_tokens=response.usage.output_tokens_details.reasoning_tokens or 0,
            )

        llm_response = LLMResponse(
            content=content,
            usage=usage,
            model=response.model,
            finish_reason=response.status,
            tool_calls=tool_calls if len(tool_calls) > 0 else None,
        )

        # Record trajectory if recorder is available
        if self.trajectory_recorder:
            self.trajectory_recorder.record_llm_interaction(
                messages=messages,
                response=llm_response,
                provider="openai",
                model=model_config.model,
                tools=tools,
            )

        return llm_response

    def parse_messages(self, messages: list[LLMMessage]) -> ResponseInputParam:
        """Parse the messages to OpenAI format."""
        openai_messages: ResponseInputParam = []
        for msg in messages:
            if msg.tool_result:
                openai_messages.append(self.parse_tool_call_result(msg.tool_result))
            elif msg.tool_call:
                openai_messages.append(self.parse_tool_call(msg.tool_call))
            else:
                if not msg.content:
                    raise ValueError("Message content is required")
                if msg.role == "system":
                    openai_messages.append({"role": "system", "content": msg.content})
                elif msg.role == "user":
                    openai_messages.append({"role": "user", "content": msg.content})
                elif msg.role == "assistant":
                    openai_messages.append({"role": "assistant", "content": msg.content})
                else:
                    raise ValueError(f"Invalid message role: {msg.role}")
        return openai_messages

    def parse_tool_call(self, tool_call: ToolCall) -> ResponseFunctionToolCallParam:
        """Parse the tool call from the LLM response."""
        return ResponseFunctionToolCallParam(
            call_id=tool_call.call_id,
            name=tool_call.name,
            arguments=json.dumps(tool_call.arguments),
            type="function_call",
        )

    def parse_tool_call_result(self, tool_call_result: ToolResult) -> FunctionCallOutput:
        """Parse the tool call result from the LLM response to FunctionCallOutput format."""
        result_content: str = ""
        if tool_call_result.result is not None:
            result_content += str(tool_call_result.result)
        if tool_call_result.error:
            result_content += f"\nError: {tool_call_result.error}"
        result_content = result_content.strip()

        return FunctionCallOutput(
            type="function_call_output",  # Explicitly set the type field
            call_id=tool_call_result.call_id,
            output=result_content,
        )

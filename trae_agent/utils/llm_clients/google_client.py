# Copyright (c) 2025 ByteDance Ltd. and/or its affiliates
# SPDX-License-Identifier: MIT

"""Google Gemini API client wrapper with tool integration."""

import json
import time
import traceback
import uuid
from typing import override

from google import genai
from google.genai import types

from trae_agent.tools.base import Tool, ToolCall, ToolResult
from trae_agent.utils.config import ModelConfig
from trae_agent.utils.llm_clients.base_client import BaseLLMClient
from trae_agent.utils.llm_clients.llm_basics import (
    LLMMessage,
    LLMResponse,
    usage_from_google_usage,
    usage_log_fields,
)
from trae_agent.utils.llm_clients.llm_logger import LLMLogger
from trae_agent.utils.llm_clients.retry_utils import retry_with


class GoogleClient(BaseLLMClient):
    """Google Gemini client wrapper with tool schema generation."""

    def __init__(self, model_config: ModelConfig):
        super().__init__(model_config)

        self.client = genai.Client(api_key=self.api_key)
        self.message_history: list[types.Content] = []
        self.system_instruction: str | None = None
        self.logger = LLMLogger(model_config.model)

    @override
    def set_chat_history(self, messages: list[LLMMessage]) -> None:
        """Set the chat history."""
        self.message_history, self.system_instruction = self.parse_messages(messages)

    def _create_google_response(
        self,
        model_config: ModelConfig,
        current_chat_contents: list[types.Content],
        generation_config: types.GenerateContentConfig,
    ) -> types.GenerateContentResponse:
        """Create a response using Google Gemini API. This method will be decorated with retry logic."""
        trace_headers = self.trace_headers()
        if trace_headers:
            existing = generation_config.http_options
            http_options = (
                types.HttpOptions(headers=trace_headers)
                if existing is None
                else existing.model_copy(
                    update={"headers": {**(existing.headers or {}), **trace_headers}}
                )
            )
            generation_config = generation_config.model_copy(update={"http_options": http_options})
        return self.client.models.generate_content(  # pyright: ignore[reportUnknownMemberType]
            model=model_config.model,
            contents=current_chat_contents,
            config=generation_config,
        )

    @override
    def chat(
        self,
        messages: list[LLMMessage],
        model_config: ModelConfig,
        tools: list[Tool] | None = None,
        reuse_history: bool = True,
    ) -> LLMResponse:
        """Send chat messages to Gemini with optional tool support."""
        newly_parsed_messages, system_instruction_from_message = self.parse_messages(messages)

        current_system_instruction = system_instruction_from_message or self.system_instruction

        if reuse_history:
            current_chat_contents = self.message_history + newly_parsed_messages
        else:
            current_chat_contents = newly_parsed_messages

        # Set up generation config
        generation_config = types.GenerateContentConfig(
            temperature=model_config.temperature,
            top_p=model_config.top_p,
            top_k=model_config.top_k,
            max_output_tokens=model_config.max_tokens,
            candidate_count=model_config.candidate_count,
            stop_sequences=model_config.stop_sequences,
            system_instruction=current_system_instruction,
        )

        # Add tools if provided
        if tools:
            tool_schemas = [
                types.Tool(
                    function_declarations=[
                        types.FunctionDeclaration(
                            name=tool.get_name(),
                            description=tool.get_description(),
                            parameters=tool.get_input_schema(),  # pyright: ignore[reportArgumentType]
                        )
                    ]
                )
                for tool in tools
            ]
            generation_config.tools = tool_schemas

        # Apply retry decorator to the API call
        retry_decorator = retry_with(
            func=self._create_google_response,
            provider_name="Google Gemini",
            max_retries=model_config.max_retries,
        )
        start_time = time.time()
        response = retry_decorator(model_config, current_chat_contents, generation_config)
        latency = time.time() - start_time

        content = ""
        tool_calls: list[ToolCall] = []
        assistant_response_content = None

        if response.candidates:
            candidate = response.candidates[0]
            if candidate.content and candidate.content.parts:
                assistant_response_content = candidate.content
                for part in candidate.content.parts:
                    if part.text:
                        content += part.text
                    elif part.function_call:
                        tool_calls.append(
                            ToolCall(
                                call_id=str(uuid.uuid4()),
                                name=part.function_call.name or "tool",
                                arguments=dict(part.function_call.args)
                                if part.function_call.args
                                else {},
                            )
                        )

        if reuse_history:
            new_history = self.message_history + newly_parsed_messages
        else:
            new_history = newly_parsed_messages

        if assistant_response_content:
            new_history.append(assistant_response_content)

        self.message_history = new_history

        if current_system_instruction:
            self.system_instruction = current_system_instruction

        usage = usage_from_google_usage(response.usage_metadata)

        llm_response = LLMResponse(
            content=content,
            usage=usage,
            model=model_config.model,
            finish_reason=str(
                response.candidates[0].finish_reason.name
                if response.candidates[0].finish_reason
                else "unknown"
            )
            if response.candidates
            else "UNKNOWN",
            tool_calls=tool_calls if len(tool_calls) > 0 else None,
        )

        # 落调用日志：此前本客户端完全不写 response 行（与 openai_client 的 Responses 路径
        # 同属「调用日志里一片空白」的缺口），token 账只剩 trajectory 文件能看。
        self.logger.log_response(
            response={
                "content": llm_response.content,
                "tool_calls": [tc.__dict__ for tc in tool_calls] if tool_calls else None,
                "finish_reason": llm_response.finish_reason,
                "model": llm_response.model,
            },
            usage=usage_log_fields(llm_response.usage),
            latency=latency,
        )

        if self.trajectory_recorder:
            self.trajectory_recorder.record_llm_interaction(
                messages=messages,
                response=llm_response,
                provider="google",
                model=model_config.model,
                tools=tools,
                latency_ms=round(latency * 1000, 3),
                credential_ref=self.credential_ref(),
            )

        return llm_response

    def parse_messages(self, messages: list[LLMMessage]) -> tuple[list[types.Content], str | None]:
        """Parse the messages to Gemini format, separating system instructions."""
        gemini_messages: list[types.Content] = []
        system_instruction: str | None = None

        for msg in messages:
            if msg.role == "system":
                system_instruction = msg.content
                continue
            elif msg.tool_result:
                gemini_messages.append(
                    types.Content(
                        role="tool",
                        parts=[self.parse_tool_call_result(msg.tool_result)],
                    )
                )
            elif msg.tool_call:
                gemini_messages.append(
                    types.Content(role="model", parts=[self.parse_tool_call(msg.tool_call)])
                )
            else:
                role = "user" if msg.role == "user" else "model"
                gemini_messages.append(
                    types.Content(role=role, parts=[types.Part(text=msg.content or "")])
                )

        return gemini_messages, system_instruction

    def parse_tool_call(self, tool_call: ToolCall) -> types.Part:
        """Parse a ToolCall into a Gemini FunctionCall Part for history."""
        return types.Part.from_function_call(name=tool_call.name, args=tool_call.arguments)

    def parse_tool_call_result(self, tool_result: ToolResult) -> types.Part:
        """Parse a ToolResult into a Gemini FunctionResponse Part for history."""
        result_content: dict[str, str] = {}
        if tool_result.result is not None:
            try:
                json.dumps(tool_result.result)
                result_content["result"] = tool_result.result
            except (TypeError, OverflowError) as e:
                tb = traceback.format_exc()
                serialization_error = f"JSON serialization failed for tool result: {e}\n{tb}"
                if tool_result.error:
                    result_content["error"] = f"{tool_result.error}\n\n{serialization_error}"
                else:
                    result_content["error"] = serialization_error
                result_content["result"] = str(tool_result.result)

        if tool_result.error and "error" not in result_content:
            result_content["error"] = tool_result.error

        if not result_content:
            result_content["status"] = "Tool executed successfully but returned no output."

        if not hasattr(tool_result, "name") or not tool_result.name:
            raise AttributeError(
                "ToolResult must have a 'name' attribute matching the function that was called."
            )
        return types.Part.from_function_response(name=tool_result.name, response=result_content)

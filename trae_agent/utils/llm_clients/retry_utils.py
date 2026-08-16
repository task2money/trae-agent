# Copyright (c) 2025 ByteDance Ltd. and/or its affiliates
# SPDX-License-Identifier: MIT

import random
import time
import traceback
from functools import wraps
from typing import Any, Callable, TypeVar

T = TypeVar("T")

# Gateway/proxy 在上游重启、路由尚未注册时常返回这些状态；与永久 4xx 区分。
_TRANSIENT_HTTP_STATUS = frozenset({404, 408, 409, 425, 429})
_PERMANENT_NOT_FOUND_MARKERS = (
    "model_not_found",
    "the model `",
    "no such model",
    "invalid model",
    "does not exist or you do not have access",
)


def _exception_blob(exc: Exception) -> str:
    parts = [str(exc)]
    body = getattr(exc, "body", None)
    if body is not None:
        parts.append(str(body))
    message = getattr(exc, "message", None)
    if message is not None:
        parts.append(str(message))
    return " ".join(parts).lower()


def _is_permanent_not_found(exc: Exception) -> bool:
    blob = _exception_blob(exc)
    return any(marker in blob for marker in _PERMANENT_NOT_FOUND_MARKERS)


def _http_status_code(exc: Exception) -> int | None:
    raw = getattr(exc, "status_code", None)
    if raw is None:
        raw = getattr(exc, "status", None)
    try:
        code = int(raw)
    except (TypeError, ValueError):
        return None
    if code <= 0:
        return None
    return code


def _should_retry_api_error(exc: Exception) -> bool:
    """Retry rate limits, 5xx, and gateway 404/408 during SaaS restart — not bad requests.

    OpenAI SDK raises APIStatusError; Anthropic/httpx 也可能带 status_code。
    空 body 的 404（APISIX Route Not Found / nginx 默认页）视为瞬时；
    明确的 model_not_found 才视为永久失败。
    """
    code = _http_status_code(exc)
    if code is None:
        return True
    if code >= 500:
        return True
    if code in _TRANSIENT_HTTP_STATUS:
        return not (code == 404 and _is_permanent_not_found(exc))
    return not 400 <= code < 500


def retry_with(
    func: Callable[..., T],
    provider_name: str = "OpenAI",
    max_retries: int = 3,
) -> Callable[..., T]:
    """
    Decorator that adds retry logic with randomized backoff.

    Args:
        func: The function to decorate
        provider_name: The name of the model provider being called
        max_retries: Maximum number of retry attempts

    Returns:
        Decorated function with retry logic
    """

    @wraps(func)
    def wrapper(*args: Any, **kwargs: Any) -> T:
        last_exception = None

        for attempt in range(max_retries + 1):
            try:
                return func(*args, **kwargs)
            except Exception as e:
                last_exception = e

                if attempt == max_retries:
                    # Last attempt, re-raise the exception
                    raise

                if not _should_retry_api_error(e):
                    raise

                # Exponential backoff with jitter (cap ~60s) — faster recovery than flat 3–30s random
                base = min(60.0, float(2**attempt))
                sleep_time = base + random.uniform(0, min(4.0, base * 0.25))
                this_error_message = str(e)
                print(
                    f"{provider_name} API call failed: {this_error_message}. Will sleep for {sleep_time:.1f} seconds and will retry.\n{traceback.format_exc()}"
                )
                time.sleep(sleep_time)

        # This should never be reached, but just in case
        raise last_exception or Exception("Retry failed for unknown reason")

    return wrapper

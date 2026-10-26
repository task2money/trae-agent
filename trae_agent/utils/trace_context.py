# Copyright (c) 2025 ByteDance Ltd. and/or its affiliates
# SPDX-License-Identifier: MIT

"""Agent 运行的关联标识（硬约束 78：trace_id / 租户 / 任务）。

平台侧日志按 trace_id 串联，agent 侧轨迹若没有同一个 id，出现「某次任务花了
3 倍 token」时两边只能靠时间戳猜。外部（控制面 / 网关）可经环境变量注入：

- ``TRAE_TRACE_ID``  / ``TRAE_TENANT_ID`` / ``TRAE_TASK_ID``

未注入时生成一个 trace_id，并随每次 provider 请求的 ``X-Trace-Id`` 头下传，
使上游代理/网关的访问日志也能与 trajectory 对齐。
"""

import os
import uuid

TRACE_ID_ENV = "TRAE_TRACE_ID"
TENANT_ID_ENV = "TRAE_TENANT_ID"
TASK_ID_ENV = "TRAE_TASK_ID"

TRACE_HEADER = "X-Trace-Id"


def _clean(value: str | None) -> str | None:
    if value is None:
        return None
    text = value.strip()
    return text or None


def resolve_trace_id(explicit: str | None = None) -> str:
    """显式注入 > 环境变量 > 新生成；空串一律视为未提供。"""
    return _clean(explicit) or _clean(os.environ.get(TRACE_ID_ENV)) or uuid.uuid4().hex


def resolve_trace_identity(
    trace_id: str | None = None,
    tenant_id: str | None = None,
    task_id: str | None = None,
) -> dict[str, str]:
    """返回轨迹要落的三个标识；租户/任务未提供时为空串（不编造）。"""
    return {
        "trace_id": resolve_trace_id(trace_id),
        "tenant_id": _clean(tenant_id) or _clean(os.environ.get(TENANT_ID_ENV)) or "",
        "task_id": _clean(task_id) or _clean(os.environ.get(TASK_ID_ENV)) or "",
    }

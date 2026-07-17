import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PARENT_SPAN_HEADER,
  isTraceIdOnlyRequest,
  resolveOutboundTraceId,
  resolveTraceId,
  spanIdFromRequest,
  startupTraceId,
  traceHeadersForOutbound,
  traceIdFromRequest,
} from './traceId.mjs';

test('traceIdFromRequest prefers req.traceId', () => {
  assert.equal(traceIdFromRequest({ traceId: 'req-trace-abc12345' }), 'req-trace-abc12345');
});

test('traceIdFromRequest reads X-Trace-Id header', () => {
  assert.equal(
    traceIdFromRequest({ headers: { 'x-trace-id': 'header-trace-xyz12345' } }),
    'header-trace-xyz12345',
  );
});

test('resolveTraceId uses startup env only when useStartupEnv', () => {
  const prev = process.env.TRACE_ID;
  process.env.TRACE_ID = 'startup-trace-abc12345';
  try {
    assert.equal(
      resolveTraceId({ useStartupEnv: true }),
      'startup-trace-abc12345',
    );
    assert.equal(resolveTraceId({ req: {} }), '');
    assert.equal(
      resolveTraceId({ req: { traceId: 'page-trace-xyz12345' } }),
      'page-trace-xyz12345',
    );
  } finally {
    if (prev === undefined) delete process.env.TRACE_ID;
    else process.env.TRACE_ID = prev;
  }
});

test('traceHeadersForOutbound sets parent span header', () => {
  const headers = traceHeadersForOutbound('forward-trace-xyz12345', 'b1b2c3d4e5f67890');
  assert.equal(headers['X-Trace-Id'], 'forward-trace-xyz12345');
  assert.equal(headers[PARENT_SPAN_HEADER], 'b1b2c3d4e5f67890');
});

test('spanIdFromRequest prefers req.spanId', () => {
  assert.equal(spanIdFromRequest({ spanId: 'c1c2c3d4e5f67890' }), 'c1c2c3d4e5f67890');
});

test('resolveOutboundTraceId prefers explicit over env', () => {
  const prev = process.env.TRACE_ID;
  process.env.TRACE_ID = 'startup-trace-abc12345';
  try {
    assert.equal(resolveOutboundTraceId('forward-trace-xyz12345'), 'forward-trace-xyz12345');
    assert.equal(resolveOutboundTraceId(undefined), 'startup-trace-abc12345');
    assert.equal(resolveOutboundTraceId(''), '');
  } finally {
    if (prev === undefined) delete process.env.TRACE_ID;
    else process.env.TRACE_ID = prev;
  }
});

test('startupTraceId reads TRACE_ID env', () => {
  const prev = process.env.TRACE_ID;
  process.env.TRACE_ID = 'env-only-trace123456';
  try {
    assert.equal(startupTraceId(), 'env-only-trace123456');
  } finally {
    if (prev === undefined) delete process.env.TRACE_ID;
    else process.env.TRACE_ID = prev;
  }
});

test('isTraceIdOnlyRequest: bare X-Trace-Id is incomplete', () => {
  assert.equal(
    isTraceIdOnlyRequest({
      headers: { 'x-trace-id': '71c09823-3d45-4777-88a9-9f57610805a1' },
    }),
    true,
  );
});

test('isTraceIdOnlyRequest: X-Trace-Id + X-Parent-Span-Id is complete', () => {
  assert.equal(
    isTraceIdOnlyRequest({
      headers: {
        'x-trace-id': '71c09823-3d45-4777-88a9-9f57610805a1',
        'x-parent-span-id': 'b1b2c3d4e5f67890',
      },
    }),
    false,
  );
});

test('isTraceIdOnlyRequest: X-Trace-Id + traceparent is complete', () => {
  assert.equal(
    isTraceIdOnlyRequest({
      headers: {
        'x-trace-id': '71c09823-3d45-4777-88a9-9f57610805a1',
        traceparent: '00-71c098233d45477788a99f57610805a1-b1b2c3d4e5f67890-01',
      },
    }),
    false,
  );
});

test('isTraceIdOnlyRequest: no X-Trace-Id is not incomplete', () => {
  assert.equal(isTraceIdOnlyRequest({ headers: {} }), false);
});

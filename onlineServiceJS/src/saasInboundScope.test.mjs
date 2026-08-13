// @ts-check
import { test } from 'node:test';
import assert from 'node:assert';
import { saasInboundScopeFields } from './saasInboundScope.mjs';

test('saasInboundScopeFields：COMMENT_ID 与 CONTAINER_NAME 写入 body 字段', () => {
  const got = saasInboundScopeFields({
    COMMENT_ID: ' cmt_1 ',
    CONTAINER_NAME: 'task_1_cmt_1',
  });
  assert.deepStrictEqual(got, { comment_id: 'cmt_1', container_name: 'task_1_cmt_1' });
});

test('saasInboundScopeFields：空环境不带字段', () => {
  const got = saasInboundScopeFields({});
  assert.deepStrictEqual(got, {});
});

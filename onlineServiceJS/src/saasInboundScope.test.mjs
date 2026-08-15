// @ts-check
import { test } from 'node:test';
import assert from 'node:assert';
import { saasInboundScopeFields, withSaasInboundScope } from './saasInboundScope.mjs';

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

test('withSaasInboundScope：合并业务字段与 comment_id', () => {
  const got = withSaasInboundScope(
    { access_token: 'tok', layer_id: 'L1' },
    { COMMENT_ID: 'cmt-a', CONTAINER_NAME: 'task_1_cmt-a' },
  );
  assert.deepStrictEqual(got, {
    access_token: 'tok',
    layer_id: 'L1',
    comment_id: 'cmt-a',
    container_name: 'task_1_cmt-a',
  });
});

test('withSaasInboundScope：两评论 id 不同则 body 不同', () => {
  const a = withSaasInboundScope({ access_token: 't' }, { COMMENT_ID: 'cmt-a' });
  const b = withSaasInboundScope({ access_token: 't' }, { COMMENT_ID: 'cmt-b' });
  assert.equal(a.comment_id, 'cmt-a');
  assert.equal(b.comment_id, 'cmt-b');
  assert.notEqual(a.comment_id, b.comment_id);
});

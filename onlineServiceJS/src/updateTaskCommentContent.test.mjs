import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildUpdateContentInboundUrl,
  updateTaskContent,
  updateCommentContent,
} from './updateTaskCommentContent.mjs';

test('buildUpdateContentInboundUrl appends action', () => {
  const url = buildUpdateContentInboundUrl('update-task-content', () =>
    'https://api.example/api/tenant/t/workspace/w/task/task1/comment/cmt_1/cloud',
  );
  assert.equal(
    url,
    'https://api.example/api/tenant/t/workspace/w/task/task1/comment/cmt_1/cloud/server-container-token/update-task-content/',
  );
});

test('updateTaskContent posts title/description with fixed idempotency key', async () => {
  const calls = [];
  const out = await updateTaskContent({
    title: 'T2',
    description: 'D2',
    accessToken: 'tok',
    idempotencyKey: 'idem-1',
    prefixFn: () =>
      'https://api.example/api/tenant/t/workspace/w/task/task1/comment/cmt_1/cloud',
    postJsonFn: async (url, body) => {
      calls.push({ url, body });
      return { unchanged: false, revision_id: 'r1' };
    },
  });
  assert.equal(out.ok, true);
  assert.equal(out.idempotency_key, 'idem-1');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/update-task-content\/$/);
  assert.equal(calls[0].body.access_token, 'tok');
  assert.equal(calls[0].body.title, 'T2');
  assert.equal(calls[0].body.description, 'D2');
  assert.equal(calls[0].body.idempotency_key, 'idem-1');
});

test('updateCommentContent requires target_comment_id', async () => {
  const out = await updateCommentContent({
    content: 'x',
    accessToken: 'tok',
    prefixFn: () =>
      'https://api.example/api/tenant/t/workspace/w/task/task1/comment/cmt_1/cloud',
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'target_comment_id_required');
});

test('updateCommentContent posts body', async () => {
  const calls = [];
  const out = await updateCommentContent({
    targetCommentId: 'cmt_2',
    content: 'hello',
    accessToken: 'tok',
    idempotencyKey: 'idem-c',
    prefixFn: () =>
      'https://api.example/api/tenant/t/workspace/w/task/task1/comment/cmt_1/cloud',
    postJsonFn: async (url, body) => {
      calls.push({ url, body });
      return { unchanged: false };
    },
  });
  assert.equal(out.ok, true);
  assert.match(calls[0].url, /\/update-comment-content\/$/);
  assert.equal(calls[0].body.target_comment_id, 'cmt_2');
  assert.equal(calls[0].body.content, 'hello');
  assert.equal(calls[0].body.idempotency_key, 'idem-c');
});

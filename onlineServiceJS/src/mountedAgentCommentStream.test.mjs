import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildContainerAgentStreamUrl,
  createMountedAgentChunkBuffer,
  postMountedAgentChunk,
} from './mountedAgentCommentStream.mjs';

test('buildContainerAgentStreamUrl strips /cloud suffix', () => {
  const url = buildContainerAgentStreamUrl('ac1', () => 'http://x/api/cloud');
  assert.equal(url, 'http://x/api/container-agent-comments/ac1/stream');
});

test('postMountedAgentChunk posts chunk with token', async () => {
  const calls = [];
  const out = await postMountedAgentChunk({
    agentCommentId: 'ac1',
    chunk: 'hello',
    accessToken: 'tok',
    prefixFn: () => 'http://x/api/cloud',
    fetchFn: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, text: async () => '{}' };
    },
  });
  assert.equal(out.ok, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/stream$/);
  assert.equal(JSON.parse(calls[0].init.body).chunk, 'hello');
  assert.equal(calls[0].init.headers['X-Access-Token'], 'tok');
});

test('postMountedAgentChunk body 带 COMMENT_ID', async () => {
  const prev = process.env.COMMENT_ID;
  process.env.COMMENT_ID = 'cmt-b';
  try {
    const calls = [];
    await postMountedAgentChunk({
      agentCommentId: 'ac1',
      chunk: 'hello',
      accessToken: 'tok',
      prefixFn: () => 'http://x/api/cloud',
      fetchFn: async (_url, init) => {
        calls.push(init);
        return { ok: true, status: 200, text: async () => '{}' };
      },
    });
    assert.equal(JSON.parse(calls[0].body).comment_id, 'cmt-b');
  } finally {
    if (prev === undefined) delete process.env.COMMENT_ID;
    else process.env.COMMENT_ID = prev;
  }
});

test('createMountedAgentChunkBuffer flushes by size', async () => {
  const chunks = [];
  const buf = createMountedAgentChunkBuffer({
    flushMs: 10_000,
    maxChars: 5,
    postFn: async ({ chunk }) => {
      chunks.push(chunk);
      return { ok: true };
    },
  });
  await buf.push('ac1', '123');
  assert.equal(chunks.length, 0);
  await buf.push('ac1', '456');
  assert.deepEqual(chunks, ['123456']);
});

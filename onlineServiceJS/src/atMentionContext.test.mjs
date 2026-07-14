import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeAtMentionContextPack, CONTEXT_PACK_MAX_BYTES } from './atMentionContext.mjs'

test('normalizeAtMentionContextPack requires at_mention_run ids', () => {
  const r = normalizeAtMentionContextPack({ at_mention_run: { run_id: 'r1' } })
  assert.equal(r.ok, false)
})

test('normalizeAtMentionContextPack accepts minimal pack', () => {
  const r = normalizeAtMentionContextPack({
    at_mention_run: {
      run_id: 'r1',
      parent_comment_id: 'c1',
      agent_comment_id: 'a1',
    },
    task: { id: 't1', title: 'hello' },
    comment_thread: [{ kind: 'human', id: 'c1', content: 'hi' }],
  })
  assert.equal(r.ok, true)
  assert.equal(r.truncated, false)
  assert.equal(r.pack.task.id, 't1')
})

test('normalizeAtMentionContextPack truncates oversized thread', () => {
  const big = 'x'.repeat(80 * 1024)
  const thread = []
  for (let i = 0; i < 8; i++) {
    thread.push({ kind: 'human', id: `c${i}`, content: big })
  }
  const r = normalizeAtMentionContextPack({
    at_mention_run: {
      run_id: 'r1',
      parent_comment_id: 'c7',
      agent_comment_id: 'a1',
    },
    task: { id: 't1' },
    comment_thread: thread,
  })
  assert.equal(r.ok, true)
  assert.equal(r.truncated, true)
  assert.ok(r.pack.comment_thread.length < 8)
  assert.ok(Buffer.byteLength(JSON.stringify(r.pack), 'utf8') <= CONTEXT_PACK_MAX_BYTES)
})

test('normalizeAtMentionContextPack keeps trigger_comment on run', () => {
  const r = normalizeAtMentionContextPack({
    at_mention_run: {
      run_id: 'r1',
      parent_comment_id: 'c1',
      agent_comment_id: 'a1',
      trigger_comment: { id: 'c1', content: 'run me' },
    },
    task: {},
    comment_thread: [{ kind: 'human', id: 'c1', content: 'run me' }],
  })
  assert.equal(r.ok, true)
  assert.equal(r.pack.at_mention_run.trigger_comment.content, 'run me')
})

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runPostBootstrapAgentKickoff } from './postBootstrapAgentKickoff.mjs';

function tmpState() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'postboot-kick-'));
  process.env.ONLINE_PROJECT_STATE_ROOT = tmp;
  return tmp;
}

const validAtMentionDetail = {
  at_mention_run: {
    run_id: 'run_1',
    parent_comment_id: 'c_parent',
    agent_comment_id: 'c_agent',
    trigger_comment: { content: 'Please fix the bug' },
  },
  comment_thread: [{ kind: 'human', content: 'Please fix the bug' }],
  task: { auto_run: true, title: 'Auto title', description: 'Auto desc' },
};

test('runPostBootstrapAgentKickoff prefers valid at_mention over auto_run', async () => {
  tmpState();
  const calls = [];
  const out = await runPostBootstrapAgentKickoff({
    detail: validAtMentionDetail,
    layerId: 'layer_1',
    createJobFn: async (body) => {
      calls.push(body);
      return { id: 'job_at', layer_id: 'layer_1' };
    },
  });
  assert.equal(out.kind, 'at_mention');
  assert.equal(out.rec?.id, 'job_at');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].at_mention_run, true);
  assert.equal(calls[0].auto_run_first, undefined);
});

test('runPostBootstrapAgentKickoff falls back to auto_run when at_mention pack invalid', async () => {
  tmpState();
  const calls = [];
  const out = await runPostBootstrapAgentKickoff({
    detail: {
      at_mention_run: { run_id: 'incomplete' },
      task: { auto_run: true, title: 'Fix me', description: 'details' },
    },
    layerId: 'layer_2',
    createJobFn: async (body) => {
      calls.push(body);
      return { id: 'job_ar', layer_id: 'layer_2' };
    },
  });
  assert.equal(out.kind, 'auto_run');
  assert.equal(out.rec?.id, 'job_ar');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].auto_run_first, true);
  assert.match(String(calls[0].command), /Fix me/);
});

test('runPostBootstrapAgentKickoff starts auto_run when no at_mention_run', async () => {
  tmpState();
  const calls = [];
  const out = await runPostBootstrapAgentKickoff({
    detail: { task: { auto_run: true, title: 'T', description: 'D' } },
    layerId: 'layer_3',
    createJobFn: async (body) => {
      calls.push(body);
      return { id: 'job_3' };
    },
  });
  assert.equal(out.kind, 'auto_run');
  assert.equal(calls[0].auto_run_first, true);
});

test('runPostBootstrapAgentKickoff returns null kind when auto_run false and no at_mention', async () => {
  tmpState();
  let called = 0;
  const out = await runPostBootstrapAgentKickoff({
    detail: { task: { auto_run: false, title: 'T', description: 'D' } },
    layerId: 'layer_4',
    createJobFn: async () => {
      called += 1;
      return { id: 'x' };
    },
  });
  assert.equal(out.kind, null);
  assert.equal(out.rec, null);
  assert.equal(called, 0);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  composeAtMentionCommand,
  detailHasAtMentionRun,
  shouldTriggerAtMentionJob,
  maybeStartAtMentionJob,
  hasAtMentionJobMarker,
  writeAtMentionJobMarker,
  atMentionJobMarkerPath,
} from './atMentionOrchestration.mjs';

const baseRun = {
  run_id: 'r1',
  parent_comment_id: 'c1',
  agent_comment_id: 'a1',
};

test('composeAtMentionCommand prefers trigger_comment.content', () => {
  assert.equal(
    composeAtMentionCommand({
      at_mention_run: {
        ...baseRun,
        trigger_comment: { id: 'c1', content: '  do this  ' },
      },
      comment_thread: [{ kind: 'human', content: 'older' }],
    }),
    'do this',
  );
});

test('composeAtMentionCommand falls back to last human in thread', () => {
  assert.equal(
    composeAtMentionCommand({
      at_mention_run: { ...baseRun },
      comment_thread: [
        { kind: 'human', content: 'first' },
        { kind: 'ai', content: 'ai note', assistant_response: 'x' },
        { kind: 'human', content: '  last human  ' },
        { kind: 'container_agent', content: 'agent', assistant_response: 'y' },
      ],
    }),
    'last human',
  );
  assert.equal(composeAtMentionCommand({ at_mention_run: { ...baseRun }, comment_thread: [] }), '');
});

test('detailHasAtMentionRun and shouldTriggerAtMentionJob gates', () => {
  assert.equal(detailHasAtMentionRun({ at_mention_run: baseRun }), true);
  assert.equal(detailHasAtMentionRun({ task: {} }), false);
  assert.equal(
    shouldTriggerAtMentionJob({
      packOk: true,
      layerId: 'L1',
      command: 'x',
      markerExists: false,
    }),
    true,
  );
  assert.equal(
    shouldTriggerAtMentionJob({
      packOk: false,
      layerId: 'L1',
      command: 'x',
      markerExists: false,
    }),
    false,
  );
  assert.equal(
    shouldTriggerAtMentionJob({
      packOk: true,
      layerId: '',
      command: 'x',
      markerExists: false,
    }),
    false,
  );
  assert.equal(
    shouldTriggerAtMentionJob({
      packOk: true,
      layerId: 'L1',
      command: '',
      markerExists: false,
    }),
    false,
  );
  assert.equal(
    shouldTriggerAtMentionJob({
      packOk: true,
      layerId: 'L1',
      command: 'x',
      markerExists: true,
    }),
    false,
  );
});

test('maybeStartAtMentionJob creates job once when pack ok', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atmention-'));
  process.env.ONLINE_PROJECT_STATE_ROOT = tmp;
  const calls = [];
  const createJobFn = async (body) => {
    calls.push(body);
    return { id: 'job_am_1', layer_id: 'layer_child', ...body };
  };
  const detail = {
    at_mention_run: {
      ...baseRun,
      trigger_comment: { id: 'c1', content: 'Fix the flaky test' },
    },
    task: { id: 't1', title: 'T' },
    comment_thread: [{ kind: 'human', id: 'c1', content: 'Fix the flaky test' }],
  };
  const rec = await maybeStartAtMentionJob({
    detail,
    layerId: 'layer_root',
    createJobFn,
  });
  assert.ok(rec);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'Fix the flaky test');
  assert.equal(calls[0].command_kind, 'trae');
  assert.equal(calls[0].repo_layer_id, 'layer_root');
  assert.equal(calls[0].at_mention_run, true);
  assert.equal(calls[0].at_mention_run_id, 'r1');
  assert.equal(hasAtMentionJobMarker(), true);

  const again = await maybeStartAtMentionJob({
    detail,
    layerId: 'layer_root',
    createJobFn,
  });
  assert.equal(again, null);
  assert.equal(calls.length, 1);
});

test('maybeStartAtMentionJob skips when no at_mention_run', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atmention-'));
  process.env.ONLINE_PROJECT_STATE_ROOT = tmp;
  let called = 0;
  const rec = await maybeStartAtMentionJob({
    detail: { task: { auto_run: true, title: 'T' } },
    layerId: 'L',
    createJobFn: async () => {
      called += 1;
      return { id: 'j' };
    },
  });
  assert.equal(rec, null);
  assert.equal(called, 0);
});

test('maybeStartAtMentionJob creates agent comment when pack omits agent_comment_id', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atmention-'));
  process.env.ONLINE_PROJECT_STATE_ROOT = tmp;
  const jobs = [];
  const creates = [];
  const rec = await maybeStartAtMentionJob({
    detail: {
      at_mention_run: {
        parent_comment_id: 'c1',
        installed_image: { id: 'img-1' },
        trigger_comment: { id: 'c1', content: 'ship it' },
        source: 'auto_run',
      },
      comment_thread: [{ kind: 'human', id: 'c1', content: 'ship it' }],
    },
    layerId: 'L1',
    createJobFn: async (body) => {
      jobs.push(body);
      return { id: 'job_new', ...body };
    },
    createAgentCommentFn: async (opts) => {
      creates.push(opts);
      return { ok: true, id: 'agent-created' };
    },
  });
  assert.ok(rec);
  assert.equal(creates.length, 1);
  assert.equal(creates[0].parentCommentId, 'c1');
  assert.equal(creates[0].installedImageId, 'img-1');
  assert.equal(creates[0].source, 'auto_run');
  assert.equal(jobs[0].at_mention_agent_comment_id, 'agent-created');
  assert.equal(jobs[0].mounted_agent_comment_id, 'agent-created');
});

test('maybeStartAtMentionJob skips invalid pack (missing ids)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atmention-'));
  process.env.ONLINE_PROJECT_STATE_ROOT = tmp;
  let called = 0;
  const rec = await maybeStartAtMentionJob({
    detail: {
      at_mention_run: { run_id: 'r1' },
      comment_thread: [{ kind: 'human', content: 'hi' }],
    },
    layerId: 'L',
    createJobFn: async () => {
      called += 1;
      return { id: 'j' };
    },
  });
  assert.equal(rec, null);
  assert.equal(called, 0);
});

test('marker path helpers write under runtime', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atmention-m-'));
  process.env.ONLINE_PROJECT_STATE_ROOT = tmp;
  assert.ok(atMentionJobMarkerPath().includes(path.join('runtime', 'at_mention_job.json')));
  writeAtMentionJobMarker('j1', { run_id: 'r1' });
  assert.equal(hasAtMentionJobMarker(), true);
});

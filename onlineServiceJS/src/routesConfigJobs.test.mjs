import assert from 'node:assert/strict';
import test from 'node:test';
import { handleJobRedo, handleJobContinue } from './routesConfigJobs.mjs';

// --- helpers ---

function makeJob(overrides = {}) {
  return {
    id: 'J1',
    layer_id: 'L1',
    command: 'hello world command',
    command_kind: 'trae',
    status: 'completed',
    auto_run_commit_message: '',
    mounted_agent_comment_id: '',
    mounted_parent_comment_id: '',
    ...overrides,
  };
}

function makeRedoDeps(opts = {}) {
  const jobs = new Map();
  const seed = opts.seedJob ? [opts.seedJob] : [makeJob()];
  for (const j of seed) jobs.set(j.id, j);
  return {
    getJob: (id) => jobs.get(id) || null,
    createJob: opts.createJobFn || (async (body) => ({ id: 'J-new', ...body })),
    jobToApiDict: opts.jobToApiDictFn || ((rec) => rec),
  };
}

function makeContinueDeps(opts = {}) {
  return makeRedoDeps(opts);
}

// --- handleJobRedo ---

test('handleJobRedo returns 404 when job not found', async () => {
  const deps = makeRedoDeps({ seedJob: null });
  const r = await handleJobRedo('nonexistent', deps);
  assert.equal(r.status, 404);
  assert.equal(r.body.detail, 'job not found');
});

test('handleJobRedo rejects clone job with 400', async () => {
  const deps = makeRedoDeps({ seedJob: makeJob({ command_kind: 'clone', status: 'completed' }) });
  const r = await handleJobRedo('J1', deps);
  assert.equal(r.status, 400);
  assert.match(r.body.detail, /clone/);
});

test('handleJobRedo rejects running job with 400', async () => {
  const deps = makeRedoDeps({ seedJob: makeJob({ status: 'running' }) });
  const r = await handleJobRedo('J1', deps);
  assert.equal(r.status, 400);
  assert.match(r.body.detail, /执行中/);
});

test('handleJobRedo rejects pending job with 400', async () => {
  const deps = makeRedoDeps({ seedJob: makeJob({ status: 'pending' }) });
  const r = await handleJobRedo('J1', deps);
  assert.equal(r.status, 400);
  assert.match(r.body.detail, /执行中/);
});

test('handleJobRedo rejects job with no layer_id', async () => {
  const deps = makeRedoDeps({ seedJob: makeJob({ layer_id: '', command_kind: 'trae', status: 'completed' }) });
  const r = await handleJobRedo('J1', deps);
  assert.equal(r.status, 400);
  assert.match(r.body.detail, /layer_id/);
});

test('handleJobRedo creates job via parent_job_id with auto_run_first', async () => {
  const createdJobs = [];
  const deps = makeRedoDeps({
    seedJob: makeJob({ id: 'J-orig', command: 'run tests', command_kind: 'trae', status: 'failed' }),
    createJobFn: async (body) => {
      createdJobs.push(body);
      return { id: 'J-new', ...body };
    },
  });
  const r = await handleJobRedo('J-orig', deps);
  assert.equal(r.status, 201);
  assert.equal(r.body.id, 'J-new');
  assert.equal(createdJobs.length, 1);
  const c = createdJobs[0];
  assert.equal(c.parent_job_id, 'J-orig');
  assert.equal(c.command, 'run tests');
  assert.equal(c.command_kind, 'trae');
  assert.equal(c.auto_run_first, true);
  assert.match(c.auto_run_commit_message, /\(redo\)$/);
  assert.equal(typeof c.repo_layer_id, 'undefined');
});

test('handleJobRedo preserves mounted_agent_comment_id', async () => {
  let captured;
  const deps = makeRedoDeps({
    seedJob: makeJob({
      id: 'J-mount',
      status: 'completed',
      mounted_agent_comment_id: 'ac-42',
      mounted_parent_comment_id: 'pc-7',
    }),
    createJobFn: async (body) => { captured = body; return { id: 'J-mount-2', ...body }; },
  });
  const r = await handleJobRedo('J-mount', deps);
  assert.equal(r.status, 201);
  assert.equal(captured.mounted_agent_comment_id, 'ac-42');
  assert.equal(captured.mounted_parent_comment_id, 'pc-7');
});

test('handleJobRedo uses auto_run_commit_message with redo suffix', async () => {
  let captured;
  const deps = makeRedoDeps({
    seedJob: makeJob({
      id: 'J-cm',
      status: 'completed',
      auto_run_commit_message: 'custom commit',
    }),
    createJobFn: async (body) => { captured = body; return { id: 'J-cm-2', ...body }; },
  });
  const r = await handleJobRedo('J-cm', deps);
  assert.equal(r.status, 201);
  assert.equal(captured.auto_run_commit_message, 'custom commit (redo)');
});

test('handleJobRedo falls back to command slice for commit message', async () => {
  let captured;
  const longCmd = 'x'.repeat(100);
  const deps = makeRedoDeps({
    seedJob: makeJob({ id: 'J-long', status: 'completed', command: longCmd, auto_run_commit_message: '' }),
    createJobFn: async (body) => { captured = body; return { id: 'J-long-2', ...body }; },
  });
  const r = await handleJobRedo('J-long', deps);
  assert.equal(r.status, 201);
  assert.ok(captured.auto_run_commit_message.endsWith(' (redo)'));
  assert.ok(captured.auto_run_commit_message.length <= 68); // 60 + ' (redo)'
});

test('handleJobRedo does not set mounted fields when none present', async () => {
  let captured;
  const deps = makeRedoDeps({
    seedJob: makeJob({ id: 'J-nomount', status: 'completed' }),
    createJobFn: async (body) => { captured = body; return { id: 'J-nomount-2', ...body }; },
  });
  const r = await handleJobRedo('J-nomount', deps);
  assert.equal(r.status, 201);
  assert.equal(typeof captured.mounted_agent_comment_id, 'undefined');
});

test('handleJobRedo propagates createJob errors', async () => {
  const deps = makeRedoDeps({
    seedJob: makeJob(),
    createJobFn: async () => { throw new Error('BOOM'); },
  });
  await assert.rejects(
    () => handleJobRedo('J1', deps),
    { message: 'BOOM' },
  );
});

// --- handleJobContinue ---

test('handleJobContinue returns 404 when job not found', async () => {
  const deps = makeContinueDeps({ seedJob: null });
  const r = await handleJobContinue('nonexistent', deps);
  assert.equal(r.status, 404);
  assert.equal(r.body.detail, 'job not found');
});

test('handleJobContinue rejects non-interrupted job with 400', async () => {
  const deps = makeContinueDeps({ seedJob: makeJob({ status: 'completed' }) });
  const r = await handleJobContinue('J1', deps);
  assert.equal(r.status, 400);
  assert.match(r.body.detail, /interrupted/);
});

test('handleJobContinue rejects running job with 400', async () => {
  const deps = makeContinueDeps({ seedJob: makeJob({ status: 'running' }) });
  const r = await handleJobContinue('J1', deps);
  assert.equal(r.status, 400);
});

test('handleJobContinue rejects pending job with 400', async () => {
  const deps = makeContinueDeps({ seedJob: makeJob({ status: 'pending' }) });
  const r = await handleJobContinue('J1', deps);
  assert.equal(r.status, 400);
});

test('handleJobContinue accepts interrupted job', async () => {
  let captured;
  const deps = makeContinueDeps({
    seedJob: makeJob({ id: 'J-int', status: 'interrupted', command: 'fix bug' }),
    createJobFn: async (body) => { captured = body; return { id: 'J-cont', ...body }; },
  });
  const r = await handleJobContinue('J-int', deps);
  assert.equal(r.status, 201);
  assert.equal(r.body.id, 'J-cont');
});

test('handleJobContinue uses repo_layer_id (not parent_job_id)', async () => {
  let captured;
  const deps = makeContinueDeps({
    seedJob: makeJob({ id: 'J-int', layer_id: 'L55', status: 'interrupted' }),
    createJobFn: async (body) => { captured = body; return { id: 'J-cont', ...body }; },
  });
  const r = await handleJobContinue('J-int', deps);
  assert.equal(r.status, 201);
  assert.equal(captured.repo_layer_id, 'L55');
  assert.equal(typeof captured.parent_job_id, 'undefined');
  assert.equal(captured.prior_context_job_id, 'J-int');
  assert.equal(captured.auto_run_first, true);
});

test('handleJobContinue rejects clone job', async () => {
  const deps = makeContinueDeps({ seedJob: makeJob({ command_kind: 'clone', status: 'interrupted' }) });
  const r = await handleJobContinue('J1', deps);
  assert.equal(r.status, 400);
  assert.match(r.body.detail, /clone/);
});

test('handleJobContinue uses continue suffix in commit message', async () => {
  let captured;
  const deps = makeContinueDeps({
    seedJob: makeJob({ id: 'J-int', status: 'interrupted', auto_run_commit_message: 'my message' }),
    createJobFn: async (body) => { captured = body; return { id: 'J-cont', ...body }; },
  });
  const r = await handleJobContinue('J-int', deps);
  assert.equal(r.status, 201);
  assert.equal(captured.auto_run_commit_message, 'my message (continue)');
});

test('handleJobContinue propagates createJob errors', async () => {
  const deps = makeContinueDeps({
    seedJob: makeJob({ status: 'interrupted' }),
    createJobFn: async () => { throw new Error('KABOOM'); },
  });
  await assert.rejects(
    () => handleJobContinue('J1', deps),
    { message: 'KABOOM' },
  );
});

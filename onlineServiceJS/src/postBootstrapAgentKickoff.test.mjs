import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  defaultFetchCommentContent,
  maybeRunPostBootstrapAgentKickoff,
  resumeAgentKickoffAfterCloneReady,
  runPostBootstrapAgentKickoff,
  runRecloneSuccessSideEffects,
  shouldDeferAgentKickoff,
} from './postBootstrapAgentKickoff.mjs';

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

test('runPostBootstrapAgentKickoff uses auto_run when at_mention source is auto_run', async () => {
  tmpState();
  const calls = [];
  const out = await runPostBootstrapAgentKickoff({
    detail: {
      at_mention_run: {
        source: 'auto_run',
        run_id: 'agent_ar',
        parent_comment_id: 'c_parent',
        agent_comment_id: 'agent_ar',
        trigger_comment: { content: '【自动运行】\nAuto title' },
      },
      task: { auto_run: true, title: 'Auto title', description: 'Auto desc' },
    },
    layerId: 'layer_ar',
    createJobFn: async (body) => {
      calls.push(body);
      return { id: 'job_ar_mount', layer_id: 'layer_ar' };
    },
  });
  assert.equal(out.kind, 'auto_run');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].auto_run_first, true);
  assert.equal(calls[0].mounted_agent_comment_id, 'agent_ar');
  assert.equal(calls[0].mounted_parent_comment_id, 'c_parent');
  assert.match(String(calls[0].command), /Auto title/);
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

test('runPostBootstrapAgentKickoff starts at_mention when auto_run is false', async () => {
  tmpState();
  const calls = [];
  const out = await runPostBootstrapAgentKickoff({
    detail: {
      ...validAtMentionDetail,
      task: { auto_run: false, title: 'Ignore me', description: 'not used' },
    },
    layerId: 'layer_mention_no_autorun',
    createJobFn: async (body) => {
      calls.push(body);
      return { id: 'job_mention', layer_id: 'layer_mention_no_autorun' };
    },
  });
  assert.equal(out.kind, 'at_mention');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].at_mention_run, true);
  assert.match(String(calls[0].command), /Please fix the bug/);
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

test('runPostBootstrapAgentKickoff starts at_mention via COMMENT_ID fallback when at_mention_run missing', async () => {
  tmpState();
  const calls = [];
  const out = await runPostBootstrapAgentKickoff({
    detail: { task: { auto_run: false, title: 'T', description: 'D' } },
    layerId: 'layer_fb',
    commentId: 'cmt_99',
    fetchCommentContent: async () => ({ content: 'Fix the bug' }),
    createJobFn: async (body) => {
      calls.push(body);
      return { id: 'job_fb', layer_id: 'layer_fb' };
    },
  });
  assert.equal(out.kind, 'at_mention');
  assert.equal(out.rec?.id, 'job_fb');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].at_mention_run, true);
  assert.equal(calls[0].comment_id_fallback, true);
  assert.match(String(calls[0].command), /Fix the bug/);
});

test('runPostBootstrapAgentKickoff creates agent comment when pack deferred to parent+image', async () => {
  tmpState();
  const jobs = [];
  const creates = [];
  const out = await runPostBootstrapAgentKickoff({
    detail: {
      task: { auto_run: false, title: 'T', installed_image_id: 'img-1' },
    },
    layerId: 'layer_def',
    commentId: 'cmt_parent',
    fetchCommentContent: async () => ({ content: '@镜像 ship' }),
    createAgentCommentFn: async (opts) => {
      creates.push(opts);
      return { ok: true, id: 'agent-new' };
    },
    createJobFn: async (body) => {
      jobs.push(body);
      return { id: 'job_def', layer_id: 'layer_def' };
    },
  });
  assert.equal(out.kind, 'at_mention');
  assert.equal(creates.length, 1);
  assert.equal(creates[0].parentCommentId, 'cmt_parent');
  assert.equal(creates[0].installedImageId, 'img-1');
  assert.equal(jobs[0].mounted_agent_comment_id, 'agent-new');
  assert.equal(jobs[0].comment_id_fallback, undefined);
});

test('runPostBootstrapAgentKickoff uses context_pack comment_thread before fetch', async () => {
  tmpState();
  let fetched = false;
  const calls = [];
  const out = await runPostBootstrapAgentKickoff({
    detail: {
      context_pack: {
        comment_thread: [
          { kind: 'assistant', content: 'skip me' },
          { kind: 'human', content: 'Use the thread command' },
        ],
      },
      task: { auto_run: false, title: 'T' },
    },
    layerId: 'layer_thread',
    commentId: 'cmt_88',
    fetchCommentContent: async () => {
      fetched = true;
      return { content: 'fetched' };
    },
    createJobFn: async (body) => {
      calls.push(body);
      return { id: 'job_t' };
    },
  });
  assert.equal(out.kind, 'at_mention');
  assert.equal(fetched, false);
  assert.equal(calls.length, 1);
  assert.match(String(calls[0].command), /Use the thread command/);
});

test('runPostBootstrapAgentKickoff does not double-create when auto_run true', async () => {
  tmpState();
  let fetched = false;
  const calls = [];
  const out = await runPostBootstrapAgentKickoff({
    detail: { task: { auto_run: true, title: 'AR', description: 'D' } },
    layerId: 'layer_ar2',
    commentId: 'cmt_ar',
    fetchCommentContent: async () => {
      fetched = true;
      return { content: 'x' };
    },
    createJobFn: async (body) => {
      calls.push(body);
      return { id: 'job_ar2' };
    },
  });
  assert.equal(out.kind, 'auto_run');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].auto_run_first, true);
  assert.equal(fetched, false);
});

test('runPostBootstrapAgentKickoff returns null when COMMENT_ID fallback finds no command', async () => {
  tmpState();
  let called = 0;
  const out = await runPostBootstrapAgentKickoff({
    detail: { task: { auto_run: false, title: 'T' } },
    layerId: 'layer_fb_empty',
    commentId: 'cmt_empty',
    fetchCommentContent: async () => ({ content: '' }),
    createJobFn: async () => {
      called += 1;
      return { id: 'x' };
    },
  });
  assert.equal(out.kind, null);
  assert.equal(out.rec, null);
  assert.equal(called, 0);
});

test('defaultFetchCommentContent extracts from context_pack.comment_thread', async () => {
  const prev = process.env.ACCESS_TOKEN;
  process.env.ACCESS_TOKEN = 'tok';
  try {
    const out = await defaultFetchCommentContent('cmt_1', {
      prefixFn: () => 'https://api.example/api/tenant/t/workspace/w/task/t1/comment/cmt_1/cloud',
      postFn: async () => ({
        context_pack: {
          comment_thread: [{ kind: 'human', content: 'Recovered command' }],
        },
      }),
    });
    assert.equal(out.content, 'Recovered command');
  } finally {
    if (prev === undefined) delete process.env.ACCESS_TOKEN;
    else process.env.ACCESS_TOKEN = prev;
  }
});

test('defaultFetchCommentContent falls back to comments array by id', async () => {
  const prev = process.env.ACCESS_TOKEN;
  process.env.ACCESS_TOKEN = 'tok';
  try {
    const out = await defaultFetchCommentContent('cmt_7', {
      prefixFn: () => 'https://api.example/api/tenant/t/workspace/w/task/t1/comment/cmt_1/cloud',
      postFn: async () => ({
        comments: [
          { id: 'cmt_7', content: 'Found by id' },
          { id: 'cmt_8', content: 'not me' },
        ],
      }),
    });
    assert.equal(out.content, 'Found by id');
  } finally {
    if (prev === undefined) delete process.env.ACCESS_TOKEN;
    else process.env.ACCESS_TOKEN = prev;
  }
});

test('shouldDeferAgentKickoff when clone attempted but no git (T1)', () => {
  assert.equal(shouldDeferAgentKickoff({ cloneAttempted: true, hasGit: false }), true);
});

test('shouldDeferAgentKickoff false when clone succeeded with git (T2)', () => {
  assert.equal(shouldDeferAgentKickoff({ cloneAttempted: true, hasGit: true }), false);
});

test('shouldDeferAgentKickoff false when no clone was attempted (T3)', () => {
  assert.equal(shouldDeferAgentKickoff({ cloneAttempted: false, hasGit: false }), false);
});

test('maybeRunPostBootstrapAgentKickoff skips createJob when clone failed (T1)', async () => {
  tmpState();
  let called = 0;
  const out = await maybeRunPostBootstrapAgentKickoff({
    detail: { task: { auto_run: true, title: 'T', description: 'D' } },
    layerId: 'layer_defer',
    cloneAttempted: true,
    hasGit: false,
    createJobFn: async () => {
      called += 1;
      return { id: 'should_not' };
    },
  });
  assert.equal(out.deferred, true);
  assert.equal(out.kind, null);
  assert.equal(called, 0);
});

test('maybeRunPostBootstrapAgentKickoff starts auto_run when git present (T2)', async () => {
  tmpState();
  const calls = [];
  const out = await maybeRunPostBootstrapAgentKickoff({
    detail: { task: { auto_run: true, title: 'T', description: 'D' } },
    layerId: 'layer_ok',
    cloneAttempted: true,
    hasGit: true,
    createJobFn: async (body) => {
      calls.push(body);
      return { id: 'job_ok', layer_id: 'layer_ok' };
    },
  });
  assert.equal(out.deferred, false);
  assert.equal(out.kind, 'auto_run');
  assert.equal(calls.length, 1);
});

test('resumeAgentKickoffAfterCloneReady starts auto_run after reclone (T4)', async () => {
  tmpState();
  const calls = [];
  const out = await resumeAgentKickoffAfterCloneReady({
    detail: { task: { auto_run: true, title: 'Resume', description: 'after clone' } },
    layerId: 'layer_reclone',
    reason: 'reclone',
    repoUrl: 'https://example.com/org/repo.git',
    createJobFn: async (body) => {
      calls.push(body);
      return { id: 'job_resume', layer_id: 'layer_reclone' };
    },
  });
  assert.equal(out.kind, 'auto_run');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].auto_run_first, true);
});

test('runRecloneSuccessSideEffects still kickoffs when identity sync fails (T5)', async () => {
  tmpState();
  let kickoffCalls = 0;
  await runRecloneSuccessSideEffects({
    layerId: 'layer_id_fail',
    repoUrl: 'https://example.com/a.git',
    detail: { task: { auto_run: true, title: 'X', description: 'Y' } },
    applyIdentities: async () => {
      throw new Error('identity boom');
    },
    kickoff: async () => {
      kickoffCalls += 1;
      return { kind: 'auto_run', rec: { id: 'j1' } };
    },
  });
  assert.equal(kickoffCalls, 1);
});

test('runRecloneSuccessSideEffects swallows kickoff errors (T6)', async () => {
  tmpState();
  await runRecloneSuccessSideEffects({
    layerId: 'layer_k',
    repoUrl: 'https://example.com/a.git',
    detail: {},
    applyIdentities: async () => {},
    kickoff: async () => {
      throw new Error('kickoff boom');
    },
    log: { error() {} },
  });
});

test('resumeAgentKickoffAfterCloneReady is idempotent when marker exists (T7)', async () => {
  tmpState();
  const calls = [];
  const createJobFn = async (body) => {
    calls.push(body);
    return { id: `job_${calls.length}`, layer_id: 'layer_idemp' };
  };
  const detail = { task: { auto_run: true, title: 'Once', description: 'Only' } };
  await resumeAgentKickoffAfterCloneReady({
    detail,
    layerId: 'layer_idemp',
    reason: 'reclone',
    createJobFn,
  });
  const again = await resumeAgentKickoffAfterCloneReady({
    detail,
    layerId: 'layer_idemp',
    reason: 'reclone',
    createJobFn,
  });
  assert.equal(calls.length, 1);
  assert.equal(again.kind, null);
  assert.equal(again.rec, null);
});

test('server and reclone routes wire kickoff defer/resume (T8)', () => {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const serverSrc = fs.readFileSync(path.join(here, 'server.mjs'), 'utf8');
  const recloneSrc = fs.readFileSync(path.join(here, 'routesReposClone.mjs'), 'utf8');
  assert.match(serverSrc, /maybeRunPostBootstrapAgentKickoff/);
  assert.match(serverSrc, /anyLayerHasGitRepo/);
  assert.match(recloneSrc, /runRecloneSuccessSideEffects/);
});

test('defaultFetchCommentContent returns empty when fetch fails', async () => {
  const prev = process.env.ACCESS_TOKEN;
  process.env.ACCESS_TOKEN = 'tok';
  try {
    const out = await defaultFetchCommentContent('cmt_x', {
      prefixFn: () => 'https://api.example/api/tenant/t/workspace/w/task/t1/comment/cmt_1/cloud',
      postFn: async () => {
        throw new Error('boom');
      },
    });
    assert.equal(out.content, '');
  } finally {
    if (prev === undefined) delete process.env.ACCESS_TOKEN;
    else process.env.ACCESS_TOKEN = prev;
  }
});

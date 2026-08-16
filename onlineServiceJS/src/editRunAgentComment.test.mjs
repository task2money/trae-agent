import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildContainerAgentCreateUrl,
  createEditRunAgentComment,
  ensureEditRunMountedAgentComment,
} from './editRunAgentComment.mjs';

test('buildContainerAgentCreateUrl strips /cloud suffix', () => {
  assert.equal(
    buildContainerAgentCreateUrl(() => 'https://api.example/t/w/task/x/comment/cmt/cloud'),
    'https://api.example/t/w/task/x/comment/cmt/container-agent-comments',
  );
});

test('createEditRunAgentComment posts with X-Access-Token', async () => {
  const calls = [];
  const result = await createEditRunAgentComment({
    parentCommentId: 'p1',
    installedImageId: 'img1',
    accessToken: 'tok',
    prefixFn: () => 'https://api.example/t/w/task/x/comment/cmt/cloud',
    fetchFn: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 201,
        text: async () => JSON.stringify({ id: 'agent-9' }),
      };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.id, 'agent-9');
  assert.equal(calls[0].url, 'https://api.example/t/w/task/x/comment/cmt/container-agent-comments');
  assert.equal(calls[0].init.headers['X-Access-Token'], 'tok');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.parent_comment_id, 'p1');
  assert.equal(body.installed_image_id, 'img1');
  assert.equal(body.context_pack.at_mention_run.source, 'edit_run');
});

test('createEditRunAgentComment body 带 COMMENT_ID', async () => {
  const prev = process.env.COMMENT_ID;
  process.env.COMMENT_ID = 'cmt-a';
  try {
    const calls = [];
    await createEditRunAgentComment({
      parentCommentId: 'p1',
      installedImageId: 'img1',
      accessToken: 'tok',
      prefixFn: () => 'https://api.example/t/w/task/x/comment/cmt/cloud',
      fetchFn: async (url, init) => {
        calls.push(init);
        return {
          ok: true,
          status: 201,
          text: async () => JSON.stringify({ id: 'agent-9' }),
        };
      },
    });
    assert.equal(JSON.parse(calls[0].body).comment_id, 'cmt-a');
  } finally {
    if (prev === undefined) delete process.env.COMMENT_ID;
    else process.env.COMMENT_ID = prev;
  }
});

test('ensureEditRunMountedAgentComment reuses existing mount', async () => {
  const rec = { edit_run_delivery: true, mounted_agent_comment_id: 'a1' };
  const out = await ensureEditRunMountedAgentComment(rec, {
    createFn: async () => {
      throw new Error('should not create');
    },
  });
  assert.equal(out.ok, true);
  assert.equal(out.reused, true);
  assert.equal(out.id, 'a1');
});

test('ensureEditRunMountedAgentComment creates and persists', async () => {
  const rec = {
    edit_run_delivery: true,
    mounted_parent_comment_id: 'p1',
    edit_run_installed_image_id: 'img1',
    command: 'fix it',
  };
  let persisted = '';
  const out = await ensureEditRunMountedAgentComment(rec, {
    createFn: async () => ({ ok: true, id: 'agent-new' }),
    persistMount: (id) => {
      persisted = id;
    },
  });
  assert.equal(out.ok, true);
  assert.equal(out.id, 'agent-new');
  assert.equal(rec.mounted_agent_comment_id, 'agent-new');
  assert.equal(persisted, 'agent-new');
});

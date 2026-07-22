// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('runLayerGithubOauthAccessPush: localhost GitLab + oauth_auth_by_repo 应尝试推送', async () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-push-gitlab-local-'));
  process.env.ONLINE_PROJECT_STATE_ROOT = stateRoot;
  const layerId = 'oauth-push-gitlab-local-layer';
  const layerDir = path.join(stateRoot, 'layers', layerId);
  const repoDir = path.join(layerDir, 'somanyad');
  fs.mkdirSync(repoDir, { recursive: true });
  fs.writeFileSync(
    path.join(layerDir, 'layer_meta.json'),
    JSON.stringify({ layer_id: layerId, kind: 'workspace' }),
  );
  assert.equal(spawnSync('git', ['init'], { cwd: repoDir, encoding: 'utf8' }).status, 0);
  assert.equal(
    spawnSync('git', ['remote', 'add', 'origin', 'http://localhost:8012/ljy/somanyad.git'], {
      cwd: repoDir,
      encoding: 'utf8',
    }).status,
    0,
  );
  assert.equal(
    spawnSync('git', ['config', 'user.email', 'e2e@test'], { cwd: repoDir, encoding: 'utf8' }).status,
    0,
  );
  assert.equal(
    spawnSync('git', ['config', 'user.name', 'e2e'], { cwd: repoDir, encoding: 'utf8' }).status,
    0,
  );
  fs.writeFileSync(path.join(repoDir, 'hello.js'), "console.log('hello world')\n");
  assert.equal(spawnSync('git', ['add', 'hello.js'], { cwd: repoDir, encoding: 'utf8' }).status, 0);
  assert.equal(
    spawnSync('git', ['commit', '-m', 'e2e push'], { cwd: repoDir, encoding: 'utf8' }).status,
    0,
  );

  const { runLayerGithubOauthAccessPush } = await import('./layerGitOauthPush.mjs');
  const { httpStatus, payload } = await runLayerGithubOauthAccessPush({
    layerId,
    targetBranch: 'feature/e2e-local-gitlab',
    oauthAuthByRepo: {
      'http://localhost:8012/ljy/somanyad': {
        provider: 'gitlab',
        access_token: 'glpat-test-token-not-real',
      },
    },
  });

  const repos = payload?.github_oauth_multirepo?.repos;
  assert.ok(Array.isArray(repos) && repos.length === 1, '应处理 1 个 git 根目录');
  const row = repos[0];
  assert.equal(row.provider, 'gitlab');
  assert.equal(row.github_slug, 'ljy/somanyad');
  assert.notEqual(row.detail, 'remote 无法识别且 oauth_auth_by_repo 无匹配项，已跳过 OAuth 推送');
  assert.match(
    String(row.detail || ''),
    /push|auth|401|403|could not|rejected|timeout|超时|fatal|Repository/i,
    '应执行 git push（成功或远端拒绝），而非跳过',
  );

  fs.rmSync(stateRoot, { recursive: true, force: true });
});

test('runLayerGithubOauthAccessPush: 多仓部分成功（一仓 push_ok、一仓 skip）不得整体 200', async () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-push-multi-'));
  process.env.ONLINE_PROJECT_STATE_ROOT = stateRoot;
  const layerId = 'oauth-push-multi-layer';
  const layerDir = path.join(stateRoot, 'layers', layerId);
  const repoA = path.join(layerDir, 'repo-a');
  const repoB = path.join(layerDir, 'repo-b');
  fs.mkdirSync(repoA, { recursive: true });
  fs.mkdirSync(repoB, { recursive: true });
  fs.writeFileSync(
    path.join(layerDir, 'layer_meta.json'),
    JSON.stringify({ layer_id: layerId, kind: 'workspace' }),
  );

  function initRepo(dir, remoteUrl, fileName) {
    assert.equal(spawnSync('git', ['init'], { cwd: dir, encoding: 'utf8' }).status, 0);
    assert.equal(
      spawnSync('git', ['remote', 'add', 'origin', remoteUrl], { cwd: dir, encoding: 'utf8' }).status,
      0,
    );
    assert.equal(
      spawnSync('git', ['config', 'user.email', 'e2e@test'], { cwd: dir, encoding: 'utf8' }).status,
      0,
    );
    assert.equal(
      spawnSync('git', ['config', 'user.name', 'e2e'], { cwd: dir, encoding: 'utf8' }).status,
      0,
    );
    fs.writeFileSync(path.join(dir, fileName), `${fileName}\n`);
    assert.equal(spawnSync('git', ['add', fileName], { cwd: dir, encoding: 'utf8' }).status, 0);
    assert.equal(
      spawnSync('git', ['commit', '-m', `commit ${fileName}`], { cwd: dir, encoding: 'utf8' }).status,
      0,
    );
  }

  // A：可匹配 github token；B：无法识别的 host → skip（continue），模拟「推了一个仍有仓未推」
  initRepo(repoA, 'https://github.com/acme/repo-a.git', 'a.js');
  initRepo(repoB, 'https://git.example.com/org/repo-b.git', 'b.js');

  const { runLayerGithubOauthAccessPush } = await import(`./layerGitOauthPush.mjs?multi=${Date.now()}`);
  const { httpStatus, payload } = await runLayerGithubOauthAccessPush({
    layerId,
    targetBranch: 'feature/multi',
    accessTokenByRepoSlug: { 'acme/repo-a': 'gho_test_token_not_real' },
    gitExecAsync: async () => {},
  });

  assert.equal(httpStatus, 400, '部分仓未推成功应 400');
  assert.equal(payload?.ok, false);
  const repos = payload?.github_oauth_multirepo?.repos || [];
  assert.equal(repos.length, 2, `应处理 2 个需推送仓，got ${repos.length}`);
  assert.equal(repos.filter((r) => r.push_ok).length, 1);
  assert.equal(repos.filter((r) => !r.push_ok).length, 1);
  assert.match(String(payload?.detail || ''), /部分仓库推送未成功/);
  assert.match(String(payload?.detail || ''), /成功：/);
  assert.match(String(payload?.detail || ''), /失败：/);

  fs.rmSync(stateRoot, { recursive: true, force: true });
});

test('runLayerGithubOauthAccessPush: 一仓失败后继续推其它仓并在 detail 列出成败', async () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-push-cont-'));
  process.env.ONLINE_PROJECT_STATE_ROOT = stateRoot;
  const layerId = 'oauth-push-cont-layer';
  const layerDir = path.join(stateRoot, 'layers', layerId);
  const parentDir = path.join(layerDir, 'parent');
  const childDir = path.join(parentDir, 'child');
  fs.mkdirSync(childDir, { recursive: true });
  fs.writeFileSync(
    path.join(layerDir, 'layer_meta.json'),
    JSON.stringify({ layer_id: layerId, kind: 'workspace' }),
  );

  function initRepo(dir, remoteUrl, fileName) {
    assert.equal(spawnSync('git', ['init'], { cwd: dir, encoding: 'utf8' }).status, 0);
    assert.equal(
      spawnSync('git', ['remote', 'add', 'origin', remoteUrl], { cwd: dir, encoding: 'utf8' }).status,
      0,
    );
    assert.equal(
      spawnSync('git', ['config', 'user.email', 'e2e@test'], { cwd: dir, encoding: 'utf8' }).status,
      0,
    );
    assert.equal(
      spawnSync('git', ['config', 'user.name', 'e2e'], { cwd: dir, encoding: 'utf8' }).status,
      0,
    );
    fs.writeFileSync(path.join(dir, fileName), `${fileName}\n`);
    assert.equal(spawnSync('git', ['add', fileName], { cwd: dir, encoding: 'utf8' }).status, 0);
    assert.equal(
      spawnSync('git', ['commit', '-m', `commit ${fileName}`], { cwd: dir, encoding: 'utf8' }).status,
      0,
    );
  }

  initRepo(parentDir, 'https://github.com/acme/parent.git', 'p.js');
  initRepo(childDir, 'https://github.com/acme/child.git', 'c.js');

  const { runLayerGithubOauthAccessPush } = await import(`./layerGitOauthPush.mjs?cont=${Date.now()}`);
  let pushCalls = 0;
  const { httpStatus, payload } = await runLayerGithubOauthAccessPush({
    layerId,
    targetBranch: 'feature/nested',
    accessTokenByRepoSlug: {
      'acme/parent': 'tok-parent',
      'acme/child': 'tok-child',
    },
    gitExecAsync: async (_args, cwd) => {
      pushCalls += 1;
      if (String(cwd).includes(`${path.sep}child`)) {
        throw new Error('simulated child push denied');
      }
    },
  });

  assert.equal(httpStatus, 400);
  assert.ok(pushCalls >= 2, `应尝试推父+子仓，got ${pushCalls}`);
  const detail = String(payload?.detail || '');
  assert.match(detail, /成功：acme\/parent/);
  assert.match(detail, /失败：acme\/child/);
  assert.match(detail, /路径 parent\/child|路径.*child/);
  assert.match(detail, /simulated child push denied/);

  fs.rmSync(stateRoot, { recursive: true, force: true });
});

test('formatOauthMultiRepoPushDetail: 父仓子仓标签一致', async () => {
  const { formatOauthMultiRepoPushDetail } = await import('./layerGitOauthPushDetail.mjs');
  const text = formatOauthMultiRepoPushDetail([
    { github_slug: 'acme/parent', rel_prefix: 'parent', push_ok: true },
    { github_slug: 'acme/child', rel_prefix: 'parent/child', push_ok: false, detail: 'x' },
  ]);
  assert.match(text, /成功：acme\/parent（路径 parent）/);
  assert.match(text, /失败：acme\/child（路径 parent\/child）/);
});

test('createGitlabMergeRequest: 将 web_url 映射为可用审查链接', async () => {
  const { createGitlabMergeRequest } = await import('./layerGitOauthPush.mjs');
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        web_url: 'https://gitlab.daydaymoney.com/ljy/somanyad/-/merge_requests/11',
        iid: 11,
        state: 'opened',
      }),
      { status: 201, headers: { 'Content-Type': 'application/json' } },
    );
  try {
    const res = await createGitlabMergeRequest({
      originUrl: 'https://gitlab.daydaymoney.com/ljy/somanyad.git',
      owner: 'ljy',
      repo: 'somanyad',
      head: 'feature/x',
      base: 'master',
      accessToken: 'glpat-x',
      title: 'MR test',
    });
    assert.equal(res.ok, true);
    assert.equal(res.json.web_url, 'https://gitlab.daydaymoney.com/ljy/somanyad/-/merge_requests/11');
  } finally {
    globalThis.fetch = origFetch;
  }
});

// @ts-check
import assert from 'node:assert/strict';
import test from 'node:test';
import { createGithubPullRequest } from './layerGitOauthPushPr.mjs';

test('createGithubPullRequest reuses existing PR on 422', async () => {
  const originalFetch = globalThis.fetch;
  let postCalls = 0;
  let getCalls = 0;
  globalThis.fetch = async (url, init) => {
    const method = String(init?.method || 'GET').toUpperCase();
    if (method === 'POST') {
      postCalls += 1;
      return {
        status: 422,
        text: async () => JSON.stringify({ message: 'Validation Failed' }),
        headers: new Headers(),
      };
    }
    getCalls += 1;
    assert.match(String(url), /\/pulls\?/);
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify([
          {
            html_url: 'https://github.com/acme/demo/pull/3',
            number: 3,
            state: 'open',
          },
        ]),
      headers: new Headers(),
    };
  };
  try {
    const res = await createGithubPullRequest({
      owner: 'acme',
      repo: 'demo',
      head: 'feat/x',
      base: 'main',
      accessToken: 'ghu_test',
      title: 't',
      bodyText: 'b',
    });
    assert.equal(res.ok, true);
    assert.equal(res.reused, true);
    assert.equal(res.json?.html_url, 'https://github.com/acme/demo/pull/3');
    assert.equal(postCalls, 1);
    assert.equal(getCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

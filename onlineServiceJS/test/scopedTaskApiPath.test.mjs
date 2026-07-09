import assert from 'node:assert/strict';
import test from 'node:test';

import {
  rewriteScopedTaskApiPath,
  createScopedTaskApiRewriteMiddleware,
} from '../src/scopedTaskApiPath.mjs';

test('rewriteScopedTaskApiPath strips tenant/workspace/task for routing', () => {
  assert.equal(
    rewriteScopedTaskApiPath(
      '/api/tenant/t1/workspace/w1/task/task1/layers/L1/files',
    ),
    '/api/layers/L1/files',
  );
  assert.equal(
    rewriteScopedTaskApiPath('/api/tenant/t1/workspace/w1/task/task1/jobs'),
    '/api/jobs',
  );
  assert.equal(
    rewriteScopedTaskApiPath(
      '/api/tenant/t1/workspace/w1/task/task1/repos/bootstrap-clone-log',
    ),
    '/api/repos/bootstrap-clone-log',
  );
});

test('rewriteScopedTaskApiPath leaves bare /api paths unchanged', () => {
  assert.equal(rewriteScopedTaskApiPath('/api/layers'), '/api/layers');
  assert.equal(rewriteScopedTaskApiPath('/api/jobs/j1/steps'), '/api/jobs/j1/steps');
});

test('middleware rewrites req.url but keeps originalUrl', () => {
  const mw = createScopedTaskApiRewriteMiddleware();
  const req = {
    originalUrl:
      '/api/tenant/t1/workspace/w1/task/task1/layers/L1/files?max_files=3000',
    url: '/api/tenant/t1/workspace/w1/task/task1/layers/L1/files?max_files=3000',
  };
  let nextCalled = false;
  mw(req, {}, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
  assert.equal(req.url, '/api/layers/L1/files?max_files=3000');
  assert.match(req.originalUrl, /\/tenant\/t1\/workspace\/w1\/task\/task1\//);
});

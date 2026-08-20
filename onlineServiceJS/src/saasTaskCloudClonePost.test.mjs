import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import {
  postCloneProgress,
  resetCloneProgressSendChainForTests,
} from './saasTaskCloudClonePost.mjs';

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

test('same-repo in-flight 9% cannot overtake later 100% POST', async () => {
  resetCloneProgressSendChainForTests();
  const order = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const delay = Number(body.progress) === 9 ? 80 : 0;
      setTimeout(() => {
        order.push(Number(body.progress));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      }, delay);
    });
  });
  const port = await listen(server);
  const prefix = `http://127.0.0.1:${port}`;
  const repo = 'https://git.example/ram-work.git';
  try {
    const slowNine = postCloneProgress(prefix, 'tok', 9, '【项目克隆】(1/1) ram-work … 9%', repo);
    const done = postCloneProgress(prefix, 'tok', 100, '项目克隆 (1/1) 完成 ram-work', repo);
    await Promise.all([slowNine, done]);
    assert.deepEqual(order, [9, 100]);
  } finally {
    await closeServer(server);
  }
});

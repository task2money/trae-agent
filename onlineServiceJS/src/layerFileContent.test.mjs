import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  formatByteSize,
  isBinaryBuffer,
  readLayerFileContentPayload,
} from './layerFileContent.mjs';

test('T1: buffer 含 NUL → isBinaryBuffer true', () => {
  assert.equal(isBinaryBuffer(Buffer.from([0x6a, 0x49, 0x4d, 0x47, 0x00, 0x01])), true);
});

test('T2: 纯 UTF-8 文本 → isBinaryBuffer false', () => {
  assert.equal(isBinaryBuffer(Buffer.from('hello 中文\n', 'utf8')), false);
});

test('T3: 二进制文件 payload 无 content、有 size_bytes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'layer-file-bin-'));
  const fp = path.join(dir, 'modules');
  fs.writeFileSync(fp, Buffer.from([0x6a, 0x49, 0x4d, 0x47, 0x00, 0x01, 0x02]));
  try {
    const out = readLayerFileContentPayload(fp, 'ram-work/jre/lib/modules');
    assert.equal(out.ok, true);
    assert.equal(out.body.kind, 'binary');
    assert.equal(out.body.content, undefined);
    assert.equal(out.body.size_bytes, 7);
    assert.equal(out.body.basename, 'modules');
    assert.ok(out.body.size_human);
    assert.ok(out.body.mtime_iso);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('T4: 文本文件 payload 有 content', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'layer-file-txt-'));
  const fp = path.join(dir, 'README.md');
  fs.writeFileSync(fp, '# hi\n', 'utf8');
  try {
    const out = readLayerFileContentPayload(fp, 'ram-work/README.md');
    assert.equal(out.ok, true);
    assert.equal(out.body.kind, 'text');
    assert.equal(out.body.content, '# hi\n');
    assert.equal(out.body.truncated, false);
    assert.equal(out.body.size_bytes, Buffer.byteLength('# hi\n', 'utf8'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('formatByteSize 基本档位', () => {
  assert.equal(formatByteSize(500), '500 B');
  assert.match(formatByteSize(2048), /KB/);
});

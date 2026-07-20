/**
 * GET /api/layers/:id/files/* 的读取与二进制判定。
 * 二进制：返回属性、不返回 content；文本：返回 utf8 content。
 */
import fs from 'fs';
import path from 'path';

/** 扫描前若干字节是否含 NUL，作为二进制启发式 */
const BINARY_PROBE_BYTES = 8192;

/**
 * @param {Buffer} buf
 * @returns {boolean}
 */
export function isBinaryBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return false;
  const n = Math.min(buf.length, BINARY_PROBE_BYTES);
  for (let i = 0; i < n; i += 1) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/**
 * @param {number} bytes
 * @returns {string}
 */
export function formatByteSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * @param {string} absPath
 * @param {string} relPath
 * @param {{ maxBytes?: number }} [opts]
 * @returns {{ ok: true, body: object } | { ok: false, status: number, body: object }}
 */
export function readLayerFileContentPayload(absPath, relPath, opts = {}) {
  const fp = String(absPath || '');
  const rel = String(relPath || '');
  if (!fp || !fs.existsSync(fp)) {
    return { ok: false, status: 404, body: { detail: 'not found' } };
  }
  let st;
  try {
    st = fs.statSync(fp);
  } catch {
    return { ok: false, status: 404, body: { detail: 'not found' } };
  }
  if (!st.isFile()) {
    return { ok: false, status: 404, body: { detail: 'not found' } };
  }

  const max = Math.min(
    Math.max(1, parseInt(String(opts.maxBytes ?? 2_000_000), 10) || 2_000_000),
    20_000_000,
  );
  const sizeBytes = st.size;
  const mtimeMs = st.mtimeMs;
  const basename = path.posix.basename(rel.replace(/\\/g, '/')) || path.basename(fp);
  const ext = path.extname(basename).replace(/^\./, '').toLowerCase();
  const baseProps = {
    path: rel,
    size_bytes: sizeBytes,
    size_human: formatByteSize(sizeBytes),
    mtime_ms: mtimeMs,
    mtime_iso: new Date(mtimeMs).toISOString(),
    basename,
    ext,
  };

  const fd = fs.openSync(fp, 'r');
  try {
    const probeLen = Math.min(sizeBytes, BINARY_PROBE_BYTES, max);
    const probe = Buffer.alloc(probeLen);
    const readProbe = fs.readSync(fd, probe, 0, probeLen, 0);
    const probeBuf = probe.subarray(0, readProbe);
    if (isBinaryBuffer(probeBuf)) {
      return {
        ok: true,
        body: {
          ...baseProps,
          kind: 'binary',
        },
      };
    }

    const readLen = Math.min(sizeBytes, max);
    const buf = Buffer.alloc(readLen);
    const n = fs.readSync(fd, buf, 0, readLen, 0);
    const slice = buf.subarray(0, n);
    // 二次确认：全文前 max 内若出现 NUL 也按二进制
    if (isBinaryBuffer(slice)) {
      return {
        ok: true,
        body: {
          ...baseProps,
          kind: 'binary',
        },
      };
    }
    return {
      ok: true,
      body: {
        ...baseProps,
        kind: 'text',
        content: slice.toString('utf8'),
        truncated: sizeBytes > max,
      },
    };
  } finally {
    fs.closeSync(fd);
  }
}

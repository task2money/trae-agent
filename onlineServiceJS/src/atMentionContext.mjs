/**
 * ContextPack helpers for container-image @ mention runs.
 * Full orchestration (start-vm + auto job) lands in follow-up; this module
 * validates / normalizes the payload shape injected into task-detail.
 */

const CONTEXT_PACK_MAX_BYTES = 256 * 1024

/**
 * @param {object} pack
 * @returns {{ ok: boolean, truncated: boolean, pack: object, error?: string }}
 */
export function normalizeAtMentionContextPack(pack) {
  if (!pack || typeof pack !== 'object') {
    return { ok: false, truncated: false, pack: null, error: 'pack required' }
  }
  const run = pack.at_mention_run
  if (!run || typeof run !== 'object') {
    return { ok: false, truncated: false, pack: null, error: 'at_mention_run required' }
  }
  if (!run.run_id || !run.parent_comment_id || !run.agent_comment_id) {
    return { ok: false, truncated: false, pack: null, error: 'run ids required' }
  }
  let thread = Array.isArray(pack.comment_thread) ? [...pack.comment_thread] : []
  let truncated = false
  let out = {
    at_mention_run: run,
    task: pack.task && typeof pack.task === 'object' ? pack.task : {},
    comment_thread: thread,
    truncated: false,
  }
  let raw = JSON.stringify(out)
  while (Buffer.byteLength(raw, 'utf8') > CONTEXT_PACK_MAX_BYTES && thread.length > 1) {
    truncated = true
    thread = thread.slice(1)
    out = { ...out, comment_thread: thread, truncated: true }
    raw = JSON.stringify(out)
  }
  if (Buffer.byteLength(raw, 'utf8') > CONTEXT_PACK_MAX_BYTES) {
    return { ok: false, truncated: true, pack: out, error: 'context pack exceeds limit after truncate' }
  }
  return { ok: true, truncated, pack: out }
}

export { CONTEXT_PACK_MAX_BYTES }

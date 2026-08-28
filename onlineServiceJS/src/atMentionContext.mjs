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
  const parentId = String(run.parent_comment_id || '').trim()
  const agentId = String(run.agent_comment_id || '').trim()
  const installed = (run.installed_image && typeof run.installed_image === 'object')
    ? run.installed_image
    : (pack.installed_image && typeof pack.installed_image === 'object' ? pack.installed_image : null)
  const imageId = String(installed?.id || installed?.image_id || run.installed_image_id || '').trim()
  // OPT-20260823-008: container POST-creates the agent comment; pack may omit agent_comment_id.
  if (!parentId) {
    return { ok: false, truncated: false, pack: null, error: 'parent_comment_id required' }
  }
  if (!agentId && !imageId) {
    return { ok: false, truncated: false, pack: null, error: 'agent_comment_id or installed_image required' }
  }
  const normalizedRun = {
    ...run,
    parent_comment_id: parentId,
    run_id: String(run.run_id || agentId || parentId).trim(),
  }
  if (agentId) normalizedRun.agent_comment_id = agentId
  if (installed && imageId) {
    normalizedRun.installed_image = { ...installed, id: imageId }
  }
  let thread = Array.isArray(pack.comment_thread) ? [...pack.comment_thread] : []
  let truncated = false
  let out = {
    at_mention_run: normalizedRun,
    task: pack.task && typeof pack.task === 'object' ? pack.task : {},
    comment_thread: thread,
    truncated: false,
  }
  if (normalizedRun.installed_image) {
    out.installed_image = normalizedRun.installed_image
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

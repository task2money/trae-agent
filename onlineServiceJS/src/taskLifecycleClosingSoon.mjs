/**
 * 排队窗口结束前预告：记录状态供容器侧感知，不中断任务、不释放机器。
 */

let lastClosingSoon = null;

/** @returns {null | { at: string, body: object }} */
export function getLastClosingSoon() {
  return lastClosingSoon;
}

/** 测试用重置 */
export function resetClosingSoonStateForTests() {
  lastClosingSoon = null;
}

/**
 * @param {object} [body]
 * @returns {{ ok: true, accepted: true, minutes_remaining?: number, reason?: string }}
 */
export function recordClosingSoon(body = {}) {
  const minutes = Number(body?.minutes_remaining);
  const reason = String(body?.reason || 'schedule_window_ending').trim();
  lastClosingSoon = {
    at: new Date().toISOString(),
    body: { ...body, reason },
  };
  console.log(
    `[taskLifecycle] closing-soon reason=${reason} minutes_remaining=${Number.isFinite(minutes) ? minutes : ''}`,
  );
  return {
    ok: true,
    accepted: true,
    reason,
    minutes_remaining: Number.isFinite(minutes) ? minutes : undefined,
  };
}

/**
 * 指令闲置倒计时：交付成功后 N 分钟无新指令则 request-machine-release。
 * 周期心跳不得带 instruction_idle（缺键 = 服务端不改列）。
 */

let idleTimer = null;
let idleMinutes = 0;
let lastSts = null;

export function resetInstructionIdleStateForTests() {
  cancelInstructionIdleTimer();
  idleMinutes = 0;
  lastSts = null;
}

export function applyIdlePolicyFromTaskDetail(detail) {
  const n = Number(detail?.idle_recycle_minutes);
  idleMinutes = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  if (detail && Object.prototype.hasOwnProperty.call(detail, 'machine_release_sts') && detail.machine_release_sts) {
    lastSts = detail.machine_release_sts;
  } else {
    lastSts = null;
  }
}

export function currentIdleMinutes() {
  return idleMinutes;
}

export function cancelInstructionIdleTimer() {
  if (idleTimer != null) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

/**
 * 新指令：取消倒计时 + 中断全部 running/pending job（不含即将创建的新 job）。
 * @returns {string[]} interrupted job ids
 */
export function preemptForNewInstruction({ jobs, interruptFn, heartbeatFn } = {}) {
  cancelInstructionIdleTimer();
  const interrupted = [];
  const map = jobs instanceof Map ? jobs : new Map();
  for (const [id, rec] of map) {
    const status = String(rec?.status || '');
    if (status !== 'running' && status !== 'pending') continue;
    try {
      if (typeof interruptFn === 'function') interruptFn(id);
      interrupted.push(String(id));
    } catch (e) {
      console.error(`[instructionIdle] interrupt failed id=${id}: ${e?.message || e}`);
    }
  }
  if (typeof heartbeatFn === 'function') {
    try {
      const ret = heartbeatFn(false);
      if (ret && typeof ret.catch === 'function') {
        void ret.catch((e) => {
          console.error(`[instructionIdle] clear heartbeat failed: ${e?.message || e}`);
        });
      }
    } catch (e) {
      console.error(`[instructionIdle] clear heartbeat failed: ${e?.message || e}`);
    }
  }
  return interrupted;
}

export function startInstructionIdleCountdown(opts = {}) {
  cancelInstructionIdleTimer();
  if (idleMinutes <= 0) return false;
  const delayMs = Number.isFinite(opts.delayMs) ? opts.delayMs : idleMinutes * 60 * 1000;
  const setTimeoutFn = opts.setTimeoutFn || setTimeout;
  idleTimer = setTimeoutFn(() => {
    idleTimer = null;
    void fireInstructionIdleTimeout(opts);
  }, delayMs);
  return true;
}

export async function fireInstructionIdleTimeout(opts = {}) {
  const releaseFn = opts.releaseFn;
  const deleteInstanceFn = opts.deleteInstanceFn;
  let released = false;
  if (typeof releaseFn === 'function') {
    try {
      released = Boolean(await releaseFn({ reason: 'instruction_idle', terminal_kind: 'cancelled' }));
    } catch (e) {
      console.error(`[instructionIdle] L1 release failed: ${e?.message || e}`);
      released = false;
    }
  }
  if (!released && lastSts && typeof deleteInstanceFn === 'function') {
    try {
      await deleteInstanceFn(lastSts);
    } catch (e) {
      console.error(`[instructionIdle] L3 STS delete failed: ${e?.message || e}`);
    }
  }
  return released;
}

export function maybeStartIdleAfterJob({ idleEligible, heartbeatFn, releaseFn, deleteInstanceFn, setTimeoutFn, delayMs } = {}) {
  if (!idleEligible) return false;
  const started = startInstructionIdleCountdown({ releaseFn, deleteInstanceFn, setTimeoutFn, delayMs });
  if (started && typeof heartbeatFn === 'function') {
    try {
      const ret = heartbeatFn(true);
      if (ret && typeof ret.catch === 'function') {
        void ret.catch((e) => {
          console.error(`[instructionIdle] mark heartbeat failed: ${e?.message || e}`);
        });
      }
    } catch (e) {
      console.error(`[instructionIdle] mark heartbeat failed: ${e?.message || e}`);
    }
  }
  return started;
}

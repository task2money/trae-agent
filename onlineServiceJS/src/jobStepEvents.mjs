/**
 * Detect newly finalized agent steps from trajectory / tae_agent_json and
 * produce job-event payloads (phase=step) so SaaS job-stream can push one SSE
 * per step instead of dumping all steps only when the job finishes.
 */
import fs from 'fs';
import path from 'path';

const STEP_DIR_RE = /^step_(\d+)$/;

function safeReadJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * @param {string} trajPath
 * @returns {Array<{ step_number: number, delivery_summary?: string, state?: string }>}
 */
export function listAgentStepsFromTrajectoryFile(trajPath) {
  const p = String(trajPath || '').trim();
  if (!p || !fs.existsSync(p)) return [];
  const raw = safeReadJson(p);
  if (!raw || typeof raw !== 'object') return [];
  const steps = Array.isArray(raw.agent_steps) ? raw.agent_steps : [];
  return steps
    .filter((s) => s && typeof s === 'object')
    .map((s, idx) => ({
      step_number: s.step_number != null ? Number(s.step_number) : idx + 1,
      delivery_summary: s.delivery_summary != null ? String(s.delivery_summary) : '',
      state: s.state != null ? String(s.state) : '',
    }));
}

/**
 * @param {string} taeRoot  runtime/job_logs/trae_agent_json/{jobId}
 * @returns {Array<{ step_number: number, delivery_summary?: string, state?: string }>}
 */
export function listAgentStepsFromTaeJsonDir(taeRoot) {
  const root = String(taeRoot || '').trim();
  if (!root || !fs.existsSync(root)) return [];
  const dirs = [];
  for (const name of fs.readdirSync(root)) {
    const m = name.match(STEP_DIR_RE);
    if (!m) continue;
    dirs.push({ num: parseInt(m[1], 10), dir: path.join(root, name) });
  }
  dirs.sort((a, b) => a.num - b.num);
  const out = [];
  for (const { num, dir } of dirs) {
    let fullPath = path.join(dir, 'agent_step_full.json');
    if (!fs.existsSync(fullPath)) fullPath = path.join(dir, 'agent_step.json');
    if (!fs.existsSync(fullPath)) continue;
    const doc = safeReadJson(fullPath);
    if (!doc || typeof doc !== 'object') continue;
    out.push({
      step_number: doc.step_number != null ? Number(doc.step_number) : num,
      delivery_summary: doc.delivery_summary != null ? String(doc.delivery_summary) : '',
      state: doc.state != null ? String(doc.state) : '',
    });
  }
  return out;
}

/**
 * @param {string} taeRoot
 * @returns {object[]} full agent_step_full.json documents (or agent_step.json fallback)
 */
export function listAgentStepFullDocsFromTaeJsonDir(taeRoot) {
  const root = String(taeRoot || '').trim();
  if (!root || !fs.existsSync(root)) return [];
  const dirs = [];
  for (const name of fs.readdirSync(root)) {
    const m = name.match(STEP_DIR_RE);
    if (!m) continue;
    dirs.push({ num: parseInt(m[1], 10), dir: path.join(root, name) });
  }
  dirs.sort((a, b) => a.num - b.num);
  const out = [];
  for (const { num, dir } of dirs) {
    let fullPath = path.join(dir, 'agent_step_full.json');
    if (!fs.existsSync(fullPath)) fullPath = path.join(dir, 'agent_step.json');
    if (!fs.existsSync(fullPath)) continue;
    const doc = safeReadJson(fullPath);
    if (!doc || typeof doc !== 'object') continue;
    if (doc.step_number == null) doc.step_number = num;
    out.push(doc);
  }
  return out;
}

/**
 * Merge trajectory + tae_json steps; prefer higher step_number coverage.
 * @param {string} trajPath
 * @param {string} taeRoot
 */
export function listVisibleAgentSteps(trajPath, taeRoot) {
  const fromTraj = listAgentStepsFromTrajectoryFile(trajPath);
  const fromTae = listAgentStepsFromTaeJsonDir(taeRoot);
  if (!fromTraj.length) return fromTae;
  if (!fromTae.length) return fromTraj;
  const byNum = new Map();
  for (const s of fromTraj) byNum.set(s.step_number, s);
  for (const s of fromTae) {
    const prev = byNum.get(s.step_number);
    if (!prev || (s.delivery_summary && !prev.delivery_summary)) {
      byNum.set(s.step_number, s);
    }
  }
  return [...byNum.values()].sort((a, b) => a.step_number - b.step_number);
}

/**
 * @param {{ step_number: number, delivery_summary?: string, state?: string }} step
 * @returns {string}
 */
export function formatStepJobEventMessage(step) {
  const n = step?.step_number != null ? Number(step.step_number) : NaN;
  const summary = String(step?.delivery_summary || '').trim();
  const state = String(step?.state || '').trim();
  const head = Number.isFinite(n) ? `step ${n}` : 'step';
  if (summary) return `${head}: ${summary}`;
  if (state) return `${head}: ${state}`;
  return head;
}

/**
 * Diff against previously seen step numbers; return only new ones.
 * @param {Array<{ step_number: number }>} steps
 * @param {Set<number>} seenStepNumbers  mutated when new steps are returned
 */
export function takeNewAgentSteps(steps, seenStepNumbers) {
  const seen = seenStepNumbers instanceof Set ? seenStepNumbers : new Set();
  const neu = [];
  for (const s of steps || []) {
    const n = Number(s?.step_number);
    if (!Number.isFinite(n) || seen.has(n)) continue;
    seen.add(n);
    neu.push(s);
  }
  return neu;
}

/**
 * Poll trajectory / tae_json and invoke onNewStep for each newly appeared step.
 * @param {{
 *   trajPath?: string,
 *   taeRoot?: string,
 *   intervalMs?: number,
 *   onNewStep: (step: object, message: string) => void,
 * }} opts
 * @returns {() => void} stop
 */
export function startAgentStepPoller(opts) {
  const onNewStep = opts?.onNewStep;
  if (typeof onNewStep !== 'function') {
    return () => {};
  }
  const trajPath = opts.trajPath || '';
  const taeRoot = opts.taeRoot || '';
  const intervalMs = Math.max(200, Number(opts.intervalMs) || 750);
  const seen = new Set();
  const tick = () => {
    try {
      const steps = listVisibleAgentSteps(trajPath, taeRoot);
      const neu = takeNewAgentSteps(steps, seen);
      for (const s of neu) {
        onNewStep(s, formatStepJobEventMessage(s));
      }
    } catch {
      /* ignore poll errors; next tick retries */
    }
  };
  tick();
  const id = setInterval(tick, intervalMs);
  return () => clearInterval(id);
}

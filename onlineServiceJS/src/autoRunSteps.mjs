/**
 * Serve /app/autoRunStep.md (or AUTO_RUN_STEPS_MD_PATH) for task UI.
 */
import fs from 'fs';
import path from 'path';

export const DEFAULT_AUTO_RUN_STEPS_PATH = '/app/autoRunStep.md';

export function resolveAutoRunStepsPath(env = process.env) {
  const custom = String(env.AUTO_RUN_STEPS_MD_PATH || '').trim();
  return custom || DEFAULT_AUTO_RUN_STEPS_PATH;
}

/**
 * @param {string} [filePath]
 * @returns {{ ok: true, markdown: string, path: string, source: string } | { ok: false, detail: string, path: string }}
 */
export function readAutoRunStepsMarkdown(filePath) {
  const p = String(filePath || resolveAutoRunStepsPath()).trim();
  if (!p) {
    return { ok: false, detail: 'autoRunStep path empty', path: p };
  }
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    return { ok: false, detail: 'autoRunStep.md not found', path: p };
  }
  if (!st.isFile()) {
    return { ok: false, detail: 'autoRunStep.md not found', path: p };
  }
  const markdown = fs.readFileSync(p, 'utf8');
  return {
    ok: true,
    markdown,
    path: p,
    source: 'image_filesystem',
  };
}

/** Repo-relative template used when baking images / local dev. */
export function bundledAutoRunStepsTemplatePath(repoRoot) {
  return path.join(repoRoot, 'autoRunStep.md');
}

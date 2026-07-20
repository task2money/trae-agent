import fs from 'fs';
import path from 'path';
import { bootstrapCloneLayerId } from './bootstrap.mjs';
import { repoRoot } from './paths.mjs';
import {
  layerGitWorkdirRootsForFileListing,
  layerPrimaryGitWorkdir,
  readLayerMeta,
  listLayerRows,
  resolvedParentLayerId,
} from './layerFs.mjs';
import { gitExec, findParentWorkdirForChildPrefix } from './layerGitRouteHelpers.mjs';
import { generateDiffSummary } from './diffSummaryLlm.mjs';


export function registerDiffLogMiscRoutes(api) {
  api.post('/layers/:layer_id/git/diff-log', async (req, res) => {
    const lid = req.params.layer_id;
    const rootsC = layerGitWorkdirRootsForFileListing(lid);
    const meta = readLayerMeta(lid);
    const known = new Set(listLayerRows().map((r) => r.layer_id));
    let parentId = meta?.parent_layer_id && known.has(meta.parent_layer_id) ? meta.parent_layer_id : null;
    if (!parentId) parentId = resolvedParentLayerId(lid, known, null);
    const rootsP = parentId ? layerGitWorkdirRootsForFileListing(parentId) : [];

    const files = Array.isArray(req.body?.files) ? req.body.files : [];
    if (!files.length) {
      return res.status(400).json({ detail: 'files array required' });
    }

    const sanitizedFiles = files
      .map(f => String(f || '').trim())
      .filter(f => f && !f.includes('..') && !f.startsWith('/'));

    if (!sanitizedFiles.length) {
      return res.status(400).json({ detail: 'no valid files provided' });
    }

    const diffLogs = [];
    for (const filePath of sanitizedFiles) {
      try {
        let diff = '';
        let hasChanges = false;

        const norm = filePath.replace(/\\/g, '/');
        const segs = norm ? norm.split('/').filter((x) => x.length) : [];

        let workdirC = null;
        let workdirP = null;
        let innerPath = null;

        for (const rootC of rootsC) {
          if (!rootC.relPrefix) {
            workdirC = rootC.workdir;
            innerPath = filePath;
            const rootP = findParentWorkdirForChildPrefix(rootsP, rootC.relPrefix);
            if (rootP) workdirP = rootP;
            break;
          }
          if (segs[0] === rootC.relPrefix) {
            workdirC = rootC.workdir;
            innerPath = segs.slice(1).join('/');
            const rootP = findParentWorkdirForChildPrefix(rootsP, rootC.relPrefix);
            if (rootP) workdirP = rootP;
            break;
          }
        }

        if (!workdirC) {
          workdirC = layerPrimaryGitWorkdir(lid);
          innerPath = filePath;
          if (parentId) workdirP = layerPrimaryGitWorkdir(parentId);
        }

        if (!workdirC) {
          diffLogs.push({ file: filePath, diff: '', has_changes: false, error: 'no git workdir found' });
          continue;
        }

        try {
          diff = await gitExec(['diff', 'HEAD', '--', innerPath], workdirC);
          hasChanges = diff.trim().length > 0;
        } catch (_) {}

        if (!hasChanges) {
          try {
            const cachedDiff = await gitExec(['diff', '--cached', 'HEAD', '--', innerPath], workdirC);
            if (cachedDiff.trim().length > 0) {
              diff = cachedDiff;
              hasChanges = true;
            }
          } catch (_) {}
        }

        if (!hasChanges) {
          try {
            const statusOut = await gitExec(['status', '--porcelain', '--', innerPath], workdirC);
            const statusLines = statusOut.trim().split('\n').filter(Boolean);
            for (const line of statusLines) {
              const status = line.slice(0, 2).trim();
              if (status === 'D' || status === 'D ' || status === ' D' || status.includes('D')) {
                const showOut = await gitExec(['show', `HEAD:${innerPath}`], workdirC);
                diff = `--- a/${filePath}\n+++ /dev/null\n-${showOut.trim().split('\n').map(l => l || '\\ No newline at end of file').join('\n-')}`;
                hasChanges = true;
                break;
              }
            }
          } catch (_) {}
        }

        if (!hasChanges && workdirP) {
          try {
            const pathInCurrent = path.join(workdirC, innerPath);
            const pathInParent = path.join(workdirP, innerPath);

            const existsInCurrent = fs.existsSync(pathInCurrent);
            const existsInParent = fs.existsSync(pathInParent);

            if (!existsInCurrent && existsInParent) {
              const parentContent = fs.readFileSync(pathInParent, 'utf8');
              diff = `--- a/${filePath}\n+++ /dev/null\n-${parentContent.trim().split('\n').map(l => l).join('\n-')}`;
              hasChanges = true;
            } else if (existsInCurrent && !existsInParent) {
              const currentContent = fs.readFileSync(pathInCurrent, 'utf8');
              diff = `--- /dev/null\n+++ b/${filePath}\n+${currentContent.trim().split('\n').map(l => l).join('\n+')}`;
              hasChanges = true;
            } else if (existsInCurrent && existsInParent) {
              const parentContent = fs.readFileSync(pathInParent, 'utf8');
              const currentContent = fs.readFileSync(pathInCurrent, 'utf8');
              if (parentContent !== currentContent) {
                const parentLines = parentContent.trim().split('\n');
                const currentLines = currentContent.trim().split('\n');
                const parts = [];
                parts.push(`--- a/${filePath}`);
                parts.push(`+++ b/${filePath}`);
                const maxLines = Math.max(parentLines.length, currentLines.length);
                for (let i = 0; i < maxLines; i++) {
                  const parentLine = parentLines[i] || '';
                  const currentLine = currentLines[i] || '';
                  if (parentLine !== currentLine) {
                    if (parentLine !== undefined) parts.push(`-${parentLine}`);
                    if (currentLine !== undefined) parts.push(`+${currentLine}`);
                  } else {
                    parts.push(` ${parentLine}`);
                  }
                }
                diff = parts.join('\n');
                hasChanges = true;
              }
            }
          } catch (e) {
            console.error('File system diff error:', e);
          }
        }

        diffLogs.push({
          file: filePath,
          diff: diff.trim(),
          has_changes: hasChanges,
        });
      } catch (e) {
        diffLogs.push({
          file: filePath,
          diff: '',
          has_changes: false,
          error: String(e.message || e),
        });
      }
    }

    const summary = await generateDiffSummary(diffLogs);

    const logContent = diffLogs
      .filter(d => d.has_changes)
      .map(d => `=== ${d.file} ===\n${d.diff}\n`)
      .join('\n');

    res.json({
      layer_id: req.params.layer_id,
      files: diffLogs,
      log: logContent,
      summary: summary,
      changed_files_count: diffLogs.filter(d => d.has_changes).length,
    });
  });

  api.get('/git/identity', (req, res) => {
    res.json({ name: '', email: '' });
  });

  api.post('/git/identity', (req, res) => {
    res.json({ ok: true });
  });

  api.get('/dev/service-repo-git-push', (req, res) => {
    res.json({
      is_git: false,
      ahead: 0,
      branch: '',
      upstream: '',
      no_upstream: true,
      path: repoRoot(),
    });
  });

  api.post('/project/view', (req, res) => {
    res.json({ status: 'ok', active_tip_layer_id: (req.body?.layer_id || '').toString() });
  });

  api.get('/project/active', (req, res) => {
    res.json({ active_tip_layer_id: bootstrapCloneLayerId, note: 'onlineServiceJS' });
  });
}

import { deleteLayerAndMirrorToSaas, enqueueLayerQueueItem } from './jobsRuntime.mjs';
import {
  listFlatRelativeFilesForLayer,
  resolveAbsolutePathForLayerListedFile,
} from './layerFs.mjs';
import { listLayerChildren } from './layerChildren.mjs';
import { readLayerFileContentPayload } from './layerFileContent.mjs';
import { getLayerParentDiffFiles, getLayerParentUnifiedDiff } from './layerParentDiff.mjs';


export function registerLayersFsRoutes(api) {
  api.delete('/layers/:layer_id', async (req, res) => {
    try {
      await deleteLayerAndMirrorToSaas(req.params.layer_id);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ detail: String(e.message || e) });
    }
  });

  api.post('/layers/:layer_id/queue', (req, res) => {
    try {
      const out = enqueueLayerQueueItem(req.params.layer_id, req.body || {});
      res.status(201).json(out);
    } catch (e) {
      res.status(400).json({ detail: String(e.message || e) });
    }
  });

  api.get('/layers/:layer_id/files', (req, res) => {
    const maxCap = Math.min(Math.max(1, parseInt(req.query.max_files || '2000', 10) || 2000), 5000);
    const { files, truncated } = listFlatRelativeFilesForLayer(req.params.layer_id, maxCap);
    res.json({ files, truncated: !!truncated, max_files: maxCap });
  });

  api.get('/layers/:layer_id/files/*', (req, res) => {
    const lid = req.params.layer_id;
    const rel = req.params[0] || '';
    const fp = resolveAbsolutePathForLayerListedFile(lid, rel);
    if (!fp) return res.status(404).json({ detail: 'not found' });
    const max = Math.min(parseInt(req.query.max_bytes || '2000000', 10) || 2000000, 20_000_000);
    const out = readLayerFileContentPayload(fp, rel, { maxBytes: max });
    if (!out.ok) return res.status(out.status || 404).json(out.body || { detail: 'not found' });
    res.json(out.body);
  });

  api.get('/layers/:layer_id/children', (req, res) => {
    const result = listLayerChildren(req.params.layer_id, {
      dir: (req.query.dir ?? '').toString(),
      prefix: (req.query.prefix ?? '').toString(),
      offset: req.query.offset,
      limit: req.query.limit,
    });
    if (!result.ok) {
      return res.status(result.status || 400).json({ detail: result.detail || 'invalid dir' });
    }
    res.json({
      entries: result.entries,
      total: result.total,
      next_offset: result.next_offset,
      truncated: result.truncated,
    });
  });

  api.get('/layers/:layer_id/diff/parent/files', (req, res) => {
    res.json(
      getLayerParentDiffFiles(req.params.layer_id, {
        offset: req.query.offset,
        limit: req.query.limit,
      }),
    );
  });

  api.get('/layers/:layer_id/diff/parent/file', (req, res) => {
    const relPath = (req.query.path ?? '').toString();
    const out = getLayerParentUnifiedDiff(req.params.layer_id, relPath);
    if (!out.ok) return res.status(out.status).json(out.body);
    res.json(out.body);
  });
}

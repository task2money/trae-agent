import fs from 'fs';
import {
  newLayerId,
  createEmptyLayer,
  readLayerMeta,
  LAYER_ID_RE,
} from './layerFs.mjs';
import { layersRoot } from './paths.mjs';
import { setStartupEmptyLayerId } from './bootstrapState.mjs';

export function ensureStartupEmptyLayer() {
  const root = layersRoot();
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
  for (const name of fs.readdirSync(root).sort()) {
    if (!LAYER_ID_RE.test(name)) continue;
    const m = readLayerMeta(name);
    if (m && m.kind === 'empty') {
      setStartupEmptyLayerId(name);
      return name;
    }
  }
  const id = newLayerId();
  createEmptyLayer(id);
  setStartupEmptyLayerId(id);
  return id;
}

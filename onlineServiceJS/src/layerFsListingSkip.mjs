/** 文件树扁平列表 / 父层 diff / 嵌套仓扫描共用：跳过噪声目录名 */
const SKIP_LISTING_DIR_NAMES = new Set([
  '__pycache__',
  '.DS_Store',
  '.git',
  'node_modules',
  '.venv',
  'venv',
  'dist',
  'build',
  '.turbo',
  '.next',
  'coverage',
]);

export function shouldSkipListingDirName(name) {
  const n = String(name || '');
  if (!n || SKIP_LISTING_DIR_NAMES.has(n)) return true;
  if (n.startsWith('.venv')) return true;
  return false;
}

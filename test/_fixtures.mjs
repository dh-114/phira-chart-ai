import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultDir } from '../lib/paths.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 参考铺面目录：参数 > 环境变量 > <插件目录>/../参考铺面 */
export function chartBase() {
  const p = process.argv[2] || process.env.PHIRA_CHARTS || path.resolve(HERE, '..', '..', '参考铺面');
  return p;
}

/** 第一个含 RPE 谱面的目录 */
export function firstChartDir() {
  const base = chartBase();
  if (!fs.existsSync(base)) return null;
  for (const name of fs.readdirSync(base)) {
    const full = path.join(base, name);
    if (!fs.statSync(full).isDirectory()) continue;
    const js = fs.readdirSync(full).filter((f) => f.endsWith('.json'));
    if (!js.length) continue;
    const head = fs.readFileSync(path.join(full, js[0]), 'utf8').slice(0, 200);
    if (head.trimStart().startsWith('{')) return full;
  }
  return null;
}

export { defaultDir };

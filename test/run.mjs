import fs from 'node:fs';
import path from 'node:path';
import { normalizeChart } from '../lib/rpe.js';
import { validate } from '../lib/validate.js';
import { stats, predictDifficulty, playability } from '../lib/analyze.js';

import { chartBase } from './_fixtures.mjs';
const base = chartBase();
if (!fs.existsSync(base)) {
  console.log(`  ⏭ 未找到参考铺面目录（${base}）：设置 PHIRA_CHARTS=/path/to/参考铺面 后再跑；跳过 25 谱面回归`);
  process.exit(0);
}
let n = 0, errs = 0;
for (const dir of fs.readdirSync(base).sort()) {
  const full = path.join(base, dir);
  if (!fs.statSync(full).isDirectory()) continue;
  const jsons = fs.readdirSync(full).filter((f) => f.toLowerCase().endsWith('.json'));
  if (!jsons.length) continue;
  const f = path.join(full, jsons.sort((a, b) => fs.statSync(path.join(full, b)).size - fs.statSync(path.join(full, a)).size)[0]);
  const src = fs.readFileSync(f, 'utf8');
  if (!src.trimStart().startsWith('{')) { console.log(`${dir.padEnd(40)} PEC 跳过`); continue; }
  try {
    const chart = normalizeChart(JSON.parse(src));
    const r = validate(chart);
    const s = stats(chart);
    const d = predictDifficulty(chart);
    n++;
    if (!r.ok) errs++;
    console.log(`${dir.slice(0, 34).padEnd(36)} notes=${String(s.notes).padStart(5)} E=${String(r.counts.errors).padStart(2)} W=${String(r.counts.warnings).padStart(2)} I=${String(r.counts.infos).padStart(2)} 预测=${d.predicted.toFixed(1)} 峰值=${s.densityPeak} 同刻=${s.maxChord}`);
  } catch (e) {
    console.log(`${dir.slice(0, 34).padEnd(36)} FAIL ${e.message}`);
    errs++;
  }
}
console.log(`\n共 ${n} 个 RPE 谱面，其中 ${errs} 个有 error 或异常`);

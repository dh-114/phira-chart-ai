/**
 * 音符分布检查：采样与生成的横向分布必须贴近参考谱面（25 谱 / 36,620 音符）。
 */
import { emptyChart, normalizeChart } from '../lib/rpe.js';
import { planChart, materializePlan } from '../lib/plan.js';
import { sampleX, chordXs, makeRng, stairsRange, maxJump, REF_DIST } from '../lib/distribution.js';
import { validate } from '../lib/validate.js';

const out = [];
const check = (n, ok, d = '') => out.push({ n, ok, d });

// 1) 采样分布
{
  const rng = makeRng(12345);
  const xs = Array.from({ length: 20000 }, () => sampleX(rng)).map(Math.abs).sort((a, b) => a - b);
  const q = (p) => xs[Math.floor((xs.length - 1) * p)];
  const avg = xs.reduce((a, b) => a + b, 0) / xs.length;
  // 参考值来自 24 谱（剔除耐力谱 23375，它单张占 38% 音符、形态极端）
  check('采样 |x| 中位 ≈ 参考 248', q(0.5) > 210 && q(0.5) < 290, String(Math.round(q(0.5))));
  check('采样 |x|>400 ≈ 17.9%', Math.abs(xs.filter((x) => x > 400).length / xs.length - REF_DIST.edge400) < 0.05, '');
  check('采样中线占比 ≈ 14.6%', Math.abs(xs.filter((x) => x <= 50).length / xs.length - 0.146) < 0.05, '');
  check('采样平均|x| ≈ 235', avg > 190 && avg < 300, String(Math.round(avg)));
}

// 2) 同刻间距
for (const k of [2, 3, 4]) {
  const rng = makeRng(7);
  const xs = chordXs(k, { rng }).sort((a, b) => a - b);
  const gaps = xs.slice(1).map((x, i) => x - xs[i]);
  check(`chordXs(${k}) 间距 ≥ 判定阈值`, gaps.every((g) => g >= 213.4), JSON.stringify(xs));
  check(`chordXs(${k}) 关于中心对称`, Math.abs(xs.reduce((a, b) => a + b, 0)) <= 1, JSON.stringify(xs));
}

// 3) 生成器输出分布
for (const seed of [7, 42, 99]) {
  const c = emptyChart({ bpm: 120, lineY: -270 });
  const plan = planChart({ durationSec: 60, bpm: 120, difficulty: 13, style: 'balanced' });
  materializePlan(c, plan, { seed });
  const norm = normalizeChart(c);
  const xs = norm.notes.filter((n) => !n.isFake).map((n) => n.x).sort((a, b) => a - b);
  const q = (p) => xs[Math.floor((xs.length - 1) * p)];
  const avg = xs.reduce((a, b) => a + Math.abs(b), 0) / xs.length;
  const edge = xs.filter((x) => Math.abs(x) > 400).length / xs.length;
  check(`生成器 seed=${seed} p50≈0`, Math.abs(q(0.5)) <= 40, String(q(0.5)));
  check(`生成器 seed=${seed} 平均|x| 150–280`, avg >= 150 && avg <= 280, String(Math.round(avg)));
  check(`生成器 seed=${seed} >400 占比 5–30%`, edge >= 0.05 && edge <= 0.30, (edge * 100).toFixed(1) + '%');
  check(`生成器 seed=${seed} 13 级不倾斜`, norm.lines.every((l) => (l.extended.inclineEvents || []).length === 0), '');
  // 同刻同线间距
  const by = new Map();
  for (const n of norm.notes) {
    const k = n.line + ':' + Math.round(n.sec * 1000);
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(n);
  }
  let minGap = Infinity;
  for (const g of by.values()) {
    if (g.length < 2) continue;
    g.sort((a, b) => a.x - b.x);
    for (let i = 0; i + 1 < g.length; i++) minGap = Math.min(minGap, Math.abs(g[i + 1].x - g[i].x));
  }
  check(`生成器 seed=${seed} 同刻间距 ≥213`, !Number.isFinite(minGap) || minGap >= 213.4, String(Math.round(minGap)));
  const v = validate(norm, { difficulty: 13 });
  check(`生成器 seed=${seed} 校验 0 warning`, v.counts.warnings === 0, JSON.stringify(v.issues.filter((i) => i.level === 'warn').map((i) => i.code)));
}

// 4) 辅助函数
check('stairsRange(13) ≈ ±380', Math.abs(stairsRange(13).x1 - 380) < 40, JSON.stringify(stairsRange(13)));
check('maxJump(13) ≥ 420', maxJump(13) >= 420, String(maxJump(13)));

console.log('音符分布检查：');
let bad = 0;
for (const r of out) { console.log(`  ${r.ok ? '✅' : '❌'} ${r.n}${r.ok ? '' : '  ' + r.d}`); if (!r.ok) bad++; }
console.log(bad ? `\n${bad} 项失败` : '\n全部通过');
process.exit(bad ? 1 : 0);

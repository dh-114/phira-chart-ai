import fs from 'node:fs';
import { normalizeChart, beats, evalSeries } from '../lib/rpe.js';
import { firstChartDir } from './_fixtures.mjs';

const dir = firstChartDir();
if (!dir) {
  console.log('  ⏭ 未找到参考铺面目录（设置 PHIRA_CHARTS 或放到 ../参考铺面），跳过 units_check');
  process.exit(0);
}
let bad = 0;
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
  const raw = JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8'));
  const c = normalizeChart(raw);
  const bpm0 = c.bpm.points[0].bpm;
  for (const l of c.lines) {
    for (const ly of l.layers) {
      for (const key of ['alphaEvents', 'moveXEvents', 'moveYEvents', 'rotateEvents', 'speedEvents']) {
        for (const e of ly[key] || []) {
          // 事件时间必须是秒：应与 bpm.at(beats) 一致（容差 1e-6）
          const expect = c.bpm.at(beats(e.startTime));
          if (!(Math.abs(e.st - expect) < 1e-6)) {
            console.log(`❌ ${f} ${key} startTime=${JSON.stringify(e.startTime)} st=${e.st} 期望秒=${expect}`);
            bad++;
          }
        }
      }
    }
  }
}
console.log(bad === 0 ? '✅ 事件时间单位正确（秒）' : `❌ ${bad} 个事件仍是拍数`);
process.exit(bad === 0 ? 0 : 1);

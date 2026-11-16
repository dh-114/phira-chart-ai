import fs from 'node:fs'; import path from 'node:path';
import { emptyChart, normalizeChart } from '../lib/rpe.js';
import { planChart, materializePlan, scalePlanDensity } from '../lib/plan.js';
import { writeChart, writeInfo } from '../lib/author.js';
import { validate } from '../lib/validate.js';
import { predictDifficulty, stats } from '../lib/analyze.js';
import { renderStrip } from '../lib/render.js';
import { encodePNG } from '../lib/raster.js';

const outDir='/storage/emulated/0/dsh/phira/铺面测试/plan_cal';
fs.mkdirSync(outDir,{recursive:true});
const base = emptyChart({ bpm: 180, title: 'Cal Demo', charter: 'DSH (AI)' });
const target = 13;
const style = process.argv[2] || 'lineShow';
let plan = planChart({ durationSec: 60, bpm: 180, difficulty: target, style });
let work = plan, best = null;
for (let i = 0; i < 4; i++) {
  const clone = JSON.parse(JSON.stringify(base));
  const r = materializePlan(clone, work);
  const pred = predictDifficulty(normalizeChart(clone)).predicted;
  console.log(`第${i+1}轮 密度 ${work.meta.density} → 预测 ${pred.toFixed(2)}`);
  if (!best || Math.abs(pred-target) < Math.abs(best.pred-target)) best = { clone, work, pred, r };
  if (Math.abs(pred-target) <= 0.35) break;
  work = scalePlanDensity(work, pred < target ? 1.22 : 0.82);
}
writeChart(path.join(outDir,'chart.json'), best.clone);
fs.writeFileSync(path.join(outDir,'plan.json'), JSON.stringify(best.work,null,2)+'\n');
writeInfo(path.join(outDir,'info.yml'), {
  name:'Cal Demo', difficulty: target, level:'IN Lv.13', charter:'DSH (AI)',
  chart:'chart.json', format:'rpe', music:'song.mp3', illustration:'background.png',
  aspectRatio:1.7777778, lineLength:6.0, offset:0.0, tags:['AI生成'], intro:'本谱面由 AI 生成',
});
const norm = normalizeChart(JSON.parse(fs.readFileSync(path.join(outDir,'chart.json'),'utf8')));
const v = validate(norm, { maxFingers: 2 });
const s = stats(norm);
console.log(`\n最终：预测 ${best.pred.toFixed(2)}（目标 ${target}）  音符 ${s.notes}  时长 ${s.duration.toFixed(0)}s  峰值 ${s.densityPeak}/s  同刻 ${s.maxChord}`);
console.log(`校验：${v.counts.errors} error / ${v.counts.warnings} warning / ${v.counts.infos} info`);
for (const i of v.issues.filter(x=>x.level!=='info').slice(0,5)) console.log('  ', i.level, i.code, i.msg);
const info = { aspectRatio:16/9, lineLength:6 };
const st = renderStrip(norm, info, 6, 30, 6, { cols:2, width:520 });
fs.writeFileSync(path.join(outDir,'strip.png'), encodePNG(st.surface));
console.log('图片：', path.join(outDir,'strip.png'));

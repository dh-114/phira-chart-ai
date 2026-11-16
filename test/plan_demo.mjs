import fs from 'node:fs'; import path from 'node:path';
import { emptyChart, normalizeChart } from '../lib/rpe.js';
import { planChart, materializePlan, fmtPlan } from '../lib/plan.js';
import { writeChart, writeInfo } from '../lib/author.js';
import { validate } from '../lib/validate.js';
import { predictDifficulty, stats } from '../lib/analyze.js';
import { renderStrip, renderFrame } from '../lib/render.js';
import { encodePNG } from '../lib/raster.js';

const outDir='/storage/emulated/0/dsh/phira/铺面测试/plan_demo';
fs.mkdirSync(outDir,{recursive:true});

const chart = emptyChart({ bpm: 180, title: 'Plan Demo', charter: 'DSH (AI)' });
const plan = planChart({ durationSec: 60, bpm: 180, difficulty: 13, style: 'lineShow' });
console.log(fmtPlan(plan));
const r = materializePlan(chart, plan);
const file = path.join(outDir, 'chart.json');
writeChart(file, chart);
writeInfo(path.join(outDir,'info.yml'), {
  name:'Plan Demo', difficulty:13, level:'IN Lv.13', charter:'DSH (AI)',
  chart:'chart.json', format:'rpe', music:'song.mp3', illustration:'background.png',
  aspectRatio:1.7777778, lineLength:6.0, offset:0.0, tags:['AI生成'], intro:'本谱面由 AI 生成',
});
fs.writeFileSync(path.join(outDir,'plan.json'), JSON.stringify(plan,null,2)+'\n');

const norm = normalizeChart(JSON.parse(fs.readFileSync(file,'utf8')));
const v = validate(norm, { maxFingers: 2 });
const d = predictDifficulty(norm);
const s = stats(norm);
console.log(`\n生成：音符 ${r.notes}，线 ${r.lines}，事件 ${r.events}`);
console.log(`校验：${v.counts.errors} error / ${v.counts.warnings} warning / ${v.counts.infos} info`);
for (const i of v.issues.filter(x=>x.level!=='info').slice(0,6)) console.log('  ', i.level, i.code, i.msg);
console.log(`难度预测：${d.predicted}   统计：${s.notes} 音符 / ${s.duration.toFixed(0)}s / 峰值 ${s.densityPeak}/s / 同刻 ${s.maxChord}`);
const info = { aspectRatio: 16/9, lineLength: 6 };
const st = renderStrip(norm, info, 4, 22, 6, { cols: 2, width: 520 });
fs.writeFileSync(path.join(outDir,'strip.png'), encodePNG(st.surface));
const f = renderFrame(norm, info, 18, { width: 900 });
fs.writeFileSync(path.join(outDir,'frame_18.png'), encodePNG(f.surface));
console.log('图片：', outDir);

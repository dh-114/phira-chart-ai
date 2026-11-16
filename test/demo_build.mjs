import fs from 'node:fs'; import path from 'node:path';
import { emptyChart, normalizeChart } from '../lib/rpe.js';
import { addLine, addNotes, addEvents, applyPattern, applyAIMark, writeChart, writeInfo } from '../lib/author.js';
import { validate } from '../lib/validate.js';
import { predictDifficulty, playability, stats } from '../lib/analyze.js';
import { renderStrip, renderFrame } from '../lib/render.js';
import { encodePNG } from '../lib/raster.js';

const outDir = '/storage/emulated/0/dsh/phira/铺面测试/demo_ai';
fs.mkdirSync(outDir, { recursive: true });

// 1) 骨架
const chart = emptyChart({ bpm: 180, title: 'AI Demo', charter: 'DSH (AI)' });

// 2) 演奏主线（0 号线）+ 左右垂直判定线
applyPattern(chart, 'stairs', { line: 0, startBeat: 8, count: 8, stepBeat: 0.5, x0: -300, x1: 300 });
applyPattern(chart, 'trill', { line: 0, startBeat: 12, count: 8, stepBeat: 0.5, x1: -220, x2: 220 });
applyPattern(chart, 'chord', { line: 0, startBeat: 16, count: 4, stepBeat: 1, xs: [-260, 260] });
applyPattern(chart, 'holdInner', { line: 0, startBeat: 20, beats: 2, x: 0, innerCount: 3, innerOffset: 260 });
applyPattern(chart, 'sweep', { line: 0, startBeat: 24, beats: 4, from: -675, to: 675, easing: 4 });
applyPattern(chart, 'freeze', { line: 0, startBeat: 30, beats: 2 });
applyPattern(chart, 'stairs', { line: 0, startBeat: 32, count: 12, stepBeat: 0.25, x0: 300, x1: -300 });

const left = addLine(chart, { name: 'Left-V', x: -650, y: 0, rot: 90, zOrder: 5 });
const right = addLine(chart, { name: 'Right-V', x: 650, y: 0, rot: -90, zOrder: 5 });
applyPattern(chart, 'stairs', { line: left, startBeat: 28, count: 8, stepBeat: 0.5, x0: -200, x1: 200 });
applyPattern(chart, 'stairs', { line: right, startBeat: 28, count: 8, stepBeat: 0.5, x0: 200, x1: -200 });

// 3) 判定线演出：淡入 + 倾角 + 染色
addEvents(chart, 0, 'alpha', [{ startBeat: 0, endBeat: 4, from: 0, to: 255, easing: 4 }]);
addEvents(chart, 0, 'incline', [{ startBeat: 20, endBeat: 28, from: 0, to: 18, easing: 4 }]);
addEvents(chart, 0, 'color', [{ startBeat: 24, endBeat: 28, from: [130, 205, 255], to: [255, 120, 160] }]);

// 4) AI 水印
applyAIMark(chart, { text: '本谱面由 AI 生成', startBeat: 0, endBeat: 6 });

// 5) 落盘
const chartFile = path.join(outDir, 'chart.json');
writeChart(chartFile, chart);
writeInfo(path.join(outDir, 'info.yml'), {
  name: 'AI Demo', difficulty: 12.5, level: 'IN Lv.12', charter: 'DSH (AI)',
  chart: 'chart.json', format: 'rpe', music: 'song.mp3', illustration: 'background.png',
  aspectRatio: 1.7777778, lineLength: 6.0, offset: 0.0, tags: ['AI生成'], intro: '本谱面由 AI 生成',
});

// 6) 校验 / 分析
const norm = normalizeChart(JSON.parse(fs.readFileSync(chartFile, 'utf8')));
const v = validate(norm);
const d = predictDifficulty(norm);
const s = stats(norm);
console.log(`校验：${v.counts.errors} error / ${v.counts.warnings} warning / ${v.counts.infos} info`);
for (const i of v.issues.slice(0, 6)) console.log('  ', i.level, i.code, i.msg);
console.log(`难度预测：${d.predicted}  依据：${d.reasons.join('；')}`);
console.log(`统计：音符 ${s.notes}，线 ${s.lines}，事件 ${s.events}，峰值 ${s.densityPeak}/s，最大同刻 ${s.maxChord}`);
const p = playability(norm, { maxFingers: 2 });
console.log('可玩性：', p.items.length ? p.items.map((i) => `${i.title}(${i.level})`).join('；') : '无问题');

// 7) 出图
const info = { aspectRatio: 16 / 9, lineLength: 6 };
for (const t of [3.2, 10.5, 18.0]) {
  const f = renderFrame(norm, info, t, { width: 900 });
  fs.writeFileSync(path.join(outDir, `frame_${t}.png`), encodePNG(f.surface));
}
const st = renderStrip(norm, info, 2.5, 11.5, 6, { cols: 2, width: 520 });
fs.writeFileSync(path.join(outDir, 'strip.png'), encodePNG(st.surface));
console.log('图片：', outDir);

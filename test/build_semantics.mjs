import fs from 'node:fs'; import path from 'node:path';
import { emptyChart, normalizeChart } from '../lib/rpe.js';
import { addLine, addNotes, addEvents, writeChart, writeInfo } from '../lib/author.js';
import { validate } from '../lib/validate.js';
import { renderFrame } from '../lib/render.js';
import { encodePNG } from '../lib/raster.js';

const dir = '/storage/emulated/0/dsh/phira/铺面测试/语义测试';
fs.mkdirSync(dir, { recursive: true });
const chart = emptyChart({ bpm: 120, title: 'Semantics Test', charter: 'DSH (AI)' });
// L0 基准：水平线 y=0
addNotes(chart, 0, [{ beat: 8, type: 1, x: 0 }, { beat: 9, type: 1, x: -300 }, { beat: 10, type: 1, x: 300 }]);
// L1 旋转 +90（左侧竖线）
const l1 = addLine(chart, { name: 'Rot+90', x: -500, y: 0, rot: 90 });
addNotes(chart, l1, [{ beat: 12, type: 1, x: 0 }, { beat: 13, type: 1, x: 0 }]);
// L2 旋转 -90（右侧竖线）
const l2 = addLine(chart, { name: 'Rot-90', x: 500, y: 0, rot: -90 });
addNotes(chart, l2, [{ beat: 16, type: 1, x: 0 }, { beat: 17, type: 1, x: 0 }]);
// L3 纵向移动：0 → +450（RPE 正方向）
const l3 = addLine(chart, { name: 'MoveY+', x: 0, y: 0, rot: 0 });
addEvents(chart, l3, 'moveY', [{ startBeat: 20, endBeat: 22, from: 0, to: 450, easing: 1 }]);
addNotes(chart, l3, [{ beat: 21, type: 1, x: 0 }, { beat: 22, type: 1, x: 0 }]);
// L4 横向扫线：-500 → +500
const l4 = addLine(chart, { name: 'SweepX', x: -500, y: -200, rot: 0 });
addEvents(chart, l4, 'moveX', [{ startBeat: 24, endBeat: 26, from: -500, to: 500, easing: 1 }]);
addNotes(chart, l4, [{ beat: 25, type: 1, x: 0 }]);

writeChart(path.join(dir, 'chart.json'), chart);
writeInfo(path.join(dir, 'info.yml'), {
  name: 'Semantics Test', difficulty: 5, level: 'TEST', charter: 'DSH (AI)',
  chart: 'chart.json', format: 'rpe', music: 'song.mp3', illustration: 'background.png',
  aspectRatio: 1.7777778, lineLength: 6.0, offset: 0.0, tags: ['AI生成'], intro: '判定语义测试',
});
const norm = normalizeChart(JSON.parse(fs.readFileSync(path.join(dir, 'chart.json'), 'utf8')));
const v = validate(norm);
console.log(`校验：${v.counts.errors} error / ${v.counts.warnings} warning`);
const info = { aspectRatio: 16 / 9, lineLength: 6 };
for (const t of [4.5, 6.5, 8.5, 10.75, 12.75]) {
  const f = renderFrame(norm, info, t, { width: 800, showIds: true });
  fs.writeFileSync(path.join(dir, `t${t}.png`), encodePNG(f.surface));
  console.log('t=' + t, JSON.stringify({ vis: f.stats.visibleLines, notes: f.stats.drawnNotes }));
}

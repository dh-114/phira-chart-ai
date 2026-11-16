import fs from 'node:fs'; import path from 'node:path';
import { normalizeChart } from '../lib/rpe.js';
import { renderFrame } from '../lib/render.js';
import { encodePNG } from '../lib/raster.js';
const base='/storage/emulated/0/dsh/phira/参考铺面';
const dir=fs.readdirSync(base).find(x=>x.startsWith('37207'));
const full=path.join(base,dir);
const j=fs.readdirSync(full).filter(x=>x.endsWith('.json')).map(x=>path.join(full,x)).sort((a,b)=>fs.statSync(b).size-fs.statSync(a).size)[0];
const chart=normalizeChart(JSON.parse(fs.readFileSync(j,'utf8')));
const info={aspectRatio:16/9,lineLength:6};
const out='/storage/emulated/0/dsh/phira/铺面测试';
for (const t of [138.62, 139.0]) {
  const f=renderFrame(chart,info,t,{width:900});
  fs.writeFileSync(path.join(out,`37207_vertical_${t}.png`), encodePNG(f.surface));
  console.log(t, JSON.stringify(f.stats));
}
// 该时刻左右两条线的旋转与位置
const bpm=chart.bpm;
for (const li of [5,6]) {
  const l=chart.lines[li];
  const x=chart.lines[li].layers.reduce((s,ly)=>s+ (ly.moveXEvents||[]).reduce((a,e)=>a,0),0);
  console.log('line',li,'name',l.name,'texture',l.texture,'notes',l.notes.length);
}

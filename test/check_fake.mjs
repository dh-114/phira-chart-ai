import fs from 'node:fs'; import path from 'node:path';
import { normalizeChart } from '../lib/rpe.js';
import { renderFrame } from '../lib/render.js';
import { encodePNG } from '../lib/raster.js';
const base='/storage/emulated/0/dsh/phira/参考铺面';
const dir=fs.readdirSync(base).find(x=>x.startsWith('28063'));
const full=path.join(base,dir);
const j=fs.readdirSync(full).filter(x=>x.endsWith('.json')).map(x=>path.join(full,x)).sort((a,b)=>fs.statSync(b).size-fs.statSync(a).size)[0];
const chart=normalizeChart(JSON.parse(fs.readFileSync(j,'utf8')));
const info={aspectRatio:16/9,lineLength:6};
for (const t of [40, 90]) {
  const f=renderFrame(chart,info,t,{width:900});
  const p=path.join('/storage/emulated/0/dsh/phira/铺面测试',`28063_t${t}.png`);
  fs.writeFileSync(p, encodePNG(f.surface));
  console.log(t, JSON.stringify(f.stats));
}

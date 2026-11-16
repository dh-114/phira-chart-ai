import fs from 'node:fs'; import path from 'node:path';
import { normalizeChart } from '../lib/rpe.js';
import { validate } from '../lib/validate.js';
const base='/storage/emulated/0/dsh/phira/参考铺面';
let tot=0, vis=0, charts=0;
for (const dir of fs.readdirSync(base)) {
  const full=path.join(base,dir); if(!fs.statSync(full).isDirectory()) continue;
  const js=fs.readdirSync(full).filter(x=>x.endsWith('.json')); if(!js.length) continue;
  const f=path.join(full,js.sort((a,b)=>fs.statSync(path.join(full,b)).size-fs.statSync(path.join(full,a)).size)[0]);
  const src=fs.readFileSync(f,'utf8'); if(!src.trimStart().startsWith('{')) continue;
  const r=validate(normalizeChart(JSON.parse(src)));
  tot+=r.stats.collisions; vis+=r.stats.visualOverlaps;
  if(r.stats.collisions) charts++;
}
console.log('同线抢判定合计:',tot,' 涉及谱面:',charts,' 跨线视觉重叠合计:',vis);

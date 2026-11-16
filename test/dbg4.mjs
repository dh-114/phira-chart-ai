import fs from 'node:fs'; import path from 'node:path';
import { normalizeChart } from '../lib/rpe.js';
import { validate } from '../lib/validate.js';
const base='/storage/emulated/0/dsh/phira/参考铺面';
for (const dir of fs.readdirSync(base)) {
  const full=path.join(base,dir); if(!fs.statSync(full).isDirectory()) continue;
  const js=fs.readdirSync(full).filter(x=>x.endsWith('.json')); if(!js.length) continue;
  const f=path.join(full,js.sort((a,b)=>fs.statSync(path.join(full,b)).size-fs.statSync(path.join(full,a)).size)[0]);
  const src=fs.readFileSync(f,'utf8'); if(!src.trimStart().startsWith('{')) continue;
  const r=validate(normalizeChart(JSON.parse(src)));
  const errs=r.issues.filter(i=>i.level==='error');
  if(errs.length) console.log(dir.slice(0,26), errs.map(e=>e.code+': '+e.msg).join(' | '));
}

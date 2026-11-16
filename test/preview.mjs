import fs from 'node:fs'; import path from 'node:path';
import { normalizeChart } from '../lib/rpe.js';
import { renderFrame, renderStrip } from '../lib/render.js';
import { encodePNG } from '../lib/raster.js';
const base='/storage/emulated/0/dsh/phira/参考铺面';
function load(prefix){
  const dir=fs.readdirSync(base).find(x=>x.startsWith(prefix));
  const full=path.join(base,dir);
  const j=fs.readdirSync(full).filter(x=>x.endsWith('.json')).map(x=>path.join(full,x)).sort((a,b)=>fs.statSync(b).size-fs.statSync(a).size)[0];
  const chart=normalizeChart(JSON.parse(fs.readFileSync(j,'utf8')));
  const info={aspectRatio:16/9,lineLength:6,forceAspectRatio:false};
  return {chart,info,name:dir};
}
const out='/storage/emulated/0/dsh/phira/铺面测试';
fs.mkdirSync(out,{recursive:true});
for (const [pre,t] of [['11404',30],['14940',9.06],['30818',40],['54712',60]]) {
  const {chart,info,name}=load(pre);
  const f=renderFrame(chart,info,t,{width:900});
  const p=path.join(out,`${pre}_t${t}.png`);
  fs.writeFileSync(p,encodePNG(f.surface));
  console.log(pre, name.slice(0,20), '->', p, f.stats);
}
const {chart,info}=load('11404');
const st=renderStrip(chart,info,28,32,6,{cols:2,width:520});
const sp=path.join(out,'11404_strip.png');
fs.writeFileSync(sp,encodePNG(st.surface));
console.log('strip ->',sp,st.size);

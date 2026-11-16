import fs from 'node:fs'; import path from 'node:path';
import { normalizeChart, evalEvents } from '../lib/rpe.js';
const base='/storage/emulated/0/dsh/phira/参考铺面';
for (const pre of ['24101','14940']) {
  const dir=fs.readdirSync(base).find(x=>x.startsWith(pre));
  const full=path.join(base,dir);
  const f=fs.readdirSync(full).filter(x=>x.endsWith('.json')).map(x=>path.join(full,x)).sort((a,b)=>fs.statSync(b).size-fs.statSync(a).size)[0];
  const chart=normalizeChart(JSON.parse(fs.readFileSync(f,'utf8')));
  console.log('===',pre,'lines',chart.lines.length);
  let shown=0;
  for (const l of chart.lines) {
    for (const n of l.notes) {
      if (n.isFake) continue;
      const lx=evalEvents(l.layers,n.sec,'moveXEvents');
      const rot=-evalEvents(l.layers,n.sec,'rotateEvents');
      const ex=lx+n.x*Math.cos(rot*Math.PI/180);
      if (Math.abs(ex)>675 && shown<6) {
        shown++;
        console.log(` line${l.index} tex=${l.texture} t=${n.sec.toFixed(2)} x=${n.x} lineX=${lx.toFixed(0)} rot=${rot.toFixed(0)} ex=${ex.toFixed(0)} type=${n.type} fake=${n.isFake} alpha=${n.alpha} size=${n.size} vt=${n.visibleTime}`);
      }
    }
  }
}

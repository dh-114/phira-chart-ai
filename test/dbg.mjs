import fs from 'node:fs'; import path from 'node:path';
import { normalizeChart, evalEvents, beats } from '../lib/rpe.js';
const base='/storage/emulated/0/dsh/phira/参考铺面';
const dir=fs.readdirSync(base).find(x=>x.startsWith('11404'));
const full=path.join(base,dir);
const j=fs.readdirSync(full).filter(x=>x.endsWith('.json')).map(x=>path.join(full,x)).sort((a,b)=>fs.statSync(b).size-fs.statSync(a).size)[0];
const chart=normalizeChart(JSON.parse(fs.readFileSync(j,'utf8')));
console.log('bpm points', chart.bpm.points.length, chart.bpm.points[0]);
const l=chart.lines[0];
console.log('line0 layers', l.layers.length, 'alpha events in layer0:', l.layers[0].alphaEvents.length);
console.log('first alpha event', l.layers[0].alphaEvents[0]);
console.log('alpha at t=30:', evalEvents(l.layers,30,'alphaEvents'));
console.log('alpha at t=5:', evalEvents(l.layers,5,'alphaEvents'));
console.log('speed at t=30:', evalEvents(l.layers,30,'speedEvents'));
// 该线音符的 sec 分布
console.log('notes', l.notes.length, 'first sec', l.notes[0]&&l.notes[0].sec);
const n=l.notes[0];
console.log('note0', {type:n.type, sec:n.sec, endSec:n.endSec, x:n.x, speed:n.speed});

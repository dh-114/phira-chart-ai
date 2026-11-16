import fs from 'node:fs'; import path from 'node:path';
import { normalizeChart } from '../lib/rpe.js';
import { renderFrame } from '../lib/render.js';
import { firstChartDir } from './_fixtures.mjs';
const dir = firstChartDir();
const j = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
  .map((f) => path.join(dir, f)).sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
const chart = normalizeChart(JSON.parse(fs.readFileSync(j, 'utf8')));
const f = renderFrame(chart, { aspectRatio: 16 / 9, lineLength: 6 }, 30, { width: 640 });
console.log(JSON.stringify({ notes: f.stats.notes, lines: f.stats.lines, drawn: f.stats.drawnNotes, vis: f.stats.visibleLines, chord: f.stats.chord, w: f.stats.width, h: f.stats.height, bpm: Math.round(f.stats.bpm) }));

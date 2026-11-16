import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto';
import { normalizeChart } from '../lib/rpe.js';
import { renderFrame } from '../lib/render.js';
import { encodePNG } from '../lib/raster.js';
import { firstChartDir } from './_fixtures.mjs';
const dir = firstChartDir();
const j = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
  .map((f) => path.join(dir, f)).sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
const chart = normalizeChart(JSON.parse(fs.readFileSync(j, 'utf8')));
const f = renderFrame(chart, { aspectRatio: 16 / 9, lineLength: 6 }, 30, { width: 640 });
const png = encodePNG(f.surface);
console.log('sha256', crypto.createHash('sha256').update(png).digest('hex'), 'bytes', png.length);

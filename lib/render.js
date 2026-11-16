/**
 * 谱面几何渲染器（prpr 数学复刻）+ 调试信息叠加
 * 可见性：判定线 alpha>0 且非文字/UI 线、屏幕内才画；音符按可见时间窗；假音符近乎透明
 * 颜色：Tap 青蓝 / Hold 绿 / Flick 粉 / Drag 琥珀；长条画区域（填充+描边+头尾）
 */
import { Surface } from './raster.js';
import { evalEvents, evalSeries, SPEED_RATIO, NOTE_WIDTH_RATIO_BASE, chartDuration, MAX_PREVIEW_SEC } from './rpe.js';
import { drawText, fillRect, strokeRect, textWidth } from './font.js';
import { applyEffects } from './effects.js';

const CACHE = new WeakMap();

/** 渲染尺寸硬上限：Surface = Uint8ClampedArray(w*h*4)，一个 width=200000 的请求能吃掉 80GB */
export const MAX_PIXELS = 4e6;
export function fitSize(w, h) {
  let W = Math.max(64, Math.min(1600, Math.round(Number(w) || 960)));
  let H = Math.max(36, Math.min(1600, Math.round(Number(h) || 540)));
  const k = (W * H) / MAX_PIXELS;
  if (k > 1) { const sc = Math.sqrt(k); W = Math.max(64, Math.floor(W / sc)); H = Math.max(36, Math.floor(H / sc)); }
  return [W, H];
}



export const NOTE_COLORS = {
  1: [86, 196, 255],
  2: [110, 231, 160],
  3: [255, 92, 138],
  4: [255, 205, 96],
};
const COL = { bg: [10, 12, 17], line: [130, 205, 255], text: [214, 226, 238], dim: [140, 155, 172], panel: [8, 10, 14] };

function ctxOf(chart, info) {
  const key = `${(info && info.aspectRatio) || 16 / 9}|${(info && info.lineLength) || 6}`;
  let c = CACHE.get(chart);
  if (c && c.key === key) return c;
  // 宽高比兜底：负数/天文数字会让 height = w/aspect 变成负长度（Uint8ClampedArray 直接抛错）
  const a = Math.max(0.35, Math.min(4, Number((info && info.aspectRatio) || 16 / 9) || 16 / 9));
  const lineLength = Number((info && info.lineLength) || 6) * 675;
  const step = 0.05;
  const notes = chart.notes;
  // 时长必须走安全 reduce：NaN/超大时间的脏数据会让 new Array() 抛 RangeError 或 OOM
  const duration = Math.min(Math.max(1, chartDuration(notes)) + 2, MAX_PREVIEW_SEC);
  const n = Math.ceil(duration / step) + 2;
  const floors = chart.lines.map((l) => {
    const arr = new Float32Array(n);
    let acc = 0;
    for (let i = 1; i < n; i++) {
      acc += evalEvents(l.layers, (i - 0.5) * step, 'speedEvents') * SPEED_RATIO * step;
      arr[i] = acc;
    }
    return arr;
  });
  const floorAt = (li, sec) => {
    const arr = floors[li];
    if (!arr) return 0;
    const x = Math.max(0, sec) / step, i = Math.floor(x), f = x - i;
    if (i + 1 >= arr.length) return arr[arr.length - 1];
    return arr[i] * (1 - f) + arr[i + 1] * f;
  };
  const bins = new Array(Math.ceil(duration) + 1).fill(0);
  for (const nt of notes) {
    if (nt.isFake || !Number.isFinite(nt.sec)) continue;
    const i = Math.floor(nt.sec);
    if (i >= 0 && i < bins.length) bins[i]++; // 秒数可以乱写，下标必须夹
  }
  c = {
    key, a, lineLength, floorAt, step, bins,
    maxBin: bins.reduce((m, v) => (v > m ? v : m), 1), duration,
    totals: { notes: notes.length, fake: notes.filter((x) => x.isFake).length, lines: chart.lines.length },
  };
  CACHE.set(chart, c);
  return c;
}

function lineGeom(line, t) {
  let x = 0, y = 0, rot = 0, alpha = 0;
  for (const layer of line.layers) {
    x += evalSeries(layer.moveXEvents || [], t);
    y += evalSeries(layer.moveYEvents || [], t);
    rot += evalSeries(layer.rotateEvents || [], t);
    alpha += evalSeries(layer.alphaEvents || [], t);
  }
  return { x, y, rot: -rot, alpha: Math.max(0, Math.min(1, alpha / 255)) };
}

function colorAt(events, t, fallback) {
  for (const e of events || []) {
    if (e.st <= t && t <= e.et) {
      const s0 = Array.isArray(e.start) ? e.start : fallback;
      const e0 = Array.isArray(e.end) ? e.end : fallback;
      const span = e.et - e.st;
      const k = span <= 1e-9 ? 0 : Math.max(0, Math.min(1, (t - e.st) / span));
      return [s0[0] + (e0[0] - s0[0]) * k, s0[1] + (e0[1] - s0[1]) * k, s0[2] + (e0[2] - s0[2]) * k];
    }
  }
  return fallback;
}

function rotPt(dx, dy, deg) {
  const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return { x: dx * c - dy * s, y: dx * s + dy * c };
}

export function renderFrame(chart, info, t, opt = {}) {
  // 出参必须是数字：传错参数时给明确错误，而不是在 drawOverlay 里抛 "toFixed of undefined"
  const time = Number(t);
  if (!Number.isFinite(time)) throw new Error(`renderFrame: 时间必须是数字（收到 ${JSON.stringify(t)}）`);
  t = time;
  const ctx = ctxOf(chart, info);
  const [width, height] = fitSize(opt.width == null ? 960 : opt.width, (Number(opt.width) || 960) / ctx.a);
  const surf = new Surface(width, height);
  surf.clear(...COL.bg);
  const px = width / 1350, py = height / 900;
  const X = (xr) => (xr + 675) * px;
  const Y = (yr) => (450 - yr) * py;
  const showFake = opt.showFake !== false;
  const fakeAlpha = opt.maxFakeAlpha == null ? 0.13 : Number(opt.maxFakeAlpha);
  const margin = 60;
  let visibleLines = 0, drawnNotes = 0, fakeDrawn = 0;
  const onScreen = [];

  for (const line of chart.lines.slice().sort((l, r) => l.zOrder - r.zOrder)) {
    const g = lineGeom(line, t);
    const isTextLine = line.extended.textEvents.length > 0;
    const hiddenByUI = !!line.attachUI;
    const half = ctx.lineLength;
    const p0 = rotPt(-half, 0, g.rot), p1 = rotPt(half, 0, g.rot);
    const x0 = X(g.x + p0.x), y0 = Y(g.y + p0.y), x1 = X(g.x + p1.x), y1 = Y(g.y + p1.y);
    const bboxOk = !(Math.max(x0, x1) < -margin || Math.min(x0, x1) > width + margin
      || Math.max(y0, y1) < -margin || Math.min(y0, y1) > height + margin);
    if (isTextLine && g.alpha > 0.004) {
      // 文字线：按「最后命中的事件」取值（RPE 保持语义）
      let str = '';
      for (const e of line.extended.textEvents) {
        if (Number.isFinite(e.st) && e.st <= t) str = t <= e.et ? String(e.start || '') : String(e.end || '');
      }
      const ascii = String(str).replace(/[^\x20-\x7e]/g, ''); // 点阵字体只覆盖 ASCII
      if (ascii.trim()) {
        const scale = Math.max(1, Math.round(width / 640));
        const cx = X(g.x), cy = Y(g.y);
        const w = textWidth(ascii, scale);
        drawText(surf, ascii, cx - w / 2, cy - 5 * scale, scale, [255, 255, 255], Math.min(1, g.alpha));
      }
    }
    if (g.alpha > 0.004 && !isTextLine && !hiddenByUI && bboxOk) {
      visibleLines++;
      const lc = colorAt(line.extended.colorEvents, t, COL.line);
      const wpx = Math.max(1.6, 0.01 * 675 * px);
      surf.line(x0, y0, x1, y1, wpx, lc, Math.min(1, g.alpha));
      if (opt.showIds) drawText(surf, `L${line.index}`, Math.min(x0, x1) + 6, Math.min(y0, y1) - 10, 1, COL.dim, 0.8);
    }

    const hiddenByNegAlpha = g.alpha < 0;
    const incline = evalSeries(line.extended.inclineEvents || [], t);
    const incSin = Math.sin((incline * Math.PI) / 180);
    for (const n of line.notes) {
      if (hiddenByNegAlpha && !n.isFake) continue;
      const nt = n.sec, endT = Number.isFinite(n.endSec) ? n.endSec : nt;
      if (!Number.isFinite(nt)) continue;
      if (n.isFake && !showFake) continue;
      const isHold = n.type === 2;
      if (isHold ? t > endT + 0.05 : t > nt + 0.06) continue;
      if (t < nt - (Number.isFinite(n.visibleTime) ? n.visibleTime : 999999)) continue;
      const spd = n.speed || 1;
      const base = (ctx.floorAt(line.index, nt) - ctx.floorAt(line.index, t)) * 450 * spd;
      if (Math.abs(base) > 1600) continue;
      const yoff = n.yOffset * spd;
      const incVal = incSin === 0 ? 1 : 1 - incSin * ((base + yoff) / 360);
      const local = rotPt(n.x * incVal, base + yoff, g.rot);
      const above = n.above === 1;
      const sx = g.x + local.x, sy = above ? g.y + local.y : g.y - local.y;
      const rot = above ? g.rot : -g.rot;
      const wpx = 2 * NOTE_WIDTH_RATIO_BASE * 675 * (n.size || 1) * px;
      const hpx = wpx * 0.42;
      let alpha = Math.max(0, Math.min(1, n.alpha / 255));
      if (!isHold && t > nt) alpha *= Math.max(0, 1 - (t - nt) / 0.16); // prpr FADEOUT_TIME
      if (n.isFake) { alpha *= fakeAlpha; fakeDrawn++; }
      const cx = X(sx), cy = Y(sy);
      if (cx < -wpx || cx > width + wpx || cy < -wpx * 2 || cy > height + wpx * 2) continue;
      const color = NOTE_COLORS[n.type] || NOTE_COLORS[1];
      drawnNotes++;
      onScreen.push({ type: n.type, x: cx, y: cy });

      if (isHold) {
        const endBase = (ctx.floorAt(line.index, endT) - ctx.floorAt(line.index, t)) * 450 * spd;
        const tl = rotPt(n.x, endBase + yoff, g.rot);
        const tx = g.x + tl.x, ty = above ? g.y + tl.y : g.y - tl.y;
        const hx = cx, hy = cy, ex = X(tx), ey = Y(ty);
        const dx = ex - hx, dy = ey - hy, len = Math.hypot(dx, dy), hw = Math.max(2, wpx / 2);
        if (len > 1.5) {
          const ux = -dy / len, uy = dx / len;
          const q = [[hx + ux * hw, hy + uy * hw], [ex + ux * hw, ey + uy * hw],
            [ex - ux * hw, ey - uy * hw], [hx - ux * hw, hy - uy * hw]];
          surf.quad(q, color, alpha * 0.30);
          for (let i = 0; i < 4; i++) {
            const a2 = q[i], b2 = q[(i + 1) % 4];
            surf.line(a2[0], a2[1], b2[0], b2[1], 1.4, color, alpha * 0.85);
          }
        }
        // 头：随线旋转的胶囊
        const hh = hw * 0.62;
        const hp = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([dx2, dy2]) => {
          const p = rotPt(dx2, dy2, rot);
          return [hx + p.x, hy + p.y];
        });
        surf.quad(hp, color, Math.min(1, alpha * 1.2));
        const he1 = rotPt(-hw, 0, rot), he2 = rotPt(hw, 0, rot);
        surf.disc(hx + he1.x, hy + he1.y, hh, color, Math.min(1, alpha * 1.2));
        surf.disc(hx + he2.x, hy + he2.y, hh, color, Math.min(1, alpha * 1.2));
        surf.disc(ex, ey, hw * 0.5, color, alpha * 0.9);
      } else if (n.type === 4) {
        surf.disc(cx, cy, wpx / 2 * 0.60, color, alpha);
      } else if (n.type === 3) {
        surf.disc(cx, cy, wpx / 2 * 0.62, color, alpha);
        surf.disc(cx, cy, wpx / 2 * 0.26, COL.bg, alpha * 0.7);
      } else {
        const hw = wpx / 2, hh = hpx / 2;
        const pts = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([dx2, dy2]) => {
          const p = rotPt(dx2, dy2, rot);
          return [cx + p.x, cy + p.y];
        });
        surf.quad(pts, color, alpha);
      }
    }
  }

  const stats = {
    t, duration: ctx.duration, aspect: ctx.a, width, height,
    notes: ctx.totals.notes, fake: ctx.totals.fake, lines: ctx.totals.lines,
    visibleLines, drawnNotes, fakeDrawn, chord: chordAt(chart, t),
    bpm: chart.bpm ? chart.bpm.bpmAt(t) : 0,
  };
  // 后处理特效（extra.json），在调试叠层之前应用，保证调试信息清晰
  if (opt.effects && opt.effects.length) stats.effectsApplied = applyEffects(surf, opt.effects, t);
  if (opt.debug !== false) drawOverlay(surf, stats, ctx, onScreen);
  return { surface: surf, stats };
}

function chordAt(chart, t) {
  const near = chart.notes.filter((n) => !n.isFake && Number.isFinite(n.sec) && Math.abs(n.sec - t) < 0.05);
  if (!near.length) return 0;
  const by = new Map();
  for (const n of near) { const k = n.sec.toFixed(3); by.set(k, (by.get(k) || 0) + 1); }
  return Math.max(...by.values());
}

function drawOverlay(surf, s, ctx, onScreen) {
  const W = surf.w, H = surf.h, pad = 10, scale = 2, lh = 7 * scale + 6;
  const panelW = Math.min(W - pad * 2, 470), panelH = lh * 3 + pad * 2;
  fillRect(surf, pad, pad, panelW, panelH, COL.panel, 0.72);
  strokeRect(surf, pad, pad, panelW, panelH, [60, 74, 92], 0.8);
  let y = pad + pad;
  drawText(surf, `T ${s.t.toFixed(2)}S / ${s.duration.toFixed(1)}S   BPM ${Math.round(s.bpm)}`, pad + pad, y, scale, COL.text, 1);
  y += lh;
  drawText(surf, `NOTES ${s.notes} (REAL ${s.notes - s.fake} / FAKE ${s.fake})   LINES ${s.lines} (VIS ${s.visibleLines})`, pad + pad, y, scale, COL.text, 1);
  y += lh;
  drawText(surf, `ON SCREEN ${s.drawnNotes}   CHORD@T ${s.chord}   ASPECT ${s.aspect.toFixed(3)}`, pad + pad, y, scale, COL.dim, 1);

  const legend = [['TAP', 1], ['HOLD', 2], ['FLICK', 3], ['DRAG', 4]];
  const lw = 92, lhh = 15, lx = W - pad - lw, ly = pad + 2;
  fillRect(surf, lx - 6, ly - 4, lw + 12, legend.length * lhh + 8, COL.panel, 0.72);
  legend.forEach(([name, type], i) => {
    const yy = ly + i * lhh;
    fillRect(surf, lx, yy + 3, 9, 9, NOTE_COLORS[type], 0.95);
    drawText(surf, name, lx + 15, yy + 1, 1, COL.text, 0.95);
  });

  const tbH = 26, tbY = H - tbH - 6, tbX = pad, tbW = W - pad * 2;
  fillRect(surf, tbX, tbY, tbW, tbH, COL.panel, 0.72);
  const innerX = tbX + 6, innerY = tbY + 6, innerW = tbW - 12, innerH = tbH - 12;
  const bins = ctx.bins, n = bins.length;
  for (let i = 0; i < n; i++) {
    const h = Math.max(1, Math.round((bins[i] / ctx.maxBin) * innerH));
    const x = innerX + Math.round((i / n) * innerW);
    fillRect(surf, x, innerY + innerH - h, Math.max(1, Math.round(innerW / n) - 1), h, [70, 120, 160], 0.75);
  }
  const mx = innerX + Math.round(Math.min(1, Math.max(0, s.t / Math.max(1, ctx.duration))) * innerW);
  surf.line(mx, tbY + 2, mx, tbY + tbH - 2, 2, [255, 120, 120], 1);
  drawText(surf, `${s.t.toFixed(2)}S`, Math.min(W - 62, mx + 4), tbY + 4, 1, [255, 170, 170], 1);

  const counts = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const n2 of onScreen) counts[n2.type] = (counts[n2.type] || 0) + 1;
  let cy = tbY - 16;
  for (const type of [1, 2, 3, 4]) {
    drawText(surf, `T${type} ${counts[type]}`, pad + 4, cy, 1, NOTE_COLORS[type], 0.95);
    cy -= 10;
  }
}

export function renderStrip(chart, info, t0, t1, count = 6, opt = {}) {
  const n = Math.max(1, Math.min(120, Math.round(Number(count) || 1)));
  const cols = Math.max(1, Math.min(20, Math.round(Number(opt.cols) || 2)));
  const rows = Math.ceil(n / cols);
  const ar = Math.max(0.35, Math.min(4, Number((info && info.aspectRatio) || 16 / 9) || 16 / 9));
  // 先按上限缩放单帧，保证 cols*rows 张图叠加后也不会爆内存
  const [fw, fh] = fitSize(Number(opt.width) || 640, (Number(opt.width) || 640) / ar);
  const gap = 8;
  const [W, H] = fitSize(cols * fw + (cols + 1) * gap, rows * fh + (rows + 1) * gap);
  const out = new Surface(W, H);
  out.clear(20, 23, 29);
  const stats = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? t0 : t0 + ((t1 - t0) * i) / (n - 1);
    const f = renderFrame(chart, info, t, { ...opt, width: fw });
    const ox = gap + (i % cols) * (fw + gap), oy = gap + Math.floor(i / cols) * (fh + gap);
    for (let y2 = 0; y2 < fh; y2++) {
      for (let x2 = 0; x2 < fw; x2++) {
        const si = (y2 * fw + x2) * 4, di = ((oy + y2) * W + ox + x2) * 4;
        out.data[di] = f.surface.data[si];
        out.data[di + 1] = f.surface.data[si + 1];
        out.data[di + 2] = f.surface.data[si + 2];
        out.data[di + 3] = 255;
      }
    }
    stats.push(f.stats);
  }
  return { surface: out, stats, size: { W, H } };
}

/**
 * M6 Host 数据通道：只读 HTTP 路由，供浏览器面板使用。
 *   GET /phira/list?dir=           目录浏览
 *   GET /phira/chart?path=         谱面数据 + 校验 + 难度 + 曲线
 *   GET /phira/sheet?path=&t0=&t1=&n=&w=&debug=&fake=  帧序列图（雪碧图）
 *   GET /phira/frame?path=&t=&w=   单帧 PNG
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SFX_DIR = path.join(HERE, '..', 'assets', 'sfx');
import path from 'node:path';
import { normalizeChart, chartDuration, MAX_PREVIEW_SEC } from './rpe.js';
import { validate } from './validate.js';
import { predictDifficulty, stats, playability } from './analyze.js';
import { renderStrip, renderFrame } from './render.js';
import { encodePNG } from './raster.js';
import { resolveSafe, defaultDir, platformInfo } from './paths.js';
import { getPanelState } from './panel-state.js';
import fsStat from 'node:fs';

function sendJSON(res, obj, status = 200) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendPNG(res, buf, headers = {}) {
  res.writeHead(200, {
    'content-type': 'image/png',
    'content-length': buf.length,
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(buf);
}


/**
 * 安全拼接谱面目录内的资源文件名（info.yml 的 chart/music/illustration 是用户可控字符串）：
 * 拒绝绝对路径与 `../` 逃逸，避免 `/phira/music?path=某谱面` 读到根目录外的任意文件。
 */
function safeJoin(baseDir, name) {
  if (!name) return null;
  const raw = String(name).trim();
  if (!raw || raw.includes('\0')) return null;
  if (path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw)) return null;
  const full = path.resolve(baseDir, raw);
  const base = path.resolve(baseDir) + path.sep;
  return full.startsWith(base) ? full : null;
}

function loadChartAt(p) {
  const dir = resolveSafe(p);
  const st = fs.statSync(dir);
  let chartFile = dir, infoPath = path.join(dir, 'info.yml');
  if (st.isDirectory()) {
    let info = {};
    if (fs.existsSync(infoPath)) {
      for (const line of fs.readFileSync(infoPath, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
        if (m) info[m[1]] = m[2].trim();
      }
    }
    const cands = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.json'));
    const chartSafe = info.chart ? safeJoin(dir, info.chart) : null;
    const preferred = chartSafe && fs.existsSync(chartSafe) ? chartSafe : null;
    chartFile = preferred || cands.map((f) => path.join(dir, f)).find((f) => {
      const head = fs.readFileSync(f, 'utf8').slice(0, 2000);
      return head.includes('"judgeLineList"');
    });
    if (!chartFile) throw new Error('目录里找不到 RPE 谱面');
    const json = JSON.parse(fs.readFileSync(chartFile, 'utf8'));
    return { dir, info, chartFile, json };
  }
  const info = {};
  if (fs.existsSync(infoPath)) {
    for (const line of fs.readFileSync(infoPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
      if (m) info[m[1]] = m[2].trim();
    }
  }
  return { dir: path.dirname(dir), info, chartFile: dir, json: JSON.parse(fs.readFileSync(dir, 'utf8')) };
}

/** 渲染用的 info 数值：不合法的 aspectRatio 会让 height = w/aspect 变成负数或天文数字 */
function numericInfo(info) {
  const num = (v, d) => { const x = Number(v); return Number.isFinite(x) ? x : d; };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  return {
    aspectRatio: clamp(num(info.aspectRatio, 16 / 9), 0.35, 4) || 16 / 9,
    lineLength: clamp(num(info.lineLength, 6), 0.5, 20),
    forceAspectRatio: String(info.forceAspectRatio).toLowerCase() === 'true',
  };
}

/** 查询参数：NaN/超界一律回落并夹取（避免 400 泄露 Node 内部报错，或返回 x-cols=NaN） */
function numParam(sp, key, def, min, max) {
  const raw = sp.get(key);
  const v = raw == null || raw === '' ? def : Number(raw);
  if (!Number.isFinite(v)) return def;
  return Math.max(min, Math.min(max, v));
}

export function seriesOf(chart) {
  const notes = chart.notes.filter((n) => !n.isFake && Number.isFinite(n.sec));
  const dur = Math.min(Math.max(1, chartDuration(chart.notes)), MAX_PREVIEW_SEC);
  const len = Math.ceil(dur) + 1;
  const density = new Array(len).fill(0);
  const chord = new Array(len).fill(0);
  const byT = new Map();
  for (const n of notes) {
    // 下标必须夹取：音符秒数是可以乱写的（[1000000,0,1]），
    // density[Math.floor(sec)]++ 会造出 33 万元素的数组，客户端展开就栈溢出 → 面板白屏
    const i = Math.floor(n.sec);
    if (i >= 0 && i < density.length) density[i]++;
    const k = Math.round(n.sec * 1000);
    byT.set(k, (byT.get(k) || 0) + 1);
  }
  for (const [k, v] of byT) {
    const t = Math.floor(k / 1000);
    if (t >= 0 && t < chord.length && v > chord[t]) chord[t] = v;
  }
  return { duration: dur, density, chord };
}

export function registerRoutes(webServer, ctx, helpers) {
  const routes = [];
  const add = (route) => {
    const dispose = webServer.register(route);
    routes.push(dispose);
  };

  /* 按键音效（随插件分发，跨平台自包含） */
  add({
    kind: 'exact',
    path: '/phira/sfx',
    handler(req, res) {
      try {
        const url = new URL(req.url, 'http://x');
        const name = (url.searchParams.get('name') || '').replace(/[^a-z]/gi, '');
        const f = path.join(SFX_DIR, name + '.ogg');
        if (!name || !fs.existsSync(f)) { sendJSON(res, { ok: false, error: '没有该音效' }, 404); return; }
        const buf = fs.readFileSync(f);
        res.writeHead(200, { 'content-type': 'audio/ogg', 'content-length': buf.length, 'cache-control': 'public, max-age=3600' });
        res.end(buf);
      } catch (e) {
        sendJSON(res, { ok: false, error: String(e.message || e) }, 400);
      }
    },
  });

  /* 背景音乐（支持 Range，便于拖动） */
  add({
    kind: 'exact',
    path: '/phira/music',
    handler(req, res) {
      try {
        const url = new URL(req.url, 'http://x');
        const t = loadChartAt(url.searchParams.get('path'));
        const cands = [(t.info && t.info.music) || ''].filter(Boolean);
        let full = null;
        for (const c of cands) {
          const f = safeJoin(t.dir, c);
          if (f && fs.existsSync(f)) { full = f; break; }
        }
        if (!full) {
          const a = fs.readdirSync(t.dir).find((x) => /\.(mp3|ogg|wav)$/i.test(x));
          if (a) full = path.join(t.dir, a);
        }
        if (!full) { sendJSON(res, { ok: false, error: '没有音频文件' }, 404); return; }
        const stat = fs.statSync(full);
        const ext = path.extname(full).toLowerCase();
        const type = ext === '.mp3' ? 'audio/mpeg' : ext === '.ogg' ? 'audio/ogg' : ext === '.wav' ? 'audio/wav' : 'application/octet-stream';
        const range = req.headers && req.headers.range;
        if (range) {
          const m = /bytes=(\d*)-(\d*)/.exec(range);
          const start = m && m[1] ? Number(m[1]) : 0;
          const end = m && m[2] ? Math.min(Number(m[2]), stat.size - 1) : stat.size - 1;
          if (start >= stat.size) { res.writeHead(416, { 'content-range': `bytes */${stat.size}` }); res.end(); return; }
          const buf = fs.readFileSync(full).subarray(start, end + 1);
          res.writeHead(206, { 'content-type': type, 'content-range': `bytes ${start}-${end}/${stat.size}`, 'accept-ranges': 'bytes', 'content-length': buf.length });
          res.end(buf);
          return;
        }
        const buf = fs.readFileSync(full);
        res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': buf.length });
        res.end(buf);
      } catch (e) {
        sendJSON(res, { ok: false, error: String(e.message || e) }, 400);
      }
    },
  });

  /* 曲绘/背景图（面板用来铺背景） */
  add({
    kind: 'exact',
    path: '/phira/bg',
    handler(req, res) {
      try {
        const url = new URL(req.url, 'http://x');
        const p = resolveSafe(url.searchParams.get('path'));
        const t = loadChartAt(p);
        const name = (t.info && (t.info.illustration || t.info.background)) || '';
        const cands = [name, 'background.png', 'background.jpg'].filter(Boolean);
        for (const c of cands) {
          const full = safeJoin(t.dir, c);
          if (full && fs.existsSync(full)) {
            const buf = fs.readFileSync(full);
            const ext = path.extname(full).toLowerCase();
            const type = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
            res.writeHead(200, { 'content-type': type, 'content-length': buf.length, 'cache-control': 'no-store' });
            res.end(buf);
            return;
          }
        }
        sendJSON(res, { ok: false, error: '没有曲绘' }, 404);
      } catch (e) {
        sendJSON(res, { ok: false, error: String(e.message || e) }, 400);
      }
    },
  });

  /* 面板状态：AI 设置过的路径 + 谱面文件 mtime（用于自动刷新） */
  add({
    kind: 'exact',
    path: '/phira/state',
    handler(req, res) {
      try {
        const st = getPanelState();
        let mtime = 0, size = 0, chartFile = '';
        if (st.path) {
          try {
            const t = loadChartAt(st.path);
            const s1 = fsStat.statSync(t.chartFile);
            mtime = s1.mtimeMs; size = s1.size; chartFile = t.chartFile;
          } catch { /* 路径暂时不可读 */ }
        }
        sendJSON(res, { ok: true, ...st, chartFile, mtime, size });
      } catch (e) {
        sendJSON(res, { ok: false, error: String(e.message || e) }, 400);
      }
    },
  });

  /* 平台信息（面板用来提示默认目录） */
  add({
    kind: 'exact',
    path: '/phira/info',
    handler(req, res) {
      try { sendJSON(res, { ok: true, ...platformInfo() }); }
      catch (e) { sendJSON(res, { ok: false, error: String(e.message || e) }, 400); }
    },
  });

  /* 目录浏览 */
  add({
    kind: 'exact',
    path: '/phira/list',
    handler(req, res) {
      try {
        const url = new URL(req.url, 'http://x');
        const dir = resolveSafe(url.searchParams.get('dir') || defaultDir());
        const entries = fs.readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => {
            const full = path.join(dir, e.name);
            let hasChart = false;
            try {
              hasChart = fs.readdirSync(full).some((f) => f.endsWith('.json'));
            } catch { /* ignore */ }
            return { name: e.name, path: full, hasChart };
          })
          .slice(0, 300);
        sendJSON(res, { ok: true, dir, parent: path.dirname(dir), entries });
      } catch (e) {
        sendJSON(res, { ok: false, error: String(e.message || e) }, 400);
      }
    },
  });

  /* 谱面 + 校验 + 难度 + 曲线 */
  add({
    kind: 'exact',
    path: '/phira/chart',
    handler(req, res) {
      try {
        const url = new URL(req.url, 'http://x');
        const t = loadChartAt(url.searchParams.get('path'));
        const chart = normalizeChart(t.json);
        const diffNum = Number(t.info && t.info.difficulty);
        const v = validate(chart, {
          difficulty: Number.isFinite(diffNum) ? diffNum : null,
          strict: !!(t.info && String(t.info.strict) === 'true'),
          rpe170Speed: String(t.info && t.info.useRpe170Speed).toLowerCase() === 'true',
        });
        const s = stats(chart);
        const d = predictDifficulty(chart);
        const pl = playability(chart, {});
        const series = seriesOf(chart);
        let plan = null;
        const planPath = path.join(t.dir, 'plan.json');
        if (fs.existsSync(planPath)) {
          try { plan = JSON.parse(fs.readFileSync(planPath, 'utf8')); } catch { /* ignore */ }
        }
        sendJSON(res, {
          ok: true,
          dir: t.dir,
          chartFile: t.chartFile,
          info: t.info,
          stats: {
            notes: s.notes, real: s.real, fake: s.fake, lines: s.lines, events: s.events,
            duration: s.duration, byType: s.byType, densityAvg: s.densityAvg, densityPeak: s.densityPeak,
            maxChord: s.maxChord, dragRatio: s.dragRatio,
          },
          validate: { ok: v.ok, counts: v.counts, issues: v.issues.slice(0, 200) },
          difficulty: { predicted: d.predicted, confidence: d.confidence, reasons: d.reasons },
          playability: pl.items,
          series,
          plan,
        });
      } catch (e) {
        sendJSON(res, { ok: false, error: String(e.message || e) }, 400);
      }
    },
  });


  /* 紧凑渲染数据（供浏览器本地 60fps 渲染） */
  add({
    kind: 'exact',
    path: '/phira/data',
    handler(req, res) {
      try {
        const url = new URL(req.url, 'http://x');
        const t = loadChartAt(url.searchParams.get('path'));
        const chart = normalizeChart(t.json);
        const info = numericInfo(t.info);
        const ev = (e) => [e.st, e.et, Number(e.start) || 0, Number(e.end) || 0, e.easingType | 0, e.easingLeft || 0, e.easingRight == null ? 1 : e.easingRight];
        const lines = chart.lines.map((l) => ({
          z: l.zOrder,
          tex: l.texture !== 'line.png' ? 1 : 0,
          txt: l.extended.textEvents.length ? 1 : 0,
          ui: l.attachUI || '',
          col: (l.extended.colorEvents || []).map((e) => [e.st, e.et, e.start, e.end]),
          inc: (l.extended.inclineEvents || []).map(ev),
          text: (l.extended.textEvents || []).map((e) => [e.st, e.et, String(e.start == null ? '' : e.start), String(e.end == null ? '' : e.end)]),
          layers: l.layers.map((ly) => ({
            alpha: (ly.alphaEvents || []).map(ev),
            moveX: (ly.moveXEvents || []).map(ev),
            moveY: (ly.moveYEvents || []).map(ev),
            rotate: (ly.rotateEvents || []).map(ev),
            speed: (ly.speedEvents || []).map(ev),
          })),
          notes: l.notes.map((n) => ({
            t: n.sec, te: Number.isFinite(n.endSec) ? n.endSec : n.sec,
            x: n.x, a: n.above, f: n.isFake ? 1 : 0, sz: n.size, sp: n.speed,
            yo: n.yOffset, al: n.alpha, vt: n.visibleTime, ty: n.type, hs: n.hitsound || '',
          })),
        }));
        const duration = Math.min(Math.max(1, chartDuration(chart.notes)), MAX_PREVIEW_SEC);
        sendJSON(res, {
          ok: true,
          duration,
          info,
          bpm: chart.bpm.points.map((p) => ({ b: p.beat, bpm: p.bpm })),
          lines,
          stats: { notes: chart.notes.length, lines: chart.lines.length },
        });
      } catch (e) {
        sendJSON(res, { ok: false, error: String(e.message || e) }, 400);
      }
    },
  });

  /* 帧序列（雪碧图） */
  add({
    kind: 'exact',
    path: '/phira/sheet',
    handler(req, res) {
      try {
        const url = new URL(req.url, 'http://x');
        const q = url.searchParams;
        const t = loadChartAt(q.get('path'));
        const chart = normalizeChart(t.json);
        const info = numericInfo(t.info);
        const t0 = numParam(q, 't0', 0, 0, MAX_PREVIEW_SEC);
        const t1 = numParam(q, 't1', t0 + 4, 0, MAX_PREVIEW_SEC);
        const n = Math.round(numParam(q, 'n', 48, 1, 120));
        const w = Math.round(numParam(q, 'w', 420, 160, 1280));
        const cols = Math.round(numParam(q, 'cols', Math.ceil(Math.sqrt(n)), 1, 20));
        const debug = q.get('debug') === '1';
        const showFake = q.get('fake') !== '0';
        const r = renderStrip(chart, info, t0, Math.max(t0 + 0.01, t1), n, { cols, width: w, debug, showFake });
        const rows = Math.ceil(n / cols);
        const fw = w, fh = Math.round(w / info.aspectRatio);
        sendPNG(res, encodePNG(r.surface), {
          'x-frames': String(n), 'x-cols': String(cols), 'x-rows': String(rows),
          'x-frame-w': String(fw), 'x-frame-h': String(fh), 'x-gap': '8',
          'access-control-expose-headers': 'x-frames,x-cols,x-rows,x-frame-w,x-frame-h,x-gap',
        });
      } catch (e) {
        sendJSON(res, { ok: false, error: String(e.message || e) }, 400);
      }
    },
  });

  /* 单帧 */
  add({
    kind: 'exact',
    path: '/phira/frame',
    handler(req, res) {
      try {
        const url = new URL(req.url, 'http://x');
        const q = url.searchParams;
        const t = loadChartAt(q.get('path'));
        const chart = normalizeChart(t.json);
        const info = numericInfo(t.info);
        const time = Number(q.get('t') || 0);
        const w = Math.max(200, Math.min(1600, Number(q.get('w') || 900)));
        const debug = q.get('debug') === '1';
        const f = renderFrame(chart, info, time, { width: w, debug, showFake: q.get('fake') !== '0' });
        sendPNG(res, encodePNG(f.surface));
      } catch (e) {
        sendJSON(res, { ok: false, error: String(e.message || e) }, 400);
      }
    },
  });

  return () => routes.forEach((d) => d && d());
}

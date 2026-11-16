/**
 * 一键生成器：MIDI → 规划 → 音符 + 事件 → chart.json + info.yml
 * 目的：AI 不必自己重写生成脚本（省大量 token），也保证默认规则（静态主线/无倾角/左右手分侧/密度封顶）一致。
 */
import fs from 'node:fs';
import path from 'node:path';
import { emptyChart, normalizeChart, beats, toTriple, NOTE_WIDTH_RATIO_BASE, RPE_WIDTH } from './rpe.js';
import { addNotes, writeChart, writeInfo, applyPattern, applyAIMark, fixEventOverlaps, insertDragChains } from './author.js';
import { planChart, materializePlan, relaxGenerated, applySectionFx } from './plan.js';
import { parseMidi } from './midi.js';
import { quantileX } from './distribution.js';
import { validate } from './validate.js';
import { predictDifficulty } from './analyze.js';

/** 音符绘制宽（RPE 像素），与 validate/analyze 同口径 */
export const NOTE_W = 2 * NOTE_WIDTH_RATIO_BASE * (RPE_WIDTH / 2); // ≈177.9
/** 同线同刻「抢判定」/ 长条内嵌的安全横向间距：音符宽 × 1.2（与 validate 的 collisionRatio 一致） */
export const SAFE_DX = NOTE_W * 1.2; // ≈213.4
const clampX = (x) => Math.max(-560, Math.min(560, Math.round(x)));
const sameSide = (a, b) => (a >= 0) === (b >= 0);

/** 按间隔分级的最大横移（手感硬指标：<0.3s 限 400、<0.5s 限 300） */
function jumpLimit(sec) {
  if (!(sec > 0)) return 560;
  if (sec < 0.3) return 320;
  if (sec < 0.5) return 300;
  return 420;
}

/**
 * 手感安全网（用与校验器一致的秒/拍口径，且把「长条身体」纳入判断）：
 * 撞键 / 同点连打 / 大跳 / 长条内嵌 / 长条重叠。构造阶段已经满足，这里只兜底。
 */
export function fixHandFeel(chart, bpm, difficulty, cap) {
  const spb = 60 / bpm;
  const bpmIdx = beats;
  const line = chart.judgeLineList[0];
  const beatOfN = (n) => bpmIdx(n && n.startTime);
  const endBeatOfN = (n) => (n.type === 2 ? bpmIdx(n.endTime) : beatOfN(n));
  for (let pass = 0; pass < 40; pass++) {
    const arr = (line.notes || []).filter((n) => !n._drop)
      .sort((a, b) => beatOfN(a) - beatOfN(b) || Number(a.positionX) - Number(b.positionX));
    let changed = 0;
    // 1) 长条重叠：后者把前一条收短（至少留 0.5 拍）
    const holds = arr.filter((n) => n.type === 2);
    for (let i = 0; i < holds.length; i++) {
      for (let j = i + 1; j < holds.length; j++) {
        const a = holds[i], b = holds[j];
        const bStart = beatOfN(b);
        if (bStart >= endBeatOfN(a) - 1e-6) continue;
        if (!(Math.abs(Number(a.positionX) - Number(b.positionX)) < SAFE_DX)) continue;
        const newEnd = bStart - 0.25;
        if (newEnd - beatOfN(a) >= 0.5) { a.endTime = toTriple(newEnd); changed++; }
        else { b._drop = true; changed++; }
      }
    }
    // 2) 相邻按键：长条内嵌 / 撞键 / jack / 大跳
    for (let i = 1; i < arr.length; i++) {
      const a = arr[i - 1], b = arr[i];
      if (a._drop || b._drop) continue;
      const aB = beatOfN(a), bB = beatOfN(b);
      const dt = (bB - aB) * spb;
      const aEndB = endBeatOfN(a);
      let dx = Math.abs(Number(b.positionX) - Number(a.positionX));
      // 2a) b 落在 a 的长条身体内且同车道：把 b 挪到另一侧（挪不开就丢）
      if (a.type === 2 && bB > aB + 1e-6 && bB < aEndB - 1e-6 && dx < SAFE_DX) {
        const away = Number(a.positionX) >= 0 ? -1 : 1;
        const nx = clampX(Number(a.positionX) + away * (SAFE_DX + 20));
        if (!sameSide(nx, Number(a.positionX)) || Math.abs(nx - Number(a.positionX)) >= SAFE_DX) b.positionX = nx;
        else b._drop = true;
        changed++; continue;
      }
      if (b.type === 4) continue; // Drag 不用按下，不参与撞键/连打判定（手指负担另算）
      // 2b) 撞键：<140ms 且横向没让开 → 挪开，挪不开就丢
      if (dt > 0 && dt < 0.14 && dx < SAFE_DX) {
        const away = Number(b.positionX) >= Number(a.positionX) ? 1 : -1;
        const nx = clampX(Number(a.positionX) + away * (SAFE_DX + 20));
        if (Math.abs(nx - Number(a.positionX)) >= SAFE_DX) { b.positionX = nx; changed++; }
        else { b._drop = true; changed++; }
        continue;
      }
      // 2c) jack：<0.6s 同位置连点（长条刚结束时再点同位置是正常手法）
      const holdRelease = a.type === 2 && bB >= aEndB - 0.03;
      dx = Math.abs(Number(b.positionX) - Number(a.positionX));
      if (dt > 0 && dt < 0.6 && dx < 70 && !holdRelease) {
        const away = Number(b.positionX) >= Number(a.positionX) ? 1 : -1;
        b.positionX = clampX(Number(a.positionX) + away * 140);
        changed++; continue;
      }
      // 2d) 大跳（只对同一只手）
      if (dt > 0 && dt < 0.3 && sameSide(Number(a.positionX), Number(b.positionX))
        && Math.abs(Number(b.positionX) - Number(a.positionX)) > jumpLimit(dt)) {
        const away = Number(b.positionX) >= Number(a.positionX) ? 1 : -1;
        b.positionX = clampX(Number(a.positionX) + away * jumpLimit(dt));
        changed++;
      }
    }
    // 3) 0.15s 窗口内「同一只手」需要按的音符超过上限 → 丢掉最外侧那个
    const press = arr.filter((n) => !n._drop && n.type !== 4);
    for (let i = 0; i < press.length; i++) {
      const t0 = beatOfN(press[i]);
      const win = press.filter((n) => { const t = beatOfN(n); return t >= t0 && t <= t0 + 0.15 / spb; });
      for (const side of [-1, 1]) {
        const sw = win.filter((n) => (Number(n.positionX) < 0 ? -1 : 1) === side);
        if (sw.length > cap) {
          sw.sort((a, b) => Math.abs(Number(b.positionX)) - Math.abs(Number(a.positionX)));
          sw[0]._drop = true; changed++;
        }
      }
    }
    if (changed) line.notes = line.notes.filter((n) => !n._drop);
    else break;
  }
}

/**
 * MIDI 起音 → 音符规格（手感优先，构造即合规）：
 * - 前置留白 introSec（默认 2s），首个音符不会贴脸；
 * - 长条时长自动收在下一个音符之前，且同一时刻只有一根长条；
 * - 长条按住期间只放 Drag（不用按下、按住长条的手指顺手就判到），Tap/Flick 需要另一只手；
 * - 双押只在整拍、无长条激活、间隔 ≥0.45s 时出现，且两键间距 ≥SAFE_DX；
 * - 相邻横移按间隔分级限速（<0.3s 限 320、<0.5s 限 300）、防同位置连打；
 * - 间隔 <150ms 的经过音一律转 Drag 并贴住上一个音符的 x。
 */
function buildMidiSpecs(track, bpm, opt = {}) {
  const grid = Math.max(0.0625, Number(opt.gridBeat == null ? 0.25 : opt.gridBeat));
  const phraseBeats = Math.max(1, Number(opt.phraseBeat == null ? 4 : opt.phraseBeat));
  const holdBeats = Number(opt.holdBeats == null ? 1.0 : opt.holdBeats);
  const spb = 60 / bpm;
  const offsetBeats = Number(opt.offsetSec || 0) / spb;
  const introBeats = Number(opt.introSec == null ? 2 : opt.introSec) / spb;
  const cap = Math.max(2, Number(opt.maxFingers == null ? 2 : opt.maxFingers));
  const melodyOnly = opt.melodyOnly === true; // 只跟主旋律：不叠和弦、不追内声部

  // 量化到网格（同格多音合并）
  const map = new Map();
  for (const n of track) {
    if (!Number.isFinite(n.startSec) || !Number.isFinite(n.pitch)) continue;
    const qb = Math.round(n.startSec / spb / grid) * grid;
    const key = qb.toFixed(6);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(n);
  }
  const keys = [...map.keys()].map(Number).sort((a, b) => a - b);
  if (!keys.length) return [];

  // 每个乐句的音域（音高 → 内→外）
  const ranges = new Map();
  for (const qb of keys) {
    const pi = Math.floor(qb / phraseBeats);
    for (const n of map.get(qb.toFixed(6))) {
      const r = ranges.get(pi) || { lo: Infinity, hi: -Infinity };
      r.lo = Math.min(r.lo, n.pitch); r.hi = Math.max(r.hi, n.pitch);
      ranges.set(pi, r);
    }
  }

  // 音高 → 横向位置：**乐句内每个音的名次 → 参考 |x| 分位**（保序 + 分布对齐）
  // 只按 (pitch-lo)/span 会受"旋律偏高的音多"影响：实测 mean|x|=318、>400 占 32%，
  // 参考 24 谱是 235 / 17.9%。按"每个音的名次"取分位，分布就天然对齐（同音高的重复音也会错开）。
  const fOf = new Map(); // note → 名次分位 0..1
  {
    const perPhrase = new Map();
    for (const qb of keys) {
      const pi = Math.floor(qb / phraseBeats);
      if (!perPhrase.has(pi)) perPhrase.set(pi, []);
      for (const n of map.get(qb.toFixed(6))) perPhrase.get(pi).push({ n, qb });
    }
    for (const list of perPhrase.values()) {
      list.sort((a, b) => a.n.pitch - b.n.pitch || a.qb - b.qb);
      const den = Math.max(1, list.length - 1);
      list.forEach((it, i) => fOf.set(it.n, list.length === 1 ? 0.5 : i / den));
    }
  }
  // ×0.85：fixHandFeel 会把撞键/连打的音符往外推，实测会把 mean|x| 从 ~235 顶到 ~287；
  // 预留这点余量后落回参考区间（参考 mean 235 / >400 17.9%）
  const laneOfF = (f) => Math.max(90, Math.min(490, quantileX(0.1 + 0.88 * (f == null ? 0.5 : f)) * 0.85));

  const specs = [];
  let lastX = 0;            // 上一「需要手指」音符的 x
  let lastBeat = -Infinity; // 上一音符（含 Drag）的拍
  let holdEnd = -Infinity;  // 当前长条结束拍
  let lastPitch = null;     // 上一个单音的音高（重复 = 重音 → 红键）
  let holdX = 0;
  let phrase = null, soundPhrase = -1, side = -1;
  let denseIdx = 0; // 密集段内换手计数

  // 音高 → 横向位置：**乐句内音高名次 → 参考 |x| 分位**（保序 + 分布对齐）
  // 只按 (pitch-lo)/span 会受"旋律偏高的音多"影响：实测 mean|x|=318、>400 占 32%，
  // 参考 24 谱是 235 / 17.9%。改成按名次取分位，分布就天然对齐。
  const phrasePitches = new Map();
  for (const qb of keys) {
    const pi = Math.floor(qb / phraseBeats);
    if (!phrasePitches.has(pi)) phrasePitches.set(pi, new Set());
    const set = phrasePitches.get(pi);
    for (const n of map.get(qb.toFixed(6))) set.add(n.pitch);
  }
  const rankOf = new Map();
  for (const [pi, set] of phrasePitches) {
    const ps = [...set].sort((a, b) => a - b);
    const m = new Map();
    ps.forEach((p, i) => m.set(p, ps.length === 1 ? 0.5 : i / (ps.length - 1)));
    rankOf.set(pi, m);
  }
  const laneOf = (pi, pitch) => {
    const f = rankOf.get(pi) ? rankOf.get(pi).get(pitch) : 0.5;
    return Math.max(90, Math.min(490, quantileX(0.1 + 0.88 * (f == null ? 0.5 : f))));
  };

  for (let i = 0; i < keys.length; i++) {
    const qb = keys[i];
    const beat = qb + offsetBeats;
    if (beat + 1e-9 < introBeats) continue; // 前奏留白
    const g = map.get(qb.toFixed(6)).slice().sort((a, b) => a.pitch - b.pitch);
    const gap = (beat - lastBeat) * spb;

    // 长条按住期间：只放 Drag，贴长条车道（不用按下，按住的手指顺手就判到）
    if (beat < holdEnd - 1e-6) {
      if (beat - lastBeat > 1e-6) { specs.push({ beat, type: 4, x: holdX }); lastBeat = beat; }
      continue;
    }

    const pi = Math.floor(qb / phraseBeats);
    if (pi !== phrase) { phrase = pi; soundPhrase++; side = soundPhrase % 2 === 0 ? -1 : 1; }

    // 经过音 → 黄键（Drag）：**只取"非整拍 + 间隔短"的过路音**，贴住上一个音符的 x。
    // 参考谱面 Drag 占 24.9%。只放宽阈值会把整首变成黄键流（实测 84%）——
    // 整拍上的音是旋律骨干，必须留 Tap；弱位上的短音才是"划过去"的那一类。
    const onBeatNow = Math.abs(beat - Math.round(beat)) < 1e-6;
    // 试玩反馈：散落的黄键太多、手感碎 → 不再把"经过音"降级成黄键，黄键只以链的形式补（见 insertDragChains）
    if (false && gap > 0 && gap < (melodyOnly ? 0.20 : 0.18) && !onBeatNow) {
      specs.push({ beat, type: 4, x: lastX });
      lastBeat = beat;
      continue;
    }

    // 双押：仅整拍 + 间隔 ≥0.45s + 上限允许
    const chordOk = !melodyOnly && g.length >= 2 && cap >= 2 && gap > 0.45 && Math.abs(beat - Math.round(beat)) < 1e-6;
    if (chordOk) {
      const lo = Math.min(510, Math.max(130, laneOfF(fOf.get(g[0]))));
      const hi = Math.min(510, Math.max(130, laneOfF(fOf.get(g[g.length - 1]))));
      let xl = -Math.round(lo), xr = Math.round(hi);
      if (xr - xl < SAFE_DX) { // 两键挨太近 → 向外撑开
        const d = SAFE_DX + 20;
        xl = -Math.round(d / 2); xr = Math.round(d / 2);
      }
      if (gap > 0 && gap < 0.6 && Math.abs(xl - lastX) < 70 && Math.abs(xr - lastX) < 70) {
        const away = lastX >= 0 ? -1 : 1; // 整组往远离上一音符的方向挪
        xl = clampX(xl + away * 140);
        xr = clampX(xr + away * 140);
      }
      specs.push({ beat, type: 1, x: xl });
      specs.push({ beat, type: 1, x: xr });
      lastX = lastX >= 0 ? xr : xl;
      lastBeat = beat;
      continue;
    }

    // 单音：取该格最高音（旋律）
    const mel = g[g.length - 1];
    // 密集段（相邻 <0.28s）每 2 个音符换一次手：不换的话会连出"同侧 8 连"，另一只手完全插不上
    if (gap > 0 && gap < 0.28) { denseIdx++; } else { denseIdx = 0; }
    const effSide = (denseIdx > 0 && Math.floor((denseIdx - 1) / 2) % 2 === 1) ? -side : side;
    let x = effSide * Math.round(Math.max(110, Math.min(510, laneOfF(fOf.get(mel)))));
    x = clampX(x);
    // 限速（大跳）
    if (gap > 0 && sameSide(x, lastX) && Math.abs(x - lastX) > jumpLimit(gap)) {
      x = clampX(lastX + Math.sign(x - lastX) * jumpLimit(gap));
    }
    // 防同位置连打
    if (gap > 0 && gap < 0.6 && Math.abs(x - lastX) < 70) {
      x = clampX(lastX + (lastX >= 0 ? -140 : 140));
    }
    // 撞键兜底（正常情况下已被上面的 <150ms→Drag 拦掉）
    if (gap > 0 && gap < 0.14 && Math.abs(x - lastX) < SAFE_DX) {
      const away = x >= lastX ? 1 : -1;
      const nx = clampX(lastX + away * (SAFE_DX + 20));
      if (Math.abs(nx - lastX) >= SAFE_DX) x = nx;
      else { specs.push({ beat, type: 4, x: lastX }); lastBeat = beat; continue; }
    }

    // 同一音高连续重复 = 重音，用红键（Flick）而不是再多一个 Tap（参考谱面 Flick 占 2–5%）
    const repeated = lastPitch != null && mel.pitch === lastPitch && gap > 0.15 && gap < 1.2;
    // 长条：时值够长，且收在下个音符之前（至少 0.25 拍余量）
    const durB = ((mel.endSec - mel.startSec) * bpm) / 60;
    const nextGapB = i + 1 < keys.length ? keys[i + 1] - qb : Infinity;
    const holdLen = Math.min(3, durB, Math.max(0, nextGapB - 0.5)); // 尾后留 0.5 拍，避免"松手就点"
    if (durB >= Math.min(holdBeats, 0.66) && holdLen >= 0.5 && nextGapB >= (melodyOnly ? 0.75 : 1)) {
      specs.push({ beat, type: 2, x, endBeat: beat + holdLen });
      holdEnd = beat + holdLen; holdX = x;
    } else {
      specs.push({ beat, type: repeated ? 3 : 1, x });
    }
    lastPitch = mel.pitch;
    lastX = x; lastBeat = beat;
  }
  // 类型配比兜底：黄键不要超过 ~30%（参考谱 25%）。超了就把一半黄键改回 Tap，
  // 保持"整拍/骨干音是 Tap、弱位短音是黄键"的比例，别把整首变成黄键流。
  const drags = specs.filter((sp) => sp.type === 4);
  if (specs.length && drags.length / specs.length > 0.25) {
    const excess = Math.ceil(specs.length * 0.25);
    for (let i = excess; i < drags.length; i++) drags[i].type = 1;
  }
  return specs;
}

const AUDIO_EXT = ['.mp3', '.ogg', '.wav', '.flac', '.m4a'];
const IMG_EXT = ['.png', '.jpg', '.jpeg', '.webp'];

function findAsset(dir, exts) {
  try {
    for (const f of fs.readdirSync(dir)) if (exts.includes(path.extname(f).toLowerCase())) return f;
  } catch { /* 目录不存在 */ }
  return null;
}

/** 事件总数（含 extended，不含音符） */
export function countEvents(chart) {
  let n = 0;
  for (const l of chart.judgeLineList || []) {
    for (const lay of l.eventLayers || []) {
      for (const k of Object.keys(lay || {})) n += (lay[k] || []).length;
    }
    for (const k of Object.keys(l.extended || {})) n += (l.extended[k] || []).length;
  }
  return n;
}

/**
 * 写 info.yml：只引用**真实存在**的资源文件。
 * 旧实现无条件写 music: song.mp3 / illustration: background.png，
 * 生成的谱面拿自己的 phira_validate 一跑就是 2 个 missing-asset error。
 */
export function writeInfoFor(outDir, opt = {}, difficulty = 13) {
  const infoPath = path.join(outDir, 'info.yml');
  if (!fs.existsSync(infoPath)) fs.writeFileSync(infoPath, '');
  const pick = (want, exts) => {
    if (want) {
      const p = path.isAbsolute(want) ? want : path.join(outDir, want);
      if (fs.existsSync(p)) return path.isAbsolute(want) ? path.basename(want) : want;
    }
    return findAsset(outDir, exts);
  };
  const music = pick(opt.music, AUDIO_EXT);
  const illustration = pick(opt.illustration, IMG_EXT);
  const updates = {
    name: opt.title || 'AI Chart',
    difficulty,
    level: `IN Lv.${Math.max(1, Math.round(difficulty))}`,
    charter: opt.charter || 'AI',
    chart: 'chart.json',
  };
  if (opt.composer) updates.composer = opt.composer;
  if (opt.illustrator) updates.illustrator = opt.illustrator;
  if (music) updates.music = music;
  if (illustration) updates.illustration = illustration;
  writeInfo(infoPath, updates);
  const missing = [];
  if (!music) missing.push('music（放一个 song.mp3 到目录里）');
  if (!illustration) missing.push('illustration（放一个 background.png 到目录里）');
  return { infoPath, music, illustration, missing };
}


/** 难度档 → 允许的同刻手指数（与 validate.chordCapForValidate 同口径） */
export function fingersFor(d) {
  const v = Number(d);
  if (!(v >= 15)) return 2;
  if (v < 17) return 3;
  if (v < 18) return 5;
  return 8;
}

/**
 * 和弦不超过「实测定数」允许的手指数：实测只有 12 分的谱面不该出现 3 指和弦
 * （validate 的 fingers 规则就是这么判的，写进 info.yml 的定数也是实测值，两者必须自洽）。
 * 超出的音符从最外侧开始丢，返回是否有改动。
 */
export function fitChordsToCap(chart, cap, bpm = 180) {
  let changed = false;
  const spb = 60 / (Number(bpm) || 180);
  for (const l of chart.judgeLineList || []) {
    const groups = new Map();
    for (const n of l.notes || []) {
      if (n.isFake || n.type === 4) continue;
      // 分组口径必须和 validate 一致（它按 round(sec*1000) 分；按拍分组会漏掉 ±1ms 的挤压）
      const sec = beats(n.startTime) * spb;
      const k = Math.round(sec * 1000);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(n);
    }
    const drop = new Set();
    for (const g of groups.values()) {
      if (g.length <= cap) continue;
      // 保留最靠中间的（读谱最容易），丢掉多余的外侧音符
      g.sort((a, b) => Math.abs(Number(a.positionX)) - Math.abs(Number(b.positionX)));
      for (const n of g.slice(cap)) drop.add(n);
    }
    if (drop.size) {
      l.notes = (l.notes || []).filter((n) => !drop.has(n));
      l.numOfNotes = l.notes.filter((n) => !n.isFake).length;
      changed = true;
    }
  }
  return changed;
}

/** 让 chart.json 的 META 与 info.yml 一致（旧版 META 是 emptyChart 的占位值：IN Lv.1 / song.mp3） */
export function syncMeta(chart, opt = {}, difficulty = 13, assets = {}) {
  const m = chart.META || (chart.META = {});
  m.name = opt.title || 'AI Chart';
  m.charter = opt.charter || 'AI';
  m.level = `IN Lv.${Math.max(1, Math.round(difficulty))}`;
  if (opt.composer) m.composer = opt.composer;
  // 没有对应文件时不要留占位名（emptyChart 的 song.mp3 / background.png 是占位值，
  // 留着会和 info.yml 对不上，Phira 也会去找一个不存在的文件）
  if (assets.music) m.song = assets.music; else delete m.song;
  if (assets.illustration) m.background = assets.illustration; else delete m.background;
  return m;
}


/** 长条尾后 0.5 拍内、同车道不许有"要按下"的音符：后移 → 换车道 → 降级黄键 */
function fixShortHolds(chart) {
  for (const l of chart.judgeLineList || []) {
    for (const n of l.notes || []) {
      if (Number(n.type) !== 2 || !Array.isArray(n.endTime)) continue;
      const b0 = n.startTime[0] + (n.startTime[1] || 0) / (n.startTime[2] || 1);
      const b1 = n.endTime[0] + (n.endTime[1] || 0) / (n.endTime[2] || 1);
      if (b1 - b0 < 0.3) { n.type = 1; n.endTime = n.startTime.slice(); }
    }
  }
}

function fixHoldTails(chart) {
  for (const l of chart.judgeLineList || []) {
    const notes = l.notes || [];
    const beatOf = (n) => n.startTime[0] + (n.startTime[1] || 0) / (n.startTime[2] || 1);
    const endOf = (n) => n.endTime[0] + (n.endTime[1] || 0) / (n.endTime[2] || 1);
    const holds = notes.filter((n) => Number(n.type) === 2 && Array.isArray(n.endTime));
    for (const h of holds) {
      const endBeat = endOf(h);
      const hx = Number(h.positionX) || 0;
      for (const n of notes) {
        if (n === h || Number(n.type) === 4) continue;
        const gap = beatOf(n) - endBeat;
        if (gap < -1e-6 || gap > 0.5) continue;
        if (Math.abs((Number(n.positionX) || 0) - hx) >= 213) continue;
        const nb = endBeat + 0.5;
        const clash = notes.some((o) => o !== n && Math.abs(beatOf(o) - nb) < 1e-6 && Math.abs((Number(o.positionX) || 0) - (Number(n.positionX) || 0)) < 213);
        if (!clash) {
          const wasHold = Number(n.type) === 2 && Array.isArray(n.endTime);
          const durB = wasHold ? Math.max(0.5, endOf(n) - beatOf(n)) : 0;
          n.startTime = [Math.floor(nb), Math.round((nb - Math.floor(nb)) * 192), 192];
          if (wasHold) {
            const e = nb + durB;
            n.endTime = [Math.floor(e), Math.round((e - Math.floor(e)) * 192), 192];
          }
          continue;
        }
        n.positionX = -(Number(n.positionX) || 0);
        if (Math.abs(n.positionX - hx) >= 213) continue;
        n.type = 4;
      }
    }
    l.numOfNotes = (l.notes || []).filter((n) => !Number(n.isFake)).length;
  }
}

export function generateChart(opt = {}) {
  const source = opt.source === 'plan' ? 'plan' : 'midi';
  const midiPath = opt.midiPath;
  // 只有 midi 模式必须要 MIDI；plan 模式可以不给（之前无条件抛错，plan 模式直接崩）
  if (source === 'midi' && (!midiPath || !fs.existsSync(midiPath))) throw new Error(`MIDI 不存在: ${midiPath}`);
  if (source === 'midi' && midiPath && !fs.existsSync(midiPath)) throw new Error(`MIDI 不存在: ${midiPath}`);
  const mid = source === 'midi' ? parseMidi(midiPath) : null;
  const bpm = Number(opt.bpm || (mid && mid.tempos && mid.tempos[0] && mid.tempos[0].bpm) || 120);
  const durationSec = Number(opt.durationSec || (mid && mid.durationSec) || 60);
  const difficulty = Number(opt.difficulty == null ? 13 : opt.difficulty);
  const style = opt.style || 'auto';
  const outDir = opt.outDir || path.dirname(midiPath);

  const chart = emptyChart({
    bpm,
    title: opt.title || 'AI Chart',
    charter: opt.charter || 'AI',
    lineY: opt.lineY == null ? -270 : Number(opt.lineY),
  });
  const plan = planChart({
    bpm,
    durationSec,
    difficulty,
    style,
    midiPath,
    noteCount: mid ? mid.notes.length : undefined,
    custom: opt.custom,
  });
  // 前奏不空转：把 intro 段压到 introSec 秒，后续段落整体前移
  if (opt.introSec != null && plan.sections.length) {
    const introSec = Math.max(0.5, Number(opt.introSec));
    const newBeats = (introSec * bpm) / 60;
    const s0 = plan.sections[0];
    const oldLen = s0.endBeat - s0.startBeat;
    const delta = oldLen - newBeats;
    if (delta > 0.5) {
      s0.endBeat = s0.startBeat + newBeats;
      for (let i = 1; i < plan.sections.length; i++) {
        plan.sections[i].startBeat -= delta;
        plan.sections[i].endBeat -= delta;
      }
      plan.meta.totalBeats = Math.round((plan.meta.totalBeats || 0) - delta);
    }
  }

  const target = Number(opt.difficulty == null ? 13 : opt.difficulty);
  const cap = fingersFor(target);
  const fxLevel = ['off', 'light', 'normal', 'rich'].includes(String(opt.effects))
    ? String(opt.effects) : 'light';
  const maxPulses = fxLevel === 'off' ? 0 : fxLevel === 'light' ? 1 : 2;
  const pulsePeriod = fxLevel === 'light' ? 2 : 1;

  if (opt.source === 'midi' || opt.midiDriven) {
    // 按 MIDI 起音生成音符（手位由 buildMidiSpecs 统一分配）
    const list = (mid.notes || []).slice().sort((a, b) => a.startSec - b.startSec);
    const tracks = new Map();
    for (const n of list) {
      if (!tracks.has(n.track)) tracks.set(n.track, []);
      tracks.get(n.track).push(n);
    }
    let trackId = opt.midiTrack != null ? Number(opt.midiTrack) : null;
    if (trackId == null) {
      // 取中位音高最高的轨（旋律），且音符数 > 50
      let best = null;
      for (const [id, arr] of tracks) {
        if (arr.length < 50) continue;
        const ps = arr.map((n) => n.pitch).sort((a, b) => a - b);
        const med = ps[Math.floor(ps.length / 2)];
        if (!best || med > best.med) best = { id, med };
      }
      trackId = best ? best.id : 1;
    }
    const track = tracks.get(trackId) || [];
    const specs = buildMidiSpecs(track, bpm, {
      ...opt,
      maxFingers: cap,
      introSec: opt.introSec == null ? 2 : opt.introSec,
    });
    addNotes(chart, 0, specs);
    fixHandFeel(chart, bpm, difficulty, cap);

    // 判定线演出：midi 路径以前完全不吃 effects 参数（off/light/normal 生成同一张谱）
    applySectionFx(chart, plan, fxLevel);
    // AI 水印（项目硬性要求：谱面明显位置必须标明 AI 生成）
    if (opt.aiMark !== false) {
      applyAIMark(chart, { text: opt.aiMarkText || '本谱面由 AI 生成', startBeat: 0, endBeat: 6 });
    }
    // 休息段：假判定线按旋律压音（档位控制段数：light 只放 1 段）
    if (opt.introPulse !== false && maxPulses > 0) {
      const starts = specs.map((s) => s.beat).sort((a, b) => a - b);
      const restBeats = (Number(opt.restSec == null ? 5 : opt.restSec) * bpm) / 60;
      let pulses = 0;
      for (let i = 1; i < starts.length && pulses < maxPulses; i++) {
        const gap = starts[i] - starts[i - 1];
        if (gap < restBeats) continue;
        const startBeat = starts[i - 1] + 0.5;
        const pb = Math.min(16, gap - 1);
        if (pb < 2) continue;
        try {
          applyPattern(chart, 'fakePulse', { startBeat, beats: pb, period: pulsePeriod, depth: 0.35, y: 0 });
          pulses++;
        } catch { /* 忽略 */ }
      }
    }
    for (const l of chart.judgeLineList) l.numOfNotes = (l.notes || []).filter((n) => !n.isFake).length;
    fixEventOverlaps(chart); // 演出线基底帧与淡入事件重叠 → 实机与预览不一致
    let norm2 = normalizeChart(chart);
    let pred2 = predictDifficulty(norm2);
    // 收敛：实测定数低于 15 就不该留 3 指和弦（否则 validate 的 fingers 会一路报警）
    for (let i = 0; i < 3; i++) {
      if (!fitChordsToCap(chart, fingersFor(pred2.predicted), bpm)) break;
      fixHandFeel(chart, bpm, difficulty, cap);
      norm2 = normalizeChart(chart);
      pred2 = predictDifficulty(norm2);
    }
    // 先测后标：默认把 info.yml 的定数标成实测值（±0.1），避免"为了凑定数硬塞音符"
    const finalDifficulty = opt.lockDifficulty === true
      ? difficulty : Math.round(pred2.predicted * 10) / 10;
    insertDragChains(chart, { bpm, limit: 60, minGapBeat: 1.5, stepBeat: 0.2 });
    fixShortHolds(chart);
    fixHoldTails(chart);
    const norm2b = normalizeChart(chart);
    const v2 = validate(norm2b, { difficulty: finalDifficulty, maxFingers: Math.max(cap, fingersFor(finalDifficulty)) });
    fs.mkdirSync(outDir, { recursive: true });
    const meta2 = writeInfoFor(outDir, opt, finalDifficulty);
    syncMeta(chart, opt, finalDifficulty, meta2);
    const chartPath2 = writeChart(path.join(outDir, 'chart.json'), chart);
    return {
      outDir, chartPath: chartPath2, infoPath: meta2.infoPath, bpm, durationSec,
      style: `midi-driven(track ${trackId})`, notes: norm2.notes.length, events: countEvents(chart),
      lines: chart.judgeLineList.length, predicted: pred2.predicted, confidence: pred2.confidence,
      targetDifficulty: difficulty, difficulty: finalDifficulty,
      missingAssets: meta2.missing,
      warnings: v2.counts, issues: v2.issues.filter((i) => i.level !== 'info').slice(0, 6).map((i) => `${i.level}:${i.code}`),
    };
  }

  const res = materializePlan(chart, plan, {
    seed: opt.seed == null ? 20261115 : opt.seed,
    aiMark: opt.aiMark !== false,
    introPulse: opt.introPulse !== false,
    effects: fxLevel,
  });

  // 先收敛（和弦数 ≤ 实测定数允许的手指数），再落盘 —— 顺序反了会把收敛前的谱面写进 chart.json，
  // 而 info.yml 的定数用的是收敛后的值，两者不自洽。
  let norm = normalizeChart(chart);
  let pred = predictDifficulty(norm);
  for (let i = 0; i < 3; i++) {
    if (!fitChordsToCap(chart, fingersFor(pred.predicted), bpm)) break;
    relaxGenerated(chart, bpm, difficulty);
    norm = normalizeChart(chart);
    pred = predictDifficulty(norm);
  }
  const finalDifficulty = opt.lockDifficulty === true
    ? difficulty : Math.round(pred.predicted * 10) / 10;
  insertDragChains(chart, { bpm, limit: fxLevel === 'off' ? 20 : 40, minGapBeat: 1.5, stepBeat: 0.2 });
  fixShortHolds(chart);
  fixHoldTails(chart);
  norm = normalizeChart(chart);
  const v = validate(norm, { difficulty: finalDifficulty, maxFingers: Math.max(cap, fingersFor(finalDifficulty)) });
  fs.mkdirSync(outDir, { recursive: true });
  const meta = writeInfoFor(outDir, opt, finalDifficulty);
  syncMeta(chart, opt, finalDifficulty, meta);
  const chartPath = writeChart(path.join(outDir, 'chart.json'), chart);
  return {
    outDir,
    chartPath,
    infoPath: meta.infoPath,
    bpm,
    durationSec,
    style: plan.meta.style,
    notes: norm.notes.length,
    events: countEvents(chart),
    lines: res.lines,
    predicted: pred.predicted,
    confidence: pred.confidence,
    targetDifficulty: difficulty,
    difficulty: finalDifficulty,
    missingAssets: meta.missing,
    warnings: v.counts,
    issues: v.issues.filter((i) => i.level !== 'info').slice(0, 6).map((i) => `${i.level}:${i.code}`),
  };
}

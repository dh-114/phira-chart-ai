/**
 * 段落规划器：先把整首曲子的"结构"定下来（每段密度/同刻/手法/演出），再逐段生成。
 * 设计目标：AI 主导结构，插件负责把结构变成合法、可玩、可校验的谱面。
 */
import { STYLES, SECTION_TEMPLATE } from './styles.js';
import { applyPattern, addEvents, addLine, addNotes, applyAIMark, bpmIndex, fixEventOverlaps } from './author.js';
import { makeBpm, toTriple, beats } from './rpe.js';
import { chordXs, stairsRange, makeRng, densityHint, quantileX, REF_DIST } from './distribution.js';
import fs from 'node:fs';
import { parseMidi } from './midi.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** 难度 → 允许的最大同刻音符（社区惯例，仅作规划上限） */
/** 从 MIDI 提取「音乐画像」，用于自动选择风格 */
export function profileFromMidi(file, bpmFallback) {
  const midi = parseMidi(fs.readFileSync(file));
  const notes = midi.notes || [];
  const dur = Math.max(1, midi.durationSec || 0);
  const buckets = Math.max(1, Math.ceil(dur));
  const perSec = new Array(buckets).fill(0);
  const byTime = new Map();
  let holdCount = 0;
  for (const n of notes) {
    const i = Math.min(buckets - 1, Math.floor(n.startSec));
    perSec[i] += 1;
    const key = Math.round(n.startSec * 1000) / 1000;
    byTime.set(key, (byTime.get(key) || 0) + 1);
    if (n.endSec - n.startSec >= 0.25) holdCount++;
  }
  const avgDensity = notes.length / dur;
  const peakDensity = perSec.reduce((a, b) => Math.max(a, b), 0);
  let chords = 0;
  for (const v of byTime.values()) if (v >= 2) chords++;
  const polyphony = byTime.size ? notes.length / byTime.size : 1;
  return {
    source: 'midi',
    bpm: (midi.tempos && midi.tempos[0] && midi.tempos[0].bpm) || bpmFallback || 120,
    durationSec: dur,
    noteCount: notes.length,
    avgDensity,
    peakDensity,
    polyphony,
    chordRatio: byTime.size ? chords / byTime.size : 0,
    holdRatio: notes.length ? holdCount / notes.length : 0,
  };
}

/** 按音乐特征自动挑选风格（不用 AI 手选） */
export function autoStyle(profile = {}) {
  const d = Number(profile.avgDensity || 0);
  const peak = Number(profile.peakDensity || 0);
  const poly = Number(profile.polyphony || 1);
  const hold = Number(profile.holdRatio || 0);
  const dur = Number(profile.durationSec || 0);
  if (poly >= 2.2 || d >= 5.5) {
    return { style: 'multiFinger', reason: `复音高（平均 ${poly.toFixed(2)} 键/时刻）或密度 ${d.toFixed(2)}/s，适合多指配置` };
  }
  if (hold >= 0.22 && dur > 90) {
    return { style: 'endurance', reason: `长音占比 ${(hold * 100).toFixed(0)}%（>22%），适合长条与耐力编排` };
  }
  // 判定线不是风格维度：峰值高只意味着"有起伏"，仍归入均衡/多指
  if (d < 2.2) {
    return { style: 'visual', reason: `密度仅 ${d.toFixed(2)}/s，音符少，适合以演出为主` };
  }
  return { style: 'balanced', reason: `密度 ${d.toFixed(2)}/s、复音 ${poly.toFixed(2)}、峰值 ${peak}/s，节奏平稳，均衡编排` };
}

export function chordCap(difficulty) {
  if (difficulty < 13) return 2;
  if (difficulty < 15) return 2;
  if (difficulty < 17) return 3;
  if (difficulty < 18) return 5;
  return 8;
}

/**
 * 生成段落规划
 * @param {{durationSec?:number,bpm?:number,difficulty?:number,style?:string}} opt
 */
export function planChart(opt = {}) {
  const durationSec = Number(opt.durationSec || 60);
  let styleKey = opt.style && opt.style !== 'auto' && (STYLES[opt.style] || opt.style === 'custom') ? opt.style : null;
  let autoInfo = null;
  let profile = opt.profile || null;
  if (!styleKey) {
    if (!profile && opt.midiPath) {
      try { profile = profileFromMidi(opt.midiPath, opt.bpm); } catch (e) { profile = null; }
    }
    const picked = autoStyle(profile || {
      avgDensity: (opt.noteCount && opt.durationSec) ? opt.noteCount / opt.durationSec : 4,
      peakDensity: opt.peakDensity || 0,
      polyphony: opt.polyphony || 1,
      holdRatio: opt.holdRatio || 0,
      durationSec: opt.durationSec || 0,
    });
    styleKey = picked.style;
    autoInfo = { ...picked, profile };
  }
  const bpm = Number(opt.bpm || (Array.isArray(opt.bpmList) && opt.bpmList.length ? opt.bpmList[0].bpm : 180));
  const bpmIdx = Array.isArray(opt.bpmList) && opt.bpmList.length ? makeBpm(opt.bpmList, []) : null;
  const difficulty = Number(opt.difficulty || 13);
  if (opt.style === 'custom') styleKey = 'custom';
  const st = STYLES[styleKey] || { name: '自定义', params: { density: Number((opt.custom && opt.custom.density) || 5) } };
  const baseSections = (styleKey === 'custom' && opt.custom && Array.isArray(opt.custom.sections) && opt.custom.sections.length)
    ? (() => {
      const raw = opt.custom.sections;
      const sum = raw.reduce((a, b) => a + Math.max(0.0001, Number(b.frac || 1)), 0);
      return raw.map((b) => ({
        name: b.name || 'S',
        frac: Math.max(0.0001, Number(b.frac || 1)) / sum,
        chord: Number(b.chord || 0),
        tech: b.tech ? [b.tech] : [],
        fx: Array.isArray(b.fx) ? b.fx : [],
        density: Number(b.density == null ? 1 : b.density),
      }));
    })()
    : SECTION_TEMPLATE;
  const totalBeats = Math.max(8, Math.round(bpmIdx ? bpmIdx.beatAt(durationSec) : (durationSec * bpm) / 60));
  const densityFactor = Math.pow(Math.max(0.35, difficulty / 13), 1.5);
  const hint = densityHint(difficulty);
  // 风格密度不能被参考区间的"上限"一刀切平（旧实现 d≥16 时四种风格全都变成 10，生成同一张谱）。
  // 上限按区间放宽 25%，下限允许到区间的一半，保留风格差异的同时不脱参考区间。
  const density = clamp(st.params.density * densityFactor, Math.max(1, hint[0] * 0.5), hint[1] * 1.25);
  const cap = chordCap(difficulty);

  let cursor = 0;
  const sections = baseSections.map((tpl, i) => {
    const beats = Math.max(2, Math.round(totalBeats * tpl.frac));
    const startBeat = cursor;
    const endBeat = cursor + beats;
    cursor = endBeat;
    // 段落同刻数：模板决定"这段有没有和弦"（弱起/休息段不该有），
    // 风格参数决定"有和弦的段落最多几指"。旧实现只看模板 → multiFinger/endurance/visual 生成同一张谱；
    // 若只取 max 则会连 verse 都塞和弦，和弦占比直接翻倍。
    const wantChord = tpl.chord ? Math.max(Number(tpl.chord), Number(st.params.chord || 0)) : 0;
    const chord = wantChord ? Math.min(wantChord, cap) : 0;
    const d = tpl.density * density;
    const secPerBeatSection = 60 / (bpmIdx ? bpmIdx.bpmAt(startBeat) : bpm);
    // d 是「音符/秒」，stepBeat 是「拍/音符」：stepBeat = 1 / (d × 秒每拍)。
    // 旧实现写成「秒每拍 / d」（少了一次取倒数）→ 全部撞在 0.25 拍下限，
    // 密度参数形同虚设，四种风格生成同一张谱，再靠 relax 删掉多余音符兜底。
    const stepBeat = d > 0 ? clamp(1 / (d * secPerBeatSection), 0.25, 4) : 0;
    const tech = tpl.tech.length ? tpl.tech[i % tpl.tech.length] : null;
    return {
      name: tpl.name, startBeat, endBeat, beats,
      density: Number(d.toFixed(2)), stepBeat: Number(stepBeat.toFixed(3)),
      chord, tech, fx: tpl.fx.slice(),
      flick: Number(st.params.flick || 0),
    };
  });

  return {
    meta: {
      style: styleKey, styleName: st.name, bpm, difficulty, durationSec,
      autoStyle: autoInfo ? { reason: autoInfo.reason, profile: autoInfo.profile } : null,
      totalBeats, density: Number(density.toFixed(2)), chordCap: cap,
      generatedAt: new Date().toISOString(),
    },
    sections,
  };
}

function fmtPlan(plan) {
  const m = plan.meta;
  const lines = [`规划：${m.styleName}（${m.style}） BPM ${m.bpm} 定数 ${m.difficulty} 时长 ${m.durationSec}s ≈ ${m.totalBeats} 拍`];
  lines.push(`目标密度 ${m.density} 音符/s，同刻上限 ${m.chordCap}`);
  lines.push('');
  lines.push('段落表：');
  for (const s of plan.sections) {
    const sec = ((s.beats * 60) / m.bpm).toFixed(1);
    lines.push(`  ${s.name.padEnd(8)} 拍 ${String(s.startBeat).padStart(4)}–${String(s.endBeat).padStart(4)}（${sec}s）  `
      + `密度 ${String(s.density).padStart(5)} 步长 ${s.stepBeat} 同刻 ${s.chord} 手法 ${s.tech || '—'} 演出 ${s.fx.join('/') || '—'}`);
  }
  return lines.join('\n');
}

const PALETTE = {
  verse: [[130, 205, 255], [120, 190, 240]],
  build: [[150, 190, 255], [190, 160, 255]],
  chorus: [[120, 210, 255], [255, 130, 180]],
  chorus2: [[255, 160, 120], [255, 90, 140]],
  rest: [[90, 120, 150], [90, 120, 150]],
  outro: [[150, 170, 200], [80, 90, 110]],
};

/**
 * 把规划落到谱面上
 * @returns {{notes:number,events:number,lines:number}}
 */

/** 生成后松弛：把撞键 / 同点连击 / 大跳 / 长条重叠压到 0（按参考手感阈值） */
export function relaxGenerated(chart, bpm, difficulty, opts = {}) {
  const beatOf = (t) => (Array.isArray(t) ? t[0] + (t[1] || 0) / (t[2] || 1) : Number(t) || 0);
  // 秒级阈值必须按谱面自己的 BPMList 换算（多 BPM 曲子里全局 bpm 会把 140ms 判错）
  const bpmIdx = (() => {
    const list = (chart.BPMList || []).map((e) => ({ bpm: Number(e.bpm), startTime: e.startTime }));
    if (!list.length) return null;
    try { return makeBpm(list, []); } catch { return null; }
  })();
  const secToBeat = (sec) => (bpmIdx ? bpmIdx.beatAt(sec) : (sec * bpm) / 60);
  const clashB = secToBeat(0.14);
  const jackB = secToBeat(0.6);
  const jumpB = secToBeat(0.3);
  const lim = 560;
  const clamp = (x) => Math.max(-lim, Math.min(lim, x));
  const lines = chart.judgeLineList || [];
  for (let round = 0; round < (opts.cleanupOnly ? 0 : 8); round++) {
    let changed = 0;
    for (const l of lines) {
      const notes = (l.notes || []).filter((n) => n.type !== 4).slice().sort((a, b) => beatOf(a.startTime) - beatOf(b.startTime) || (a.positionX - b.positionX));
      // 按时刻分组
      const groups = [];
      for (const n of notes) {
        const b = beatOf(n.startTime);
        const g = groups[groups.length - 1];
        if (g && Math.abs(g.beat - b) < 1e-6) g.notes.push(n);
        else groups.push({ beat: b, notes: [n] });
      }
      for (let i = 1; i < groups.length; i++) {
        const a = groups[i - 1], b = groups[i];
        const dt = b.beat - a.beat;
        let best = Infinity;
        const sameSide = (x1, x2) => (x1 >= 0) === (x2 >= 0);
        for (const p of a.notes) for (const q of b.notes) {
          if (sameSide(p.positionX, q.positionX)) best = Math.min(best, Math.abs(q.positionX - p.positionX));
        }
        // 跨侧换手：两只手各管一边，不构成"同一只手要大跳/连打"，不参与后面的修正。
        // 旧实现把 best 置 0 → 后面 `best < 70` 恒真 → 每轮把音符往外推 130px，直接顶到 ±560 墙边。
        const crossSide = !Number.isFinite(best);
        if (crossSide) best = 0;
        // 大跳：整组朝前一组平移
        if (!crossSide && dt > 1e-6 && dt < jumpB && best > 400) {
          const dir = b.notes[0].positionX >= a.notes[0].positionX ? 1 : -1;
          const shift = best - 390;
          for (const q of b.notes) q.positionX = clamp(q.positionX - dir * shift);
          changed++;
          continue;
        }
        if (crossSide) continue;
        // 撞键 / 同点：把后一组推开
        if (dt < clashB && best < 170) {
          const dir = b.notes[0].positionX >= a.notes[0].positionX ? 1 : -1;
          for (const q of b.notes) q.positionX = clamp(q.positionX + dir * (200 - best + 30));
          changed++;
        } else if (dt < jackB && best < 70) {
          const dir = b.notes[0].positionX >= a.notes[0].positionX ? 1 : -1;
          for (const q of b.notes) q.positionX = clamp(q.positionX + dir * (100 - best + 30));
          changed++;
        }
      }
      // 长条重叠：缩短较早那根到下一根之前
      const holds = notes.filter((n) => n.type === 2);
      for (let i = 0; i < holds.length; i++) {
        for (let j = i + 1; j < holds.length; j++) {
          const h1 = holds[i], h2 = holds[j];
          const s1 = beatOf(h1.startTime), e1 = beatOf(h1.endTime);
          const s2 = beatOf(h2.startTime);
          if (s2 < e1 && Math.abs(h1.positionX - h2.positionX) < 213) {
            if (s2 - s1 >= 0.5) {
              // 错开足够：把较早那根收短到下一根之前（至少留 0.25 拍）
              h1.endTime = toTriple(Math.max(s1 + 0.25, Math.min(s2 - 0.05, e1)), 192);
            } else {
              // 同刻/几乎同刻：收短没有意义（会留下 0.02s 长条），直接把后一根挪到别的车道
              const away = Number(h1.positionX) >= 0 ? -1 : 1;
              h2.positionX = clamp(Number(h1.positionX) + away * 240);
            }
            changed++;
          }
        }
      }
    }
    if (!changed) break;
  }
  // 手指数清理：hold 激活期间同刻按键太多 → 丢掉多余按键（生成器场景）
  const cap = difficulty < 15 ? 2 : difficulty < 17 ? 3 : difficulty < 18 ? 5 : 8;
  if (opts.cleanupOnly) { /* 只做删除类清理 */ }
  for (let pass = 0; pass < 8; pass++) {
    let dropped = 0;
    for (const l of lines) {
      const press = (l.notes || []).filter((n) => n.type !== 4);
      const holds = press.filter((n) => n.type === 2 && Number.isFinite(beatOf(n.endTime)));
      const groups = new Map();
      for (const n of press) {
        const k = beatOf(n.startTime).toFixed(6);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(n);
      }
      for (const [k, g] of groups) {
        const t = Number(k);
        const active = holds.filter((h) => beatOf(h.startTime) < t - 1e-6 && beatOf(h.endTime) > t + 1e-6).length;
        const load = active + g.length;
        if (load <= cap) continue;
        // 先丢非长条（从后往前），仍超则丢长条
        const droppable = g.filter((n) => n.type !== 2).sort((a, b) => b.positionX - a.positionX);
        for (const n of droppable) {
          if (active + g.filter((x) => !x._dropped).length <= cap) break;
          n._dropped = true; dropped++;
        }
      }
      if (dropped) l.notes = (l.notes || []).filter((n) => !n._dropped);
    }
    if (!dropped) break;
  }

  // 兜底清理：极端位置（夹在 ±560 边界）仍撞就删掉后一个音符。
  // 删除后可能形成新的相邻对，所以要反复扫到稳定。
  for (let pass = 0; pass < 8; pass++) {
    let dropped = 0;
    for (const l of lines) {
      const notes = (l.notes || []).filter((n) => n.type !== 4).slice().sort((a, b) => beatOf(a.startTime) - beatOf(b.startTime));
      const drop = new Set();
      for (let i = 1; i < notes.length; i++) {
        const a = notes[i - 1], b = notes[i];
        const dt = beatOf(b.startTime) - beatOf(a.startTime);
        const dx = Math.abs(b.positionX - a.positionX);
        if ((dt < clashB && dx < 170) || (dt < jackB && dx < 70)) drop.add(b);
      }
      if (drop.size) { l.notes = (l.notes || []).filter((n) => !drop.has(n)); dropped += drop.size; }
    }
    if (!dropped) break;
  }

  // 同刻同线间距硬保证：任意两个同刻点击音符间距必须 ≥ 判定安全值。
  // 引擎每个触点只判"最近的一个"（judge.rs），挨太近会被判给错的音符、另一个必漏。
  // 做法：同刻组按需等距重排（并保证不越界）；实在放不下（>6 指）才丢音符。
  const SAFE_DX = 213.5;
  const maxPerChord = Math.floor(1120 / SAFE_DX) + 1; // ±560 内最多 6 个
  for (const l of lines) {
    const groups = new Map();
    for (const n of l.notes || []) {
      if (n.isFake || n.type === 4) continue;
      const k = beatOf(n.startTime).toFixed(6);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(n);
    }
    const drop = new Set();
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      g.sort((a, b) => Number(a.positionX) - Number(b.positionX));
      if (g.length > maxPerChord) for (const n of g.slice(maxPerChord)) drop.add(n);
      const keep = g.slice(0, maxPerChord);
      let need = false;
      for (let i = 1; i < keep.length; i++) {
        if (Number(keep[i].positionX) - Number(keep[i - 1].positionX) < SAFE_DX - 0.5) { need = true; break; }
      }
      if (!need) continue;
      const center = keep.reduce((a, n) => a + Number(n.positionX), 0) / keep.length;
      const gap = SAFE_DX + 2;
      const total = (keep.length - 1) * gap;
      let startX = Math.max(-560, Math.min(560 - total, center - total / 2));
      keep.forEach((n, i) => { n.positionX = Math.round(startX + i * gap); });
    }
    if (drop.size) l.notes = (l.notes || []).filter((n) => !drop.has(n));
  }
}

/**
 * 按段落给判定线加演出（配色渐变 / 扫线 / 淡入），midi 与 plan 两条生成路径共用。
 * level: off（无）/ light（只换色）/ normal|rich（演出线 + 扫线 + 淡入）
 */
export function applySectionFx(chart, plan, level = 'light') {
  const lvl = ['off', 'light', 'normal', 'rich'].includes(String(level)) ? String(level) : 'light';
  if (lvl === 'off') return { events: 0, lines: 0 };
  const wantFxLine = lvl === 'normal' || lvl === 'rich';
  let events = 0, lines = 0;
  let fx = null;
  if (wantFxLine) { fx = addLine(chart, { name: 'AI-FX', x: 0, y: 0, zOrder: -5 }); lines++; }
  const main = 0;
  for (const s of plan.sections || []) {
    const start = s.startBeat, end = s.endBeat;
    if (!(end > start)) continue;
    const fxList = s.fx || [];
    if (fxList.includes('color')) {
      const pal = PALETTE[s.name] || PALETTE.verse;
      addEvents(chart, main, 'color', [{ startBeat: start, endBeat: end, from: pal[0], to: pal[1], easing: 1 }]);
      events++;
    }
    if (wantFxLine && fxList.includes('sweep')) {
      applyPattern(chart, 'sweep', { line: fx, startBeat: start, beats: 2, from: -675, to: 675, easing: 4 });
      events++;
    }
    if (wantFxLine && fxList.includes('fade')) {
      addEvents(chart, fx, 'alpha', [{ startBeat: start, endBeat: Math.min(end, start + 2), from: 0, to: 110, easing: 4 }]);
      events++;
    }
  }
  // 演出线的 alpha 基底（0→1 拍 255）会和淡入事件（0→2 拍 0→110）区间重叠 → 收口
  fixEventOverlaps(chart);
  return { events, lines, fxLine: fx };
}


/** 按风格参数里的 drag 比例，把一部分 Tap 降级成黄键（styles.js 里 drag 定义了很久但没人用 → 类型配比偏 Tap） */
function applyStyleDensity(chart, sections, st, bpm, seed = 20261115) {
  const ratio = Number((st && st.params && st.params.drag) || 0);
  if (!(ratio > 0)) return;
  let rnd = (seed % 233280) / 233280;
  const rand = () => { rnd = (rnd * 9301 + 49297) % 233280; return rnd / 233280; };
  for (const sec of sections || []) {
    const b0 = Number(sec.startBeat), b1 = Number(sec.endBeat);
    if (!(b1 > b0)) continue;
    for (const l of chart.judgeLineList || []) {
      const notes = (l.notes || []).slice().sort((a, z) => (a.startTime[0] + (a.startTime[1] || 0) / (a.startTime[2] || 1)) - (z.startTime[0] + (z.startTime[1] || 0) / (z.startTime[2] || 1)));
      let lastDragBeat = -99;
      const beatAt = (n) => n.startTime[0] + (n.startTime[1] || 0) / (n.startTime[2] || 1);
      for (const n of notes) {
        if (Number(n.type) !== 1) continue;
        const b = beatAt(n);
        if (b < b0 || b >= b1) continue;
        // 黄键之间太密会触发 drag-crowd（同一只手划不过来）
        if (b - lastDragBeat < 0.35) continue;
        const sibs = notes.filter((o) => o !== n && Math.abs(beatAt(o) - b) < 1e-6);
        // 和弦里只降级「最外侧」那一个（保留至少一个要点下的音，同刻结构不被破坏）
        if (sibs.length && Math.abs(Number(n.positionX) || 0) < Math.max(...sibs.map((o) => Math.abs(Number(o.positionX) || 0)))) continue;
        if (rand() < ratio) { n.type = 4; lastDragBeat = b; } // 黄键：不用按下，靠手指经过
      }
      l.numOfNotes = (l.notes || []).filter((n) => !Number(n.isFake)).length;
    }
  }
}

export function materializePlan(chart, plan, opt = {}) {
  const bpm = plan.meta.bpm;
  // 谱面自己的 BPMList 优先（build_from_plan 时 plan 的 bpm 可能和 chart 不一致）
  const bpmIdx = (() => {
    const list = (chart.BPMList || []).map((e) => ({ bpm: Number(e.bpm), startTime: e.startTime }));
    try { return list.length ? makeBpm(list, []) : null; } catch { return null; }
  })();
  const secPerBeatAt = (beat) => 60 / (bpmIdx ? bpmIdx.bpmAt(beat) : bpm);
  const difficulty = Number(plan.meta.difficulty || 13);
  const rng = makeRng(opt.seed == null ? 20261115 : opt.seed);
  let notes = 0, events = 0;
  // 特效档位：off 不做演出 / light 只留判定线换色 / normal、rich 才建演出线
  const lvl = ['off', 'light', 'normal', 'rich'].includes(String(opt.effects)) ? String(opt.effects) : 'normal';
  const wantColor = lvl !== 'off';
  const wantFxLine = lvl === 'normal' || lvl === 'rich';
  // 假线压音是最占事件的部分（每段按拍生成一条 scaleY）：按档位限段数/降频
  const maxPulse = lvl === 'off' ? 0 : lvl === 'light' ? 1 : 2;
  const pulsePeriod = lvl === 'light' ? 2 : 1;
  // 主判定线
  if (!chart.judgeLineList || !chart.judgeLineList.length) throw new Error('谱面没有判定线，先 phira_chart_init');
  const main = 0;
  // 演出线（不承载音符）；light/off 下不建，省一条线、少一批事件
  const fx = wantFxLine ? addLine(chart, { name: 'AI-FX', x: 0, y: 0, zOrder: -5 }) : null;

  let phrase = 0;
  let pulseCount = 0;
  for (const s of plan.sections) {
    const start = s.startBeat;
    const end = s.endBeat;
    const beats = end - start;

    /* ---------- 音符 ---------- */
    if (s.density > 0 && beats >= 2) {
      const minStep = 0.14 / secPerBeatAt(start); // 相邻音符最小间隔 140ms（否则会 key-clash）
      const step = Math.max(0.25, minStep, s.stepBeat);
      const count = Math.max(1, Math.floor(beats / step));
      const dir = phrase % 2 === 0;
      const tech = s.tech || 'stairs';
      if (s.chord >= 2 && (tech === 'chord' || phrase % 3 === 0)) {
        // 同刻间距按参考分布（中位 260 / p75 520），并随机平移整组位置
        // 参考（剔除耐力谱后）同刻同线间距 p50≈506 / p75≈675，写谱用 300/500 两档。
        // 3 指以上还用 500 会让整谱 |x|>400 占到 60%+（实测），所以按指数收紧。
        const gap = (s.chord === 2 && rng() < 0.3) ? 500 : 300;
        const xs = chordXs(s.chord, { rng, centerX: 0, limit: 560, gap }); // 对称居中：左右手各负责一边
        // 同刻多音符用更宽的步长，避免密度爆炸
        const chordStep = Math.max(0.5, step * 2);
        const n = Math.max(1, Math.floor(beats / chordStep));
        applyPattern(chart, 'chord', { line: main, startBeat: start + chordStep, count: n, stepBeat: chordStep, xs });
        notes += n * xs.length;
      } else if (tech === 'trill') {
        // 摆幅按段落轮换而不是"每个 seed 抽一次"：单次抽样会让整张谱的横向范围靠运气
        //（seed 42 抽到小值 → 全谱 |x|>400 直接 0%）。参考 |x| p50≈248、>400 占 17.9%（24 谱口径）。
        const GAPS = [260, 420, 320, 500, 300, 380];
        const gapScale = 0.85 + Math.max(0, difficulty - 13) * 0.03; // 高难略放宽，但不无限
        const gap = Math.max(120, Math.min(520, (GAPS[phrase % GAPS.length] + (rng() * 40 - 20)) * gapScale));
        const before = (chart.judgeLineList[main].notes || []).length;
        applyPattern(chart, 'trill', { line: main, startBeat: start + step, count, stepBeat: step, x1: -gap, x2: gap });
        // 按风格 flick 比例把部分单音换成红键（参考谱 2–5%）；trill 是 Tap 流，转换不会造成撞车
        if (s.flick > 0) {
          const every = Math.max(8, Math.round(1 / s.flick));
          const added = chart.judgeLineList[main].notes.slice(before);
          for (let i = 0; i < added.length; i++) if (i % every === 2) added[i].type = 3;
        }
        notes += count;
      } else if (tech === 'jack') {
        const jx = (phrase % 2 === 0 ? -1 : 1) * 160; // 单手半区，交替
        // 真·同点连击在多数难度是负手感，这里用 90px 交替保留"连打"读感
        applyPattern(chart, 'trill', { line: main, startBeat: start + step, count, stepBeat: step, x1: jx - 45, x2: jx + 45 });
        notes += count;
      } else if (tech === 'hold') {
        const hb = 1;
        const hstep = Math.max(step * 2, hb + 0.5); // 长条尾后至少 0.5 拍
        const n = Math.max(1, Math.floor(beats / hstep));
        applyPattern(chart, 'hold', { line: main, startBeat: start + 1, count: n, stepBeat: hstep, beats: hb, x: (phrase % 2 === 0 ? -1 : 1) * 200 });
        notes += n;
      } else {
        // 左右手分侧：偶数位落左半屏、奇数位落右半屏，各自在自己的半区移动
        // 一个乐句交给一只手（左/右段交替），该手在自己半屏内从内侧走到外侧，
        // 这样既满足"左手负责左、右手负责右"，也能自然用到 ±400~470 的外侧音。
        const side = (phrase % 2 === 0) ? -1 : 1;
        const half = Math.min(Math.max(Math.abs(stairsRange(difficulty).x1), 430), 470); // 外侧至少到 ±430
        const arr = [];
        for (let i = 0; i < count; i++) {
          const k = count > 1 ? i / (count - 1) : 1;
          // 楼梯从内走到外：按参考 |x| 分位取位置（k=0 → 内侧分位，k=1 → 外侧分位），
          // 比"90..half 线性"更贴参考（参考 |x| p50≈248、>400 占 17.9%）
          const mag = Math.max(90, Math.min(560, quantileX(0.08 + 0.9 * k)));
          const x = side * mag;
          // 按风格的 flick 比例把部分音符做成红键（参考谱面 2–5%）；只在单音流里用，避免和弦变难读
          const isFlick = s.flick > 0 && rng() < s.flick;
          arr.push({ beat: start + step + i * step, type: isFlick ? 3 : 1, x: Math.round(Math.max(-560, Math.min(560, x))) });
        }
        addNotes(chart, main, arr);
        notes += arr.length;
      }
      phrase++;
    }

    /* ---------- 开场 / 休息：假线压音（pure visual） ---------- */
    if (s.density === 0 && !s._pulsed && pulseCount < maxPulse && opt.introPulse !== false) {
      const pb = Math.max(2, Math.min(beats, 16));
      try {
        applyPattern(chart, 'fakePulse', { startBeat: start, beats: pb, period: pulsePeriod, depth: 0.35, y: 0,
          style: ['tilt', 'verticalPair'][pulseCount % 2], lines: 1, tilt: 10 });
        s._pulsed = true;
        pulseCount++;
        events += 1;
      } catch { /* 忽略 */ }
    }

    /* ---------- 判定线演出 ---------- */
    const fxList = wantColor ? (s.fx || []) : [];
    if (fxList.includes('color')) {
      const pal = PALETTE[s.name] || PALETTE.verse;
      addEvents(chart, main, 'color', [{ startBeat: start, endBeat: end, from: pal[0], to: pal[1], easing: 1 }]);
      events++;
    }
    // 倾角默认禁用：参考 25 谱面里 1089 个 incline 事件的值全为 0（从未真正使用）
    if (wantFxLine && fxList.includes('sweep')) {
      applyPattern(chart, 'sweep', { line: fx, startBeat: start, beats: 2, from: -675, to: 675, easing: 4 });
      events++;
    }
    if (wantFxLine && fxList.includes('fade')) {
      addEvents(chart, fx, 'alpha', [{ startBeat: start, endBeat: Math.min(end, start + 2), from: 0, to: 110, easing: 4 }]);
      events++;
    }
  }

  /* ---------- 收尾：最后长条（必须避开末段已有音符，否则同线双长条/0.02s 长条） ---------- */
  const last = plan.sections[plan.sections.length - 1];
  {
    const sB = last.endBeat - 2;
    const mainNotes = (chart.judgeLineList[main].notes || []).filter((n) => !n.isFake);
    const overlaps = (x) => mainNotes.some((n) => {
      const b = beats(n.startTime);
      return b >= sB - 1e-6 && b <= last.endBeat + 1e-6 && Math.abs(Number(n.positionX) - x) < 214;
    });
    const lane = [0, 240, -240, 460, -460, 660 - 60].find((x) => !overlaps(x));
    if (lane != null) {
      applyPattern(chart, 'hold', { line: main, startBeat: sB, count: 1, stepBeat: 1, beats: 2, x: lane });
      notes += 1;
    }
  }

  if (opt.aiMark !== false) applyAIMark(chart, { text: '本谱面由 AI 生成', startBeat: 0, endBeat: 6 });

  // 松弛 → 中位归零
  relaxGenerated(chart, bpm, difficulty);
  {
    const all = chart.judgeLineList.flatMap((l) => l.notes || []);
    if (all.length) {
      const xs = all.map((n) => Number(n.positionX || 0)).sort((a, b) => a - b);
      const med = xs[Math.floor((xs.length - 1) / 2)];
      const minX = xs[0], maxX = xs[xs.length - 1];
      // 只做**纯平移**：以前的「超界就整体缩放」会把同刻间距一起压扁
      //（chord=8 时 224px→177px，直接掉进判定重叠区），平移永远不改变任何间距。
      const lo = -560 - minX, hi = 560 - maxX; // 平移后仍在 ±560 的合法区间
      let shift = Number.isFinite(med) ? -med : 0;
      if (lo <= hi) shift = Math.max(lo, Math.min(hi, shift));
      if (Number.isFinite(shift) && Math.abs(shift) > 0.5) {
        for (const n of all) n.positionX = Math.round(Number(n.positionX || 0) + shift);
      }
    }
  }
  relaxGenerated(chart, bpm, difficulty, { cleanupOnly: true });
  for (const l of chart.judgeLineList) l.numOfNotes = (l.notes || []).filter((n) => !n.isFake).length;
  // 演出线 alpha 基底（0→1 拍 255）与淡入（0→2 拍 0→110）区间重叠 → 收口：
  // 否则 prpr 按数组顺序压关键帧，实机亮度曲线和插件预览不一致（盲测实测到过）
  fixEventOverlaps(chart);
  const styleKey = (plan.meta && plan.meta.style) || plan.style;
  applyStyleDensity(chart, plan.sections, { params: (STYLES[styleKey] || {}).params || {} }, bpm, opt.seed);
  return { notes, events, lines: chart.judgeLineList.length, fxLine: fx };
}

/** 按比例缩放规划密度（用于对齐目标定数的闭环校准） */
export function scalePlanDensity(plan, k) {
  const out = JSON.parse(JSON.stringify(plan));
  const bpm = out.meta.bpm;
  out.meta.density = Number((out.meta.density * k).toFixed(2));
  for (const s of out.sections) {
    if (!s.density) continue;
    s.density = Number((s.density * k).toFixed(2));
    s.stepBeat = Number(clamp((bpm / 60) / s.density, 0.25, 4).toFixed(3));
  }
  return out;
}

export { fmtPlan };

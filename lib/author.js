/**
 * 谱面编辑与手法生成（AI 编排层的核心）
 * 所有时间参数默认用"拍"，也接受秒（sec）；写入时统一转成 RPE 三元组 [a,b,c]。
 */
import fs from 'node:fs';
import path from 'node:path';
import { makeBpm, toTriple, beats } from './rpe.js';

const DEN = 192;

export function bpmIndex(chart) {
  const list = (chart.BPMList || []).map((e) => ({ bpm: Number(e.bpm), startTime: e.startTime }));
  return makeBpm(list, []);
}

function lineOf(chart, index) {
  const lines = chart.judgeLineList || [];
  if (index == null) return { chart, line: lines[0], index: 0 };
  if (index < 0 || index >= lines.length) throw new Error(`判定线索引 ${index} 越界（共 ${lines.length} 条）`);
  return { chart, line: lines[index], index };
}

/** 创建一条判定线（带 RPE 默认样板字段） */
export function makeLine({ name = 'AI Line', x = 0, y = 0, rot = 0, isCover = 1, zOrder = 0, father = -1, attachUI = null } = {}) {
  const now = [0, 0, 1];
  // 基线只覆盖 1 拍：之后按 RPE「保持」语义延续，且不会挡住后续事件
  const end = [1, 0, 1];
  const ev = (start, end2, k, v) => ({ bezier: 0, bezierPoints: [0, 0, 0, 0], easingLeft: 0, easingRight: 1, easingType: 1, end: v, endTime: end2, linkgroup: 0, start: start, startTime: k });
  const line = {
    Group: 0,
    Name: name,
    Texture: 'line.png',
    bpmfactor: 1,
    eventLayers: [(() => {
      const lay = {
        alphaEvents: [ev(255, end, now, 255)],
        speedEvents: [ev(10, end, now, 10)],
      };
      // 只在需要时建键；空数组会在「图层链」上制造无关键帧节点（prpr 会 panic）
      if (x) lay.moveXEvents = [ev(x, end, now, x)];
      if (y) lay.moveYEvents = [ev(y, end, now, y)];
      if (rot) lay.rotateEvents = [ev(rot, end, now, rot)];
      return lay;
    })()],
    extended: { inclineEvents: [] },
    father,
    isCover,
    notes: [],
    numOfNotes: 0,
    zOrder,
    posControl: [{ easing: 1, pos: 1, x: 0 }, { easing: 1, pos: 1, x: 9999999 }],
    sizeControl: [{ easing: 1, size: 1, x: 0 }, { easing: 1, size: 1, x: 9999999 }],
    skewControl: [{ easing: 1, skew: 0, x: 0 }, { easing: 1, skew: 0, x: 9999999 }],
    yControl: [{ easing: 1, x: 0, y: 1 }, { easing: 1, x: 9999999, y: 1 }],
  };
  if (attachUI) line.attachUI = attachUI;
  return line;
}

export function addLine(chart, opts = {}) {
  const line = makeLine(opts);
  chart.judgeLineList = chart.judgeLineList || [];
  chart.judgeLineList.push(line);
  return chart.judgeLineList.length - 1;
}

/**
 * RGB（prpr 的 RGBColor = [u8;3]）：0~1 浮点自动 ×255，非法值直接抛错。
 * 颜色写成 0~1 是作者最常犯的错，写进文件后整张谱会因反序列化失败而打不开。
 */
export function normRGB(v, where = 'color') {
  if (!Array.isArray(v) || v.length !== 3) throw new Error(`${where}：RGB 必须是 3 个元素，收到 ${JSON.stringify(v)}`);
  const nums = v.map(Number);
  if (!nums.every((x) => Number.isFinite(x))) throw new Error(`${where}：RGB 含非数字 ${JSON.stringify(v)}`);
  if (nums.every((x) => Number.isInteger(x) && x >= 0 && x <= 255)) return nums;
  if (nums.every((x) => x >= 0 && x <= 1)) return nums.map((x) => Math.round(x * 255));
  throw new Error(`${where}：RGB 必须是 0–255 整数（或统一写 0~1 浮点），收到 ${JSON.stringify(v)}`);
}

function beatOf(spec, bpm, keys) {
  for (const k of keys) {
    if (spec[k] != null) {
      const v = Number(spec[k]);
      if (!Number.isFinite(v)) throw new Error(`${k} 必须是数字`);
      const isSec = /sec$/i.test(k); // 同时接受 sec / startSec / endSec
      return isSec ? bpm.beatAt(v) : v;
    }
  }
  return null;
}

/** 生成单个音符对象 */
export function makeNote(spec, bpm) {
  const type = Number(spec.type || 1);
  if (![1, 2, 3, 4].includes(type)) throw new Error(`type 必须是 1-4，收到 ${spec.type}`);
  const beat = spec.beat != null ? Number(spec.beat) : beatOf(spec, bpm, ['startBeat', 'startSec', 'sec', 'start']);
  if (beat == null) throw new Error('缺少开始时间：beat / startBeat / startSec / sec');
  let endBeat = beat;
  if (type === 2) {
    const eb = spec.endBeat != null ? Number(spec.endBeat) : beatOf(spec, bpm, ['endSec', 'end']);
    if (eb == null) throw new Error('Hold 需要 endBeat（或 endSec）');
    endBeat = eb;
    if (endBeat <= beat) throw new Error('Hold 的 endBeat 必须大于 beat');
  }
  const out = {
    type,
    above: spec.above == null ? 1 : Number(spec.above),
    startTime: toTriple(beat, DEN),
    endTime: toTriple(endBeat, DEN),
    // RPE 允许任意 f32，但屏幕上 |positionX|>675 就是出界（引擎坐标 = position_x/675）。
    // 这里统一夹到 ±660：任何工具/手法都不可能写出"打不到的音符"。
    positionX: Math.max(-660, Math.min(660, Number(spec.x == null ? 0 : spec.x) || 0)),
    yOffset: Number(spec.yOffset || 0),
    alpha: spec.alpha == null ? 255 : Math.max(0, Math.min(255, Number(spec.alpha))),
    size: spec.size == null ? 1 : Number(spec.size),
    speed: spec.speed == null ? 1 : Number(spec.speed),
    isFake: spec.fake ? 1 : 0,
    visibleTime: spec.visibleTime == null ? 999999 : Number(spec.visibleTime),
    judgeArea: spec.judgeArea == null ? 1 : Number(spec.judgeArea),
  };
  // 透传扩展字段（给 AI 更大自由度；RPE 里合法但工具不常用的字段）
  if (spec.tint != null) out.tint = normRGB(spec.tint, 'note.tint');
  if (spec.hitsound != null) out.hitsound = spec.hitsound;
  if (spec.extra && typeof spec.extra === 'object') Object.assign(out, spec.extra);
  return out;
}

/** 批量加音符；返回写入数量 */
export function addNotes(chart, lineIndex, specs) {
  const bpm = bpmIndex(chart);
  const { line } = lineOf(chart, lineIndex);
  line.notes = line.notes || [];
  let n = 0;
  for (const s of specs || []) {
    const note = makeNote(s, bpm);
    line.notes.push(note);
    if (!note.isFake) n++; // 长条也是真音符，Phira 计入物量
  }
  line.numOfNotes = (line.numOfNotes || 0) + n;
  line.notes.sort((a, b) => beats(a.startTime) - beats(b.startTime));
  return (specs || []).length;
}

const EVENT_KEYS = {
  moveX: 'moveXEvents', moveY: 'moveYEvents', rotate: 'rotateEvents', alpha: 'alphaEvents', speed: 'speedEvents',
};
const EXT_KEYS = {
  scaleX: 'scaleXEvents', scaleY: 'scaleYEvents', color: 'colorEvents', text: 'textEvents', incline: 'inclineEvents',
};

export function makeEvent(spec, bpm) {
  const s = spec.startBeat != null ? Number(spec.startBeat) : beatOf(spec, bpm, ['startSec', 'start']);
  if (s == null) throw new Error('事件缺少 startBeat / startSec');
  const e = spec.endBeat != null ? Number(spec.endBeat) : beatOf(spec, bpm, ['endSec', 'end']);
  if (e == null) throw new Error('事件缺少 endBeat / endSec');
  let start = spec.value != null ? spec.value : (spec.from != null ? spec.from : 0);
  let end = spec.to != null ? spec.to : (spec.value != null ? spec.value : 0);
  // colorEvents 的值是 RGBColor(u8,u8,u8)
  if (Array.isArray(start)) start = normRGB(start, 'event.start');
  if (Array.isArray(end)) end = normRGB(end, 'event.end');
  return {
    bezier: 0, bezierPoints: [0, 0, 0, 0],
    easingLeft: 0, easingRight: 1,
    easingType: spec.easing == null ? 1 : Number(spec.easing),
    endTime: toTriple(e, DEN),
    linkgroup: 0,
    start,
    startTime: toTriple(s, DEN),
    end,
  };
}

/** 加普通事件（moveX/moveY/rotate/alpha/speed）或特殊事件（scaleX/scaleY/color/text/incline） */
export function addEvents(chart, lineIndex, key, specs, layer = 0) {
  const bpm = bpmIndex(chart);
  const { line } = lineOf(chart, lineIndex);
  if (EVENT_KEYS[key]) {
    line.eventLayers = line.eventLayers || [{}];
    while (line.eventLayers.length <= layer) line.eventLayers.push({});
    const lay = line.eventLayers[layer] || (line.eventLayers[layer] = {});
    lay[EVENT_KEYS[key]] = (lay[EVENT_KEYS[key]] || []).concat((specs || []).map((s) => makeEvent(s, bpm)));
    lay[EVENT_KEYS[key]].sort((a, b) => beats(a.startTime) - beats(b.startTime));
  } else if (EXT_KEYS[key]) {
    line.extended = line.extended || {};
    line.extended[EXT_KEYS[key]] = (line.extended[EXT_KEYS[key]] || []).concat((specs || []).map((s) => makeEvent(s, bpm)));
    line.extended[EXT_KEYS[key]].sort((a, b) => beats(a.startTime) - beats(b.startTime));
  } else {
    throw new Error(`未知事件类型 ${key}；可用：${Object.keys(EVENT_KEYS).concat(Object.keys(EXT_KEYS)).join('/')}`);
  }
  return (specs || []).length;
}

/** 参数化手法 */

/**
 * 黄键只以"链"出现（试玩反馈：散落的黄键太多、手感碎）：
 * 在空档前最后一个按键后面插一条链——同 x 固定 5 个；楼梯至少 8 个。
 * @returns {number} 插入的链数
 */
export function insertDragChains(chart, opt = {}) {
  const bpm = Number(opt.bpm || 150);
  const bt = 60 / bpm; // 秒/拍
  const minGapBeat = Number(opt.minGapBeat == null ? 3 : opt.minGapBeat);
  const limit = Number(opt.limit == null ? 12 : opt.limit);
  const stepBeat = Number(opt.stepBeat == null ? 0.25 : opt.stepBeat);
  let added = 0;
  for (const l of chart.judgeLineList || []) {
    const ns = (l.notes || []).filter((n) => !Number(n.isFake)).sort((a, b) => (a.startTime[0] + (a.startTime[1] || 0) / (a.startTime[2] || 1)) - (b.startTime[0] + (b.startTime[1] || 0) / (b.startTime[2] || 1)));
    for (let i = 0; i < ns.length && added < limit; i++) {
      const n = ns[i];
      if (Number(n.type) === 4) continue;
      const b = n.startTime[0] + (n.startTime[1] || 0) / (n.startTime[2] || 1);
      const next = ns[i + 1];
      const nb = next ? next.startTime[0] + (next.startTime[1] || 0) / (next.startTime[2] || 1) : b + 99;
      // 只在"这一拍之后还有 ≥minGapBeat 拍空档"时插链，避免和后续音符抢手
      if (nb - b < minGapBeat) continue;
      // 和弦头不插（黄键紧贴双押会触发 drag-crowd）
      const chorusSib = ns.some((o) => o !== n && Math.abs((o.startTime[0] + (o.startTime[1] || 0) / (o.startTime[2] || 1)) - b) < 1e-6);
      if (chorusSib) continue;
      const x = Number(n.positionX) || 0;
      const stairs = added % 4 === 3; // 每 4 条里有 1 条楼梯
      const count = stairs ? 8 : 5;
      const dx = x >= 0 ? -1 : 1;
      for (let k = 1; k <= count; k++) {
        const beat = b + 0.5 + (k - 1) * stepBeat;
        const px = stairs ? x + dx * k * 45 : x;
        l.notes.push({
          type: 4, above: 1, startTime: [Math.floor(beat), Math.round((beat - Math.floor(beat)) * 192), 192],
          endTime: [Math.floor(beat), Math.round((beat - Math.floor(beat)) * 192), 192],
          positionX: Math.max(-660, Math.min(660, Math.round(px))), yOffset: 0, alpha: 255, size: 1, speed: 1,
          isFake: 0, visibleTime: 999999,
        });
      }
      l.numOfNotes = (l.notes || []).filter((x2) => !Number(x2.isFake)).length;
      added++;
      i += 1; // 跳过链头后面的位置，避免连续插
    }
  }
  return added;
}

export function applyPattern(chart, pattern, p = {}) {
  const bpm = bpmIndex(chart);
  const line = p.line == null ? 0 : Number(p.line);
  const start = Number(p.startBeat != null ? p.startBeat : (p.startSec != null ? bpm.beatAt(Number(p.startSec)) : 0));
  const step = Number(p.stepBeat == null ? 0.5 : p.stepBeat);
  const count = Math.max(0, Math.floor(Number(p.count == null ? 8 : p.count)));
  if (p.stepBeat != null && (!Number.isFinite(step) || step <= 0)) {
    throw new Error(`stepBeat 必须 > 0（收到 ${p.stepBeat}）：0 会产生同刻堆叠、负数会产生负拍`);
  }
  if (!Number.isFinite(start)) throw new Error(`startBeat 必须是数字（收到 ${p.startBeat != null ? p.startBeat : p.startSec}）`);
  const type = Number(p.type == null ? 1 : p.type);
  const notes = [];
  const ev = [];
  // 旋律 → x：melody 直接给坐标；pitches 给音高，按音域线性映射到 ±span
  const melodyXs = () => {
    if (Array.isArray(p.melody) && p.melody.length) return p.melody.map(Number);
    if (Array.isArray(p.pitches) && p.pitches.length) {
      const ps = p.pitches.map(Number);
      const lo = p.pitchMin == null ? Math.min(...ps) : Number(p.pitchMin);
      const hi = p.pitchMax == null ? Math.max(...ps) : Number(p.pitchMax);
      const span = Number(p.span == null ? 560 : p.span);
      return ps.map((v) => (hi === lo ? 0 : -span + (span * 2 * (v - lo)) / (hi - lo)));
    }
    return null;
  };
  const addToLine = (li, arr) => { if (arr.length) addNotes(chart, li, arr); return arr.length; };
  const spec = (beat, extra = {}) => ({ beat, type, ...extra });

  switch (pattern) {
    case 'stairs': {
      const x0 = Number(p.x0 == null ? -300 : p.x0), x1 = Number(p.x1 == null ? 300 : p.x1);
      for (let i = 0; i < count; i++) {
        const k = count === 1 ? 0 : i / (count - 1);
        notes.push(spec(start + i * step, { x: x0 + (x1 - x0) * k }));
      }
      break;
    }
    case 'trill': {
      const x1 = Number(p.x1 == null ? -200 : p.x1), x2 = Number(p.x2 == null ? 200 : p.x2);
      for (let i = 0; i < count; i++) notes.push(spec(start + i * step, { x: i % 2 ? x2 : x1 }));
      break;
    }
    case 'jack': {
      const x = Number(p.x == null ? 0 : p.x);
      for (let i = 0; i < count; i++) notes.push(spec(start + i * step, { x }));
      break;
    }
    case 'chord': {
      const xs = Array.isArray(p.xs) ? p.xs : (p.chord === 3 ? [-350, 0, 350] : [-260, 260]);
      for (let i = 0; i < count; i++) for (const x of xs) notes.push(spec(start + i * step, { x: Number(x) }));
      break;
    }
    case 'hold': {
      const beats2 = Number(p.beats == null ? 1 : p.beats);
      const x = Number(p.x == null ? 0 : p.x);
      // 默认步长必须让前后两根长条不重叠（旧默认 0.5 < 1 拍 → 同线双长条 → 漏判）
      const st = Number(p.stepBeat == null ? beats2 + 0.25 : step);
      for (let i = 0; i < count; i++) notes.push(spec(start + i * st, { type: 2, x, endBeat: start + i * st + beats2 }));
      break;
    }
    case 'holdInner': {
      // 一条长条 + 内部只放 Tap/Flick（默认），外部再放一组音符
      const beats2 = Number(p.beats == null ? 2 : p.beats);
      const x = Number(p.x == null ? 0 : p.x);
      notes.push(spec(start, { type: 2, x, endBeat: start + beats2 }));
      const innerCount = Math.max(0, Number(p.innerCount == null ? 4 : p.innerCount));
      // 长条里塞什么都可以：黄键(4)最省手（按住长条的手指顺手就判到），Tap/Flick 要另一只手
      const innerType = [1, 3, 4].includes(Number(p.innerType)) ? Number(p.innerType) : 1;
      for (let i = 1; i <= innerCount; i++) {
        const b = start + (beats2 * i) / (innerCount + 1);
        // 默认就是「同车道」：按住长条的那根手指顺手就判到（参考谱 725 例黄键内嵌都是这么写的）；
        // 想让另一只手点旁边，再显式传 innerOffset。
        notes.push({ beat: b, type: innerType, x: x + (p.innerOffset == null ? 0 : Number(p.innerOffset)) });
      }
      break;
    }
    case 'holdMelody': {
      // 长条内嵌旋律按键：按 melody 数组（或均匀分布）在长条时段内放 Drag/Flick（可含 Tap）
      const beats2 = Number(p.beats == null ? 4 : p.beats);
      const hx = Number(p.x == null ? 0 : p.x);
      notes.push(spec(start, { type: 2, x: hx, endBeat: start + beats2 }));
      const types = (Array.isArray(p.types) && p.types.length ? p.types : [4, 3])
        .map(Number).filter((t2) => [1, 3, 4].includes(t2));
      const useTypes = types.length ? types : [4, 3];
      const mel = Array.isArray(p.melody) ? p.melody.map(Number) : null;
      const n = mel ? mel.length : Math.max(1, Math.round(Number(p.count == null ? 4 : p.count)));
      const innerStart = start + Number(p.offsetBeat == null ? 0.5 : p.offsetBeat);
      const innerEnd = start + beats2 - Number(p.tailBeat == null ? 0.5 : p.tailBeat);
      const span = Math.max(0.25, innerEnd - innerStart);
      const spread = Number(p.spread == null ? 120 : p.spread);
      for (let i = 0; i < n; i++) {
        const b = n === 1 ? (innerStart + innerEnd) / 2 : innerStart + (span * i) / (n - 1);
        let x = mel ? mel[i] : hx + (((i % 5) - 2) * spread);
        const t2 = useTypes[i % useTypes.length];
        // 只有「要按下」的类型（Tap/Flick）才需要离开长条车道；
        // Drag 留在同车道才是标准写法（按住长条的那根手指顺手就判到了，不用换手）。
        // keepLane=true 时全部保留原车道 —— 长条里塞红键/蓝键是合法手法（要另一只手），只是更难读。
        if (!p.keepLane && t2 !== 4 && Math.abs(x - hx) < 214) x = hx + (x >= hx ? 240 : -240);
        notes.push({ beat: b, type: useTypes[i % useTypes.length], x: Math.max(-660, Math.min(660, x)) });
      }
      break;
    }
    case 'mirrorLines': {
      // 上下两条互为主判定线：第二条整体旋转 180°（x/y 双翻转），音符从相反方向落下
      const yA = Number(p.y == null ? -270 : p.y);
      const rotB = Number(p.rotB == null ? 180 : p.rotB);
      const a = addLine(chart, { name: p.nameA || 'Mirror-A', x: Number(p.xA || 0), y: yA, rot: Number(p.rotA == null ? 0 : p.rotA), zOrder: Number(p.zA == null ? 10 : p.zA) });
      const b = addLine(chart, { name: p.nameB || 'Mirror-B', x: -Number(p.xA || 0), y: -yA, rot: rotB, zOrder: Number(p.zB == null ? 9 : p.zB) });
      return { pattern, lines: [a, b], notes: 0 };
    }

    case 'belowDrag': {
      // 屏幕下方升上来的黄键：落点对齐「主判定线上已有的按键」，让玩家点键的瞬间刚好碰到黄键
      const xs = melodyXs();
      const n = xs ? xs.length : count;
      const lineNotes = (lineOf(chart, line).line.notes || [])
        .filter((nn) => !nn.isFake && [1, 2, 3].includes(Number(nn.type)))
        .map((nn) => ({ beat: beats(nn.startTime), x: Number(nn.positionX || 0) }))
        .sort((a, b) => a.beat - b.beat);
      for (let i = 0; i < n; i++) {
        const rawBeat = start + i * Number(p.stepBeat == null ? 0.5 : p.stepBeat);
        let target = null;
        if (p.alignToNotes !== false) {
          let best = Infinity;
          for (const nn of lineNotes) {
            const d = Math.abs(nn.beat - rawBeat);
            if (d < best) { best = d; target = nn; }
          }
          if (!target || best > Number(p.toleranceBeat == null ? 0.125 : p.toleranceBeat)) target = null;
        }
        const beat = target ? target.beat : rawBeat;
        const x = target ? target.x : (xs ? xs[i] : (((i % 5) - 2) * Number(p.spread == null ? 140 : p.spread)));
        notes.push({ beat, type: 4, x, above: 0 });
      }
      break;
    }

    case 'dualLines': {
      // 上下两条都能打的主线：xy 对称、靠边、时长受限、BPM 高时禁用
      const bpmVal = Number((bpm.points && bpm.points[0] && bpm.points[0].bpm) || p.bpm || 120);
      if (bpmVal >= Number(p.maxBpm == null ? 160 : p.maxBpm)) {
        throw new Error(`BPM ${bpmVal} 偏高，双判定线会读谱困难（阈值 ${p.maxBpm == null ? 160 : p.maxBpm}）；请改用单线`);
      }
      const beats2 = Number(p.beats == null ? 16 : p.beats);
      const maxBeats = Number(p.maxBeats == null ? 32 : p.maxBeats);
      if (beats2 > maxBeats) throw new Error(`双判定线持续 ${beats2} 拍过长（上限 ${maxBeats} 拍）`);
      const y = Number(p.y == null ? 300 : p.y);
      const xo = Number(p.xOffset == null ? 120 : p.xOffset);
      const top = addLine(chart, { name: p.nameA || 'Dual-Top', x: xo, y, rot: Number(p.rotTop == null ? 0 : p.rotTop), zOrder: Number(p.zTop == null ? 10 : p.zTop) });
      const bot = addLine(chart, { name: p.nameB || 'Dual-Bottom', x: -xo, y: -y, rot: Number(p.rotBottom == null ? 180 : p.rotBottom), zOrder: Number(p.zBottom == null ? 9 : p.zBottom) });
      const half = Number(p.halfWidth == null ? 380 : p.halfWidth);
      const upper = [], lower = [];
      for (let i = 0; i < count; i++) {
        const beat = start + i * step;
        const side = i % 2 === 0 ? -1 : 1;
        // 上面线的音符从上方落下（above=1）；下面线反向（above=0），保持同样的左右手分工
        if (side < 0) upper.push({ beat, type: 1, x: -half * 0.5 });
        else lower.push({ beat, type: 1, x: half * 0.5 });
      }
      addToLine(top, upper);
      addToLine(bot, lower);
      return { pattern, lines: [top, bot], notes: upper.length + lower.length };
    }

    case 'crossLines': {
      // 上下两条线：下方音符打到上面的线（above=0），上方音符打到下面的线（above=1）
      const topY = Number(p.topY == null ? 270 : p.topY);
      const botY = Number(p.bottomY == null ? -270 : p.bottomY);
      const a = addLine(chart, { name: p.nameA || 'Cross-Top', x: 0, y: topY, rot: 0, zOrder: Number(p.zA == null ? 10 : p.zA) });
      const b = addLine(chart, { name: p.nameB || 'Cross-Bottom', x: 0, y: botY, rot: 0, zOrder: Number(p.zB == null ? 9 : p.zB) });
      const xs = melodyXs() || [0];
      const holdBeats = Number(p.beats == null ? 0 : p.beats);
      const upper = [], lower = [];
      for (let i = 0; i < count; i++) {
        const beat = start + i * step;
        const x = xs[i % xs.length];
        const t = Number(p.type == null ? (holdBeats ? 2 : 1) : p.type);
        if (t === 2) {
          upper.push({ beat, type: 2, x, endBeat: beat + holdBeats, above: 0 });
          lower.push({ beat, type: 2, x, endBeat: beat + holdBeats, above: 1 });
        } else {
          if (i % 2 === 0) upper.push({ beat, type: t, x, above: 0 });
          else lower.push({ beat, type: t, x, above: 1 });
        }
      }
      const n1 = addToLine(a, upper), n2 = addToLine(b, lower);
      return { pattern, lines: [a, b], notes: n1 + n2 };
    }

    case 'tapDragChain': {
      // 蓝键/红键起头，后跟 N 个黄键（Drag）：同 x = "按住顺手带过去"，也可以成楼梯
      // （黄键不用按下，只要手指在原键附近经过就自动判定，所以适合做"按键之后的滑行尾"）
      const headType = [1, 3].includes(Number(p.type)) ? Number(p.type) : 1;
      const x0 = Number(p.x == null ? -200 : p.x);
      // 手感规则（试玩反馈）：同 x 的黄键链固定 5 个；楼梯状至少 8 个，且楼梯段里不要夹别的按键
      const stairs = String(p.shape || 'same') === 'stairs';
      let n = Math.max(0, Math.floor(Number(p.count == null ? (stairs ? 8 : 5) : p.count)));
      if (stairs) n = Math.max(8, n);
      else if (p.count == null) n = 5;
      const st = Number(p.stepBeat == null ? 0.25 : p.stepBeat);
      const x1 = Number(p.x2 == null ? x0 + (x0 >= 0 ? 260 : -260) : p.x2);
      notes.push({ beat: start, type: headType, x: x0 });
      for (let i = 0; i < n; i++) {
        const k = n > 1 ? i / (n - 1) : 0;
        notes.push({ beat: start + (i + 1) * st, type: 4, x: stairs ? x0 + (x1 - x0) * k : x0 });
      }
      break;
    }
    case 'holdFlick': {
      // 长条起点同时出现红键（Flick）：红键必须避开长条车道，否则默认参数自己就撞车
      const beats2 = Number(p.beats == null ? 2 : p.beats);
      const x = Number(p.x == null ? 0 : p.x);
      const st = Number(p.stepBeat == null ? beats2 + 0.5 : step); // 尾后至少留 0.5 拍，别让下一根/下一个键立刻接上
      const sgn = x >= 0 ? -1 : 1;                                  // 红键往屏幕内侧放，避免夹到边上
      const dx = p.flickDx == null ? 240 : Number(p.flickDx);        // ≥ 判定安全距离 213.5
      for (let i = 0; i < count; i++) {
        const b0 = start + i * st;
        notes.push({ beat: b0, type: 2, x, endBeat: b0 + beats2 });
        notes.push({ beat: b0, type: 3, x: x + sgn * dx });
      }
      break;
    }

    case 'fakePulse': {
      // 假判定线随旋律「压音」：scaleY 压缩 + 轻微上下浮动（不承载音符）
      const y = Number(p.y == null ? 0 : p.y);
      // 压音线样式：single=一条水平 / tilt=一条带倾斜 / verticalPair=两条竖直平行
      // （"不可以一起出现太多"：同时最多 2 条）
      const style = ['single', 'tilt', 'verticalPair'].includes(String(p.style)) ? String(p.style) : 'single';
      const lineCount = Math.min(2, Math.max(1, Math.floor(Number(p.lines == null ? (style === 'verticalPair' ? 2 : 1) : p.lines))));
      const gapY = Number(p.gapY == null ? 70 : p.gapY); // 多条线之间的间距
      // 每次出现的位置与倾斜都不一样（同一个 startBeat 结果稳定可复现）
      const seedOf = (b) => { const x = Math.sin(b * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x); };
      const varyY = Number(p.varyY == null ? 0 : p.varyY);
      const varyTilt = Number(p.varyTilt == null ? 0 : p.varyTilt);
      const varyX = Number(p.varyX == null ? 0 : p.varyX);
      const jitterY = varyY ? (seedOf(start) - 0.5) * 2 * varyY : 0;
      const jitterX = varyX ? (seedOf(start + 3.7) - 0.5) * 2 * varyX : 0;
      const tiltDeg = Number(p.tilt == null ? 10 : p.tilt) + (varyTilt ? (seedOf(start + 7.1) - 0.5) * 2 * varyTilt : 0);
      let li = p.line == null ? null : Number(p.line);
      const madeLines = [];
      if (li == null) {
        for (let k = 0; k < lineCount; k++) {
          const isVert = style === 'verticalPair';
          const isTilt = style === 'tilt';
          madeLines.push(addLine(chart, {
            name: `${p.name || 'Fake-Pulse'}${lineCount > 1 ? '-' + (k + 1) : ''}`,
            x: isVert
              ? (k === 0 ? -Number(p.dx || 300) : Number(p.dx || 300))
              : Number(p.x == null ? 0 : p.x) + jitterX,
            y: isVert ? jitterY : y + jitterY + (k - (lineCount - 1) / 2) * gapY,
            rot: isVert ? 90 : (isTilt ? tiltDeg : Number(p.rot || 0)),
            zOrder: Number(p.zOrder == null ? -3 : p.zOrder) - k,
          }));
        }
        li = madeLines[0];
      }
      const beats2 = Number(p.beats == null ? 16 : p.beats);
      const period = Math.max(0.25, Number(p.period == null ? 1 : p.period));
      const depth = Number(p.depth == null ? 0.45 : p.depth);
      const xs = melodyXs();
      const pulses = Math.max(1, Math.round(beats2 / period));
      const sc = [];
      for (let i = 0; i < pulses; i++) {
        const b = start + i * period;
        sc.push({ startBeat: b, endBeat: b + period * 0.35, from: 1, to: 1 - depth, easing: 4 });
        sc.push({ startBeat: b + period * 0.35, endBeat: b + period, from: 1 - depth, to: 1, easing: 2 });
      }
      // 实机反馈：给压音线写「每拍 scaleY 压缩」会让整屏闪烁（B 包验证：去掉压缩就正常），
      // 所以默认**不压缩**，只做 alpha 出现/消失；要压缩必须显式传 pulse:true。
      if (p.pulse === true) for (const idx of (madeLines.length ? madeLines : [li])) addEvents(chart, idx, 'scaleY', sc);
      // 默认补 alpha 淡入/淡出：假线只在 start..start+beats 内可见
      const fadeIn = Math.min(0.75, beats2 / 4);
      for (const idx of (madeLines.length ? madeLines : [li])) {
        const { line: pl } = lineOf(chart, idx);
        pl.eventLayers = pl.eventLayers && pl.eventLayers.length ? pl.eventLayers : [{}];
        pl.eventLayers[0].alphaEvents = [
          // 关键：首个 alpha 关键帧必须在 0s。引擎 line.rs:237 `alpha.now_opt().unwrap_or(1.0)`
          // 在第一个关键帧之前会回落成 1.0（完全不透明）——不补这一条，压音线从 0s 起就一直可见。
          { bezier: 0, bezierPoints: [0, 0, 0, 0], easingLeft: 0, easingRight: 1, easingType: 1,
            start: 0, startTime: [0, 0, 1], end: 0, endTime: toTriple(Math.max(start, 1 / DEN), DEN) },
          { bezier: 0, bezierPoints: [0, 0, 0, 0], easingLeft: 0, easingRight: 1, easingType: 2,
            start: 0, startTime: toTriple(start, DEN), end: 255, endTime: toTriple(start + fadeIn, DEN) },
          { bezier: 0, bezierPoints: [0, 0, 0, 0], easingLeft: 0, easingRight: 1, easingType: 2,
            start: 255, startTime: toTriple(start + beats2 - fadeIn, DEN), end: 0, endTime: toTriple(start + beats2, DEN) },
        ];
      }
      // 上下浮动：有旋律就按旋律，没有就按拍轻轻浮动（假线"呼吸"）
      const bob = Number(p.bob == null ? 40 : p.bob);
      const mv = [];
      for (let i = 0; i < pulses; i++) {
        const b = start + i * period;
        const amp = xs ? (xs[i % xs.length] / 675) * bob : (i % 2 ? bob : -bob) * 0.6;
        mv.push({ startBeat: b, endBeat: b + period * 0.9, from: y + jitterY, to: y + jitterY + amp, easing: 6 });
      }
      for (const idx of (madeLines.length ? madeLines : [li])) addEvents(chart, idx, 'moveY', mv);
      // 卡点旋转：每个脉冲轻轻扭一下（假线只做演出，扭它不影响判定）
      const rotDepth = Number(p.rotDepth == null ? 0 : p.rotDepth); // 默认**不旋转**：压音线只做出现/消失 + 压缩
      if (rotDepth > 0) {
        const rot = [];
        for (let i = 0; i < pulses; i++) {
          const b = start + i * period;
          rot.push({ startBeat: b, endBeat: b + period * 0.5, from: i % 2 ? -rotDepth : rotDepth, to: i % 2 ? rotDepth : -rotDepth, easing: 4 });
        }
        for (const idx of (madeLines.length ? madeLines : [li])) addEvents(chart, idx, 'rotate', rot);
      }
      fixEventOverlaps(chart);
      return { pattern, lines: [li], notes: 0, pulses };
    }

    case 'holdFlickMelody': {
      // 一只手一直按长条，另一只手按旋律打红键
      const beats2 = Number(p.beats == null ? 8 : p.beats);
      const hx = Number(p.x == null ? -260 : p.x);
      const xs = melodyXs() || [260, 120, 300, 60, 200];
      const gap = Number(p.minGap == null ? 260 : p.minGap);
      notes.push({ beat: start, type: 2, x: hx, endBeat: start + beats2 });
      const n = Math.max(1, Math.round(Number(p.count == null ? xs.length : p.count)));
      const span = Math.max(0.25, beats2 - Number(p.offsetBeat == null ? 0.5 : p.offsetBeat) - Number(p.tailBeat == null ? 0.5 : p.tailBeat));
      const innerStart = start + Number(p.offsetBeat == null ? 0.5 : p.offsetBeat);
      for (let i = 0; i < n; i++) {
        const b = n === 1 ? innerStart + span / 2 : innerStart + (span * i) / (n - 1);
        let x = xs[i % xs.length];
        if (Math.abs(x - hx) < gap) x = hx + (x >= hx ? gap : -gap); // 避开长条所在车道
        notes.push({ beat: b, type: Number(p.flickType == null ? 3 : p.flickType), x: Math.max(-620, Math.min(620, x)) });
      }
      break;
    }

    case 'sweep': {
      const axis = p.axis === 'y' ? 'moveY' : 'moveX';
      const from = Number(p.from == null ? -675 : p.from), to = Number(p.to == null ? 675 : p.to);
      const beats2 = Number(p.beats == null ? 2 : p.beats);
      ev.push({ key: axis, spec: { startBeat: start, endBeat: start + beats2, from, to, easing: Number(p.easing == null ? 4 : p.easing) } });
      break;
    }
    case 'vertical': {
      const x = Number(p.x == null ? -650 : p.x), rot = Number(p.rot == null ? 90 : p.rot);
      // 零时长事件会被部分实现跳过（AGENTS「不要写零时长事件」）→ 给 1 拍区间，start=end 视觉无差异
      addEvents(chart, line, 'moveX', [{ startBeat: 0, endBeat: 1, value: x }]);
      addEvents(chart, line, 'rotate', [{ startBeat: 0, endBeat: 1, value: rot }]);
      const span = Number(p.span == null ? 600 : p.span);
      for (let i = 0; i < count; i++) {
        const x = p.noteX != null ? Number(p.noteX)
          : (count === 1 ? 0 : -span / 2 + (span * i) / (count - 1));
        notes.push(spec(start + i * step, { x }));
      }
      break;
    }
    case 'fourSide': {
      const idx = [];
      const specs = [
        { name: 'Top', x: 0, y: 450, rot: 0 },
        { name: 'Bottom', x: 0, y: -450, rot: 0 },
        { name: 'Left', x: -620, y: 0, rot: 90 },
        { name: 'Right', x: 620, y: 0, rot: -90 },
      ];
      for (const s of specs) idx.push(addLine(chart, s));
      // 每条线各放一个音符，形成 4 面同时
      idx.forEach((li, i) => {
        addNotes(chart, li, [{ beat: start + i * 0, type: 1, x: 0 }]);
      });
      return { lines: idx, notes: idx.length };
    }
    case 'freeze': {
      // 安全实现：把该线已有流速事件替换为「常速 → 冻结 → 恢复」的分段表
      const beats2 = Number(p.beats == null ? 2 : p.beats);
      const base = Number(p.baseSpeed == null ? 10 : p.baseSpeed);
      const { line: l2 } = lineOf(chart, line);
      l2.eventLayers = l2.eventLayers || [{}];
      l2.eventLayers[0] = l2.eventLayers[0] || {};
      const pre = start > 1e-6
        ? [{ bezier: 0, bezierPoints: [0, 0, 0, 0], easingLeft: 0, easingRight: 1, easingType: 1, end: base, endTime: toTriple(start, DEN), linkgroup: 0, start: base, startTime: [0, 0, 1] }]
        : []; // start=0 时不要写 0→0 的零时长事件
      l2.eventLayers[0].speedEvents = [
        ...pre,
        { bezier: 0, bezierPoints: [0, 0, 0, 0], easingLeft: 0, easingRight: 1, easingType: 1, end: 0, endTime: toTriple(start + beats2, DEN), linkgroup: 0, start: 0, startTime: toTriple(start, DEN) },
        { bezier: 0, bezierPoints: [0, 0, 0, 0], easingLeft: 0, easingRight: 1, easingType: 1, end: base, endTime: [9999999, 0, 1], linkgroup: 0, start: base, startTime: toTriple(start + beats2, DEN) },
      ];
      break;
    }
    default:
      throw new Error(`未知手法 ${pattern}；可用：stairs/trill/jack/chord/hold/holdInner/holdMelody/tapDragChain/mirrorLines/belowDrag/dualLines/crossLines/holdFlick/fakePulse/holdFlickMelody/sweep/vertical/fourSide/freeze`);
  }

  if (notes.length) addNotes(chart, line, notes);
  for (const e of ev) addEvents(chart, line, e.key, [e.spec]);
  return { pattern, notes: notes.length, lines: 0 };
}

/** AI 水印：一条只显示文字、不放音符的判定线（到点自动清屏） */
export function applyAIMark(chart, { text = '本谱面由 AI 生成', startBeat = 0, endBeat = 6, y = -420 } = {}) {
  // 幂等：已经有 AI-Mark 线就复用（旧实现每调用一次就多一条水印线，重复调用会把画面叠成一团）
  let idx = (chart.judgeLineList || []).findIndex((l) => l && l.Name === 'AI-Mark');
  if (idx < 0) idx = addLine(chart, { name: 'AI-Mark', x: 0, y, rot: 0, zOrder: 99 });
  const line = chart.judgeLineList[idx];
  const ev = (sBeat, eBeat, sVal, eVal) => ({
    bezier: 0, bezierPoints: [0, 0, 0, 0], easingLeft: 0, easingRight: 1, easingType: 1,
    end: eVal, endTime: toTriple(eBeat, DEN), font: 'cmdysj', linkgroup: 0,
    start: sVal, startTime: toTriple(sBeat, DEN),
  });
  line.extended = line.extended || {};
  // 文字：显示到 endBeat，随后用空串清屏（RPE 语义是「保持最后值」，不清会一直挂着）
  line.extended.textEvents = [
    ev(startBeat, endBeat, text, text),
    ev(endBeat, endBeat + 1, '', ''),
  ].sort((a, b) => beats(a.startTime) - beats(b.startTime));
  // 透明度：直接**覆盖**整条 alpha 轨（不追加），否则重复调用会留下重叠事件
  line.eventLayers = line.eventLayers && line.eventLayers.length ? line.eventLayers : [{}];
  line.eventLayers[0] = line.eventLayers[0] || {};
  line.eventLayers[0].alphaEvents = [
    { bezier: 0, bezierPoints: [0, 0, 0, 0], easingLeft: 0, easingRight: 1, easingType: 1, end: 255, endTime: toTriple(endBeat, DEN), linkgroup: 0, start: 255, startTime: toTriple(startBeat, DEN) },
    { bezier: 0, bezierPoints: [0, 0, 0, 0], easingLeft: 0, easingRight: 1, easingType: 1, end: 0, endTime: toTriple(endBeat + 1, DEN), linkgroup: 0, start: 0, startTime: toTriple(endBeat, DEN) },
  ];
  return idx;
}

/** 原子写谱面 */
export function writeChart(file, chart) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(chart, null, 2) + '\n');
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    // Windows: rename 不能覆盖已存在文件
    if (fs.existsSync(file)) { try { fs.unlinkSync(file); } catch { /* ignore */ } }
    fs.renameSync(tmp, file);
  }
  return file;
}

/**
 * 同一轨道里「区间重叠」的事件必须收口：
 * prpr 的 parse_events 按**数组顺序**把 start/end 压成关键帧（不排序），两个事件时间区间交叠时，
 * 关键帧序列会变成 (0,255)(1,255)(0,0)(2,110) 这种乱序，cursor 推进给出的亮度/位移与"看起来"完全不同；
 * 而插件的预览是按时间排序求值的 → 预览与实机不一致。
 * 参考谱面 24/25 张完全无重叠（唯一有的是已排除的耐力谱）。
 */
export function fixEventOverlaps(chart) {
  const b = (t) => (Array.isArray(t) ? beats(t) : NaN);
  const clip = (arr) => {
    if (!Array.isArray(arr) || arr.length < 2) return 0;
    const sorted = arr.slice().sort((x, y) => b(x.startTime) - b(y.startTime));
    let n = 0;
    for (let i = 0; i + 1 < sorted.length; i++) {
      const end = b(sorted[i].endTime), next = b(sorted[i + 1].startTime);
      if (Number.isFinite(end) && Number.isFinite(next) && end > next + 1e-9) {
        sorted[i].endTime = toTriple(next, DEN);
        n++;
      }
    }
    // 收口后变成零时长的事件对部分实现无效（alpha 闸门会失效）→ 直接丢掉
    const keep = sorted.filter((e) => b(e.endTime) > b(e.startTime) + 1e-9);
    const dropped = sorted.length - keep.length;
    if (n || dropped) {
      arr.length = 0;
      arr.push(...keep);
      return n + dropped;
    }
    return 0;
  };
  let n = 0;
  for (const l of chart.judgeLineList || []) {
    for (const ly of l.eventLayers || []) {
      for (const k of Object.keys(ly || {})) n += clip(ly[k]);
    }
    for (const k of Object.keys(l.extended || {})) n += clip(l.extended[k]);
  }
  return n;
}

/** 写 info.yml（保留未知字段） */
export function writeInfo(file, updates) {
  let lines = [];
  if (fs.existsSync(file)) lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  while (lines.length && lines[0].trim() === '') lines.shift(); // 别留首行空行
  const seen = new Set();
  const out = lines.map((line) => {
    const m = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!m) return line;
    const k = m[1];
    if (updates[k] === undefined) return line;
    seen.add(k);
    const v = updates[k];
    return `${k}: ${Array.isArray(v) ? `[${v.map((x) => String(x)).join(', ')}]` : v}`;
  });
  for (const [k, v] of Object.entries(updates)) {
    if (seen.has(k)) continue;
    out.push(`${k}: ${Array.isArray(v) ? `[${v.map((x) => String(x)).join(', ')}]` : v}`);
  }
  fs.writeFileSync(file, out.join('\n').replace(/\n+$/, '') + '\n');
  return file;
}

export { path };

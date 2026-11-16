/**
 * Phira / RPE 谱面核心库（纯 ESM，无依赖）
 * 数学与字段严格对齐 prpr `parse/rpe.rs`、`core/note.rs`、`core/resource.rs`。
 */
export const RPE_WIDTH = 1350;
export const RPE_HEIGHT = 900;
export const HEIGHT_RATIO = 0.83175;
export const SPEED_RATIO = 10 / 45 / HEIGHT_RATIO; // ≈0.26717 world/s @RPE speed 1
export const NOTE_WIDTH_RATIO_BASE = 0.13175016;   // 音符绘制宽 = 屏宽 13.175%
export const X_DIFF_MAX = (0.21 / (16 / 9)) * 2;   // ≈0.23625 world = 判定半宽
export const NOTE_TYPES = { 1: 'tap', 2: 'hold', 3: 'flick', 4: 'drag' };
export const UI_ELEMENTS = ['pause', 'combonumber', 'combo', 'score', 'bar', 'name', 'level'];
export const LIMIT = { perfect: 0.08, good: 0.16, bad: 0.22 };

/** RPE beat 三元组 [a,b,c] → 拍数；c=0 或非法 → NaN（引擎会 panic） */
export function beats(t) {
  if (!Array.isArray(t) || t.length < 3) return NaN;
  const a = Number(t[0]), b = Number(t[1]), c = Number(t[2]);
  if (![a, b, c].every(Number.isFinite) || c === 0) return NaN;
  return a + b / c;
}

/**
 * 拍数 → RPE 三元组 [a,b,c]（a=i32 有符号，b、c 必须是 u32 非负整数）。
 * 负拍要落成「floor + 正的分数」：-1.5 → [-2, 1, 2]。
 * 旧实现输出 [-1, -3, 6]（b<0），prpr 的 serde 会直接拒绝整张谱。
 */
export function toTriple(beat, den = 192) {
  if (!Number.isFinite(beat)) throw new Error(`toTriple 收到非有限拍数：${beat}`);
  const whole = Math.floor(beat + 1e-9);
  let num = Math.round((beat - whole) * den);
  let d = den;
  if (num < 0) { num = 0; } // 浮点抖动兜底：分数部分必须 >= 0
  while (num > 0 && num % 2 === 0 && d % 2 === 0) { num /= 2; d /= 2; }
  return [whole, num, d];
}

/** BPM 表：{ beat→秒 / 秒→拍 / bpmAt } */
export function makeBpm(list, errors = []) {
  const pts = [];
  for (const e of (list || [])) {
    const b = beats(e && e.startTime);
    const bpm = Number(e && e.bpm);
    if (!Number.isFinite(b)) { errors.push({ code: 'bpm-time-nan', msg: `BPM 事件 startTime 非法（分母为 0 或缺失）` }); continue; }
    if (!Number.isFinite(bpm) || bpm <= 0) { errors.push({ code: 'bpm-invalid', msg: `BPM 值非法：${e && e.bpm}` }); continue; }
    pts.push({ beat: b, bpm });
  }
  pts.sort((x, y) => x.beat - y.beat);
  if (!pts.length) pts.push({ beat: 0, bpm: 120 });
  let sec = 0;
  for (let i = 0; i < pts.length; i++) {
    if (i > 0) sec += ((pts[i].beat - pts[i - 1].beat) * 60) / pts[i - 1].bpm;
    pts[i].sec = sec;
  }
  const at = (beat) => {
    if (!Number.isFinite(beat)) return NaN;
    let i = 0;
    while (i + 1 < pts.length && pts[i + 1].beat <= beat) i++;
    const p = pts[i];
    return p.sec + (beat - p.beat) * (60 / p.bpm);
  };
  const beatAt = (s) => {
    if (!Number.isFinite(s)) return NaN;
    let i = 0;
    while (i + 1 < pts.length && pts[i + 1].sec <= s) i++;
    const p = pts[i];
    return p.beat + (s - p.sec) / (60 / p.bpm);
  };
  const bpmAt = (beat) => {
    let i = 0;
    while (i + 1 < pts.length && pts[i + 1].beat <= beat) i++;
    return pts[i].bpm;
  };
  return { points: pts, at, beatAt, bpmAt, length: pts.length };
}

/* ---------------- 缓动（官方 29 种，1-based） ---------------- */
const PI = Math.PI;
const pow2 = (x) => Math.pow(2, x);
const bounceOut = (x) => {
  const n1 = 7.5625, d1 = 2.75;
  if (x < 1 / d1) return n1 * x * x;
  if (x < 2 / d1) { const t = x - 1.5 / d1; return n1 * t * t + 0.75; }
  if (x < 2.5 / d1) { const t = x - 2.25 / d1; return n1 * t * t + 0.9375; }
  const t = x - 2.625 / d1; return n1 * t * t + 0.984375;
};
export const EASING_NAMES = [
  'Linear', 'Out Sine', 'In Sine', 'Out Quad', 'In Quad', 'In Out Sine', 'In Out Quad',
  'Out Cubic', 'In Cubic', 'Out Quart', 'In Quart', 'In Out Cubic', 'In Out Quart',
  'Out Quint', 'In Quint', 'Out Expo', 'In Expo', 'Out Circ', 'In Circ', 'Out Back', 'In Back',
  'In Out Circ', 'In Out Back', 'Out Elastic', 'In Elastic', 'Out Bounce', 'In Bounce',
  'In Out Bounce', 'In Out Elastic',
];
const F = {
  sine: (x) => 1 - Math.cos((x * PI) / 2),
  quad: (x) => x * x,
  cubic: (x) => x * x * x,
  quart: (x) => x * x * x * x,
  quint: (x) => x * x * x * x * x,
  expo: (x) => pow2(10 * (x - 1)),
  circ: (x) => 1 - Math.sqrt(Math.max(0, 1 - x * x)),
  back: (x) => { const C1 = 1.70158, C3 = C1 + 1; return (C3 * x - C1) * x * x; },
  elastic: (x) => { const C4 = (2 * PI) / 3; return -(pow2(10 * x - 10) * Math.sin((x * 10 - 10.75) * C4)); },
  bounce: (x) => 1 - bounceOut(1 - x),
};
const out__ = (f) => (x) => 1 - f(1 - x);
const inout__ = (f) => (x) => { const y = x * 2; return y < 1 ? f(y) / 2 : 1 - f(2 - y) / 2; };
const OUT = (f) => out__(f), IN = (f) => f, IO = (f) => inout__(f);
/** 缓动函数表：索引 1..29，与 RPE easingType 一致 */
export const EASINGS = (() => {
  const a = [null];
  const push = (fn) => a.push(fn);
  push((x) => x);                    // 1 Linear
  push(OUT(F.sine));                 // 2 Out Sine
  push(IN(F.sine));                  // 3 In Sine
  push(OUT(F.quad));                 // 4 Out Quad
  push(IN(F.quad));                  // 5 In Quad
  push(IO(F.sine));                  // 6 In Out Sine
  push(IO(F.quad));                  // 7 In Out Quad
  push(OUT(F.cubic));                // 8 Out Cubic
  push(IN(F.cubic));                 // 9 In Cubic
  push(OUT(F.quart));                // 10 Out Quart
  push(IN(F.quart));                 // 11 In Quart
  push(IO(F.cubic));                 // 12 In Out Cubic
  push(IO(F.quart));                 // 13 In Out Quart
  push(OUT(F.quint));                // 14 Out Quint
  push(IN(F.quint));                 // 15 In Quint
  push((x) => (x === 1 ? 1 : 1 - pow2(-10 * x)));  // 16 Out Expo
  push((x) => (x === 0 ? 0 : pow2(10 * x - 10)));  // 17 In Expo
  push(OUT(F.circ));                 // 18 Out Circ
  push(IN(F.circ));                  // 19 In Circ
  push(OUT(F.back));                 // 20 Out Back
  push(IN(F.back));                  // 21 In Back
  push(IO(F.circ));                  // 22 In Out Circ
  push(IO(F.back));                  // 23 In Out Back
  push((x) => (x === 0 ? 0 : x === 1 ? 1 : pow2(-10 * x) * Math.sin((x * 10 - 0.75) * ((2 * PI) / 3)) + 1)); // 24
  push((x) => (x === 0 ? 0 : x === 1 ? 1 : -pow2(10 * x - 10) * Math.sin((x * 10 - 10.75) * ((2 * PI) / 3)))); // 25
  push(OUT(F.bounce));               // 26
  push(IN(F.bounce));                // 27
  push(IO(F.bounce));                // 28
  push((x) => (x === 0 ? 0 : x === 1 ? 1 : x < 0.5
    ? -(pow2(20 * x - 10) * Math.sin((20 * x - 11.125) * ((2 * PI) / 4.5))) / 2
    : (pow2(-20 * x + 10) * Math.sin((20 * x - 11.125) * ((2 * PI) / 4.5))) / 2 + 1)); // 29
  return a;
})();
export function ease(type, x) {
  const f = EASINGS[Math.max(1, Math.min(29, type | 0))] || EASINGS[1];
  return f(Math.max(0, Math.min(1, x)));
}

/* ---------------- 归一化 ---------------- */
function normEvent(e, layerIndex) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return null; // 由调用方过滤并记 error
  const st = beats(e.startTime), et = beats(e.endTime);
  return {
    startTime: e.startTime, endTime: e.endTime,
    st, et,
    start: e.start, end: e.end,
    easingType: e.easingType === undefined ? 1 : Number(e.easingType),
    bezier: Number(e.bezier || 0),
    bezierPoints: e.bezierPoints || [0, 0, 0, 0],
    easingLeft: e.easingLeft === undefined ? 0 : Number(e.easingLeft),
    easingRight: e.easingRight === undefined ? 1 : Number(e.easingRight),
    layer: layerIndex,
    raw: e,
  };
}

function normNote(n) {
  if (!n || typeof n !== 'object' || Array.isArray(n)) return null;
  const st = beats(n.startTime), et = beats(n.endTime);
  return {
    type: Number(n.type === undefined ? 1 : n.type),
    above: n.above === undefined ? 1 : Number(n.above),
    startTime: n.startTime, endTime: n.endTime, st, et,
    x: Number(n.positionX === undefined ? 0 : n.positionX),
    yOffset: Number(n.yOffset || 0),
    alpha: n.alpha === undefined ? 255 : Number(n.alpha),
    size: Number(n.size === undefined ? 1 : n.size),
    speed: Number(n.speed === undefined ? 1 : n.speed),
    isFake: Number(n.isFake || 0),
    visibleTime: Number(n.visibleTime === undefined ? 999999 : n.visibleTime),
    judgeArea: n.judgeArea === undefined ? 1 : Number(n.judgeArea),
    tint: n.tint || n.color || null,
    hitsound: n.hitsound || null,
    raw: n,
  };
}

const EV_KEYS = ['moveXEvents', 'moveYEvents', 'rotateEvents', 'alphaEvents', 'speedEvents'];
const EXT_KEYS = ['scaleXEvents', 'scaleYEvents', 'colorEvents', 'textEvents', 'inclineEvents', 'paintEvents', 'gifEvents'];

function normLine(l, index, errors) {
  const pushErr = (code, msg) => { if (errors) errors.push({ code, msg }); };
  const layers = [];
  const rawLayers = Array.isArray(l.eventLayers) ? l.eventLayers : [];
  if (l.eventLayers != null && !Array.isArray(l.eventLayers)) pushErr('layers-not-array', `judgeLineList[${index}].eventLayers 必须是数组`);
  rawLayers.forEach((lay, li) => {
    const out = {};
    for (const k of EV_KEYS) {
      const arr = Array.isArray(lay && lay[k]) ? lay[k] : [];
      const mapped = arr.map((e) => normEvent(e, li));
      if (mapped.some((x) => x === null)) pushErr('event-not-object', `judgeLineList[${index}].eventLayers[${li}].${k} 含 null / 非对象元素`);
      out[k] = mapped.filter(Boolean).sort((a, b) => a.st - b.st);
    }
    layers.push(out);
  });
  if (!layers.length) { const empty = {}; for (const k of EV_KEYS) empty[k] = []; layers.push(empty); }
  const ext = {};
  if (l.extended != null && (typeof l.extended !== 'object' || Array.isArray(l.extended))) pushErr('extended-not-object', `judgeLineList[${index}].extended 必须是对象`);
  for (const k of EXT_KEYS) {
    const src = l.extended && Array.isArray(l.extended[k]) ? l.extended[k] : [];
    const mapped = src.map((e) => normEvent(e, 5));
    if (mapped.some((x) => x === null)) pushErr('event-not-object', `judgeLineList[${index}].extended.${k} 含 null / 非对象元素`);
    ext[k] = mapped.filter(Boolean).sort((a, b) => a.st - b.st);
  }
  return {
    index,
    name: l.Name || 'Untitled',
    texture: l.Texture || 'line.png',
    isGif: !!l.isGif,
    isCover: l.isCover === undefined ? 1 : Number(l.isCover),
    father: l.father === undefined ? -1 : Number(l.father),
    rotWithFather: l.rotateWithFather === undefined ? false : !!l.rotateWithFather,
    zOrder: Number(l.zOrder || 0),
    attachUI: l.attachUI || null,
    anchor: Array.isArray(l.anchor) ? l.anchor : [0.5, 0.5],
    bpmfactor: l.bpmfactor === undefined ? 1 : Number(l.bpmfactor),
    layers,
    extended: ext,
    controls: {
      pos: l.posControl || [], size: l.sizeControl || [],
      alpha: l.alphaControl || [], y: l.yControl || [], skew: l.skewControl || [],
    },
    notes: (() => {
      const arr = Array.isArray(l.notes) ? l.notes : [];
      const mapped = arr.map(normNote);
      if (mapped.some((x) => x === null)) pushErr('note-not-object', `judgeLineList[${index}].notes 含 null / 非对象元素`);
      return mapped.filter(Boolean);
    })(),
    raw: l,
  };
}

/** 解析 RPE JSON 为内部结构 */
export function normalizeChart(json) {
  const errors = [], warnings = [];
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return { errors: [{ code: 'not-object', msg: '谱面不是 JSON 对象' }], warnings, lines: [], notes: [], bpm: makeBpm([], errors), raw: json };
  }
  const bpm = makeBpm(json.BPMList, errors);
  const meta = json.META || {};
  const rawLines = Array.isArray(json.judgeLineList) ? json.judgeLineList : [];
  const lines = [];
  rawLines.forEach((l, i) => {
    if (!l || typeof l !== 'object' || Array.isArray(l)) {
      errors.push({ code: 'line-not-object', msg: `judgeLineList[${i}] 不是对象（null / 字符串 / 数组），已跳过` });
      return;
    }
    lines.push(normLine(l, i, errors));
  });
  // 事件时间：拍 → 秒（关键修正：此前 st/et 存的是拍数，与音符的秒混用）
  const toSec = (evs) => {
    if (!evs) return;
    for (const e of evs) {
      if (e && Number.isFinite(e.st)) e.st = bpm.at(e.st);
      if (e && Number.isFinite(e.et)) e.et = bpm.at(e.et);
    }
  };
  for (const l of lines) {
    for (const ly of l.layers) {
      toSec(ly.alphaEvents); toSec(ly.moveXEvents); toSec(ly.moveYEvents);
      toSec(ly.rotateEvents); toSec(ly.speedEvents);
    }
    for (const k of Object.keys(l.extended || {})) {
      if (Array.isArray(l.extended[k])) toSec(l.extended[k]);
    }
  }
  for (const l of lines) {
    for (const n of l.notes) {
      n.line = l.index;
      n.bpmfactor = l.bpmfactor;
      n.sec = bpm.at(n.st);
      n.endSec = bpm.at(n.et);
    }
  }
  for (const l of lines) {
    if (l.raw && l.raw.notes != null && !Array.isArray(l.raw.notes)) {
      errors.push({ code: 'notes-not-array', msg: `judgeLineList[${l.index}].notes 必须是数组` });
    }
  }
  const notes = lines.flatMap((l) => l.notes);
  notes.sort((a, b) => (a.sec - b.sec) || (a.line - b.line));
  return {
    raw: json, meta, bpm, lines, notes, errors, warnings,
    offset: Number(meta.offset || 0) / 1000,
    rpeVersion: Number(meta.RPEVersion || 0),
  };
}

/** 生成一个可直接被 RPE/Phira 打开的最小谱面骨架 */
export function emptyChart({ bpm = 180, title = 'AI Chart', charter = 'AI', lineY = -270 } = {}) {
  const line = {
    Group: 0, Name: 'Untitled', Texture: 'line.png',
    bpmfactor: 1,
    eventLayers: [{
      alphaEvents: [
        { bezier: 0, bezierPoints: [0, 0, 0, 0], easingLeft: 0, easingRight: 1, easingType: 1, end: 255, endTime: [1, 0, 1], linkgroup: 0, start: 255, startTime: [0, 0, 1] },
      ],
      speedEvents: [
        { bezier: 0, bezierPoints: [0, 0, 0, 0], easingLeft: 0, easingRight: 1, easingType: 1, end: 10, endTime: [1, 0, 1], linkgroup: 0, start: 10, startTime: [0, 0, 1] },
      ],
      // 主线默认放在屏幕偏下（参考谱面 y 中位数 ≈ -270），避免"判定线在屏幕正中"
      moveYEvents: [
        { bezier: 0, bezierPoints: [0, 0, 0, 0], easingLeft: 0, easingRight: 1, easingType: 1, end: Number(lineY), endTime: [1, 0, 1], linkgroup: 0, start: Number(lineY), startTime: [0, 0, 1] },
      ],
    }],
    extended: { inclineEvents: [] },
    father: -1, isCover: 1, notes: [], numOfNotes: 0, zOrder: 0,
    posControl: [{ easing: 1, pos: 1, x: 0 }, { easing: 1, pos: 1, x: 9999999 }],
    sizeControl: [{ easing: 1, size: 1, x: 0 }, { easing: 1, size: 1, x: 9999999 }],
    skewControl: [{ easing: 1, skew: 0, x: 0 }, { easing: 1, skew: 0, x: 9999999 }],
    yControl: [{ easing: 1, x: 0, y: 1 }, { easing: 1, x: 9999999, y: 1 }],
  };
  return {
    BPMList: [{ bpm, startTime: [0, 0, 1] }],
    META: { RPEVersion: 170, background: 'background.png', charter, composer: 'Unknown', id: '0', level: 'IN Lv.1', name: title, offset: 0, song: 'song.mp3' },
    judgeLineGroup: ['Default'],
    judgeLineList: [line],
  };
}

/** 谱面时长（秒）：安全的 reduce，忽略 NaN/Infinity（`Math.max(...arr)` 在超大数组上会抛 RangeError） */
export function chartDuration(notes) {
  let d = 0;
  for (const n of notes || []) {
    const v = Number.isFinite(n.endSec) ? n.endSec : n.sec;
    if (Number.isFinite(v) && v > d) d = v;
  }
  return d;
}

/** 预览/统计用的时长上限（秒）：脏数据里 t=1e9 会让 new Array(NaN/1e9) 直接 OOM */
export const MAX_PREVIEW_SEC = 9000;

/** 单个事件内部插值 */
export function valueAt(e, sec) {
  if (!Number.isFinite(e.st) || !Number.isFinite(e.et)) return Number(e.start) || 0;
  const span = e.et - e.st;
  if (span <= 1e-9) return Number(e.start) || 0;
  let x = (sec - e.st) / span;
  let l = e.easingLeft == null ? 0 : e.easingLeft;
  let r = e.easingRight == null ? 1 : e.easingRight;
  if (!(r > l)) { l = 0; r = 1; }
  x = l + Math.max(0, Math.min(1, x)) * (r - l);
  const k = ease(e.easingType, Math.max(0, Math.min(1, x)));
  const a = Number(e.start), b = Number(e.end);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.isFinite(a) ? a : 0;
  return a + (b - a) * k;
}

/**
 * 单层事件求值。RPE 的空隙语义：最后一个事件结束后到下一个事件开始之间，
 * 从上一事件的 end 线性过渡到下一事件的 start（prpr 用关键帧插值实现）。
 */
export function evalSeries(evs, sec) {
  if (!evs || !evs.length) return 0;
  let lo = 0, hi = evs.length - 1, idx = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (evs[m].st <= sec) { idx = m; lo = m + 1; } else hi = m - 1;
  }
  if (idx < 0) return Number(evs[0].start) || 0;
  const e = evs[idx];
  if (Number.isFinite(e.et) && sec <= e.et) return valueAt(e, sec);
  // 关键：prpr 的 keyframe tween 0 是 |_| 0.（阶跃），区间之间「保持上一事件的结束值」，
  // 不做线性插值。这正是"多余的线/音符方向歪"的根源。
  return Number(e.end) || 0;
}

/**
 * 音符在屏幕上的 x（世界单位）：判定线位移 + 旋转后的横向偏移。
 * 引擎里音符是判定线的子对象（parse/rpe.rs: translation = position_x/(RPE_WIDTH/2)），
 * 所以玩家看到/要打的落点是这个值，而不是 positionX。
 */
export function screenX(line, sec, x) {
  if (!line || !Number.isFinite(sec)) return Number(x) || 0;
  const mx = evalEvents(line.layers, sec, 'moveXEvents');
  const rotDeg = -evalEvents(line.layers, sec, 'rotateEvents');
  return mx + (Number(x) || 0) * Math.cos((rotDeg * Math.PI) / 180);
}

/** 跨层求和（同层用 evalSeries） */
export function evalEvents(layers, sec, key) {
  let v = 0;
  for (const layer of layers || []) v += evalSeries(layer[key] || [], sec);
  return v;
}

/**
 * RPE 谱面校验器：结构 / 崩溃 / 语义 / 可玩性 四级
 * 规则来源：prpr `parse/rpe.rs` 的 serde 定义、`has_cycle`、`not_nan` panic、
 *           官方文档（issue #252 的 textEvents 缓动崩溃、文字线隐藏、纹理线缩放单位）
 */
import {
  RPE_WIDTH, NOTE_TYPES, UI_ELEMENTS, NOTE_WIDTH_RATIO_BASE, beats, evalEvents,
} from './rpe.js';
import { TYPE_MIX } from './distribution.js';

/**
 * prpr 里用整数类型反序列化的字段（写成浮点会直接 "invalid type: floating point, expected i32/u8"）。
 * `test/source_check.mjs` 会把这份清单和 `parse/rpe.rs` 的结构体逐字段比对，防止漏检。
 */
export const INTEGER_FIELDS = {
  note: ['type', 'above', 'alpha', 'isFake', 'tint', 'tintHitEffects'],
  event: ['bezier', 'easingType'],
  line: ['father', 'isCover', 'zOrder'],
  ctrl: ['easing'],
  meta: ['offset'],
  triple: ['a', 'b', 'c'],
  color: ['start', 'end'],
};

const NOTE_REQUIRED = ['type', 'above', 'startTime', 'endTime', 'positionX', 'yOffset', 'alpha', 'size', 'speed', 'isFake', 'visibleTime'];

function err(list, code, msg, at, t) { list.push({ level: 'error', code, msg, at, ...(t != null ? { t } : {}) }); }
function warn(list, code, msg, at, t) { list.push({ level: 'warn', code, msg, at, ...(t != null ? { t } : {}) }); }
function info(list, code, msg, at, t) { list.push({ level: 'info', code, msg, at, ...(t != null ? { t } : {}) }); }

/** 检测 father 成环 / 越界；返回 {cycle:number[]|null, bad:number[]} */
export function checkFathers(lines) {
  const n = lines.length;
  const bad = [];
  const color = new Int8Array(n); // 0 未访问 1 栈中 2 完成
  let cycle = null;
  const stack = [];
  const dfs = (i) => {
    if (cycle) return;
    if (i < 0 || i >= n) return;
    if (color[i] === 1) {
      const start = stack.indexOf(i);
      cycle = stack.slice(start === -1 ? 0 : start).concat(i);
      return;
    }
    if (color[i] === 2) return;
    color[i] = 1; stack.push(i);
    const p = lines[i].father;
    if (p !== -1) {
      if (p < 0 || p >= n) { bad.push({ line: i, father: p }); }
      else dfs(p);
    }
    stack.pop(); color[i] = 2;
  };
  for (let i = 0; i < n && !cycle; i++) if (color[i] === 0) dfs(i);
  return { cycle, bad };
}

/**
 * @param {object} chart normalizeChart() 的结果
 * @param {object} opt   { info, allowImages, launchGapSec, collisionRatio, maxFingers, difficulty, strict }
 * @returns {{ok:boolean, issues:Array, counts:object, stats:object}}
 */
function chordCapForValidate(difficulty) {
  if (difficulty < 15) return 2;   // in15 以下不允许三指以上
  if (difficulty < 17) return 3;
  if (difficulty < 18) return 5;
  return 8;
}

const isIntTriple = (v) => Array.isArray(v) && v.length === 3 && v.every((x) => Number.isInteger(x));
/**
 * prpr 的 Triple = (i32, u32, u32)：a 可为负，b、c 必须非负（c 还要 > 0，否则 beats()=NaN → panic）。
 * 旧实现只查"是不是整数"，把 b<0 的非法三元组放过去了 —— 这种谱面 Phira 根本打不开。
 */
const tripleBad = (v) => {
  if (!Array.isArray(v) || v.length !== 3) return '不是 [a,b,c]';
  if (!v.every((x) => Number.isInteger(x))) return '含非整数项';
  if (v[1] < 0) return `b=${v[1]} 为负（prpr 的 b 是 u32）`;
  if (v[2] <= 0) return `c=${v[2]} 必须 > 0（否则 beats()=NaN → panic）`;
  return null;
};

export function validate(chart, opt = {}) {
  const issues = [];
  const {
    allowImages = false,
    launchGapSec = 2,
    collisionRatio = 1.2,
    maxFingers = null,
    difficulty = null,
    strict = false,
    effects = null, // extra.json 的已解析特效（由工具层传入，validate 自己不读文件）
    rpe170Speed = null, // info.yml 的 useRpe170Speed；true 表示已启用 RPE 1.70 速度缓动
  } = opt;

  const raw = chart.raw || {};
  /* ---------- 结构 ---------- */
  if (!raw.META || typeof raw.META !== 'object') err(issues, 'missing-meta', '缺少 META 对象（RPE 必需）', 'META');
  else if (!Number.isFinite(Number(raw.META.offset))) warn(issues, 'meta-offset', 'META.offset 缺失或非数字（默认 0）', 'META.offset');
  if (!Array.isArray(raw.BPMList) || !raw.BPMList.length) err(issues, 'missing-bpm', 'BPMList 缺失或为空', 'BPMList');
  if (!Array.isArray(raw.judgeLineList)) err(issues, 'missing-lines', 'judgeLineList 缺失', 'judgeLineList');

  /* ---------- 原始 JSON 整数扫描（prpr 反序列化的 i32/u8/u16 字段，写成浮点会直接加载失败） ---------- */
  // 依据 prpr `parse/rpe.rs`：Triple(i32,u32,u32)、META.offset(i32)、
  // RPENote(kind/above/is_fake u8, alpha u16)、RPEJudgeLine(is_cover u8, z_order i32, father isize)、
  // RPEEvent(easing_type i32, bezier u8)、RGBColor(u8,u8,u8)。
  // f32/f64 字段（positionX/speed/visibleTime/yOffset/judgeArea/alpha 事件的 start/end/BPM）不在此列。
  {
    const rawJson = chart.raw || chart;
    const bad = [];
    let nonInt = 0;
    const push = (v, where) => {
      if (typeof v === 'number' && !Number.isInteger(v)) { nonInt++; if (bad.length < 8) bad.push(`${where}=${v}`); }
    };
    const triple = (v, where) => {
      if (!Array.isArray(v) || v.length !== 3) return;
      v.forEach((x, k) => push(x, `${where}[${k}]`));
    };
    const rgb = (v, where) => {
      if (!Array.isArray(v) || v.length !== 3) return;
      v.forEach((x, k) => push(x, `${where}[${k}]`));
    };
    const meta = rawJson.META;
    if (meta && typeof meta === 'object') push(meta.offset, 'META.offset');
    const rawJudgeLines = Array.isArray(rawJson.judgeLineList) ? rawJson.judgeLineList : [];
    for (const [li, l] of rawJudgeLines.entries()) {
      const lat = `judgeLineList[${li}]`;
      if (!l || typeof l !== 'object' || Array.isArray(l)) continue; // 脏数据：normalize 侧已记 line-not-object
      push(l.isCover, `${lat}.isCover`);
      push(l.zOrder, `${lat}.zOrder`);
      push(l.father, `${lat}.father`);
      const rawNotes = Array.isArray(l.notes) ? l.notes : [];
      for (const [ni, n] of rawNotes.entries()) {
        const at = `${lat}.notes[${ni}]`;
        if (!n || typeof n !== 'object' || Array.isArray(n)) continue;
        push(n.type, `${at}.type`);
        push(n.above, `${at}.above`);
        push(n.alpha, `${at}.alpha`);
        push(n.isFake, `${at}.isFake`);
        if (Array.isArray(n.tint)) rgb(n.tint, `${at}.tint`);
        if (Array.isArray(n.tintHitEffects)) rgb(n.tintHitEffects, `${at}.tintHitEffects`);
        triple(n.startTime, `${at}.startTime`);
        triple(n.endTime, `${at}.endTime`);
      }
      const checkEv = (e, at) => {
        push(e.easingType, `${at}.easingType`);
        push(e.bezier, `${at}.bezier`);
        triple(e.startTime, `${at}.startTime`);
        triple(e.endTime, `${at}.endTime`);
      };
      const rawLayersForScan = Array.isArray(l.eventLayers) ? l.eventLayers : [];
      for (const [ei, layer] of rawLayersForScan.entries()) {
        if (!layer || typeof layer !== 'object') continue;
        for (const key of Object.keys(layer)) {
          const arr = Array.isArray(layer[key]) ? layer[key] : [];
          for (const [i, e] of arr.entries()) {
            if (!e || typeof e !== 'object') continue;
            const at = `${lat}.eventLayers[${ei}].${key}[${i}]`;
            checkEv(e, at);
            if (key === 'colorEvents') rgb(e.start, `${at}.start`), rgb(e.end, `${at}.end`);
          }
        }
      }
      // 线的 alpha 动画首个关键帧必须从 0s 开始：引擎 line.rs:237 在首个关键帧前回落 1.0（整段不透明）
      {
        const alphas = (l.layers || []).flatMap((ly) => (ly.alphaEvents || []));
        if (alphas.length) {
          const first = Math.min(...alphas.map((e) => (Number.isFinite(e.st) ? e.st : Infinity)));
          if (first > 0.2) {
            warn(issues, 'line-alpha-head',
              `L${l.index} 的 alpha 关键帧从 ${first.toFixed(1)}s 才开始：引擎在首个关键帧之前把 alpha 回落成 1.0，`
              + '这条线会从 0s 起就整段不透明（压音线"一直有"的根因）；请在 0s 补一条 alpha=0 的关键帧', `${lat}.alphaEvents`);
          }
        }
      }
      // alphaControl 恒为 1 = 线整首曲子都不透明，alphaEvents 的「出现/消失」会被它压住（实机踩过）
      {
        const ac = Array.isArray(l.alphaControl) ? l.alphaControl : [];
        if (ac.length && ac.every((c) => c && typeof c === 'object' && Number(c.alpha) > 0)) {
          warn(issues, 'line-alpha-control',
            `L${l.index} 写了 alphaControl 且恒为 ${ac[0].alpha}（x 单位是秒）：这会让判定线**整首曲子都不透明**，`
            + '压音线的「出现→消失」和主线的淡入淡出都会失效；删掉 alphaControl，只留 alphaEvents', `${lat}.alphaControl`);
        }
      }
      // 控制事件：RPECtrlEvent.easing 是 u8（写成浮点会加载失败）
      for (const [key, arr] of Object.entries({
        posControl: l.posControl, sizeControl: l.sizeControl, alphaControl: l.alphaControl,
        yControl: l.yControl, skewControl: l.skewControl,
      })) {
        for (const [ci, c] of (Array.isArray(arr) ? arr : []).entries()) {
          if (c && typeof c === 'object') push(c.easing, `${lat}.${key}[${ci}].easing`);
        }
      }
      const rawExt = (l.extended && typeof l.extended === 'object' && !Array.isArray(l.extended)) ? l.extended : {};
      for (const key of Object.keys(rawExt)) {
        const arr = Array.isArray(rawExt[key]) ? rawExt[key] : [];
        for (const [i, e] of arr.entries()) {
          if (!e || typeof e !== 'object') continue;
          const at = `${lat}.extended.${key}[${i}]`;
          checkEv(e, at);
          if (key === 'colorEvents') rgb(e.start, `${at}.start`), rgb(e.end, `${at}.end`);
        }
      }
    }
    for (const [i, b] of (rawJson.BPMList || []).entries()) triple(b.startTime, `BPMList[${i}].startTime`);
    if (nonInt) {
      err(issues, 'non-integer-field',
        `${nonInt} 个整数字段写成浮点（prpr 用 i32/u8/u16 反序列化，会直接 "invalid type: floating point, expected i32" 导致加载失败）：`
        + bad.join('、'), 'chart.json');
    }
  }

  /* ---------- BPM / 时间三元组 ---------- */
  for (let i = 0; i < (raw.BPMList || []).length; i++) {
    const e = raw.BPMList[i];
    if (!Number.isFinite(beats(e && e.startTime))) err(issues, 'triple-nan', `BPMList[${i}].startTime 非法（[a,b,c] 需 c>0）`, `BPMList[${i}]`);
    {
      const bad = tripleBad(e && e.startTime);
      if (bad && bad !== '不是 [a,b,c]') err(issues, 'triple-out-of-range', `BPMList[${i}].startTime：${bad}`, `BPMList[${i}].startTime`);
    }
    if (e && Array.isArray(e.startTime) && !isIntTriple(e.startTime)) err(issues, 'triple-noninteger', `BPMList[${i}].startTime 必须是整数三元组（prpr 用 i32），当前=${JSON.stringify(e.startTime)}`, `BPMList[${i}].startTime`);
    if (!(Number(e && e.bpm) > 0)) err(issues, 'bpm-invalid', `BPMList[${i}].bpm 必须 > 0`, `BPMList[${i}].bpm`);
  }

  /* ---------- 判定线 ---------- */
  const lines = chart.lines || [];
  const { cycle, bad } = checkFathers(lines);
  if (cycle) err(issues, 'father-cycle', `father 成环：${cycle.map((i) => `L${i}`).join(' → ')}（引擎会栈溢出/报错）`, 'father');
  for (const b of bad) err(issues, 'father-oob', `L${b.line} 的 father=${b.father} 越界（合法范围 -1 ~ ${lines.length - 1}）`, `judgeLineList[${b.line}].father`);

  const uiSeen = new Map();
  const imgLines = [];
  const gifLines = [];
  for (const l of lines) {
    const rl = l.raw || {};
    const at = `judgeLineList[${l.index}]`;
    if (!('Name' in rl)) err(issues, 'line-missing-name', `${at} 缺少 Name（引擎必需）`, `${at}.Name`);
    if (!('Texture' in rl)) err(issues, 'line-missing-texture', `${at} 缺少 Texture（引擎必需）`, `${at}.Texture`);
    if (!('eventLayers' in rl)) err(issues, 'line-missing-layers', `${at} 缺少 eventLayers（引擎必需，可为空数组）`, `${at}.eventLayers`);
    if (!('isCover' in rl)) err(issues, 'line-missing-cover', `${at} 缺少 isCover（引擎必需 0/1）`, `${at}.isCover`);
    if (![0, 1].includes(l.isCover)) err(issues, 'line-cover', `${at}.isCover 必须为 0/1，当前 ${l.isCover}`, `${at}.isCover`);
    if (l.texture !== 'line.png') { imgLines.push({ line: l.index, tex: l.texture }); if (l.isGif) gifLines.push(l.index); }
    if (l.attachUI) {
      if (!UI_ELEMENTS.includes(l.attachUI)) err(issues, 'attachui-invalid', `${at}.attachUI="${l.attachUI}" 非法，合法值：${UI_ELEMENTS.join('/')}`, `${at}.attachUI`);
      else {
        if (uiSeen.has(l.attachUI)) warn(issues, 'attachui-dup', `attachUI "${l.attachUI}" 被 L${uiSeen.get(l.attachUI)} 与 L${l.index} 同时绑定（后者覆盖前者）`, `${at}.attachUI`);
        else uiSeen.set(l.attachUI, l.index);
      }
    }
    if (l.layers.length > 5) warn(issues, 'too-many-layers', `${at} 有 ${l.layers.length} 个事件层（RPE 上限 5）`, `${at}.eventLayers`);

    /* 事件 */
    const checkEv = (list, keyName, kind) => {
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        const where = `${at}.${keyName}[${i}]`;
        if (!Number.isFinite(e.st)) err(issues, 'event-time-nan', `${where}.startTime 非法（[a,b,c] 需 c>0）`, where);
        if (e.startTime && !isIntTriple(e.startTime)) err(issues, 'triple-noninteger', `${where}.startTime 必须是整数三元组（prpr 用 i32），当前=${JSON.stringify(e.startTime)}`, where);
        if (e.endTime && !isIntTriple(e.endTime)) err(issues, 'triple-noninteger', `${where}.endTime 必须是整数三元组（prpr 用 i32），当前=${JSON.stringify(e.endTime)}`, where);
        if (!Number.isFinite(e.et)) err(issues, 'event-time-nan', `${where}.endTime 非法`, where);
        for (const [f, v] of [['startTime', e.startTime], ['endTime', e.endTime]]) {
          const bad = tripleBad(v);
          if (bad) err(issues, 'triple-out-of-range', `${where}.${f}：${bad}`, `${where}.${f}`);
        }
        if (Number.isFinite(e.st) && Number.isFinite(e.et) && e.et < e.st) warn(issues, 'event-reversed', `${where} endTime < startTime（已自动按 start 处理）`, where);
        const ez = Number(e.easingType);
        if ((!Number.isFinite(ez) || ez < 0 || ez > 29) && Number(e.start) !== Number(e.end)) warn(issues, 'easing-range', `${where}.easingType=${e.easingType} 超出 1–29（引擎回退为线性）`, `${where}.easingType`);
        if (e.bezier && !(Array.isArray(e.bezierPoints) && e.bezierPoints.length === 4 && e.bezierPoints.every(Number.isFinite))) {
          err(issues, 'bezier-bad', `${where}.bezier=1 但 bezierPoints 非 4 个数字`, `${where}.bezierPoints`);
        }
        if (kind === 'alpha' && (typeof e.start !== 'number' || typeof e.end !== 'number')) {
          err(issues, 'alpha-type', `${where} alpha 值必须为数字`, where);
        }
        if (kind === 'speed' && Number(e.easingType) > 1) {
          if (rpe170Speed === true) {
            info(issues, 'new-speed-easing-enabled',
              `${where} 使用了非 1 缓动的流速事件；info.yml 已设 useRpe170Speed: true，Phira 会按 RPE 1.70 语义启用`, `${at}.speedEvents`);
            return;
          }
          warn(issues, 'new-speed-easing',
            `${where} 用了非 1 缓动的流速事件（RPE 1.70 新速度缓动）：Phira 导入时会提示且默认不启用；`
            + '若谱面依赖该效果，需在「谱面信息 → 新速度缓动」勾选，或在 info.yml 写 useRpe170Speed: true',
            `${at}.speedEvents`);
        }
      }
    };
    for (const k of ['moveXEvents', 'moveYEvents', 'rotateEvents', 'alphaEvents', 'speedEvents']) {
      for (const layer of l.layers) checkEv(layer[k] || [], k, k.replace('Events', '').replace('alpha', 'alpha').toLowerCase());
    }
    for (const k of Object.keys(l.extended)) checkEv(l.extended[k], k, 'extended');
    if (l.extended.paintEvents.length) warn(issues, 'paint-events', `${at} 使用 paintEvents（143 版后废弃，建议不用）`, `${at}.extended.paintEvents`);
    if (l.extended.gifEvents.length) warn(issues, 'gif-events', `${at} 使用 gifEvents（需配合 GIF 纹理）`, `${at}.extended.gifEvents`);
    if (l.extended.textEvents.length) {
      const bad = l.extended.textEvents.filter((e) => Number(e.easingType) !== 1);
      if (bad.length) warn(issues, 'text-easing-risk', `${at} 的 textEvents 使用了非 1 缓动（官方 issue #252 记录可能崩溃；参考谱面中也有 2 例，建议改成 1）`, `${at}.extended.textEvents`);
    if (l.notes.length) warn(issues, 'text-line-hides-notes', `${at} 有文字事件：该线永远隐藏且不绘制线上音符（音符仍会被判定），建议把这 ${l.notes.length} 个音符移走`, at);
    }
    /* 事件结构风险（这些会直接让 Phira 崩溃或静默失效） */
    const EV_KEYS = ['moveXEvents', 'moveYEvents', 'rotateEvents', 'alphaEvents', 'speedEvents'];
    // 注意：必须查「原始 JSON」里是否真的写了空数组；normalize 会给缺失键补 []，那是默认值
    const rawLineObj = (raw.judgeLineList || [])[l.index] || {};
    const rawLayers = Array.isArray(rawLineObj.eventLayers) ? rawLineObj.eventLayers : [];
    for (const k of EV_KEYS) {
      const cells = rawLayers.map((ly, i) => ({
        i,
        has: !!ly && Object.prototype.hasOwnProperty.call(ly, k),
        n: ((ly && ly[k]) || []).length,
      }));
      const anyNonEmpty = cells.some((c) => c.has && c.n > 0);
      for (const c of cells) {
        if (!c.has || c.n !== 0 || !anyNonEmpty) continue;
        // 源码依据：parse/rpe.rs events_with_factor 用 filter_map 只丢「键不存在」的层，
        // 显式空数组仍会进 AnimFloat::chain；core/anim.rs 的 now_opt() 对无关键帧的 next 直接 unwrap。
        const beforeHasKf = c.i > 0 && cells.slice(0, c.i).some((x) => x.has && x.n > 0);
        if (beforeHasKf) {
          err(issues, 'empty-event-array',
            `${at}.eventLayers[${c.i}].${k} 在原始 JSON 里是空数组：同键在**前一层**有事件时，`
            + 'prpr 会把它挂在事件链上但没有关键帧（core/anim.rs `next.now_opt().unwrap()`）→ 直接闪退。删掉这个键。',
            `${at}.eventLayers[${c.i}].${k}`);
        } else {
          warn(issues, 'empty-event-array-head',
            `${at}.eventLayers[${c.i}].${k} 在原始 JSON 里是空数组，且它排在链首：不会闪退，但 `
            + '`now_opt()` 因首层无关键帧返回 None → 调用方 unwrap_or 默认值，**后面各层的事件全部被静默丢弃**'
            + '（线的 alpha/位移会停在默认值）。删掉这个键即可。',
            `${at}.eventLayers[${c.i}].${k}`);
        }
      }
    }
    for (const k of EV_KEYS) {
      for (let li = 0; li < l.layers.length; li++) {
        const list = l.layers[li][k] || [];
        for (let i = 0; i < list.length; i++) {
          const e = list[i];
          if (Number.isFinite(e.st) && Number.isFinite(e.et) && Math.abs(e.et - e.st) < 1e-9) {
            warn(issues, 'zero-duration-event', `${at}.eventLayers[${li}].${k}[${i}] 时长为 0：部分实现会当作无效事件跳过（透明度闸门失效的常见原因）`, `${at}.eventLayers[${li}].${k}`);
          }
        }
        // 乱序判定必须看**原始 JSON**：normalizeChart 会排序，拿归一化后的数组判断永远不会触发。
        // speedEvents 例外：prpr 的 parse_speed_events 会自己 sort_by_key（其余事件不排序）。
        if (k === 'speedEvents') continue;
        const rawList = ((rawLayers[li] || {})[k]) || [];
        let prevBeat = -Infinity, unsortedAt = -1;
        for (let i = 0; i < rawList.length; i++) {
          const b = beats(rawList[i] && rawList[i].startTime);
          if (!Number.isFinite(b)) continue;
          if (b < prevBeat - 1e-9) { unsortedAt = i; break; }
          prevBeat = b;
        }
        if (unsortedAt >= 0) {
          warn(issues, 'unsorted-events', `${at}.eventLayers[${li}].${k} 第 ${unsortedAt} 个事件的开始时间早于前一个：prpr 不排序关键帧，乱序会让后面的关键帧失效（引擎里不存在"自动排好"这回事）`, `${at}.eventLayers[${li}].${k}`);
        }
        // 区间重叠：parse_events 按数组顺序压关键帧，重叠会让关键帧乱序 → 实机表现和"看起来的"不一致
        // （插件的预览是按时间排序求值的，所以预览会显示成平滑过渡，和实机不同）。参考谱面 24/25 张为 0。
        {
          const seq = rawList
            .map((e, i) => ({ i, st: beats(e && e.startTime), et: beats(e && e.endTime) }))
            .filter((x) => Number.isFinite(x.st) && Number.isFinite(x.et))
            .sort((a, b) => a.st - b.st);
          let overlapped = 0;
          for (let i = 1; i < seq.length; i++) {
            if (seq[i].st < seq[i - 1].et - 1e-9) overlapped++;
          }
          if (overlapped) {
            warn(issues, 'event-overlap',
              `${at}.eventLayers[${li}].${k} 有 ${overlapped} 处事件区间重叠：prpr 按数组顺序压关键帧，`
              + '重叠后 sequence 会乱序，实机结果与"看起来的"不符（插件预览也会和实机不一致）。'
              + '参考谱面 24/25 张完全没有重叠；请把前一个事件的 endTime 收到下一个的开始处', `${at}.eventLayers[${li}].${k}`);
          }
        }
      }
    }

    /* 负 alpha 隐藏 */
    const negAlpha = [];
    for (const layer of l.layers) for (const e of layer.alphaEvents || []) {
      if (typeof e.start === 'number' && e.start < 0) negAlpha.push(e);
      if (typeof e.end === 'number' && e.end < 0) negAlpha.push(e);
    }
    if (negAlpha.length && l.notes.length) warn(issues, 'neg-alpha-notes', `${at} 有 ${negAlpha.length} 个负 alpha 值（会连同线上 ${l.notes.length} 个音符一起隐藏），确认是否符合预期`, at);
  }

  /* ---------- 音符 ---------- */
  let fake = 0, holdShort = 0, outOfBounds = 0, nearEdge = 0, speedBad = 0, staticOob = 0, movingOob = 0;
  let firstOobT = null, firstNearT = null, firstHoldShortT = null, firstSpeedBadT = null;
  /** 这条线的 moveX 是否真的会动（值集合 size>1；只有一个恒定值 = 静止） */
  const lineMovesCache = new Map();
  const lineMovesOf = (l) => {
    if (lineMovesCache.has(l.index)) return lineMovesCache.get(l.index);
    const vals = new Set();
    for (const ly of l.layers) for (const e of (ly.moveXEvents || [])) { vals.add(Number(e.start)); vals.add(Number(e.end)); }
    const moving = vals.size > 1;
    lineMovesCache.set(l.index, moving);
    return moving;
  };
  for (const l of lines) {
    const lineMoves = lineMovesOf(l);
    for (const n of l.notes) {
      const nr = n.raw || {};
      const at = `judgeLineList[${l.index}].notes`;
      for (const k of NOTE_REQUIRED) if (!(k in nr)) err(issues, 'note-missing-field', `${at} 缺少必填字段 ${k}（引擎会加载失败）`, `${at}.*.${k}`);
      if (!NOTE_TYPES[n.type]) err(issues, 'note-type', `${at} 非法 type=${n.type}（1 Tap / 2 Hold / 3 Flick / 4 Drag）`, at);
      if (!Number.isFinite(n.st)) err(issues, 'note-time-nan', `${at} startTime 非法（[a,b,c] 需 c>0）`, at);
      for (const [f, v] of [['startTime', nr.startTime], ['endTime', nr.endTime]]) {
        const bad = tripleBad(v);
        if (bad) err(issues, 'triple-out-of-range', `${at} ${f}：${bad}（这种谱面 Phira 直接反序列化失败）`, `${at}.*.${f}`);
      }
      if (!Number.isFinite(n.et)) err(issues, 'note-time-nan', `${at} endTime 非法`, at);
      if (n.type === 2 && Number.isFinite(n.st) && Number.isFinite(n.et) && n.et < n.st) err(issues, 'hold-reversed', `${at} Hold 的 endTime < startTime`, at);
      if (!(n.alpha >= 0 && n.alpha <= 255)) err(issues, 'note-alpha', `${at} alpha 必须在 0–255（负数会导致解析失败）`, at);
      if (!(n.size > 0)) err(issues, 'note-size', `${at} size 必须 > 0`, at);
      if (!(n.speed > 0)) { speedBad++; if (firstSpeedBadT == null) firstSpeedBadT = n.sec; }
      if (!(n.visibleTime >= 0)) warn(issues, 'note-visible-time', `${at} visibleTime=${n.visibleTime} 非法`, at);
      if (!(n.judgeArea > 0)) warn(issues, 'note-judge-area', `${at} judgeArea=${n.judgeArea} 非法`, at);
      if (n.isFake !== 0) fake++;
      const lx = evalEvents(l.layers, n.sec, 'moveXEvents');
      const ly = evalEvents(l.layers, n.sec, 'moveYEvents');
      const rotDeg = -evalEvents(l.layers, n.sec, 'rotateEvents');
      const rad = (rotDeg * Math.PI) / 180;
      const cosR = Math.cos(rad), sinR = Math.sin(rad);
      n.ex = lx + n.x * cosR;              // 沿线方向的横向偏移（旋转 90° 时为 0）
      n.ey = ly + n.x * sinR;              // 旋转后的纵向偏移（供跨线视觉重叠判断）
      // 出界只看**屏幕位置** |ex|（玩家打的是屏幕落点）。error/info 的区别在于"这条线会不会动"：
      //   - 线不动 → 音符永远出屏、打不到 → error（即使音符自身 x 合法，也是被静止位移推出去的）
      //   - 线会动 + 音符自身在线内 → 可能是扫线/瞬移经过 → info（确认玩家不需要打）
      //   - 音符自身就超出 ±675 → 无论如何都是 error
      const localOut = Math.abs(n.x * cosR) > RPE_WIDTH / 2;
      if (!n.isFake && Math.abs(n.ex) > RPE_WIDTH / 2) {
        if (!localOut && lineMoves) movingOob++;
        else { staticOob++; if (firstOobT == null) firstOobT = n.sec; }
      }
      else if (!n.isFake && Math.abs(n.ex) > 600 && Math.abs(cosR) > 0.5) { nearEdge++; if (firstNearT == null) firstNearT = n.sec; } // 垂直判定线贴边是设计使然，不告警
      if (n.type === 2 && Number.isFinite(n.endSec) && Number.isFinite(n.sec) && n.endSec - n.sec < 0.1) { holdShort++; if (firstHoldShortT == null) firstHoldShortT = n.sec; }
    }
  }
  if (staticOob) err(issues, 'note-oob', `${staticOob} 个真音符在不会移动的判定线上仍超出屏幕 ±${RPE_WIDTH / 2}（出界）`, 'notes', firstOobT);
  if (movingOob) info(issues, 'note-oob-moving', `${movingOob} 个真音符因判定线位移瞬时出屏（扫线/瞬移，通常为特效；确认玩家不需要打）`, 'notes');
  if (imgLines.length && !allowImages) warn(issues, 'image-texture', `${imgLines.length} 条判定线使用图片纹理（例：L${imgLines[0].line}「${imgLines[0].tex}」）：本项目建议禁用图片装饰`, 'judgeLineList');
  if (gifLines.length) warn(issues, 'gif-texture', `${gifLines.length} 条判定线使用 GIF 纹理（>15MB 会解码失败）`, 'judgeLineList');
  if (speedBad) info(issues, 'note-speed', `${speedBad} 个音符 speed<=0（0=静止、负=上飞，属特效用法）`, 'notes', firstSpeedBadT);
  if (nearEdge) warn(issues, 'note-near-edge', `${nearEdge} 个真音符的**有效位置**（判定线 moveX/rotate 之后）贴近屏幕边缘（|ex|>600），判定风险高`, 'notes', firstNearT);
  if (holdShort) info(issues, 'hold-short', `${holdShort} 个长条短于 0.1s（多为特效，可忽略）`, 'notes', firstHoldShortT);

  /* ---------- 同刻 / 多指 / 碰撞 / 开局 ---------- */
  const byTime = new Map();
  for (const n of chart.notes) {
    if (!Number.isFinite(n.sec)) continue;
    const key = Math.round(n.sec * 1000) / 1000;
    if (!byTime.has(key)) byTime.set(key, []);
    byTime.get(key).push(n);
  }
  let maxChord = 0;
  let maxChordPress = 0;     // 同刻「需要按下」的音符数（Drag 不算手）
  let collisions = 0;        // 同一条线上的「抢判定」（明显重叠）
  let collisionsMarginal = 0; // 间距偏近但仍在参考谱面常见范围内
  let visualOverlaps = 0;    // 跨线视觉重叠
  const collisionList = [];
  const overlapList = [];
  const noteW = 2 * NOTE_WIDTH_RATIO_BASE * (RPE_WIDTH / 2); // ≈177.9 RPE px
  const noteH = noteW * 0.42;
  for (const [t, group] of byTime) {
    const real = group.filter((n) => !n.isFake);
    if (real.length > maxChord) maxChord = real.length;
    const pressCount = real.filter((n) => n.type !== 4).length; // Drag 不用按下（但手指仍要经过它的 x）
    if (pressCount > maxChordPress) maxChordPress = pressCount;
    // ---- 同线：需要点击的音符（Tap/Hold/Flick）互相抢同一触点的容差 ----
    const perLine = new Map();
    for (const n of real) {
      if (n.type === 4) continue;
      if (!perLine.has(n.line)) perLine.set(n.line, []);
      perLine.get(n.line).push(n);
    }
    for (const [li, arr] of perLine) {
      if (arr.length < 2) continue;
      const sorted = arr.slice().sort((a, b) => a.x - b.x);
      for (let i = 0; i + 1 < sorted.length; i++) {
        const d = sorted[i + 1].x - sorted[i].x;
        // 分级：< 音符宽×0.8（明显重叠）才告警；< ×1.2 只是"偏近"，降为 info。
        // 参考谱面实测：同刻同线间距 p5≈203px、p10≈260px，把 213px 当告警会让 15/25 张正经谱面都报警。
        if (d < noteW * (collisionRatio - 0.4)) {
          collisions++;
          if (collisionList.length < 10) {
            collisionList.push({ t: Number(t), line: li, d: Math.round(d), x1: Math.round(sorted[i].x), x2: Math.round(sorted[i + 1].x) });
          }
        } else if (d < noteW * collisionRatio) collisionsMarginal++;
      }
    }
    // ---- 跨线：屏幕位置重叠（视觉混淆，不抢判定）----
    for (let i = 0; i < real.length; i++) {
      for (let j = i + 1; j < real.length; j++) {
        const a = real[i], b = real[j];
        if (a.line === b.line) continue;
        const dx = Math.abs((a.ex ?? a.x) - (b.ex ?? b.x));
        const dy = Math.abs((a.ey ?? 0) - (b.ey ?? 0));
        if (dx < noteW * 0.8 && dy < noteH * 1.2) {
          visualOverlaps++;
          if (overlapList.length < 6) overlapList.push({ t: Number(t), l1: a.line, l2: b.line });
        }
      }
    }
  }
  if (collisionsMarginal) {
    info(issues, 'collision-marginal',
      `${collisionsMarginal} 对同线同刻点击音符横向间距 < ${Math.round(noteW * collisionRatio)}px（参考谱面里这类占 ~5%，可接受但别再挤）`, 'notes');
  }
  if (collisions) {
    const sample = collisionList[0];
    (strict ? err : warn)(issues, 'collision',
      `${collisions} 对同线同刻点击音符横向间距 < ${Math.round(noteW * collisionRatio)}px（音符宽 ${Math.round(noteW)}px）：`
      + '一个触点只判最近的那个音符（judge.rs 的 closest），离得这么近会被判给错的音符、另一个必漏'
      + (sample ? `（例：${sample.t.toFixed(2)}s L${sample.line} Δx=${sample.d}）` : ''),
      'notes', sample && sample.t);
  }

  /* ---------- 长条：重叠与内嵌碰撞 ---------- */
  let holdOverlap = 0, holdInnerDrag = 0, holdInnerDragFar = 0, holdInnerFar = 0, holdClash = 0;
  const holdList = [];
  for (const l of chart.lines) {
    const holds = l.notes.filter((n) => n.type === 2 && !n.isFake && Number.isFinite(n.sec) && Number.isFinite(n.endSec));
    if (!holds.length) continue;
    holds.sort((a, b) => a.sec - b.sec);
    // 同线两长条时间重叠 → 同一条线上需要两根手指
    for (let i = 0; i < holds.length; i++) {
      for (let j = i + 1; j < holds.length; j++) {
        const a = holds[i], b = holds[j];
        if (b.sec >= a.endSec - 1e-6) break;
        if (Math.abs(a.x - b.x) < noteW * collisionRatio) {
          holdOverlap++;
          if (holdList.length < 8) holdList.push({ t: a.sec, line: l.index, kind: 'hold-overlap' });
        }
      }
    }
    // 长条身体内的音符：Drag 同车道是常规写法；Tap/Flick 同车道 = 手指撞车（参考谱极少这么写）
    for (const h of holds) {
      for (const n of l.notes) {
        if (n === h || n.isFake) continue;
        if (!(n.sec > h.sec + 1e-3 && n.sec < h.endSec - 1e-3)) continue;
        if (n.type === 2) continue;
        const dx = Math.abs(n.x - h.x);
        if (n.type === 4) {
          if (dx < noteW * collisionRatio) {
            holdInnerDrag++;
            if (holdList.length < 8) holdList.push({ t: n.sec, line: l.index, kind: 'hold-inner-drag', type: n.type });
          } else holdInnerDragFar++;
        } else if (dx < noteW * collisionRatio) {
          holdClash++;
          if (holdList.length < 8) holdList.push({ t: n.sec, line: l.index, kind: 'hold-collision', type: n.type, dx });
        } else {
          holdInnerFar++;
        }
      }
    }
  }
  // 黄键楼梯段：≥4 连黄键且 x 单调移动（楼梯）时，段里不要夹要按下的键，否则手要一边划一边点
  {
    let bad = null;
    for (const l of chart.lines) {
      const ns = l.notes.filter((n) => !n.isFake && Number.isFinite(n.sec)).sort((a, b) => a.sec - b.sec);
      for (let i = 0; i < ns.length; i++) {
        if (ns[i].type !== 4) continue;
        let j = i;
        while (j + 1 < ns.length && ns[j + 1].type === 4 && ns[j + 1].sec - ns[j].sec < 0.6) j++;
        const run = ns.slice(i, j + 1);
        if (run.length < 4) { i = j; continue; }
        const dx = run.map((n) => n.x);
        const mono = dx.every((v, k) => k === 0 || v > dx[k - 1]) || dx.every((v, k) => k === 0 || v < dx[k - 1]);
        const span = Math.max(...dx) - Math.min(...dx);
        if (mono && span >= 120) {
          const t0 = run[0].sec, t1 = run[run.length - 1].sec;
          const mixed = ns.some((n) => n.type !== 4 && n.sec >= t0 - 1e-6 && n.sec <= t1 + 1e-6);
          if (mixed) { bad = { t: t0, n: run.length }; break; }
        }
        i = j;
      }
      if (bad) break;
    }
    if (bad) {
      info(issues, 'drag-stairs-mixed',
        `${bad.t.toFixed(1)}s 起的黄键楼梯（${bad.n} 连）里夹了要按下的键：一手在划楼梯时腾不出手点/按，`
        + '建议楼梯段内保持纯黄键（同 x 的链固定 5 个，楼梯至少 8 个），把按键放到楼梯前后', 'notes', bad.t);
    }
  }

  // 压音/装饰线：只该在"没有音符"的空档出现
  {
    const realTimes = chart.notes.filter((n) => !n.isFake && Number.isFinite(n.sec)).map((n) => n.sec).sort((a, b) => a - b);
    if (realTimes.length >= 20) {
      const dur = realTimes[realTimes.length - 1];
      const nearNote = (t) => {
        let lo = 0, hi = realTimes.length - 1;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (realTimes[mid] < t) lo = mid + 1; else hi = mid; }
        return [realTimes[lo], realTimes[Math.max(0, lo - 1)]].some((x) => Math.abs(x - t) <= 0.35);
      };
      let bad = 0, samples = 0, firstT = null;
      for (const l of chart.lines) {
        if (l.notes.some((n) => !n.isFake)) continue;
        // 只算"压音线"（有 scaleY 压缩事件的装饰线）；水印线/背景线不算
        if (!(l.extended.scaleYEvents || []).length) continue;
        for (let t = 0; t <= dur; t += 0.25) {
          const a = evalEvents(l.layers, t, 'alphaEvents');
          if (a <= 10) continue;
          samples++;
          if (nearNote(t)) { bad++; if (firstT == null) firstT = t; }
        }
      }
      if (bad && samples && bad / samples > 0.25) {
        warn(issues, 'fx-line-over-notes',
          `压音/装饰线有 ${bad}/${samples} 个采样点（${(bad / samples * 100).toFixed(0)}%）与真实音符重叠（首个 ${firstT.toFixed(1)}s）：`
          + '压音线只该在「没有音符的空档」出现——音符段里它只会抢视觉、让判定线更难找；请把它限制在整段空拍里（出现 → 压缩几拍 → 消失）', 'judgeLineList', firstT);
      }
    }
  }

  // 长条结束后「立马」跟按键：按住的手指要先松、再点/再按，同一个点上做不到
  {
    const TAIL = 0.10; // 100ms 内
    let bad = 0;
    const samples = [];
    for (const l of chart.lines) {
      const ns = l.notes.filter((n) => !n.isFake && Number.isFinite(n.sec));
      const holds = ns.filter((n) => n.type === 2 && Number.isFinite(n.endSec));
      for (const h of holds) {
        for (const n of ns) {
          if (n === h || n.type === 4) continue; // 黄键不用按下，不算
          const dt = n.sec - h.endSec;
          if (dt < -1e-3 || dt > TAIL) continue; // 只看长条结束之后 100ms 内
          if (Math.abs(n.x - h.x) >= noteW * collisionRatio) continue; // 不同车道可以
          bad++;
          if (samples.length < 4) samples.push({ t: h.endSec, type: n.type, dt });
        }
      }
    }
    if (bad) {
      const kinds = samples.map((x) => (x.type === 1 ? '蓝键' : x.type === 2 ? '又一根长条' : '红键')).join('/');
      warn(issues, 'hold-tail-press',
        `${bad} 处在长条结束后的 ${Math.round(TAIL * 1000)}ms 内、同车道紧接要按下的音符（${kinds}）：`
        + '按住长条的手指必须先松开才能再点/再按，同一个点上基本做不到，实机会漏；'
        + '长条尾后至少留 0.5 拍（或把下一个音移到别的车道）', 'notes', samples[0] && samples[0].t);
    }
  }

  // 整首长条内嵌为零 → 提示（参考 24 谱里 725 例黄键内嵌，是省手又好看的手法）
  {
    const holdsAny = chart.notes.filter((n) => n.type === 2 && !n.isFake && Number.isFinite(n.endSec));
    if (holdsAny.length >= 10) {
      let inner = 0;
      for (const l of chart.lines) {
        const holds = l.notes.filter((n) => n.type === 2 && !n.isFake && Number.isFinite(n.endSec));
        for (const h of holds) {
          for (const n of l.notes) {
            if (n === h || n.isFake) continue;
            if (n.sec > h.sec + 1e-3 && n.sec < h.endSec - 1e-3) { inner++; break; }
          }
        }
      }
      if (!inner) {
        info(issues, 'hold-inner-none',
          `全谱 ${holdsAny.length} 个长条里没有任何「长条内嵌」（按住长条时同线还有黄键/红键）：`
          + '参考谱面 1,961 个内嵌里 725 例是同车道黄键（按住长条的那根手指顺手就判到，最省手）；'
          + '可用手法 holdInner / holdFlick / holdFlickMelody（keepLane=true 可让红键留在长条车道）', 'notes');
      }
    }
  }

  if (holdOverlap) {
    (strict ? err : warn)(issues, 'hold-overlap',
      `${holdOverlap} 处同一条线上两根长条时间重叠（且横向间距 < ${Math.round(noteW * collisionRatio)}px）：需要同一根线同时按住两处，实际会漏判`,
      'notes', holdList[0] && holdList[0].t);
  }
  if (holdClash) {
    const sample = holdList.find((h) => h.kind === 'hold-collision');
    (strict ? err : warn)(issues, 'hold-collision',
      `${holdClash} 个 Tap/Flick 与同线长条同车道且落在长条身体内（|Δx|<${Math.round(noteW * collisionRatio)}）：`
      + '一手按着长条时，另一手必须在同一位置点/划 → 手指必然撞车。'
      + `参考 25 个谱面的 1,961 个长条内嵌里，同车道 Tap/Flick 只有 11 个；同车道安全写法只有 Drag（自动判定）。`
      + (sample ? `（例：${sample.t.toFixed(2)}s type${sample.type} Δx=${Math.round(sample.dx)}）` : ''),
      'notes', sample && sample.t);
  }
  if (holdInnerDrag) {
    info(issues, 'hold-inner-ok',
      `${holdInnerDrag} 个 Drag 内嵌在同线长条身体内（Drag 自动判定、不用按下，按住长条的那根手指顺手就带到 —— 参考谱面 725 例的标准写法）`, 'notes');
  }
  if (holdInnerDragFar) {
    info(issues, 'hold-inner-drag-far',
      `${holdInnerDragFar} 个 Drag 与长条身体重叠但横向错开 ≥${Math.round(noteW * collisionRatio)}px：不用按下，但手指要离开长条去划，会打断按住的长条`, 'notes');
  }
  if (holdInnerFar) {
    info(issues, 'hold-inner-far',
      `${holdInnerFar} 个音符在长条身体内但与其他车道错开（≥${Math.round(noteW * collisionRatio)}px）：需要第二根手指，确认手序可完成`, 'notes');
  }

  {
    const cap = maxFingers != null ? Number(maxFingers)
      : (difficulty != null && Number.isFinite(Number(difficulty)) ? chordCapForValidate(Number(difficulty)) : null);
    if (cap != null && maxChordPress > cap) {
      (strict ? err : warn)(issues, 'fingers',
        `同刻需要按下 ${maxChordPress} 个音符（Drag 不计），超过该难度上限 ${cap}（${maxFingers != null ? 'maxFingers 参数' : `定数 ${difficulty}`}）：需要 ${maxChordPress} 根手指`,
        'notes');
    }
  }
  const realNotes = chart.notes.filter((n) => !n.isFake);
  const firstSec = realNotes.length ? Math.min(...realNotes.map((n) => n.sec)) : null;
  if (firstSec != null && firstSec < launchGapSec) warn(issues, 'launch-gap', `首个音符在 ${firstSec.toFixed(2)}s 就出现（< ${launchGapSec}s）：玩家可能没有准备时间（需结合前奏判断）`, 'notes', firstSec);

  /* ---------- 主线高度：不要在屏幕正中 ---------- */
  {
    const mainLines = chart.lines
      .map((l) => ({
        l,
        notes: l.notes.filter((n) => !n.isFake).length,
        y0: (() => {
          const evs = l.layers.flatMap((ly) => ly.moveYEvents || []);
          if (!evs.length) return 0;
          const first = evs.slice().sort((a, b) => a.st - b.st)[0];
          return Number(first.start) || 0;
        })(),
      }))
      .filter((x) => x.notes > 0)
      .sort((a, b) => b.notes - a.notes);
    const main = mainLines[0];
    if (main && Math.abs(main.y0) < 120) {
      warn(issues, 'line-height',
        `主判定线（承载 ${main.notes} 个音符）在 y=${Math.round(main.y0)}，接近屏幕正中；参考谱面主线中位数 ≈ -270（屏幕 60–65% 处），`
        + '放在正中会让下落距离过短/贴脸。建议 y≈-260 ~ -300。', 'judgeLineList');
    }
  }

  /* ---------- 类型配比：和参考谱面差太远时提示（Tap 堆太多 = 全是点，没有黄键/长条/红键的变化） ---------- */
  {
    const rs = realNotes.length >= 100 ? realNotes : null;
    if (rs) {
      const counts = { 1: 0, 2: 0, 3: 0, 4: 0 };
      for (const n of rs) counts[n.type] = (counts[n.type] || 0) + 1;
      const shareOf = (t) => counts[t] / rs.length;
      const density = (() => {
        const secs = rs.map((n) => n.sec).filter(Number.isFinite);
        if (secs.length < 2) return 0;
        const dur = Math.max(...secs) - Math.min(...secs);
        return dur > 1 ? rs.length / dur : 0;
      })();
      const off = [];
      for (const t of [1, 2, 3, 4]) {
        const share = shareOf(t);
        const ref = TYPE_MIX[t];
        // 黄键/长条偏少在慢歌里是正常的 → 只在"密度够高还全是 Tap"时算问题
        const slack = (t === 4 || t === 2) && density < 4 ? 0.3 : 0.15;
        if (Math.abs(share - ref) > slack) off.push(`${NOTE_TYPES[t]} ${(share * 100).toFixed(0)}%（参考 ${(ref * 100).toFixed(0)}%）`);
      }
      if (off.length) {
        const msg = `类型配比偏离参考（24 谱，已排除耐力谱）：${off.join('、')}。`
          + '参考占比：Tap 57% / Hold 13% / Flick 5% / Drag 25%';
        // 参考谱里也有 98% 全 Tap 的谱，所以只在"又长又密还几乎全 Tap"时告警，其余只提示
        // 黄键现在是链式出现（同 x 5 个 / 楼梯 8 个），占比低是设计而非病态：几乎没有黄键才告警
        if (shareOf(1) > 0.9 && shareOf(4) < 0.02 && rs.length > 500 && density > 4) {
          warn(issues, 'type-mix', `${msg} —— 又长又密却几乎全是 Tap：只有点、没有划和按，节奏层次和体力分配都会变差`, 'notes');
        } else info(issues, 'type-mix-info', msg, 'notes');
      }
    }
  }

  /* ---------- 同侧粘连：连续一串都在同一侧，另一只手插不上 ---------- */
  {
    const press = realNotes.filter((n) => n.type !== 4 && Number.isFinite(n.sec)).sort((a, b) => a.sec - b.sec);
    let worst = null;
    for (let i = 0; i < press.length; i++) {
      const side = press[i].x < 0 ? -1 : 1;
      let j = i;
      while (j + 1 < press.length && press[j + 1].sec - press[i].sec <= 1.0 && (press[j + 1].x < 0 ? -1 : 1) === side) j++;
      const seg = press.slice(i, j + 1);
      const span = Math.max(...seg.map((n) => n.x)) - Math.min(...seg.map((n) => n.x));
      // 只有"同侧 + 1 秒内 + 横向几乎不动（跨度 <120px）"才算"另一只手帮不上"；
      // 同侧但横向拉开的大范围跑动是正常手法（参考谱里也有 12–17 连）
      const n = span < 120 ? seg.length : 0;
      if (!worst || n > worst.n) worst = { n, t: press[i].sec, side, span };
      i = j;
    }
    if (worst && worst.n >= 10) {
      warn(issues, 'same-side-stream',
        `${worst.t.toFixed(1)}s 起有 ${worst.n} 个连续音符全在${worst.side < 0 ? '左' : '右'}侧、横向跨度只有 ${Math.round(worst.span)}px（1 秒内）：`
        + '位置几乎不动，另一只手完全帮不上，只能单手连打；若不是刻意的纵连手法，建议按 2–4 个一组左右交替', 'notes', worst.t);
    }
  }

  /* ---------- 全局/全程后处理：会把整屏压暗，只该小段点缀 ---------- */
  {
    const ext = Array.isArray(opt.effects) ? opt.effects : [];
    if (ext.length) {
      const secs = chart.notes.filter((n) => !n.isFake && Number.isFinite(n.sec)).map((n) => n.sec);
      const dur = secs.length ? Math.max(...secs) : 0;
      for (const e of ext) {
        const span = Number(e.end) - Number(e.start);
        if (e.global === true) {
          warn(issues, 'fx-global-shader',
            `${e.shader} 标了 global=true：全局后处理会作用于整屏、把画面整体压暗/变灰，`
            + '玩家会看不清判定线和音符；去掉 global，只在小段用', 'extra.json', e.start);
        } else if (dur > 0 && span / dur > 0.5) {
          warn(issues, 'fx-global-shader',
            `${e.shader} 覆盖 ${span.toFixed(0)}s / ${dur.toFixed(0)}s（${(span / dur * 100).toFixed(0)}%）：`
            + '长时间的后处理等于"整首歌都戴着一层滤镜"，实测会被反馈"太暗"；建议只在高潮等小段点缀（≤15%）', 'extra.json', e.start);
        }
      }
    }
  }

  /* ---------- 强扭曲特效盖住判定线：线会被"揉"得看不见 ---------- */
  {
    const DISTORT = ['fisheye', 'glitch', 'radialBlur', 'circleBlur'];
    const ext = Array.isArray(opt.effects) ? opt.effects : null;
    // extra.json 由工具层传入（validate 不读文件）；没有就当未知
    if (ext) {
      for (const e of ext) {
        if (!DISTORT.includes(String(e.shader))) continue;
        // 该时段内是否有"贴着屏幕边缘"或竖直的判定线在承载音符
        for (const l of chart.lines) {
          const ns = l.notes.filter((n) => !n.isFake && n.sec >= e.start && n.sec <= e.end);
          if (!ns.length) continue;
          const evs = l.layers.flatMap((y) => y.rotateEvents || []);
          const rot = evs.length ? Number(evs[0].start) || 0 : 0;
          const vert = Math.abs(Math.cos((rot * Math.PI) / 180)) < 0.35;
          const mx = l.layers.flatMap((y) => y.moveXEvents || []).flatMap((x) => [Number(x.start) || 0, Number(x.end) || 0]);
          const edge = mx.length ? Math.max(...mx.map(Math.abs)) > 560 : false;
          if (vert || edge) {
            warn(issues, 'fx-distort-line',
              `${e.shader} 在 ${e.start.toFixed(1)}–${e.end.toFixed(1)}s 生效，正好盖住 ${vert ? '竖直' : '贴边'}判定线 L${l.index}（承载 ${ns.length} 个音符）：`
              + '强扭曲会把线本身揉到看不清，玩家找不到判定线；建议这类段落换温和特效（换色/暗角）或把线放回中部', 'extra.json', e.start);
            break;
          }
        }
      }
    }
  }

  /* ---------- 主判定线「旋转」倾斜：长段倾斜会让落点方向飘 ---------- */
  {
    for (const l of chart.lines) {
      const realCount = l.notes.filter((n) => !n.isFake).length;
      if (realCount < 100) continue; // 观赏谱/装饰线的倾斜不在此列（参考谱里 45–60° 的倾斜都发生在少音符线上）
      let worst = null;
      for (const ly of l.layers) {
        for (const e of ly.rotateEvents || []) {
          const dur = (Number.isFinite(e.et) && Number.isFinite(e.st)) ? e.et - e.st : 0;
          // 只看"倾斜"：90°=竖直判定线、180°=镜像线，都不是倾斜（normalize 到 [-90,90] 后 >60° 视为布局而非倾斜）
          const tiltOf = (v) => { const n = ((Number(v) % 180) + 180) % 180; return n > 90 ? 180 - n : n; };
          const ang = Math.max(tiltOf(e.start), tiltOf(e.end));
          if (ang >= 3 && ang <= 60 && dur >= 4) {
            if (!worst || ang * dur > worst.ang * worst.dur) worst = { ang, dur, t: e.st };
          }
        }
      }
      if (worst) {
        warn(issues, 'line-rotate-tilt',
          `L${l.index} 承载 ${realCount} 个音符，却在 ${worst.t.toFixed(1)}s 起倾斜 ${Math.round(worst.ang)}°、持续 ${worst.dur.toFixed(1)}s：`
          + '判定线旋转会连带改变音符的落点方向与横向压缩，长段倾斜读谱会"发飘"（参考谱面主线倾角全为 0）；'
          + '要倾斜就控制在 1–2 秒内做过渡', `judgeLineList[${l.index}].eventLayers`);
      }
    }
  }

  /* ---------- 竖直判定线：要贴边、别太长 ---------- */
  {
    const rotOf = (l) => {
      const evs = l.layers.flatMap((ly) => ly.rotateEvents || []);
      return evs.length ? Number(evs[0].start) || 0 : 0;
    };
    for (const l of chart.lines) {
      const ns = l.notes.filter((n) => !n.isFake);
      if (!ns.length) continue;
      const rot = rotOf(l);
      if (Math.abs(Math.cos((rot * Math.PI) / 180)) >= 0.35) continue; // 只处理近竖直的线
      const xs = l.layers.flatMap((ly) => ly.moveXEvents || []).flatMap((e) => [Number(e.start) || 0, Number(e.end) || 0]);
      const vals = xs.length ? xs : [0];
      const maxAbs = Math.max(...vals.map((v) => Math.abs(v)));
      if (maxAbs < 380) {
        warn(issues, 'vertical-line-center',
          `L${l.index} 是竖直判定线（旋转 ${Math.round(rot)}°）且承载 ${ns.length} 个音符，但它在屏幕中间横移（|moveX| ≤ ${Math.round(maxAbs)}）：`
          + '竖着打的音符本来就要横手，再放在正中间会和主线音符挤在一起；建议贴到屏幕左右边缘（|x| ≥ 400）', `judgeLineList[${l.index}].eventLayers`);
      }
      const t0 = Math.min(...ns.map((n) => n.sec));
      const t1 = Math.max(...ns.map((n) => n.sec));
      if (Number.isFinite(t0) && Number.isFinite(t1) && t1 - t0 > 12) {
        warn(issues, 'vertical-line-long',
          `L${l.index} 竖直判定线承载音符 ${(t1 - t0).toFixed(1)}s（${t0.toFixed(1)}→${t1.toFixed(1)}s）：超过 12s 的竖打段落很吃横向体力，建议≤8–12s，或拆成两段`, `judgeLineList[${l.index}]`, t0);
      }
    }
  }

  /* ---------- 上下双线：音符应从两条线「向外」分开 ---------- */
  {
    const carriers = chart.lines.filter((l) => l.notes.some((n) => !n.isFake));
    if (carriers.length >= 2) {
      const info = carriers.map((l) => {
        const ns = l.notes.filter((n) => !n.isFake);
        const y = ns.reduce((a, n) => a + (Number.isFinite(n.ey) ? n.ey : 0), 0) / ns.length;
        const above = ns[0].above === 0 ? -1 : 1;
        const evs = l.layers.flatMap((ly) => ly.rotateEvents || []);
        const rot = evs.length ? Number(evs[0].start) || 0 : 0;
        const flip = Math.cos((rot * Math.PI) / 180) >= 0 ? 1 : -1;
        return { l, y, dir: above * flip }; // +1 = 从上往下落，-1 = 从下往上升
      }).sort((a, b) => b.y - a.y);
      // 只看"水平类"的线成对比较（竖直判定线的纵向分布会干扰 y 判断）
      const horiz = info.filter((x) => {
        const evs = x.l.layers.flatMap((ly) => ly.rotateEvents || []);
        const rot = evs.length ? Number(evs[0].start) || 0 : 0;
        return Math.abs(Math.cos((rot * Math.PI) / 180)) >= 0.35;
      }).sort((a, b) => b.y - a.y);
      let hit = null;
      for (let i = 0; i < horiz.length && !hit; i++) {
        for (let j = i + 1; j < horiz.length; j++) {
          const up = horiz[i], lo = horiz[j];
          if (Math.abs(up.y - lo.y) <= 120) continue;
          if (up.dir > 0 && lo.dir < 0) { hit = { up, lo }; break; }
        }
      }
      if (hit) {
        warn(issues, 'cross-line-direction',
          `上方线 L${hit.up.l.index} 的音符从上往下、下方线 L${hit.lo.l.index} 从下往上升：两股音符朝彼此运动，`
          + '会在中线附近糊成一片、也难判断该按哪条线；建议上方线音符 above=0（从下往上）、下方线 above=1（从上往下），'
          + '让两条线的音符各自向外分开', 'notes');
      }
    }
  }

  /* ---------- 倾斜（incline）：手感与多线布置 ---------- */
  {
    const lined = chart.lines
      .map((l) => {
        const notes = l.notes.filter((n) => !n.isFake).length;
        const evs = l.extended.inclineEvents || [];
        let maxAbs = 0;
        for (const e of evs) maxAbs = Math.max(maxAbs, Math.abs(Number(e.start) || 0), Math.abs(Number(e.end) || 0));
        return { index: l.index, notes, maxAbs, evs: evs.length };
      })
      .filter((x) => x.notes > 0);
    const mainLines = lined.length;
    for (const x of lined) {
      if (x.maxAbs > 20) {
        warn(issues, 'line-tilt',
          `L${x.index} 倾斜达 ${Math.round(x.maxAbs)}°（承载 ${x.notes} 个音符）：倾角越大横向压缩越强、落点越难读；`
          + '参考谱面并非每张都用倾角，单线建议 ≤15°，高潮段更应接近 0°', `judgeLineList[${x.index}].extended.inclineEvents`);
      }
    }
    if (mainLines >= 2) {
      const tilted = lined.filter((x) => x.maxAbs > 0.5);
      if (tilted.length) {
        warn(issues, 'line-tilt-multiline',
          `使用 ${mainLines} 条承载音符的判定线时不应倾斜（L${tilted.map((x) => x.index).join('/L')} 有倾角）：`
          + '上下/双主线布置靠位置区分方向，倾斜会破坏读谱', 'judgeLineList');
      }
    }
  }

  /* ---------- 手感：跨音符手指数 / 撞键 / jack / 大跳 ---------- */
  {
    // Drag 不需要「按下」（引擎里触点在它附近经过就自动判），但它依然要一根手指跑过去；
    // 所以「同刻需要按下的键数」不计 Drag，「手指要移动到哪」另有一项 drag-far 管。
    const pressAll = realNotes.filter((n) => n.type !== 4);
    const holds = pressAll.filter((n) => n.type === 2);
    // 1) 跨音符手指数：长条按住期间 + 同刻需要按下的音符
    const byMs = new Map();
    for (const n of pressAll) {
      const k = Math.round(n.sec * 1000);
      if (!byMs.has(k)) byMs.set(k, []);
      byMs.get(k).push(n);
    }
    const cap = maxFingers != null ? Number(maxFingers)
      : (difficulty != null && Number.isFinite(Number(difficulty)) ? chordCapForValidate(Number(difficulty)) : null);
    let fingerOver = 0;
    const fingerSamples = [];
    const holdMs = holds.map((h) => ({
      start: Math.round(h.sec * 1000),
      end: Number.isFinite(h.endSec) ? Math.round(h.endSec * 1000) : null,
    }));
    for (const [ms, group] of [...byMs.entries()].sort((a, b) => a[0] - b[0])) {
      const t = ms / 1000;
      // 「在 t 之前就已按下、且 t 时还按着」的长条占用手指数
      let active = 0;
      for (const h of holdMs) {
        if (h.start < ms && h.end != null && h.end > ms) active++;
      }
      // 本组（同一毫秒）所有需要按下的音符，含长条头；Drag 已在 pressAll 里排除
      const load = active + group.length;
      if (cap != null && load > cap) {
        fingerOver++;
        if (fingerSamples.length < 5) fingerSamples.push({ t, load, cap });
      }
    }
    if (fingerOver) {
      (strict ? err : warn)(issues, 'finger-overload',
        `${fingerOver} 个时刻需要超过 ${cap ?? '?'} 根手指（含正在按住的长条）：`
        + fingerSamples.map((x) => `${x.t.toFixed(2)}s需${x.load}指`).join('、'),
        'notes', fingerSamples[0] && fingerSamples[0].t);
    }

    // 2) 撞键 / jack / 大跳：同线相邻（Drag 不参与）
    //    一律用**屏幕有效坐标 ex**（判定线 moveX/rotate 之后）——玩家是按看到的位置出手的，
    //    只看逻辑 x 会在扫线谱面上把"横跨半屏"判成"同位置连击"。
    // 一律用**屏幕 2D 坐标**（判定线 moveX/rotate 之后）——玩家是按看到的位置出手的：
    //   · 只看逻辑 x：扫线时把"横跨半屏"判成"同位置连击"；
    //   · 只看屏幕 x：竖直判定线（rot 90°）上所有音符的 x 都塌成同一条竖线 → 全部误报连打。
    const sxOf = (n) => (Number.isFinite(n.ex) ? n.ex : n.x);
    const syOf = (n) => (Number.isFinite(n.ey) ? n.ey : 0);
    const dist2 = (a, b) => Math.hypot(sxOf(a) - sxOf(b), syOf(a) - syOf(b));
    const byLine = new Map();
    for (const n of pressAll) {
      if (!byLine.has(n.line)) byLine.set(n.line, []);
      byLine.get(n.line).push(n);
    }
    let keyClash = 0, jack = 0, jackTight = 0, jump = 0;
    const clashSamples = [], jumpSamples = [];
    for (const arr of byLine.values()) {
      arr.sort((a, b) => a.sec - b.sec);
      for (let i = 1; i < arr.length; i++) {
        const a = arr[i - 1], b = arr[i];
        const dt = b.sec - a.sec;
        const dx = dist2(b, a); // 屏幕 2D 距离（竖直判定线上就是纵向差）
        if (dt < 0.14 && dx < 170) { keyClash++; if (clashSamples.length < 4) clashSamples.push({ t: b.sec, dt, dx }); }
        // 长条刚结束时在同位置再点一下是正常手法，不算 jack
        const holdRelease = a.type === 2 && Number.isFinite(a.endSec) && b.sec >= a.endSec - 0.03;
        // dt>0：同刻的两个音符是"同刻多指"（collision 管），不是"连击"——别双重计数
        if (dt > 1e-6 && dt < 0.6 && dx < 70 && !holdRelease) {
          // 纵连（同位置连续点）是标准手法：参考谱 24 张里有 1550 对、dt 中位 0.226s。
          // 只有"又近又窄"（<120ms 且 <45px）才会读成一次、属于难读，其余只作提示。
          if (dt < 0.075 && dx < 45) jackTight++; else jack++;
        }
      }
    }
    // 大跳：按「最近手配对」——同刻多音符时每只手可以各走各的，取组间最小位移
    const groups = [...byMs.entries()].sort((a, b) => a[0] - b[0])
      .map(([ms, g]) => ({ t: ms / 1000, ns: g }));
    for (let i = 1; i < groups.length; i++) {
      const a = groups[i - 1], b = groups[i];
      const dt = b.t - a.t;
      if (!(dt > 1e-4 && dt < 0.3)) continue;
      // 同一只手才需要移动：左右手分侧时，跨侧换手不算大跳。
      // 另外必须**同一条判定线**：上下双线（ey 差 550px）各由一只手负责，
      // 人在两条线之间交替不是"单手横跨半屏"（实测盲测谱 45 条告警全来自这种跨线配对）。
      let best = Infinity;
      const sameSide = (x1, x2) => (x1 >= 0) === (x2 >= 0);
      for (const n1 of a.ns) for (const n2 of b.ns) {
        if (n1.line !== n2.line) continue;
        if (sameSide(sxOf(n1), sxOf(n2))) best = Math.min(best, dist2(n1, n2));
      }
      if (!Number.isFinite(best)) best = 0;
      if (best > 400) {
        jump++;
        if (jumpSamples.length < 4) jumpSamples.push({ t: b.t, dt, dx: best });
      }
    }
    if (keyClash) {
      (strict ? err : warn)(issues, 'key-clash',
        `${keyClash} 处相邻音符时间过近且横向没让开（<140ms 且 |Δx|<170）：手指来不及分开，会互相抢判定`
        + (clashSamples.length ? `（例：${clashSamples[0].t.toFixed(2)}s Δt=${(clashSamples[0].dt * 1000).toFixed(0)}ms Δx=${Math.round(clashSamples[0].dx)}）` : ''),
        'notes', clashSamples[0] && clashSamples[0].t);
    }
    if (jackTight) {
      warn(issues, 'jack-tight',
        `${jackTight} 处同线「又近又窄」连击（<75ms 且 |Δx|<45px，约等于 32 分同点连打）：会被读成一次点击，建议错开`,
        'notes');
    }
    if (jack) {
      info(issues, 'jack-repeat',
        `${jack} 处同线同位置连击（<0.6s 且 |Δx|<70）：这是纵连手法（参考谱 24 张里 1550 对），正常密度无需处理`,
        'notes');
    }
    if (jump) {
      warn(issues, 'big-jump',
        `${jump} 处 0.3s 内横向跨度 >400px：手要横跨半屏，建议按间隔限制位移（<0.3s 限 400、<0.5s 限 300）`
        + (jumpSamples.length ? `（例：${jumpSamples[0].t.toFixed(2)}s Δx=${Math.round(jumpSamples[0].dx)}）` : ''),
        'notes', jumpSamples[0] && jumpSamples[0].t);
    }
  }

  /* ---------- 黄键（Drag）：不需要按下，但需要一根手指经过它 ---------- */
  // 事实（judge.rs）：Drag 没有按下事件也能判 —— 只要任一触点落在它的 X_DIFF_MAX 内。
  // 所以它不增加「同时按下的键数」，但手指必须跑到它的 x；成串滑动（相邻黄键）不算跳。
  // 这里只给 info，不当警告：参考谱面里大量黄键靠"长条/前一个音符的手指"或"划一串"完成。
  {
    const FAR_DX = 320;      // ≈1.8 个音符宽
    const PRESS_WIN = 0.3;   // 前后 0.3s 内按下的音符，手指一般都还在附近
    const CHAIN_WIN = 0.35;  // 相邻黄键 = 顺着一划
    let lonely = 0;
    const samples = [];
    for (const l of chart.lines) {
      const ns = l.notes.filter((n) => !n.isFake && Number.isFinite(n.sec)).sort((a, b) => a.sec - b.sec);
      const isDrag = (n) => n.type === 4;
      for (const d of ns) {
        if (!isDrag(d)) continue;
        let nearPress = false, chain = false;
        for (const o of ns) {
          if (o === d) continue;
          const dt = Math.abs(o.sec - d.sec);
          if (dt > CHAIN_WIN) continue;
          if (isDrag(o)) { chain = true; continue; }
          if (dt <= PRESS_WIN && Math.abs(o.x - d.x) <= FAR_DX) { nearPress = true; break; }
        }
        if (!nearPress && !chain) {
          lonely++;
          if (samples.length < 3) samples.push(d.sec);
        }
      }
    }
    if (lonely) {
      info(issues, 'drag-lonely',
        `${lonely} 个黄键（Drag）既没有邻近的按键可依托、也不在黄键串里：`
        + '黄键不用按，但要有一根手指经过它的 x 才能自动判定 —— 这类位置要靠手指主动跑过去'
        + (samples.length ? `（例：${samples[0].toFixed(2)}s）` : ''), 'notes', samples[0]);
    }
  }

  /* ---------- 密度相关的多指 / 拥挤 / 换手 ---------- */
  {
    const cap2 = maxFingers != null ? Number(maxFingers)
      : (difficulty != null && Number.isFinite(Number(difficulty)) ? chordCapForValidate(Number(difficulty)) : null);
    const pressAll2 = realNotes.filter((n) => n.type !== 4);
    const drags = realNotes.filter((n) => n.type === 4);
    const byMs2 = new Map();
    for (const n of pressAll2) {
      const k = Math.round(n.sec * 1000);
      if (!byMs2.has(k)) byMs2.set(k, []);
      byMs2.get(k).push(n);
    }
    const groups2 = [...byMs2.entries()].sort((a, b) => a[0] - b[0]).map(([ms, g]) => ({ t: ms / 1000, g }));
    // 1) 双押附近放黄键（视觉拥挤 + 引导手指乱跑）
    let dragCrowd = 0;
    const dragSamples = [];
    for (const grp of groups2) {
      if (grp.g.length < 2) continue;
      for (const d of drags) {
        if (Math.abs(d.sec - grp.t) > 0.12) continue;
        if (grp.g.some((n) => Math.abs(n.x - d.x) < noteW)) {
          dragCrowd++;
          if (dragSamples.length < 4) dragSamples.push({ t: d.sec, x: d.x });
          break;
        }
      }
    }
    if (dragCrowd) {
      warn(issues, 'drag-crowd',
        `${dragCrowd} 处双押/多押附近 0.12s 内还有黄键（横向 < ${Math.round(noteW)}）：手指会被引导去滑，容易漏拍或误触`,
        'notes', dragSamples[0] && dragSamples[0].t);
    }
    // 2) 时间窗手指数：0.15s 内需要按下的音符超过上限
    const W = 0.15;
    let handLoad = 0;
    const loadSamples = [];
    let lastStart = -Infinity;
    for (let i = 0; i < groups2.length; i++) {
      const start = groups2[i].t;
      if (start - lastStart <= W) continue; // 窗口重叠时不重复计数（否则同一段会被算好几次）
      let left = 0, right = 0;
      for (let j = i; j < groups2.length && groups2[j].t - start <= W; j++) {
        for (const n of groups2[j].g) { if (n.x < 0) left++; else right++; }
      }
      const cnt = Math.max(left, right); // 左右手交替是正常写法，按单只手统计
      if (cap2 != null && cnt > cap2) {
        handLoad++;
        lastStart = start;
        if (loadSamples.length < 4) loadSamples.push({ t: start, cnt });
      }
    }
    if (handLoad) {
      warn(issues, 'hand-load',
        `${handLoad} 段 0.15s 内同一只手要先后按下 ${cap2 ?? '?'} 个以上音符（不是同刻多指，是连打过密/换手不足）`
        + (loadSamples.length ? `（例：${loadSamples[0].t.toFixed(2)}s 段内单侧 ${loadSamples[0].cnt} 个）` : ''),
        'notes', loadSamples[0] && loadSamples[0].t);
    }
    // 竖直判定线的局部 x 是屏幕纵向位置，不代表左右手 → 手部分布统计要排除
    const vertLines = new Set(chart.lines.filter((l) => {
      const evs = l.layers.flatMap((ly) => ly.rotateEvents || []);
      const rot = evs.length ? Number(evs[0].start) || 0 : 0;
      return Math.abs(Math.cos((rot * Math.PI) / 180)) < 0.35;
    }).map((l) => l.index));

    // 2.5) 分窗检查：全曲均衡不代表每段都不累（实测有谱面全曲 56%，但某 30s 段右占 78%）
    {
      const W = 30, STEP = 10;
      const pressAll3 = chart.notes.filter((n) => !n.isFake && n.type !== 4 && Number.isFinite(n.sec) && !vertLines.has(n.line));
      if (pressAll3.length >= 60) {
        const dur = Math.max(...pressAll3.map((n) => n.sec));
        let worst = null;
        for (let t = 0; t + W <= Math.max(W, dur) + 1e-9; t += STEP) {
          const seg = pressAll3.filter((n) => n.sec >= t && n.sec < t + W);
          if (seg.length < 20) continue;
          const left = seg.filter((n) => n.x < 0).length;
          const share = Math.max(left, seg.length - left) / seg.length;
          if (seg.length >= 30 && share > 0.7 && (!worst || share > worst.share)) worst = { t, share, left, n: seg.length };
        }
        if (worst) {
          const sideName = worst.left > worst.n - worst.left ? '左手' : '右手';
          warn(issues, 'hand-balance-window',
            `${worst.t.toFixed(0)}–${(worst.t + W).toFixed(0)}s 的单侧负担占 ${(worst.share * 100).toFixed(0)}%（${worst.left} 左 / ${worst.n - worst.left} 右），${sideName}会先累：`
            + '建议该段整体左右镜像，或把这一段的落点重心挪回中间', 'notes', worst.t);
        }
      }
    }

    // 3) 左右手分工：只统计"水平类"判定线上的音符 —— 竖直判定线的局部 x 是屏幕纵向位置，
    //    拿它判断左右手会得出完全错误的结论（实测竖线段的音符全被算成"右手"）
    const handNotes = pressAll2.filter((n) => !vertLines.has(n.line));
    if (handNotes.length >= 32) {
      const left = handNotes.filter((n) => n.x < 0).length;
      const share = Math.min(left, handNotes.length - left) / handNotes.length;
      if (share < 0.25) {
        warn(issues, 'hand-balance',
          `左右手分工失衡：${left} 个在左 / ${handNotes.length - left} 个在右（少的一侧仅 ${(share * 100).toFixed(0)}%）：`
          + '参考谱面长期保持"一手负责一半屏幕"，建议按半区分配',
          'notes');
      }
    }
  }

  /* ---------- 规模 ---------- */
  if (chart.notes.length > 20000) warn(issues, 'too-many-notes', `音符号 ${chart.notes.length}，可能卡顿`, 'notes');
  if (lines.length > 200) warn(issues, 'too-many-lines', `判定线 ${lines.length} 条，可能卡顿`, 'judgeLineList');
  let evCount = 0;
  for (const l of lines) {
    for (const layer of l.layers) for (const k of Object.keys(layer)) evCount += layer[k].length;
    for (const k of Object.keys(l.extended)) evCount += l.extended[k].length;
  }
  if (evCount > 60000) warn(issues, 'too-many-events', `事件 ${evCount} 个，可能卡顿`, 'events');

  /* ---------- numOfNotes ---------- */
  // numOfNotes 口径：与 addNotes 一致 = 非 fake 音符数（含 Hold）
  for (const l of lines) {
    const declared = Number((l.raw || {}).numOfNotes);
    const actual = l.notes.filter((n) => !n.isFake).length;
    if (l.notes.length && Number.isFinite(declared) && declared !== actual) {
      info(issues, 'numofnotes', `L${l.index} numOfNotes=${declared} 与实际真音符 ${actual} 不一致（仅显示用途）`, `judgeLineList[${l.index}].numOfNotes`);
    }
  }

  const counts = {
    errors: issues.filter((i) => i.level === 'error').length,
    warnings: issues.filter((i) => i.level === 'warn').length,
    infos: issues.filter((i) => i.level === 'info').length,
  };
  return {
    ok: counts.errors === 0,
    counts,
    issues,
    stats: { notes: chart.notes.length, real: realNotes.length, fake, lines: lines.length, events: evCount, maxChord, maxChordPress, collisions, collisionsMarginal, visualOverlaps, firstSec },
  };
}

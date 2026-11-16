/**
 * 难度与可玩性分析。难度模型用参考谱面标定：剔除「耐力谱 23375」与 3 个作者自填异常定数样本后
 * （21 张）MAE≈0.31；含耐力谱反而更差（0.81）——它 693s / 黄键 61%，特征分布和其它谱不同源。
 * 特征：x1 峰值密度 / x2 最大同刻 / x3 平均密度 / x4 判定线事件率 / x5 Drag 占比 / x6 多指负载 / x7 时长
 */
import { NOTE_TYPES, RPE_WIDTH, NOTE_WIDTH_RATIO_BASE, chartDuration, screenX } from './rpe.js';

// 带符号约束的最小二乘标定（剔除耐力谱 23375 + 3 个作者自填异常样本，21 张）：MAE≈0.31
// x1 峰值密度 / x2 最大同刻 / x3 平均密度 / x4 判定线事件率 / x5 Drag 占比(稀释) / x6 多指负载
const COEF = { x1: 0.10, x2: 0.20, x3: 2.40, x4: 0.60, x5: -1.50, x6: 0.30, b: 6.724 };
const NOTE_WIDTH_PX = 2 * NOTE_WIDTH_RATIO_BASE * (RPE_WIDTH / 2); // ≈177.9 RPE 单位

export function stats(chart) {
  const notes = chart.notes || [];
  const real = notes.filter((n) => !n.isFake);
  const dur = chartDuration(notes);
  // 密度只能用**真音符**的时间跨度：假音符可以把谱面尾巴拖长，不该稀释平均密度（否则难度预测会随装饰变化）
  const realDur = chartDuration(real);
  const byType = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const n of notes) byType[n.type] = (byType[n.type] || 0) + 1;
  // 难度特征只认真音符：假音符不判定、不占手，不该稀释 Drag 占比/长条统计
  const realByType = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const n of real) realByType[n.type] = (realByType[n.type] || 0) + 1;
  // 峰值密度：任意 1s 窗口内的最大音符数。
  // 旧实现用 Math.floor(sec) 的绝对秒桶，同一段爆发跨桶边界时会被劈成两桶、峰值凭空减半。
  const secs = real.map((n) => n.sec).filter(Number.isFinite).sort((a, b) => a - b);
  let peak = 0;
  for (let i = 0, j = 0; i < secs.length; i++) {
    while (j < secs.length && secs[j] < secs[i] + 1 - 1e-9) j++;
    if (j - i > peak) peak = j - i;
  }
  // 同刻（含 Drag，用于物量/读谱）
  const byTime = new Map();
  for (const n of real) { const k = Math.round(n.sec * 1000); if (!byTime.has(k)) byTime.set(k, 0); byTime.set(k, byTime.get(k) + 1); }
  let maxChord = 0;
  const chordDist = {};
  for (const v of byTime.values()) { chordDist[v] = (chordDist[v] || 0) + 1; if (v > maxChord) maxChord = v; }
  // 同刻「需要按下」的音符（排除 Drag）：这才是手指数口径
  const pressTime = new Map();
  for (const n of real) {
    if (n.type === 4 || !Number.isFinite(n.sec)) continue;
    const k = Math.round(n.sec * 1000);
    pressTime.set(k, (pressTime.get(k) || 0) + 1);
  }
  let maxChordPress = 0;
  for (const v of pressTime.values()) if (v > maxChordPress) maxChordPress = v;
  // 间隔
  const sorted = real.map((n) => n.sec).sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) { const d = sorted[i] - sorted[i - 1]; if (d > 0.0005) gaps.push(d); }
  gaps.sort((a, b) => a - b);
  const medianGap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : null;
  const p10 = gaps.length ? gaps[Math.max(0, Math.floor(gaps.length * 0.1))] : null;
  // 事件
  let events = 0;
  for (const l of chart.lines) { for (const layer of l.layers) for (const k of Object.keys(layer)) events += layer[k].length; for (const k of Object.keys(l.extended)) events += l.extended[k].length; }
  const holdDur = real.filter((n) => n.type === 2).map((n) => n.endSec - n.sec).filter(Number.isFinite);
  const fake = notes.length - real.length;
  const dragRatio = real.length ? (realByType[4] || 0) / real.length : 0;
  // 时间非法的音符数（=NaN 秒）：难度模型对它无能为力，输出里要显式暴露
  const invalidNotes = notes.filter((n) => !Number.isFinite(n.sec)).length;
  // 额外手指数只统计「需要按下」的音符：Drag 自动判定，算进来会让 x6 虚高 0.1~0.2
  const pressDist = {};
  let pressTotal = 0;
  for (const v of pressTime.values()) { pressDist[v] = (pressDist[v] || 0) + 1; pressTotal += v; }
  const fingerExtra = Object.entries(pressDist).reduce((s, [k, v]) => s + (Number(k) - 1) * v, 0) / Math.max(pressTotal, 1);
  // 首音符时刻：playability / 生成器都要用它判断"开局有没有准备时间"
  let firstSec = null;
  for (const n of real) if (Number.isFinite(n.sec) && (firstSec == null || n.sec < firstSec)) firstSec = n.sec;
  // 同线同刻抢判定（与 validate 的 collision 同口径：直线坐标 x，不看判定线位移）
  let collisions = 0;
  {
    const perLine = new Map();
    for (const n of real) {
      if (n.type === 4 || !Number.isFinite(n.sec)) continue;
      const k = `${n.line}@${Math.round(n.sec * 1000)}`;
      if (!perLine.has(k)) perLine.set(k, []);
      perLine.get(k).push(n.x);
    }
    const need = NOTE_WIDTH_PX * 0.8; // 与 validate 的 collision 告警同口径
    for (const xs of perLine.values()) {
      if (xs.length < 2) continue;
      const s2 = xs.slice().sort((a, b) => a - b);
      for (let i = 0; i + 1 < s2.length; i++) if (s2[i + 1] - s2[i] < need) collisions++;
    }
  }
  // 连击里程碑：按音符顺序累加（连击 = 判定数，Drag 也计入），用来把截图里的 combo 换算成时间
  const comboMarks = [];
  {
    const seq = real.filter((n) => Number.isFinite(n.sec)).sort((a, b) => a.sec - b.sec);
    const step = seq.length >= 1000 ? 250 : seq.length >= 400 ? 100 : 50;
    for (let i = step - 1; i < seq.length; i += step) comboMarks.push({ combo: i + 1, sec: Number(seq[i].sec.toFixed(2)) });
  }
  return {
    comboMarks,
    notes: notes.length, real: real.length, fake, lines: chart.lines.length, events,
    duration: dur, realDuration: realDur, byType,
    densityAvg: realDur ? real.length / realDur : 0, densityPeak: peak,
    maxChord, maxChordPress, chordDist, medianGap, p10Gap: p10, firstSec, collisions, invalidNotes,
    holdCount: holdDur.length,
    holdAvg: holdDur.length ? holdDur.reduce((a, b) => a + b, 0) / holdDur.length : 0,
    holdMax: holdDur.reduce((m, v) => (v > m ? v : m), 0),
    dragRatio, fingerExtra, eventRate: realDur ? events / realDur : 0,
  };
}

/** 难度预测：返回 {predicted, confidence, features, reasons} */
export function predictDifficulty(chart) {
  const s = stats(chart);
  const x = {
    x1: Math.log1p(s.densityPeak),
    x2: Math.log1p(s.maxChordPress == null ? s.maxChord : s.maxChordPress),
    x3: Math.log1p(s.densityAvg),
    x4: Math.log1p(s.eventRate),
    x5: s.dragRatio,
    x6: Math.log1p(s.fingerExtra * 20),
  };
  const LABELS = { x1: '峰值密度', x2: '最大同刻', x3: '平均密度', x4: '事件率', x5: 'Drag 占比', x6: '额外手指数' };
  let d = COEF.b;
  const terms = [{ name: '基准', coef: 1, value: 1, contribution: COEF.b }];
  for (const k of Object.keys(x)) {
    const contribution = COEF[k] * x[k];
    d += contribution;
    terms.push({ name: LABELS[k] || k, coef: COEF[k], value: x[k], contribution });
  }
  d = Math.max(1, Math.min(17.5, d));
  const reasons = [];
  if (s.densityAvg > 7) reasons.push(`平均密度高（${s.densityAvg.toFixed(2)} 音符/s）`);
  if (s.densityPeak > 30) reasons.push(`峰值密度高（${s.densityPeak} 音符/s）`);
  if (s.maxChord >= 3) reasons.push(`多指（最大同刻 ${s.maxChord}）`);
  if (s.dragRatio > 0.35) reasons.push(`Drag 占比高（${(s.dragRatio * 100).toFixed(0)}%），实际手感会被稀释`);
  if (s.eventRate > 60) reasons.push(`判定线事件极密（${s.eventRate.toFixed(0)}/s）`);
  if (s.duration > 240) reasons.push(`时长消耗（${(s.duration / 60).toFixed(1)} 分钟）`);
  if (s.invalidNotes) reasons.push(`${s.invalidNotes} 个音符时间非法（[a,b,c] 的 c=0 或缺失），这些音符不参与统计，预测不可信`);
  if (!reasons.length) reasons.push('各项指标温和，属于基础谱面');
  let confidence = s.notes < 50 ? 0.3 : s.duration < 30 ? 0.5 : 0.75;
  if (s.invalidNotes) confidence = Math.min(confidence, 0.2);
  return { predicted: Number(d.toFixed(2)), confidence, features: s, reasons, terms };
}

/** 10 项可玩性检查（结构化） */
export function playability(chart, opt = {}) {
  const {
    launchGapSec = 2,
    collisionRatio = 1.2,
    maxFingers = null,
  } = opt;
  const s = stats(chart);
  const out = [];
  const add = (id, level, title, detail, at) => out.push({ id, level, title, detail, at });
  const real = chart.notes.filter((n) => !n.isFake);
  // 屏幕有效坐标：音符是判定线的子对象，玩家打的是 ex = 线位移 + x·cos(旋转)
  const lineByIndex = new Map((chart.lines || []).map((l) => [l.index, l]));
  const exOf = (n) => {
    const l = lineByIndex.get(n.line);
    return l ? screenX(l, n.sec, n.x) : n.x;
  };

  // 1 出界（按屏幕位置，含判定线位移/旋转）
  const oob = real.filter((n) => Math.abs(exOf(n)) > RPE_WIDTH / 2);
  if (oob.length) add('oob', 'error', '音符出界', `${oob.length} 个真音符屏幕位置 |x| > ${RPE_WIDTH / 2}（含判定线位移；例：${oob.slice(0, 3).map((n) => exOf(n).toFixed(0)).join(', ')}）`, 'notes');
  // 2 贴边
  const near = real.filter((n) => Math.abs(exOf(n)) > 600);
  if (near.length) add('near-edge', 'warn', '音符贴边', `${near.length} 个真音符屏幕位置 |x| > 600，判定风险高`, 'notes');
  // 3 碰撞：同线同刻、横向间距 < 音符宽×1.2 → 一个触点抢两个判定
  if (s.collisions) add('collision', 'warn', '同线同刻抢判定', `${s.collisions} 对同线同刻点击音符横向间距 < ${Math.round(NOTE_WIDTH_PX * 0.8)}px（音符宽 ${Math.round(NOTE_WIDTH_PX)}px）：一个触点只判最近的那个，会判错`, 'notes');
  // 4 开局
  if (s.firstSec != null && s.firstSec < launchGapSec) add('launch', 'warn', '开局无准备', `首个音符在 ${s.firstSec.toFixed(2)}s（阈值 ${launchGapSec}s）`, 'notes');
  // 5 多指
  const chordPress = s.maxChordPress == null ? s.maxChord : s.maxChordPress;
  if (maxFingers != null && chordPress > maxFingers) add('fingers', 'warn', '多指超规格', `同刻需要按下 ${chordPress} 个音符（黄键不用按下，但手指仍要经过）> 上限 ${maxFingers}`, 'notes');
  // 6 判定线极速
  let fast = 0;
  for (const l of chart.lines) for (const layer of l.layers) {
    for (const key of ['moveXEvents', 'moveYEvents']) {
      for (const e of layer[key] || []) {
        if (!Number.isFinite(e.st) || !Number.isFinite(e.et)) continue;
        const dt = e.et - e.st;
        const dx = Math.abs(Number(e.end) - Number(e.start));
        if (dt > 1e-4 && dx / dt > 3000) fast++;
      }
    }
  }
  if (fast) add('fast-line', 'warn', '判定线极速移动', `${fast} 个移动事件速度 > 3000px/s（可能看不清音符）`, 'events');
  // 7 可读性：可见时间
  const badVis = real.filter((n) => Number.isFinite(n.visibleTime) && n.visibleTime < 0.5);
  if (badVis.length) add('visible-time', 'warn', '可见时间过短', `${badVis.length} 个音符 visibleTime < 0.5s`, 'notes');
  // 8 长条异常
  const tooShort = chart.notes.filter((n) => n.type === 2 && Number.isFinite(n.endSec) && n.endSec - n.sec < 0.1);
  const tooLong = chart.notes.filter((n) => n.type === 2 && Number.isFinite(n.endSec) && n.endSec - n.sec > 4);
  if (tooShort.length) add('hold-short', 'info', '超短长条', `${tooShort.length} 个长条 < 0.1s`, 'notes');
  if (tooLong.length) add('hold-long', 'info', '超长长条', `${tooLong.length} 个长条 > 4s`, 'notes');
  // 9 双押间距（3 指以上也要看：任意一对都能被一只手够到）
  const byTime = new Map();
  for (const n of real) { const k = Math.round(n.sec * 1000); if (!byTime.has(k)) byTime.set(k, []); byTime.get(k).push(n); }
  let wide = 0;
  for (const all of byTime.values()) {
    const g = all.filter((n) => n.type !== 4); // Drag 自动判定，不构成"双押"
    if (g.length < 2) continue;
    for (let i = 0; i < g.length; i++) {
      for (let j = i + 1; j < g.length; j++) {
        if (Math.abs(g[i].x - g[j].x) > 900) wide++;
      }
    }
  }
  if (wide) add('wide-chord', 'info', '双押间距过大', `${wide} 对双押横向间距 > 900`, 'notes');
  // 10 长条内嵌：Drag 同车道安全（自动判定）；Tap/Flick 同车道 = 手指撞车
  const holdClash = [];
  let holdDrag = 0;
  for (const l of chart.lines) {
    const holds = l.notes.filter((n) => n.type === 2 && !n.isFake && Number.isFinite(n.sec) && Number.isFinite(n.endSec));
    if (!holds.length) continue;
    for (const n of l.notes) {
      if (n.type === 2 || n.isFake || !Number.isFinite(n.sec)) continue;
      for (const h of holds) {
        if (h === n) continue;
        if (!(h.sec + 1e-3 < n.sec && n.sec < h.endSec - 1e-3)) continue;
        const sameLane = Math.abs(n.x - h.x) < NOTE_WIDTH_PX * collisionRatio;
        if (!sameLane) continue;
        if (n.type === 4) holdDrag++;
        else holdClash.push({ line: l.index, t: n.sec, type: n.type });
      }
    }
  }
  if (holdClash.length) {
    add('hold-collision', 'warn', '长条与按键撞车',
      `${holdClash.length} 个 Tap/Flick 与同线长条同车道且落在身体内（一手按住时另一手要在同一点击/划）：`
      + `参考谱面 1,961 个长条内嵌里同车道 Tap/Flick 仅 11 个；同车道安全写法只有 Drag`
      + `（示例 t=${holdClash[0].t.toFixed(2)}s ${NOTE_TYPES[holdClash[0].type]}）`, 'notes');
  }
  if (holdDrag) add('hold-inner-drag', 'info', '长条内嵌 Drag', `${holdDrag} 个 Drag 内嵌在同车道长条内（不用按下，按住长条的那根手指顺手就判到，标准写法）`, 'notes');

  return { items: out, stats: s };
}

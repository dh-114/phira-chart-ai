/**
 * 质量回归：把「代码 ↔ prpr 源码」对过的语义钉死，防止被改回去。
 * 每条断言都对应一个曾经的 bug（详见 README「已修 bug」与 docs/engine.md §2/§5）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emptyChart, normalizeChart, toTriple, chartDuration } from '../lib/rpe.js';
import { validate } from '../lib/validate.js';
import { stats, predictDifficulty, playability } from '../lib/analyze.js';
import { renderFrame } from '../lib/render.js';
import { parseExtra } from '../lib/effects.js';
import { generateChart, writeInfoFor, countEvents } from '../lib/generator.js';

let bad = 0;
const ok = (name, cond, detail = '') => {
  if (cond) console.log(`  ✅ ${name}`);
  else { console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); bad++; }
};
const section = (t) => console.log(`\n【${t}】`);

/* ---------------- 构造工具 ---------------- */
const T = (beat) => toTriple(beat, 192);
const ev = (a, b, start, end, easingType = 1) => ({
  bezier: 0, bezierPoints: [0, 0, 0, 0], easingLeft: 0, easingRight: 1, easingType,
  start, end, startTime: T(a), endTime: T(b), linkgroup: 0,
});
const note = (beat, x, { type = 1, endBeat = null, fake = 0 } = {}) => ({
  type, above: 1, startTime: T(beat), endTime: T(endBeat == null ? beat : endBeat),
  positionX: x, yOffset: 0, alpha: 255, size: 1, speed: 1, isFake: fake, visibleTime: 999999,
});
const baseChart = (bpm = 180, lineY = -270) => emptyChart({ bpm, lineY });
const codes = (r, level) => r.issues.filter((i) => (level ? i.level === level : true)).map((i) => i.code);

/* ================= 1. validate：事件链语义（源码 core/anim.rs / parse/rpe.rs） ================= */
section('validate · 事件链（anim.rs 空层 / speedEvents 例外排序）');
{
  const c = baseChart();
  const L = c.judgeLineList[0];
  L.eventLayers[0].rotateEvents = [ev(4, 4, 0), ev(2, 2, 30)]; // 乱序 rotate
  L.eventLayers[0].speedEvents = [ev(4, 4, 10), ev(2, 2, 5)];  // 乱序 speed（引擎会排序）
  const r = validate(normalizeChart(c));
  ok('乱序 rotate → unsorted-events', codes(r).includes('unsorted-events'));
  ok('乱序 speedEvents 不报（parse_speed_events 会 sort）',
    !r.issues.some((i) => i.code === 'unsorted-events' && String(i.at || '').includes('speed')));
}
{
  // 首层空数组 + 后层有事件 → 不闪退但静默丢值（warn）
  const c = baseChart(); const L = c.judgeLineList[0];
  L.eventLayers = [{ alphaEvents: [] }, { alphaEvents: [ev(0, 1, 255)] }];
  const r = validate(normalizeChart(c));
  ok('链首空数组 → empty-event-array-head（warn）', codes(r).includes('empty-event-array-head'));
  // 后层空数组 + 前层有事件 → anim.rs unwrap panic（error）
  const c2 = baseChart(); const L2 = c2.judgeLineList[0];
  L2.eventLayers = [{ alphaEvents: [ev(0, 1, 255)] }, { alphaEvents: [] }];
  const r2 = validate(normalizeChart(c2));
  ok('后层空数组 → empty-event-array（error）',
    r2.issues.some((i) => i.code === 'empty-event-array' && i.level === 'error'));
  // 只有空数组（没有任何宿主层）→ 不进链，不该报
  const c3 = baseChart(); c3.judgeLineList[0].eventLayers = [{ alphaEvents: [] }];
  ok('孤立空数组不误报', !codes(validate(normalizeChart(c3))).some((x) => x.startsWith('empty-event')));
}

/* ================= 2. validate：手指口径 / 出界 / numOfNotes ================= */
section('validate · 手指口径与几何（judge.rs Drag 自动判定 / position_x÷675）');
{
  // 1 Tap + 2 Drag 同刻：Drag 不占手指 → 不该报 fingers
  const c = baseChart(); const L = c.judgeLineList[0];
  L.notes.push(note(4, 0), note(4, -400, { type: 4 }), note(4, 400, { type: 4 }));
  const r = validate(normalizeChart(c), { maxFingers: 2 });
  ok('Drag 不计入手指数（maxChordPress=1 ≤ 2）', r.stats.maxChordPress === 1, `maxChordPress=${r.stats.maxChordPress}`);
  ok('Drag 不触发 fingers', !codes(r).includes('fingers'));
  ok('maxChord 仍统计全部真音符（=3）', r.stats.maxChord === 3, `maxChord=${r.stats.maxChord}`);
}
{
  // |positionX|=1000 出界；即使判定线有 moveX 呼吸也不能降级成 info
  for (const moveX of [null, [ev(0, 4, 0), ev(4, 8, 10)]]) {
    const c = baseChart(); const L = c.judgeLineList[0];
    if (moveX) L.eventLayers[0].moveXEvents = moveX;
    L.notes.push(note(4, 1000), note(8, 0));
    const r = validate(normalizeChart(c));
    ok(`x=1000 出界判 error（moveX=${moveX ? '有' : '无'}）`,
      r.issues.some((i) => i.code === 'note-oob' && i.level === 'error'));
  }
}
{
  // numOfNotes 写成 0 也是错（旧实现把 0 当"没写"放过）
  const c = baseChart(); const L = c.judgeLineList[0];
  L.notes.push(note(4, -200), note(5, 200), note(6, -200));
  L.numOfNotes = 0;
  ok('numOfNotes=0 且实际 3 → numofnotes', codes(validate(normalizeChart(c))).includes('numofnotes'));
}
{
  // 撞键/jack 用屏幕有效坐标：moveX 把第二个音符推到半屏外，不该判成"同位置连击"
  const c = baseChart(); const L = c.judgeLineList[0];
  L.eventLayers[0].moveXEvents = [ev(0, 2, 0), ev(2, 4, -540)];
  L.notes.push(note(1, 0), note(3, 0));
  const r = validate(normalizeChart(c));
  ok('扫线时不再误报 jack-repeat', !codes(r).includes('jack-repeat'));
}

/* ================= 2.5 竖直判定线（rot 90°）：手感判据必须用屏幕 2D 坐标 ================= */
section('竖直判定线（手法：vertical）');
{
  const vert = (c) => { c.judgeLineList[0].eventLayers[0].rotateEvents = [ev(0, 1, 90)]; return c; };
  // 竖直线上的音符横向（屏幕 x）全塌成一条线，但纵向散开 —— 不该报同位置连打
  const c = vert(baseChart(180));
  for (let i = 0; i < 8; i++) c.judgeLineList[0].notes.push(note(8 + i, i % 2 ? 300 : -300));
  const r = validate(normalizeChart(c));
  ok('竖直线 ±300 交替不再误报 jack-repeat', !codes(r).includes('jack-repeat'), codes(r).join(','));
  // 竖直线上的真同点连打仍要报
  const c2 = vert(baseChart(180));
  c2.judgeLineList[0].notes.push(note(8, 200), note(9, 200)); // 9 拍 = 3s？bpm180 → 相邻 0.33s
  ok('竖直线上真同点连打仍报 jack-repeat', codes(validate(normalizeChart(c2))).includes('jack-repeat'));
  // 扫线（同局部 x、线横移半屏）：手指跟着线走，不算同位置连打
  const c3 = baseChart(180); const L3 = c3.judgeLineList[0];
  L3.eventLayers[0].moveXEvents = [ev(0, 2, 0), ev(2, 4, -540)];
  L3.notes.push(note(1, 0), note(3, 0));
  ok('扫线同点位不误报 jack-repeat', !codes(validate(normalizeChart(c3))).includes('jack-repeat'));
}

/* ================= 2.6 盲测2 反馈：大跳跨线 / 纵连分级 / 特效语义 ================= */
section('盲测2 反馈');
{
  // 上下双线各由一只手负责：两线之间交替不是"单手横跨半屏"
  const c = baseChart(180);
  c.judgeLineList.push(JSON.parse(JSON.stringify(c.judgeLineList[0]))); // 复制一条线当第二条
  const L0 = c.judgeLineList[0], L1 = c.judgeLineList[1];
  L1.Name = 'L1';
  L0.eventLayers[0].moveYEvents = [ev(0, 8, -300, -300, 1)];
  L1.eventLayers[0].moveYEvents = [ev(0, 8, 300, 300, 1)];
  L0.notes.push({ ...note(4, -20) });
  L1.notes.push({ ...note(5, 20) }); // 0.33s 后，另一条线
  const r = validate(normalizeChart(c));
  ok('两条线的上下交替不报 big-jump', !codes(r).includes('big-jump'), codes(r).join(','));
}
{
  // 纵连（同位置连点）是标准手法：正常密度只提示，不告警
  const mk = (gapBeats) => {
    const c = baseChart(180); const L = c.judgeLineList[0];
    for (let i = 0; i < 6; i++) L.notes.push(note(8 + i * gapBeats, 120)); // 从 2.67s 起，避开 launch-gap
    return validate(normalizeChart(c));
  };
  const normal = mk(0.5);  // 0.167s
  ok('常规纵连只给 info 不告警', normal.counts.warnings === 0 && codes(normal).includes('jack-repeat'), normal.issues.filter((i) => i.level !== 'info').map((i) => i.code).join(','));
  const tight = mk(0.2);   // 0.067s ≈ 32 分同点连打
  ok('极密纵连（<75ms）才告警', codes(tight).includes('jack-tight'));
}
{
  // 同刻双音符由 collision 管，不该再被算成"连击"
  const c = baseChart(180); const L = c.judgeLineList[0];
  L.notes.push(note(4, 0), note(4, 30));
  const r = validate(normalizeChart(c));
  ok('同刻近距不强算 jack', !codes(r).includes('jack-tight') && !codes(r).includes('jack-repeat'), codes(r).join(','));
}
{
  // 水印幂等（旧实现每调用一次多一条线）
  const { applyAIMark } = await import('../lib/author.js');
  const c = baseChart(180);
  applyAIMark(c); applyAIMark(c); applyAIMark(c);
  const marks = c.judgeLineList.filter((l) => l.Name === 'AI-Mark');
  ok('applyAIMark 幂等（只有一条水印线）', marks.length === 1, `lines=${marks.length}`);
  ok('水印 alpha 轨被覆盖而非追加', (marks[0].eventLayers[0].alphaEvents || []).length === 2, `alpha=${(marks[0].eventLayers[0].alphaEvents || []).length}`);
}
{
  // vignette 必须复刻引擎着色器：uv*(1-uv.yx)*radius → pow(·, extend) → mix(color, tex, vig)
  const { applyEffect } = await import('../lib/effects.js');
  const W = 200, H = 112;
  const data = new Uint8ClampedArray(W * H * 4).fill(255);
  applyEffect({ w: W, h: H, data }, 'vignette', {}, 5);
  const px = (x, y) => data[(y * W + x) * 4];
  const f = (x, y) => {
    const u = (x + 0.5) / W, v = (y + 0.5) / H;
    return Math.round(255 * Math.min(1, Math.pow(Math.max(0, u * (1 - v) * v * (1 - u) * 15), 0.25)));
  };
  ok('vignette 中心亮度匹配着色器', Math.abs(px(100, 56) - f(100, 56)) <= 1, `${px(100, 56)} vs ${f(100, 56)}`);
  ok('vignette 角部亮度匹配着色器', Math.abs(px(1, 1) - f(1, 1)) <= 1, `${px(1, 1)} vs ${f(1, 1)}`);
}

/* ================= 2.7 试玩反馈：倾斜/竖线/双线方向/分窗手部负担 + 新手法 ================= */
section('试玩反馈（判定线布局与手法）');
{
  // 新手法：按键起头 + N 个黄键（同 x / 楼梯）
  const { applyPattern } = await import('../lib/author.js');
  const mk = (params) => {
    const c = baseChart(180);
    applyPattern(c, 'tapDragChain', { startBeat: 8, stepBeat: 0.25, ...params });
    return c.judgeLineList[0].notes.map((n) => `${n.type}:${n.positionX}`);
  };
  const same = mk({ x: -200, count: 4, type: 1 });
  ok('tapDragChain 同 x：1 蓝键 + 4 黄键', same.length === 5 && same[0] === '1:-200' && same.slice(1).every((v) => v === '4:-200'), same.join(' '));
  const stairs = mk({ x: -300, count: 5, shape: 'stairs', x2: 300, type: 3 });
  ok('tapDragChain 楼梯：红键起头、黄键横向展开', stairs[0] === '3:-300' && stairs[4] === '4:150' && stairs[5] === '4:300', stairs.join(' '));
}
{
  // 主判定线长段旋转
  const long = baseChart(180); const L = long.judgeLineList[0];
  for (let i = 0; i < 120; i++) L.notes.push(note(8 + i * 0.5, i % 2 ? 300 : -300));
  L.eventLayers[0].rotateEvents = [ev(4, 24, 0, 10, 1)]; // 10° 持续 20 拍 = 6.7s
  ok('主判定线长段倾斜 → line-rotate-tilt', codes(validate(normalizeChart(long))).includes('line-rotate-tilt'));
  const brief = baseChart(180); const Lb = brief.judgeLineList[0];
  for (let i = 0; i < 120; i++) Lb.notes.push(note(8 + i * 0.5, i % 2 ? 300 : -300));
  Lb.eventLayers[0].rotateEvents = [ev(8, 8.5, 0, 10, 1)]; // 只 0.17s 的过渡
  ok('短暂倾斜不报（过渡允许）', !codes(validate(normalizeChart(brief))).includes('line-rotate-tilt'));
}
{
  // 竖直判定线：位置与时长
  const mk = (x, beats) => {
    const c = baseChart(180); const L = c.judgeLineList[0];
    L.eventLayers[0].rotateEvents = [ev(0, 1, 90, 90, 1)];
    if (x) L.eventLayers[0].moveXEvents = [ev(0, 1, x, x, 1)];
    for (let i = 0; i < 20; i++) L.notes.push(note(8 + i * (beats / 20), i % 2 ? 300 : -300));
    return validate(normalizeChart(c));
  };
  ok('竖线在屏幕中间 → vertical-line-center', codes(mk(0, 8)).includes('vertical-line-center'));
  ok('竖线贴边 → 不报中间', !codes(mk(-600, 8)).includes('vertical-line-center'));
  ok('竖线段过长 → vertical-line-long', codes(mk(-600, 100)).includes('vertical-line-long'));
}
{
  // 上下双线：音符应向外分开
  const mk = (topAbove) => {
    const c = baseChart(180);
    const top = JSON.parse(JSON.stringify(c.judgeLineList[0])); top.Name = 'TOP';
    const bot = JSON.parse(JSON.stringify(c.judgeLineList[0])); bot.Name = 'BOT';
    top.eventLayers[0].moveYEvents = [ev(0, 1, 300, 300, 1)];
    bot.eventLayers[0].moveYEvents = [ev(0, 1, -300, -300, 1)];
    bot.eventLayers[0].rotateEvents = [ev(0, 1, 180, 180, 1)];
    c.judgeLineList = [c.judgeLineList[0], top, bot];
    for (let i = 0; i < 6; i++) {
      top.notes.push({ ...note(8 + i, i % 2 ? 200 : -200), above: topAbove });
      bot.notes.push({ ...note(8 + i, i % 2 ? 200 : -200), above: 1 });
    }
    return validate(normalizeChart(c));
  };
  ok('两线音符朝彼此运动 → cross-line-direction', codes(mk(1)).includes('cross-line-direction'));
  ok('上线上方 above=0 向外分开 → 不报', !codes(mk(0)).includes('cross-line-direction'));
}
{
  // 右手负担：全曲均衡但某 30s 段单侧 100%
  const c = baseChart(180); const L = c.judgeLineList[0];
  for (let i = 0; i < 60; i++) L.notes.push(note(8 + i * 0.25, i % 2 ? 250 : -250));      // 前半 均衡
  for (let i = 0; i < 60; i++) L.notes.push(note(45 + i * 0.25, 150 + (i % 2) * 100));     // 15–20s 段全在右侧
  const r = validate(normalizeChart(c));
  ok('某段单侧负担过重 → hand-balance-window', codes(r).includes('hand-balance-window'));
}
{
  // 连击里程碑：用于把截图里的 combo 换算成时间
  const s2 = stats(normalizeChart(baseChart(180)));
  ok('stats 暴露 comboMarks', Array.isArray(s2.comboMarks));
}

/* ================= 2.8 生成器：plan 模式无 MIDI / 风格 drag 比例 ================= */
section('生成器 · plan 模式');
{
  // plan 模式不该要求 MIDI（之前无条件抛 "MIDI 不存在"）
  let planOk = true, planErr = '';
  try {
    const r = generateChart({ outDir: path.join(os.tmpdir(), 'phira-plan-nomidi'), source: 'plan', style: 'balanced', difficulty: 12, durationSec: 60, bpm: 170 });
    planOk = r.notes > 0;
  } catch (e) { planOk = false; planErr = e.message; }
  ok('plan 模式不需要 MIDI', planOk, planErr);

  // endurance 风格的 styles.js drag 比例要真的生效（之前写了 0.47 但没人用 → 0% 黄键）
  const dir = path.join(os.tmpdir(), 'phira-plan-endurance');
  const r = generateChart({ outDir: dir, source: 'plan', style: 'endurance', difficulty: 15, durationSec: 90, bpm: 170, seed: 1 });
  const c = normalizeChart(JSON.parse(fs.readFileSync(path.join(dir, 'chart.json'), 'utf8')));
  const real = c.notes.filter((n) => !n.isFake);
  const dragShare = real.filter((n) => n.type === 4).length / real.length;
  ok('endurance 的黄键占比 > 15%', dragShare > 0.15, (dragShare * 100).toFixed(0) + '%');
  const v = validate(c, { difficulty: r.difficulty });
  ok('endurance 生成 0E/0W', v.counts.errors === 0 && v.counts.warnings === 0, `${v.counts.errors}E/${v.counts.warnings}W ${v.issues.filter((i) => i.level !== 'info').map((i) => i.code).join(',')}`);
  // 长条尾后 0.5 拍不许接按键
  ok('endurance 无 hold-tail-press', !v.issues.some((i) => i.code === 'hold-tail-press'));
}

/* ================= 2.9 后处理：不许全局/全程 ================= */
section('后处理 · 全局滤镜');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phira-globalfx-'));
  const chart = baseChart(150);
  for (let i = 0; i < 40; i++) chart.judgeLineList[0].notes.push(note(8 + i, i % 2 ? 200 : -200));
  const c = normalizeChart(chart);
  const dur = Math.max(...c.notes.filter((n) => !n.isFake).map((n) => n.sec));
  const mk = (fx) => validate(c, { effects: [{ shader: 'vignette', start: 0, end: fx, global: false }] });
  ok('全程 vignette → fx-global-shader', codes(mk(dur * 1.0)).includes('fx-global-shader'));
  ok('短段 vignette（5%）→ 不报', !codes(mk(dur * 0.05)).includes('fx-global-shader'));
  const g = validate(c, { effects: [{ shader: 'grayscale', start: 10, end: 12, global: true }] });
  ok('global:true → fx-global-shader', codes(g).includes('fx-global-shader'));
}

/* ================= 3. analyze：死项复活 / 桶相位 / 假音符 / NaN ================= */
section('analyze · 统计口径（judge.rs 判定半径 / 手指数）');
{
  const c = baseChart(); const L = c.judgeLineList[0];
  L.notes.push(note(0.5, -200), note(2, 200), note(2.1, 0)); // 首音符 0.5 拍 ≈ 0.17s
  const ch = normalizeChart(c);
  const s = stats(ch);
  ok('stats 暴露 firstSec', Number.isFinite(s.firstSec), `firstSec=${s.firstSec}`);
  ok('stats 暴露 collisions/invalidNotes', 'collisions' in s && 'invalidNotes' in s);
  ok('playability 报 launch（之前是死项）',
    playability(ch, { launchGapSec: 2 }).items.some((i) => i.id === 'launch'));
  const d = predictDifficulty(ch);
  ok('predictDifficulty 返回 terms（doctor 公式明细依赖它）', Array.isArray(d.terms) && d.terms.length >= 3, `terms=${d.terms && d.terms.length}`);
}
{
  // 同一段爆发整体后移 0.5s：绝对秒桶会算出不同峰值，滑动窗口不会
  const mk = (shift) => {
    const c = baseChart(); const L = c.judgeLineList[0];
    for (let i = 0; i < 12; i++) L.notes.push(note(2 + shift + i * 0.05, (i % 2 ? 300 : -300)));
    return stats(normalizeChart(c)).densityPeak;
  };
  ok('峰值密度与桶相位无关（滑动 1s 窗口）', mk(0) === mk(0.5), `${mk(0)} vs ${mk(0.5)}`);
}
{
  // 假音符不该影响难度
  const mk = (fakeDrag) => {
    const c = baseChart(); const L = c.judgeLineList[0];
    for (let i = 0; i < 40; i++) L.notes.push(note(1 + i * 0.25, i % 2 ? 200 : -200));
    if (fakeDrag) for (let i = 0; i < 200; i++) L.notes.push(note(1 + i * 0.05, 0, { type: 4, fake: 1 }));
    return predictDifficulty(normalizeChart(c)).predicted;
  };
  ok('假音符不改变难度预测', mk(false) === mk(true), `${mk(false)} vs ${mk(true)}`);
}
{
  // 时间非法（c=0）的音符：不能把 duration 变成 NaN，且要降置信
  const c = baseChart(); const L = c.judgeLineList[0];
  L.notes.push(note(4, 0));
  L.notes.push({ ...note(4, 100), startTime: [0, 0, 0], endTime: [0, 0, 0] });
  const ch = normalizeChart(c);
  const s = stats(ch);
  const d = predictDifficulty(ch);
  ok('非法时间不污染 duration', Number.isFinite(s.duration) && Math.abs(s.duration - 4 * 60 / 180) < 1e-9, `duration=${s.duration}`);
  ok('invalidNotes 计数', s.invalidNotes === 1, `invalidNotes=${s.invalidNotes}`);
  ok('置信度下调并给出原因', d.confidence <= 0.2 && d.reasons.some((x) => x.includes('非法')));
}

/* ================= 4. 崩溃类：NaN 时间渲染 / extra.json ================= */
section('崩溃类（render / effects）');
{
  const c = baseChart(); const L = c.judgeLineList[0];
  L.notes.push(note(4, 0));
  L.notes.push({ ...note(4, 100), startTime: [0, 0, 0], endTime: [0, 0, 0] });
  let threw = null;
  try { renderFrame(normalizeChart(c), {}, 1, { width: 200, debug: false }); } catch (e) { threw = e; }
  ok('含 NaN 音符时 renderFrame 不崩（旧版 new Array(NaN) → RangeError）', !threw, threw && threw.message);
}
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phira-q-'));
  const cases = [['null', 'null'], ['number', '42'], ['array', '[1,2]']];
  for (const [name, body] of cases) {
    fs.writeFileSync(path.join(dir, 'extra.json'), body);
    let threw = null, r = null;
    try { r = parseExtra(dir, null); } catch (e) { threw = e; }
    ok(`extra.json=${name} 不抛异常、给结构化错误`,
      !threw && r && r.errors.some((e) => e.code === 'extra-json-shape'), threw && threw.message);
  }
  // extra 自己的 bpm：beat 8 = 8×0.5s（120bpm 段）→ 4s，与 chart 的 BPMList 无关
  fs.writeFileSync(path.join(dir, 'extra.json'), JSON.stringify({
    bpm: [{ time: [0, 0, 1], bpm: 120 }, { time: [8, 0, 1], bpm: 60 }],
    effects: [{ shader: 'grayscale', start: [8, 0, 1], end: [12, 0, 1] }],
  }));
  const r = parseExtra(dir, null); // 故意不给 chart 的 bpm
  ok('extra.json 时间用自带 bpm 换算（beat 8 → 4.00s）',
    r.effects.length === 1 && Math.abs(r.effects[0].start - 4) < 1e-6,
    r.effects[0] && `start=${r.effects[0].start}`);
}

/* ================= 5. 生成器：手感硬指标 ================= */
section('generator · 手感硬指标');
const MIDI = process.env.PHIRA_TEST_MIDI || path.resolve(process.env.HOME || '/root', '../..', '') ;
const midiCandidates = [
  process.env.PHIRA_TEST_MIDI,
  // 仓库自带样例（可选）：test/fixtures/*.mid
  ...(() => { try { return fs.readdirSync(path.join(HERE, 'fixtures')).filter((f) => f.endsWith('.mid')).map((f) => path.join(HERE, 'fixtures', f)); } catch { return []; } })(),
].filter(Boolean);
const midi = midiCandidates.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
if (!midi) {
  console.log('  （未找到测试 MIDI，跳过生成器用例）');
} else {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'phira-gen-'));
  const r = generateChart({ midiPath: midi, outDir: out, source: 'midi', difficulty: 13, effects: 'light' });
  const ch = normalizeChart(JSON.parse(fs.readFileSync(path.join(out, 'chart.json'), 'utf8')));
  const v = validate(ch, { difficulty: r.difficulty });
  const c = codes(v);
  ok('生成结果 0 error', v.counts.errors === 0, JSON.stringify(v.counts));
  ok('生成结果 0 warn', v.counts.warnings === 0, c.join(','));
  for (const k of ['hold-overlap', 'hold-collision', 'finger-overload', 'key-clash', 'jack-repeat', 'big-jump', 'launch-gap']) {
    ok(`无 ${k}`, !c.includes(k));
  }
  const first = Math.min(...ch.notes.filter((n) => !n.isFake).map((n) => n.sec));
  ok('前奏留白 ≥ introSec(2s)', first >= 2 - 1e-6, `first=${first.toFixed(2)}s`);
  ok('info.yml 定数按实测写（先测后标）',
    Math.abs(r.difficulty - r.predicted) < 0.06, `写 ${r.difficulty} / 预测 ${r.predicted}`);
  ok('info.yml 不引用不存在的资源',
    r.missingAssets.length === 2 && !fs.existsSync(path.join(out, 'song.mp3')));
  const info = fs.readFileSync(path.join(out, 'info.yml'), 'utf8');
  ok('info.yml 里确实没有 music/illustration 假引用', !/^music:/m.test(info) && !/^illustration:/m.test(info));

  // 特效档位：off < light < normal（事件数），light 默认
  const counts = {};
  for (const fx of ['off', 'light', 'normal']) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), `phira-fx-${fx}-`));
    const rr = generateChart({ midiPath: midi, outDir: d, source: 'plan', difficulty: 13, effects: fx });
    counts[fx] = rr.events;
  }
  ok('特效档位单调：off < light < normal', counts.off < counts.light && counts.light < counts.normal, JSON.stringify(counts));

  // midi 路径的 effects 也必须生效（旧实现 off/light/normal 生成同一张谱）
  const midiCounts = {};
  for (const fx of ['off', 'light', 'normal']) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), `phira-midi-fx-${fx}-`));
    const rr = generateChart({ midiPath: midi, outDir: d, source: 'midi', difficulty: 13, effects: fx });
    midiCounts[fx] = rr.events;
  }
  ok('midi 模式 effects 也单调', midiCounts.off < midiCounts.light && midiCounts.light < midiCounts.normal, JSON.stringify(midiCounts));

  // 风格必须真的不同（旧实现 4 种风格生成同一张谱）
  {
    const fps = new Set();
    for (const style of ['balanced', 'multiFinger', 'visual', 'endurance']) {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), `phira-style-${style}-`));
      generateChart({ midiPath: midi, outDir: d, source: 'plan', difficulty: 15, style, effects: 'off' });
      const ch2 = normalizeChart(JSON.parse(fs.readFileSync(path.join(d, 'chart.json'), 'utf8')));
      fps.add(ch2.notes.length + ':' + ch2.notes.reduce((a, n) => a + n.x, 0));
    }
    ok('四种风格生成不同谱面', fps.size >= 3, `不同结果=${fps.size}/4`);
  }

  // 至少要有红键（Flick）——旧实现一个都不生成
  {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'phira-flick-'));
    generateChart({ midiPath: midi, outDir: d, source: 'midi', difficulty: 13, effects: 'off' });
    const ch2 = normalizeChart(JSON.parse(fs.readFileSync(path.join(d, 'chart.json'), 'utf8')));
    const flick = ch2.notes.filter((n) => n.type === 3).length;
    ok('生成器产出 Flick（红键）', flick > 0, `flick=${flick}`);
  }

  // 已有资源时 info.yml 要写对
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'phira-asset-'));
  fs.writeFileSync(path.join(d2, 'song.mp3'), '');
  fs.writeFileSync(path.join(d2, 'background.png'), '');
  const meta = writeInfoFor(d2, { title: 'x' }, 12.5);
  ok('目录里有音频/曲绘时自动写进 info.yml', meta.music === 'song.mp3' && meta.illustration === 'background.png');
  ok('countEvents 统计事件而非自增计数',
    countEvents({ judgeLineList: [{ eventLayers: [{ alphaEvents: [1, 2], speedEvents: [1] }], extended: { textEvents: [1] } }] }) === 4);
}

/* ================= 5.5 盲测反馈：事件区间重叠 / META 同步 ================= */
section('盲测反馈修复');
{
  // validate 必须能抓到「同键事件区间重叠」（引擎按数组顺序压关键帧，与预览不一致）
  const c = baseChart(); const L = c.judgeLineList[0];
  L.eventLayers[0].alphaEvents = [ev(0, 1, 255, 255), ev(0, 2, 0, 110, 4)];
  const r = validate(normalizeChart(c));
  ok('检出事件区间重叠', codes(r).includes('event-overlap'), codes(r).join(','));
  // 首尾相接（前一个 end == 后一个 start）不算重叠
  const c2 = baseChart(); const L2 = c2.judgeLineList[0];
  L2.eventLayers[0].alphaEvents = [ev(0, 2, 255, 255), ev(2, 4, 0, 110, 4)];
  ok('首尾相接不误报重叠', !codes(validate(normalizeChart(c2))).includes('event-overlap'));
}
if (midi) {
  // 生成器（两种模式 × 三档特效）都不许产出重叠事件
  for (const src of ['midi', 'plan']) {
    for (const fx of ['off', 'light', 'normal']) {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), `phira-ov-${src}-${fx}-`));
      generateChart({ midiPath: midi, outDir: d, source: src, difficulty: 13, effects: fx });
      const j = JSON.parse(fs.readFileSync(path.join(d, 'chart.json'), 'utf8'));
      const b = (t) => t[0] + (t[1] || 0) / (t[2] || 1);
      let n = 0;
      for (const l of j.judgeLineList || []) {
        const tracks = [];
        for (const ly of l.eventLayers || []) for (const [k, arr] of Object.entries(ly || {})) tracks.push(arr);
        for (const v of Object.values(l.extended || {})) tracks.push(v);
        for (const arr of tracks) {
          if (!Array.isArray(arr)) continue;
          const sorted = arr.slice().sort((x, y) => b(x.startTime) - b(y.startTime));
          for (let i = 1; i < sorted.length; i++) if (b(sorted[i].startTime) < b(sorted[i - 1].endTime) - 1e-9) n++;
        }
      }
      ok(`${src}/${fx} 生成结果无重叠事件`, n === 0, `overlap=${n}`);
    }
  }
  // info.yml 无首行空行 + META 与 info.yml 一致 + 不留占位资源名
  {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'phira-meta-'));
    generateChart({ midiPath: midi, outDir: d, source: 'midi', difficulty: 13, title: 'T', charter: 'CH', effects: 'light' });
    const infoSrc = fs.readFileSync(path.join(d, 'info.yml'), 'utf8');
    ok('info.yml 无首行空行', infoSrc.split('\n')[0].trim() !== '', JSON.stringify(infoSrc.slice(0, 12)));
    const j = JSON.parse(fs.readFileSync(path.join(d, 'chart.json'), 'utf8'));
    const info = Object.fromEntries(infoSrc.split(/\r?\n/).map((l) => l.match(/^([A-Za-z0-9_]+):\s*(.*)$/)).filter(Boolean).map((m) => [m[1], m[2].trim()]));
    ok('META.name 与 info.yml 一致', j.META.name === info.name, `${j.META.name} vs ${info.name}`);
    ok('META.charter 与 info.yml 一致', j.META.charter === info.charter, `${j.META.charter} vs ${info.charter}`);
    ok('META.level 与 info.yml 一致', j.META.level === info.level, `${j.META.level} vs ${info.level}`);
    ok('没有资源文件时不留占位 META.song/background', !j.META.song && !j.META.background, JSON.stringify({ song: j.META.song, bg: j.META.background }));
  }
}

/* ================= 5.7 特效 vars：prpr untagged Variable 的形状 ================= */
section('特效 vars 形状（extra.json）');
{
  const mkExtra = (vars) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phira-fxv-'));
    fs.writeFileSync(path.join(dir, 'extra.json'), JSON.stringify({
      bpm: 180,
      effects: [{ shader: 'vignette', start: [0, 0, 1], end: [8, 0, 1], vars }],
    }));
    return dir;
  };
  // 0~1 浮点颜色 → prpr 的 Color 是 [u8;4]，整张 extra.json 会解析失败
  const bad = parseExtra(mkExtra({ color: [0.02, 0, 0.1, 1], radius: 62 }), null);
  ok('裸值颜色写成 0~1 浮点 → 报 effect-var-type', bad.errors.some((e) => e.code === 'effect-var-type'), bad.errors.map((e) => e.code).join(','));
  const good = parseExtra(mkExtra({ color: [5, 0, 26, 255], radius: 62, extend: 0.2 }), null);
  ok('裸值颜色写 0–255 整数 → 通过', good.errors.length === 0, good.errors.map((e) => e.code).join(','));
  // vignette radius > 16 → 引擎 vig>1，画面中心被提亮（玩家反馈"一直闪"）
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'phira-vig-'));
  fs.writeFileSync(path.join(d2, 'extra.json'), JSON.stringify({ bpm: 180, effects: [{ shader: 'vignette', start: [0, 0, 1], end: [8, 0, 1], vars: { color: [5, 0, 26, 255], radius: 62, extend: 0.2 } }] }));
  const vig = parseExtra(d2, null);
  ok('vignette radius>16 → 告警 fx-vignette-radius', vig.warnings.some((w) => w.code === 'fx-vignette-radius'), vig.warnings.map((w) => w.code).join(','));

  const v2 = parseExtra(mkExtra({ center: [0.5, 0.5] }), null);
  ok('Vec2 两元素 → 通过', v2.errors.length === 0, v2.errors.map((e) => e.code).join(','));
  const def = parseExtra(mkExtra({ power: null }), null);
  ok('null = ExtAnim::Default → 通过', def.errors.length === 0, def.errors.map((e) => e.code).join(','));
  const three = parseExtra(mkExtra({ color: [1, 2, 3] }), null);
  ok('3 元素数组 → 报错', three.errors.some((e) => e.code === 'effect-var-type'), three.errors.map((e) => e.code).join(','));
}
{
  // 音符 tint / color 事件也是 u8[3]：写入时 0~1 浮点必须换算，长度不对必须报错
  const { normRGB, addNotes, addEvents } = await import('../lib/author.js');
  ok('normRGB 把 0~1 浮点换算成 0–255', JSON.stringify(normRGB([0.1, 0.5, 1])) === '[26,128,255]', JSON.stringify(normRGB([0.1, 0.5, 1])));
  ok('normRGB 保留合法整数', JSON.stringify(normRGB([1, 128, 255])) === '[1,128,255]');
  let threw = false;
  try { normRGB([1, 2]); } catch { threw = true; }
  ok('normRGB 长度非法抛错', threw);
  const c = baseChart(180);
  addNotes(c, 0, [{ beat: 8, type: 1, x: 0, tint: [0.1, 0.5, 1] }]);
  addEvents(c, 0, 'color', [{ startBeat: 0, endBeat: 4, from: [0.2, 0.4, 0.6], to: [1, 0.5, 0.2] }]);
  const j = c.judgeLineList[0];
  ok('音符 tint 写入时换算', JSON.stringify(j.notes[0].tint) === '[26,128,255]', JSON.stringify(j.notes[0].tint));
  ok('color 事件写入时换算', JSON.stringify(j.extended.colorEvents[0].start) === '[51,102,153]', JSON.stringify(j.extended.colorEvents[0].start));
}

/* ================= 6. 崩溃/边界（面板白屏、路径白名单、渲染尺寸、脏数据） ================= */
section('崩溃 · 边界');
{
  // P1：一个拍数写错的音符不能把 density 数组撑到 33 万（客户端展开就栈溢出 → 面板白屏）
  const { seriesOf } = await import('../lib/routes.js');
  const c = baseChart(180); const L = c.judgeLineList[0];
  L.notes.push(note(4, 0));
  L.notes.push({ ...note(4, 100), startTime: [1000000, 0, 1], endTime: [1000000, 0, 1] });
  const se = seriesOf(normalizeChart(c));
  ok('seriesOf density 长度受时长上限约束', se.density.length <= 9002, `len=${se.density.length}`);
  ok('density 不含 NaN/负数', se.density.every((v) => Number.isFinite(v) && v >= 0));
}
{
  // 工具/路由走同一套根目录白名单
  const { resolveSafe, inRoots } = await import('../lib/paths.js');
  let threw = null;
  try { resolveSafe('/etc/passwd'); } catch (e) { threw = e; }
  ok('根目录外路径被拒绝', !!threw);
  const wd = process.cwd();
  ok('工作目录在允许范围内', inRoots(wd));
}
{
  // 渲染尺寸必须夹取（width=200000 曾经要分配 83GB）
  const { renderFrame, renderStrip, fitSize } = await import('../lib/render.js');
  const c = normalizeChart(baseChart(180));
  const f = renderFrame(c, {}, 1, { width: 200000, debug: false });
  ok('renderFrame 夹取超宽请求', f.surface.w * f.surface.h <= 4e6, `${f.surface.w}x${f.surface.h}`);
  const st = renderStrip(c, {}, 0, 2, 1, { cols: 999, width: 640, debug: false });
  ok('renderStrip 夹取超大网格', st.surface.w * st.surface.h <= 4e6, `${st.surface.w}x${st.surface.h}`);
  const [w2] = fitSize(99999, 99999);
  ok('fitSize 夹到 1600 以内', w2 <= 1600, String(w2));
  // 宽高比非法不能算出负高度
  const neg = renderFrame(c, { aspectRatio: -9 }, 1, { width: 400, debug: false });
  ok('aspectRatio=-9 有兜底', neg.surface.w > 0 && neg.surface.h > 0);
}
{
  // 脏数据：null 元素只能得到结构化错误，不能 TypeError
  const dirty = {
    BPMList: [{ bpm: 180, startTime: [0, 0, 1] }], META: { offset: 0 },
    judgeLineList: [{ Name: 'a', Texture: 'line.png', isCover: 1, eventLayers: [{ alphaEvents: [null] }], notes: [null] }],
  };
  let threw = null, codes2 = [];
  try { const c = normalizeChart(dirty); codes2 = c.errors.map((e) => e.code); validate(c); } catch (e) { threw = e; }
  ok('null 元素不抛 TypeError，转成 errors', !threw, threw && threw.message);
  ok('null 元素被记成结构化错误', codes2.includes('note-not-object') && codes2.includes('event-not-object'), codes2.join(','));
}
{
  // 负拍三元组必须落成 b>=0（prpr 是 Triple(i32,u32,u32)），并且 validate 要拦非法 b/c
  const t = toTriple(-1.5, 192);
  ok('toTriple 负拍 b>=0', t[1] >= 0 && t[2] > 0 && Math.abs(t[0] + t[1] / t[2] + 1.5) < 1e-9, JSON.stringify(t));
  const c = baseChart(180);
  c.judgeLineList[0].notes.push({ ...note(4, 0), startTime: [-1, -3, 6] });
  ok('validate 拦 b<0 的三元组', codes(validate(normalizeChart(c))).includes('triple-out-of-range'));
}
{
  // MIDI 第一个 tempo 不在 tick 0 → 之前按默认 120BPM（SMF 规范）
  const { parseMidi } = await import('../lib/midi.js');
  const vlq = (n) => { const b = [n & 0x7f]; n >>= 7; while (n) { b.unshift((n & 0x7f) | 0x80); n >>= 7; } return b; };
  const track = [];
  const ev2 = (dt, bytes) => { track.push(...vlq(dt), ...bytes); };
  ev2(480, [0xFF, 0x51, 0x03, 0x07, 0xA1, 0x20]); // tick480: 120BPM
  ev2(0, [0x90, 60, 64]); ev2(480, [0x80, 60, 0]);
  track.push(0, 0xFF, 0x2F, 0x00);
  const hdr = [0x4D, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xE0];
  const trkHdr = [0x4D, 0x54, 0x72, 0x6B, (track.length >> 24) & 255, (track.length >> 16) & 255, (track.length >> 8) & 255, track.length & 255];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phira-midi-'));
  const f = path.join(dir, 'a.mid');
  fs.writeFileSync(f, Buffer.from([...hdr, ...trkHdr, ...track]));
  const mid = parseMidi(f);
  ok('MIDI tick 480（首 tempo 之前）= 0.500s', Math.abs(mid.notes[0].startSec - 0.5) < 1e-6, String(mid.notes[0].startSec));
}

/* ---------------- 汇总 ---------------- */
console.log(bad === 0 ? '\n全部通过' : `\n${bad} 项失败`);
process.exit(bad === 0 ? 0 : 1);

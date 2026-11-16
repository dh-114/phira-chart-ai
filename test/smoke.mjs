import fs from 'node:fs'; import path from 'node:path';
import { apply } from '../index.js';

const defs = new Map();
const ctx = { tools: { register(d) { defs.set(d.name, d); return () => {}; } }, get() {}, inject() {}, on() {}, effect() {} };
apply(ctx);

const call = async (name, args) => {
  const d = defs.get(name);
  if (!d) throw new Error(`未注册：${name}`);
  const out = await d.execute(args, { signal: new AbortController().signal });
  return d.output.render(args, out)[0].text;
};

import { firstChartDir } from './_fixtures.mjs';
import { parseExtra } from '../lib/effects.js';
import { makeBpm } from '../lib/rpe.js';
const chartDir = firstChartDir();
if (!chartDir) { console.log('未找到参考铺面，跳过冒烟测试（可用 PHIRA_CHARTS 指定目录）'); process.exit(0); }
const results = [];
const check = (name, fn) => results.push([name, fn]);

const g = await call('phira_guide', { topic: 'judge' });
check('phira_guide', g.includes('垂直通道') ? 'OK' : 'FAIL');
const ge = await call('phira_guide', { topic: 'engine' });
check('phira_guide(engine)', ge.includes('tween 0') && ge.includes('保持') && ge.includes('空事件数组') ? 'OK' : 'FAIL');
const gp = await call('phira_guide', { topic: 'platform' });
check('phira_guide(platform)', gp.includes('PHIRA_ROOTS') && gp.includes('rename') ? 'OK' : 'FAIL');
const gd = await call('phira_guide', { topic: 'doc' });
check('phira_guide(doc)', gd.length > 2000 && gd.includes('引擎语义速查') ? 'OK' : 'FAIL');

const v = await call('phira_validate', { path: chartDir });
check('phira_validate', v.includes('校验') && v.includes('0 error') ? 'OK' : 'FAIL: ' + v.slice(0, 80));

const a = await call('phira_analyze', { path: chartDir });
check('phira_analyze', a.includes('难度预测') ? 'OK' : 'FAIL: ' + a.slice(0, 80));

const p = await call('phira_chart_plan', { durationSec: 40, bpm: 180, difficulty: 13, style: 'multiFinger' });
check('phira_chart_plan', p.includes('段落表') ? 'OK' : 'FAIL');

// 演示：复制一份再改，避免污染参考谱面
const tmp = path.join(path.dirname(chartDir), '..', '铺面测试', 'smoke_copy');
fs.mkdirSync(tmp, { recursive: true });
const src = fs.readdirSync(chartDir).find((f) => f.endsWith('.json'));
fs.copyFileSync(path.join(chartDir, src), path.join(tmp, 'chart.json'));
fs.copyFileSync(path.join(chartDir, 'info.yml'), path.join(tmp, 'info.yml'));

for (const [nm, prm] of [
  ['mirrorLines', { y: -270 }],
  ['belowDrag', { line: 0, startBeat: 240, count: 4, pitches: [60, 64, 67, 72] }],
  ['crossLines', { startBeat: 250, count: 2, stepBeat: 2, beats: 1 }],
  ['holdFlick', { line: 0, startBeat: 260, count: 1, beats: 2, x: 0 }],
  ['fakePulse', { startBeat: 270, beats: 8 }],
  ['holdFlickMelody', { line: 0, startBeat: 280, beats: 8, melody: [260, 120, 300] }],
]) {
  const ro = await call('phira_chart_apply_pattern', { path: tmp, pattern: nm, params: prm });
  check(`phira_chart_apply_pattern(${nm})`, ro.includes(nm) ? 'OK' : 'FAIL: ' + ro.slice(0, 100));
}

const hm = await call('phira_chart_apply_pattern', {
  path: tmp, pattern: 'holdMelody',
  params: { line: 0, startBeat: 200, beats: 4, melody: [-300, -150, 0, 150, 300], types: [4, 3] },
});
check('phira_chart_apply_pattern(holdMelody)', hm.includes('holdMelody') ? 'OK' : 'FAIL: ' + hm.slice(0, 100));

// 特效 vars：0~1 浮点颜色必须在写盘前换算成 0–255（否则游戏里整张 extra.json 解析失败）
{
  const d = path.join(tmp, '..', 'smoke_fxcolor');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'chart.json'), JSON.stringify({ BPMList: [{ bpm: 180, startTime: [0, 0, 1] }], META: { offset: 0 }, judgeLineList: [{ Name: 'a', Texture: 'line.png', isCover: 1, eventLayers: [{}], notes: [] }] }));
  fs.writeFileSync(path.join(d, 'info.yml'), 'name: t\ncharter: t\ndifficulty: 13\nchart: chart.json\n');
  await call('phira_chart_add_effect', { path: d, effects: [{ shader: 'vignette', startBeat: 0, endBeat: 8, vars: { color: [0.02, 0, 0.1, 1], radius: 62 } }] });
  const col = JSON.parse(fs.readFileSync(path.join(d, 'extra.json'), 'utf8')).effects[0].vars.color;
  check('add_effect 把 0~1 颜色换算成 0–255',
    Array.isArray(col) && col.every((x) => Number.isInteger(x) && x >= 0 && x <= 255) ? 'OK' : JSON.stringify(col));
  const p2 = parseExtra(d, null);
  check('换算后 extra.json 解析 0 error', p2.errors.length === 0 ? 'OK' : p2.errors.map((e) => e.code).join(','));
}
const ap = await call('phira_chart_apply_pattern', { path: tmp, pattern: 'stairs', params: { line: 0, startBeat: 4, count: 8, stepBeat: 0.5 } });
check('phira_chart_apply_pattern', ap.includes('已写入') ? 'OK' : 'FAIL: ' + ap.slice(0, 80));

// patch 顶层写法（不写 op.set 也要生效）+ 着色器边界反序拦截
{
  const p2 = path.join(tmp, '..', 'smoke_patch_top');
  fs.mkdirSync(p2, { recursive: true });
  const { emptyChart } = await import('../lib/rpe.js');
  const { addNotes, writeChart } = await import('../lib/author.js');
  const c2 = emptyChart({ bpm: 120 });
  addNotes(c2, 0, [{ beat: 0, type: 1, x: 0 }]);
  writeChart(path.join(p2, 'chart.json'), c2);
  fs.writeFileSync(path.join(p2, 'info.yml'), 'name: t\ndifficulty: 13\nchart: chart.json\nmusic: song.mp3\nillustration: background.png\n');
  await call('phira_chart_patch', { path: p2, ops: [{ op: 'update-notes', line: 0, x: 120 }] });
  const after2 = JSON.parse(fs.readFileSync(path.join(p2, 'chart.json'), 'utf8'));
  check('phira_chart_patch(顶层 set 兼容)', after2.judgeLineList[0].notes[0].positionX === 120 ? 'OK' : 'FAIL');
  let blocked = false;
  try {
    await call('phira_chart_add_shader', { path: p2, name: 'bad', source: 'uniform float x; // %1%\nvoid main(){ float t=smoothstep(1.05,0.12,0.5); }' });
  } catch { blocked = true; }
  check('phira_chart_add_shader(smoothstep 反序拦截)', blocked ? 'OK' : 'FAIL');
}

// 浮点字段必须被拦住（prpr 的 Triple/i32 会直接加载失败）
{
  const d6 = path.join(tmp, '..', 'smoke_float');
  fs.mkdirSync(d6, { recursive: true });
  const { emptyChart } = await import('../lib/rpe.js');
  const { addNotes, writeChart } = await import('../lib/author.js');
  const c6 = emptyChart({ bpm: 120 });
  addNotes(c6, 0, [{ beat: 0, type: 2, x: 0, endBeat: 2 }]);
  c6.judgeLineList[0].notes[0].endTime = [2.5, 0, 192];
  writeChart(path.join(d6, 'chart.json'), c6);
  fs.writeFileSync(path.join(d6, 'info.yml'), 'name: t\ndifficulty: 13\nchart: chart.json\nmusic: song.mp3\nillustration: background.png\n');
  const v6 = await call('phira_validate', { path: d6 });
  check('phira_validate(浮点三元组)', v6.includes('non-integer-field') || v6.includes('浮点') ? 'OK' : 'FAIL: ' + v6.slice(0, 120));

  // 非三元组的 i32/u8/u16 字段（META.offset / note.alpha / easingType）写浮点同样会让 prpr 反序列化失败
  const c6b = emptyChart({ bpm: 120 });
  addNotes(c6b, 0, [{ beat: 0, type: 1, x: 0 }]);
  c6b.META.offset = 1.5;
  c6b.judgeLineList[0].notes[0].alpha = 254.9;
  c6b.judgeLineList[0].eventLayers[0].alphaEvents[0].easingType = 1.5;
  writeChart(path.join(d6, 'chart.json'), c6b);
  const v6b = await call('phira_validate', { path: d6 });
  check('phira_validate(非三元组整数字段)', v6b.includes('non-integer-field') && v6b.includes('META.offset') ? 'OK' : 'FAIL: ' + v6b.slice(0, 160));
}

// 体检 / 批量工具
{
  const d5 = path.join(tmp, '..', 'smoke_doctor');
  fs.mkdirSync(d5, { recursive: true });
  const { emptyChart } = await import('../lib/rpe.js');
  const { addNotes, writeChart } = await import('../lib/author.js');
  const c5 = emptyChart({ bpm: 120 });
  addNotes(c5, 0, [{ beat: 0, type: 1, x: 0 }]);
  writeChart(path.join(d5, 'chart.json'), c5);
  fs.writeFileSync(path.join(d5, 'info.yml'), 'name: t\ndifficulty: 13\nchart: chart.json\nmusic: song.mp3\nillustration: background.png\n');
  const doc = await call('phira_doctor', { path: d5 });
  check('phira_doctor 输出体检', doc.includes('难度预测') && doc.includes('校验：') ? 'OK' : 'FAIL: ' + doc.slice(0, 100));
  const bat = await call('phira_chart_batch', { path: d5, ops: [{ tool: 'phira_validate', args: {} }, { tool: 'phira_analyze', args: {} }] });
  check('phira_chart_batch 执行两条', bat.includes('批量执行 2 条') ? 'OK' : 'FAIL: ' + bat.slice(0, 100));
}

// 自定义着色器 + 特效（先清掉上次残留，保证幂等）
{
  fs.rmSync(path.join(tmp, 'extra.json'), { force: true });
  fs.rmSync(path.join(tmp, 'custom.glsl'), { force: true });
  const glsl = 'uniform float factor; // %1.0%\nvoid main() { gl_FragColor = texture2D(screenTexture, uv); }';
  const sh = await call('phira_chart_add_shader', { path: tmp, name: 'custom', source: glsl });
  check('phira_chart_add_shader', sh.includes('factor') ? 'OK' : 'FAIL: ' + sh.slice(0, 100));
  const ef = await call('phira_chart_add_effect', {
    path: tmp,
    effects: [
      { shader: 'grayscale', startBeat: 0, endBeat: 4, vars: { factor: 1 } },
      { shader: '/custom.glsl', startBeat: 4, endBeat: 8 },
    ],
  });
  check('phira_chart_add_effect', ef.includes('特效数：2') ? 'OK' : 'FAIL: ' + ef.slice(0, 120));
  const ve = await call('phira_validate', { path: tmp });
  check('phira_validate(extra.json)', ve.includes('特效：2') ? 'OK' : 'FAIL: ' + ve.slice(0, 120));

  // 回归：extra.json 的 bpm 必须是 prpr 的 BpmForm（Single 数字 或 [{time,bpm}]）。
  // 写成 RPE 的 [{bpm,startTime}] 会让真实客户端整张谱面加载失败。
  {
    const ch = JSON.parse(fs.readFileSync(path.join(tmp, 'chart.json'), 'utf8'));
    const bpmIdx = makeBpm(ch.BPMList, []);
    const okRes = parseExtra(tmp, bpmIdx);
    check('extra.json bpm 合法', okRes.errors.length === 0 ? 'OK' : 'FAIL: ' + okRes.errors.map((e) => e.code).join(','));
    const ex = JSON.parse(fs.readFileSync(path.join(tmp, 'extra.json'), 'utf8'));
    ex.bpm = [{ bpm: 180, startTime: [0, 0, 1] }]; // 模拟旧版写坏的格式
    fs.writeFileSync(path.join(tmp, 'extra.json'), JSON.stringify(ex, null, 2));
    const badRes = parseExtra(tmp, bpmIdx);
    check('坏的 bpm 被拦下', badRes.errors.some((e) => e.code === 'extra-bpm-form') ? 'OK' : 'FAIL: 未拦截');
    // 再调一次 add_effect，应把非法 bpm 自动修成合法形式
    await call('phira_chart_add_effect', { path: tmp, effects: [{ shader: 'grayscale', startBeat: 20, endBeat: 24 }] });
    const fixRes = parseExtra(tmp, bpmIdx);
    check('add_effect 自动修复 bpm', fixRes.errors.length === 0 ? 'OK' : 'FAIL: ' + fixRes.errors.map((e) => e.code).join(','));
  }
}

// patch：先人为制造「空数组 + 乱序」，再用工具修
{
  const cj = JSON.parse(fs.readFileSync(path.join(tmp, 'chart.json'), 'utf8'));
  const l0 = cj.judgeLineList[0];
  l0.eventLayers = l0.eventLayers || [{}];
  if (l0.eventLayers.length < 2) l0.eventLayers.push({});
  l0.eventLayers[1].moveXEvents = [];
  const arr = l0.eventLayers[0].moveYEvents || [];
  if (arr.length > 2) arr.reverse();
  fs.writeFileSync(path.join(tmp, 'chart.json'), JSON.stringify(cj, null, 2));
  const pr = await call('phira_chart_patch', { path: tmp, ops: [{ op: 'prune-empty' }, { op: 'sort-events' }] });
  const after = JSON.parse(fs.readFileSync(path.join(tmp, 'chart.json'), 'utf8'));
  const stillEmpty = (after.judgeLineList[0].eventLayers[1] || {}).moveXEvents !== undefined;
  check('phira_chart_patch', pr.includes('prune-empty') && !stillEmpty ? 'OK' : 'FAIL: ' + pr.slice(0, 100));
}

// 修改能力：update-notes / clamp-x / set-line / delete-line
{
  const cj = JSON.parse(fs.readFileSync(path.join(tmp, 'chart.json'), 'utf8'));
  const linesBefore = cj.judgeLineList.length;
  cj.judgeLineList[0].notes.push({ type: 1, above: 1, startTime: [8, 0, 192], endTime: [8, 0, 192], positionX: 700, yOffset: 0, alpha: 255, size: 1, speed: 1, isFake: 0, visibleTime: 999999 });
  fs.writeFileSync(path.join(tmp, 'chart.json'), JSON.stringify(cj, null, 2));
  const up = await call('phira_chart_patch', {
    path: tmp,
    ops: [
      { op: 'update-notes', line: 0, fromBeat: 0, toBeat: 4, types: [1], set: { x: 300 } },
      { op: 'clamp-x', limit: 600 },
      { op: 'set-line', line: 0, y: -260, speed: 10 },
      { op: 'delete-line', line: 1 },
    ],
  });
  const after = JSON.parse(fs.readFileSync(path.join(tmp, 'chart.json'), 'utf8'));
  const l0 = after.judgeLineList[0];
  const movedOk = l0.notes.filter((n) => n.type === 1 && n.positionX === 300).length > 0;
  const clampedOk = l0.notes.every((n) => Math.abs(n.positionX) <= 600);
  const lineY = (l0.eventLayers[0].moveYEvents || [])[0];
  const yOk = lineY && lineY.start === -260;
  const delOk = after.judgeLineList.length === linesBefore - 1;
  check('phira_chart_patch(修改)', up.includes('update-notes') && movedOk && clampedOk && yOk && delOk
    ? 'OK' : `FAIL: ${JSON.stringify({ movedOk, clampedOk, yOk, delOk })}`);
}

// 通用 JSON 编辑 + 自定义规划
{
  const ed = await call('phira_chart_edit', {
    path: tmp,
    ops: [
      { op: 'set', path: 'META.name', value: 'Edited Title' },
      { op: 'set', path: 'judgeLineList.0.notes.0.positionX', value: 123 },
      { op: 'append', path: 'judgeLineList.0.extended.inclineEvents', value: { start: 0, end: 0, startTime: [0, 0, 1], endTime: [1, 0, 1], easingType: 1 } },
    ],
  });
  const after = JSON.parse(fs.readFileSync(path.join(tmp, 'chart.json'), 'utf8'));
  check('phira_chart_edit', ed.includes('set META.name') && after.META.name === 'Edited Title'
    && after.judgeLineList[0].notes[0].positionX === 123
    && after.judgeLineList[0].extended.inclineEvents.length > 0 ? 'OK' : 'FAIL: ' + ed.slice(0, 120));
  const cp = await call('phira_chart_plan', {
    durationSec: 40, bpm: 120, difficulty: 13, style: 'custom',
    custom: { density: 5, sections: [{ name: 'A', frac: 1, chord: 2 }, { name: 'B', frac: 1, density: 1.2 }] },
  });
  check('phira_chart_plan(custom)', cp.includes('自定义') && cp.includes('A') && cp.includes('B') ? 'OK' : 'FAIL: ' + cp.slice(0, 120));
}

// Drag 内嵌长条：analyze 可玩性不应报“类型不符”
{
  const { emptyChart, toTriple } = await import('../lib/rpe.js');
  const { addNotes } = await import('../lib/author.js');
  const { writeChart } = await import('../lib/author.js');
  const d2 = path.join(tmp, '..', 'smoke_draginner');
  fs.mkdirSync(d2, { recursive: true });
  const c2 = emptyChart({ bpm: 120 });
  addNotes(c2, 0, [{ beat: 0, type: 2, x: 0, endBeat: 4 }, { beat: 2, type: 4, x: 0 }]);
  writeChart(path.join(d2, 'chart.json'), c2);
  fs.writeFileSync(path.join(d2, 'info.yml'), 'name: t\ndifficulty: 13\nchart: chart.json\nmusic: song.mp3\nillustration: background.png\n');
  const an = await call('phira_analyze', { path: d2 });
  check('phira_analyze(Drag 内嵌)', !an.includes('类型不符') ? 'OK' : 'FAIL: ' + an.slice(0, 120));
}

// 非整数拍三元组：validate 必须报错
{
  const { emptyChart, writeChartFile } = await import('../lib/rpe.js');
  const d3 = path.join(tmp, '..', 'smoke_badtriple');
  fs.mkdirSync(d3, { recursive: true });
  const c3 = emptyChart({ bpm: 120 });
  c3.judgeLineList[0].eventLayers[0].alphaEvents[0].startTime = [0.5, 0, 1];
  fs.writeFileSync(path.join(d3, 'chart.json'), JSON.stringify(c3, null, 2));
  fs.writeFileSync(path.join(d3, 'info.yml'), 'name: t\ndifficulty: 13\nchart: chart.json\nmusic: song.mp3\nillustration: background.png\n');
  const v3 = await call('phira_validate', { path: d3 });
  check('phira_validate(非整数三元组)', v3.includes('triple-noninteger') || v3.includes('整数三元组') ? 'OK' : 'FAIL: ' + v3.slice(0, 160));
}

// 长条与蓝键同车道碰撞：validate / analyze 都必须报
{
  const { emptyChart } = await import('../lib/rpe.js');
  const { addNotes, writeChart } = await import('../lib/author.js');
  const d4 = path.join(tmp, '..', 'smoke_holdclash');
  fs.mkdirSync(d4, { recursive: true });
  const c4 = emptyChart({ bpm: 120 });
  addNotes(c4, 0, [
    { beat: 0, type: 2, x: 0, endBeat: 4 },
    { beat: 2, type: 1, x: 0 },   // 同车道 Tap → 撞车
    { beat: 3, type: 4, x: 0 },   // 同车道 Drag → 合法
  ]);
  writeChart(path.join(d4, 'chart.json'), c4);
  fs.writeFileSync(path.join(d4, 'info.yml'), 'name: t\ndifficulty: 13\nchart: chart.json\nmusic: song.mp3\nillustration: background.png\n');
  const v4 = await call('phira_validate', { path: d4 });
  check('phira_validate(长条撞键)', v4.includes('hold-collision') || v4.includes('同车道') ? 'OK' : 'FAIL: ' + v4.slice(0, 120));
  const a4 = await call('phira_analyze', { path: d4 });
  check('phira_analyze(长条撞键)', a4.includes('长条与按键撞车') ? 'OK' : 'FAIL: ' + a4.slice(0, 120));
}

const pf = await call('phira_preview_frame', { path: tmp, time: 20, width: 640 });
check('phira_preview_frame', pf.includes('.png') ? 'OK' : 'FAIL: ' + pf.slice(0, 80));

console.log('冒烟测试：');
let bad = 0;
for (const [n, r] of check === null ? [] : results) { console.log(`  ${r === 'OK' ? '✅' : '❌'} ${n}  ${r === 'OK' ? '' : r}`); if (r !== 'OK') bad++; }
console.log(bad ? `\n${bad} 项失败` : '\n全部通过');

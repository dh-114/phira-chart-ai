/**
 * 特效/着色器检查：解析 extra.json、10 个内置 shader、自定义 /file.glsl、渲染生效。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { makeBpm, normalizeChart, toTriple } from '../lib/rpe.js';
import { parseExtra, applyEffect, applyEffects, PRESET_NAMES, evalVar } from '../lib/effects.js';
import { renderFrame } from '../lib/render.js';
import { emptyChart } from '../lib/rpe.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir ? os.tmpdir() : '/tmp', 'phira-fx-'));
const results = [];
const check = (n, ok, d = '') => results.push({ n, ok, d });

// 1) 全部内置着色器都能应用到像素上
const surf = { w: 16, h: 16, data: new Uint8ClampedArray(16 * 16 * 4) };
for (let y = 0; y < 16; y++) {
  for (let x = 0; x < 16; x++) {
    const i = (y * 16 + x) * 4;
    surf.data[i] = 40 + x * 12;
    surf.data[i + 1] = 30 + y * 12;
    surf.data[i + 2] = 20 + ((x * 7 + y * 3) % 200);
    surf.data[i + 3] = 255;
  }
}
const before = Uint8ClampedArray.from(surf.data);
for (const name of PRESET_NAMES) {
  surf.data.set(before);
  applyEffect(surf, name, { factor: 1, power: 0.5, size: 4, radius: 15, extend: 0.25, rate: 1, speed: 5, blockCount: 4, seed: 1, progress: 0.5, centerX: 0.5, centerY: 0.5, width: 0.1, distortion: 0.8, expand: 10, sampleCount: 4, color: [0, 0, 0, 1] }, 1.0);
  const changed = surf.data.some((v, i) => v !== before[i]);
  check(`shader ${name} 生效`, changed);
}

// 2) grayscale 数值正确性
surf.data.set(before);
applyEffect(surf, 'grayscale', { factor: 1 }, 0);
const g = 0.299 * before[0] + 0.587 * before[1] + 0.114 * before[2];
check('grayscale 结果≈亮度', Math.abs(surf.data[0] - g) < 3, `${surf.data[0]} vs ${g.toFixed(1)}`);

// 3) extra.json 解析：拍→秒 + 未知 shader 报错 + 自定义文件
const chartDir = path.join(dir, 'chart');
fs.mkdirSync(chartDir, { recursive: true });
const chart = emptyChart({ bpm: 120 });
const bpm = makeBpm(chart.BPMList);
const eff = (shader) => ({ shader, start: [0, 0, 1], end: [4, 0, 1], global: false, vars: { factor: 1 } });
fs.writeFileSync(path.join(chartDir, 'extra.json'), JSON.stringify({ bpm: 120, effects: [eff('grayscale')] }));
let r = parseExtra(chartDir, bpm);
check('extra.json 解析出 1 个特效', r.effects.length === 1 && r.errors.length === 0, JSON.stringify(r.errors));
check('拍→秒换算正确（4 拍 @120 = 2s）', Math.abs(r.effects[0].end - 2) < 1e-6, String(r.effects[0].end));

fs.writeFileSync(path.join(chartDir, 'extra.json'), JSON.stringify({ bpm: 120, effects: [eff('not-a-shader')] }));
r = parseExtra(chartDir, bpm);
check('未知 shader → error', r.errors.some((e) => e.code === 'effect-shader-unknown'));

fs.writeFileSync(path.join(chartDir, 'extra.json'), JSON.stringify({ bpm: 120, effects: [eff('/my.glsl')] }));
r = parseExtra(chartDir, bpm);
check('自定义 shader 缺文件 → error', r.errors.some((e) => e.code === 'effect-shader-file'));
fs.writeFileSync(path.join(chartDir, 'my.glsl'), 'uniform float factor; // %1.0%\nvoid main(){}');
r = parseExtra(chartDir, bpm);
check('自定义 shader 存在 → 通过', r.effects.length === 1 && r.effects[0].custom && r.errors.length === 0);

// 4) 渲染：同一谱面有/无特效像素不同
const norm = normalizeChart(chart);
const plain = renderFrame(norm, { aspectRatio: 16 / 9, lineLength: 6 }, 0.5, { width: 160, debug: false });
const grayscale = { shader: 'grayscale', start: 0, end: 99, global: false, vars: { factor: 1 } };
const fx = renderFrame(norm, { aspectRatio: 16 / 9, lineLength: 6 }, 0.5, { width: 160, debug: false, effects: [grayscale] });
const diff = plain.surface.data.some((v, i) => v !== fx.surface.data[i]);
check('渲染时特效生效', diff);
check('applyEffects 计数', applyEffects(fx.surface, [grayscale], 0.5) === 1);

// 6) vars 关键帧单位：拍三元组必须按 BPM 换成秒再求值（120bpm 下 1 拍=0.5s）
{
  const d2 = path.join(dir, 'vars');
  fs.mkdirSync(d2, { recursive: true });
  fs.writeFileSync(path.join(d2, 'extra.json'), JSON.stringify({
    bpm: 120,
    effects: [{
      shader: 'grayscale', start: [0, 0, 1], end: [8, 0, 1],
      vars: { factor: [{ startTime: [0, 0, 1], endTime: [2, 0, 1], start: 0, end: 1, easingType: 1 }] },
    }],
  }));
  const r2 = parseExtra(d2, makeBpm([{ bpm: 120, startTime: [0, 0, 1] }]));
  const f2 = r2.effects[0].vars.factor;
  check('vars 关键帧按秒求值（t=0.5s→0.5）', Math.abs(evalVar(f2, 0.5) - 0.5) < 1e-6, String(evalVar(f2, 0.5)));
  check('vars 关键帧按秒求值（t=1.0s→1）', Math.abs(evalVar(f2, 1) - 1) < 1e-6, String(evalVar(f2, 1)));

  // 7) 小数拍三元组必须报错（prpr 的 Triple 是 i32）
  fs.writeFileSync(path.join(d2, 'extra.json'), JSON.stringify({
    bpm: 120, effects: [{ shader: 'grayscale', start: [0.5, 0, 1], end: [8, 0, 1] }],
  }));
  const r3 = parseExtra(d2, makeBpm([{ bpm: 120, startTime: [0, 0, 1] }]));
  check('小数拍三元组 → error', r3.errors.some((e) => e.code === 'effect-triple-noninteger'));
}

// 5) evalVar：固定值 / 关键帧
check('evalVar 固定值', evalVar(0.3, 1) === 0.3);
const kf = [{ startTime: [0, 0, 1], endTime: [2, 0, 1], start: 0, end: 1, easingType: 1 }];
check('evalVar 关键帧插值', Math.abs(evalVar(kf, 1) - 0.5) < 1e-6, String(evalVar(kf, 1)));

// 8) 1px 线必须可见（曾经整条画不出来）
{
  const { Surface } = await import('../lib/raster.js');
  const s1 = new Surface(1920, 1080); s1.clear(0, 0, 0);
  s1.line(0, 540, 1920, 540, 1, [255, 0, 0], 1);
  let lit = 0;
  for (let x = 0; x < 1920; x++) if (s1.data[(540 * 1920 + x) * 4] > 10) lit++;
  check('1px 水平线可见', lit > 1900, lit + '/1920');
}

fs.rmSync(dir, { recursive: true, force: true });
console.log('特效/着色器检查：');
let bad = 0;
for (const x of results) { console.log(`  ${x.ok ? '✅' : '❌'} ${x.n}${x.ok ? '' : '  ' + x.d}`); if (!x.ok) bad++; }
console.log(bad ? `\n${bad} 项失败` : '\n全部通过');
process.exit(bad ? 1 : 0);

/**
 * Phira 后处理特效（extra.json / shaders）
 *
 * 源码依据（prpr）：
 * - 内置于 core/effect.rs：chromatic / circleBlur / fisheye / glitch / grayscale /
 *   noise / pixel / radialBlur / shockwave / vignette
 * - 每个着色器用 `uniform float xxx; // %默认值%` 声明 uniform（float / vec2 / vec4）
 * - extra.json：{ bpm, effects: [{ shader, start, end, global, vars }], videos: [] }
 * - `shader` 以 "/" 开头 → 从谱面包内加载 GLSL 文件（自定义着色器）
 *
 * 本模块：解析 extra.json（拍→秒）、按时间生效、在 JS 光栅器上近似实现 10 个内置特效。
 */
import fs from 'node:fs';
import path from 'node:path';
import { beats, makeBpm } from './rpe.js';

export const PRESETS = {
  grayscale: { factor: 1 },
  vignette: { color: [0, 0, 0, 1], extend: 0.25, radius: 15 },
  pixel: { size: 10 },
  chromatic: { sampleCount: 3, power: 0.01 },
  noise: { seed: 81, power: 0.03 },
  glitch: { power: 0.03, rate: 0.6, speed: 5, blockCount: 30.5, colorRate: 0.01 },
  fisheye: { power: -0.1 },
  circleBlur: { size: 10 },
  radialBlur: { centerX: 0.5, centerY: 0.5, power: 0.01, sampleCount: 6 },
  shockwave: { progress: 0.2, centerX: 0.5, centerY: 0.5, width: 0.1, distortion: 0.8, expand: 10 },
};

export const PRESET_NAMES = Object.keys(PRESETS);

const clamp01 = (v) => Math.max(0, Math.min(1, v));

/**
 * 解析 extra.json。返回 { effects: [{shader,start,end,global,vars}], warnings, errors }
 * bpmIdx 来自 makeBpm（用于把 start/end 的 [a,b,c] 拍三元组换算成秒）
 */
export function parseExtra(dir, bpmIdx) {
  const file = path.join(dir, 'extra.json');
  if (!fs.existsSync(file)) return { effects: [], warnings: [], errors: [], file };
  const warnings = [];
  const errors = [];
  let json;
  try { json = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    return { effects: [], warnings, errors: [{ code: 'extra-json-bad', msg: `extra.json 解析失败：${e.message}` }], file };
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return {
      effects: [], warnings,
      errors: [{ code: 'extra-json-shape', msg: `extra.json 必须是对象 { bpm, effects:[...] }，当前是 ${Array.isArray(json) ? 'array' : json === null ? 'null' : typeof json}` }],
      file,
    };
  }
  /**
   * extra.json 自己带 bpm（BpmForm）：effects 的 start/end 与关键帧 startTime/endTime
   * 必须用**它**换算成秒（prpr parse/extra.rs），与 chart.json 的 BPMList 无关。
   * 旧实现直接用 chart 的 bpm，多 BPM 曲子里特效时间点会整体错位。
   */
  const ownBpm = (() => {
    const form = json.bpm;
    if (typeof form === 'number' && Number.isFinite(form) && form > 0) {
      return makeBpm([{ bpm: form, startTime: [0, 0, 1] }], []);
    }
    if (Array.isArray(form) && form.length) {
      const list = form
        .filter((it) => it && Array.isArray(it.time) && Number.isFinite(Number(it.bpm)) && Number(it.bpm) > 0)
        .map((it) => ({ bpm: Number(it.bpm), startTime: it.time }));
      if (list.length) return makeBpm(list, []);
    }
    return null;
  })();
  const timeBase = ownBpm || bpmIdx;
  const toSec = (triple) => {
    const b = beats(triple);
    if (!Number.isFinite(b)) return null;
    return timeBase ? timeBase.at(b) : b; // 兼容：没有 bpm 索引时按拍=秒（仅供预览）
  };
  const isIntTriple = (v) => Array.isArray(v) && v.length === 3 && v.every((x) => Number.isInteger(x));
  const checkTriple = (v, where) => {
    if (!isIntTriple(v)) errors.push({ code: 'effect-triple-noninteger', msg: `${where} 的拍三元组必须是整数 [a,b,c]（prpr 用 i32），当前=${JSON.stringify(v)}` });
  };
  // prpr: BpmForm = Single(f64) | List([{ time: Triple, bpm }])
  // 写成 RPE 的 [{bpm,startTime}] 会让整个 extra.json 解析失败，必须拦下来。
  const bpmFormOk = (v) => (typeof v === 'number' && Number.isFinite(v))
    || (Array.isArray(v) && v.length > 0 && v.every((it) => it && isIntTriple(it.time) && Number.isFinite(Number(it.bpm))));
  if (!bpmFormOk(json.bpm)) {
    errors.push({
      code: 'extra-bpm-form',
      msg: `extra.json 的 bpm 必须是数字（常量）或 [{time:[a,b,c], bpm}]（prpr BpmForm）；`
        + `当前=${JSON.stringify(json.bpm)?.slice(0, 100)}。写成 RPE 的 startTime 形式会导致整张谱面加载失败`,
    });
  }
  /**
   * prpr 的取值形状（serde untagged，三选一，全部不匹配就**整张 extra.json 解析失败**）：
   *   Variable = Float(ExtAnim<f32>) | Vec2(ExtAnim<(f32,f32)>) | Color(ExtAnim<[u8;4]>)
   *   ExtAnim  = Default(null) | Fixed(V) | Keyframes([{easingLeft?, easingRight?, easingType, start, end, startTime, endTime}])
   * 特别注意 Color 是 u8：写 0~1 浮点（[0.02,0,0.1,1]）会让整谱打不开。
   */
  const bareVarType = (v) => {
    if (v == null) return 'default';                       // ExtAnim::Default（序列化成 null）
    if (typeof v === 'number') return Number.isFinite(v) ? 'float' : null;
    if (!Array.isArray(v)) return null;
    if (v.length === 2 && v.every((x) => typeof x === 'number' && Number.isFinite(x))) return 'vec2';
    if (v.length === 4 && v.every((x) => Number.isInteger(x) && x >= 0 && x <= 255)) return 'color';
    return null;
  };
  const colorHint = '（prpr 的 Color 是 [u8;4]：必须是 0–255 整数。写成 0~1 浮点会让整个 extra.json 解析失败，谱面直接打不开）';
  // prpr: Variable = Float | Vec2 | Color([u8;4])，vec4 参数必须是 0–255 整数
  const varType = (v) => {
    if (typeof v === 'number' && Number.isFinite(v)) return 'float';
    if (Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === 'number')) return 'vec2';
    if (Array.isArray(v) && v.length === 4 && v.every((x) => Number.isInteger(x) && x >= 0 && x <= 255)) return 'color';
    return null;
  };
  if (json.effects != null && !Array.isArray(json.effects)) {
    errors.push({ code: 'extra-effects-shape', msg: 'extra.json 的 effects 必须是数组' });
  }
  const effects = [];
  for (let i = 0; i < (Array.isArray(json.effects) ? json.effects.length : 0); i++) {
    const e = json.effects[i] || {};
    checkTriple(e.start, `effects[${i}].start`);
    checkTriple(e.end, `effects[${i}].end`);
    const start = toSec(e.start);
    const end = toSec(e.end);
    if (start == null || end == null || end <= start) {
      errors.push({ code: 'effect-range', msg: `effects[${i}] 时间范围非法（start/end 需为 [a,b,c] 且 end>start）` });
      continue;
    }
    if (typeof e.shader !== 'string' || !e.shader) {
      errors.push({ code: 'effect-shader', msg: `effects[${i}].shader 缺失` });
      continue;
    }
    const custom = e.shader.startsWith('/');
    const preset = PRESETS[e.shader];
    if (!custom && !preset) {
      errors.push({ code: 'effect-shader-unknown', msg: `effects[${i}].shader=${e.shader} 不是内置着色器（${PRESET_NAMES.join('/')}），也不是 / 开头的自定义文件` });
      continue;
    }
    if (custom) {
      const f = path.join(dir, e.shader.slice(1));
      if (!fs.existsSync(f)) errors.push({ code: 'effect-shader-file', msg: `effects[${i}].shader 指向 ${e.shader}，但目录里没有该文件` });
    }
    // vars：{ name: [event, ...] } → 逐帧求值成数字/数组
    const vars = {};
    const base = custom ? {} : preset;
    for (const k of Object.keys(base)) vars[k] = base[k];
    for (const [name, evs] of Object.entries(e.vars || {})) {
      // prpr 的 ExtAnim 允许 Fixed（裸数字/颜色）与 Default（null），不必强制关键帧数组
      const isKfList = Array.isArray(evs) && evs.length > 0 && evs.every((x) => x && typeof x === 'object' && !Array.isArray(x));
      if (!isKfList) {
        const t = bareVarType(evs);
        if (!t) {
          errors.push({
            code: 'effect-var-type',
            msg: `effects[${i}].vars.${name} = ${JSON.stringify(evs)} 不匹配 prpr 的 Float/Vec2/Color 任一形状`
              + (Array.isArray(evs) && evs.length === 4 ? colorHint : '（Float=数字；Vec2=[数,数]；Color=[0–255 整数×4]；关键帧=对象数组）'),
          });
          continue;
        }
        vars[name] = evs;
        continue;
      }
      if (!Array.isArray(evs)) { warnings.push({ code: 'effect-var', msg: `effects[${i}].vars.${name} 类型不支持，已忽略` }); continue; }
      // 关键帧时间：拍三元组 → 秒（与 effect 的 start/end 同一时间基）
      const conv = (v) => {
        const b = beats(v);
        if (!Number.isFinite(b)) return null;
        return timeBase ? timeBase.at(b) : b;
      };
      let kfVarType = null;
      for (const kf of evs) {
        if (kf && typeof kf === 'object' && Array.isArray(kf.startTime)) {
          const st = conv(kf.startTime), et = conv(kf.endTime);
          if (st == null || et == null) {
            errors.push({ code: 'effect-var-time', msg: `effects[${i}].vars.${name} 的关键帧时间非法` });
            continue;
          }
          kf.__st = st; kf.__et = et;
          const a = varType(kf.start), b = varType(kf.end);
          if (!a || !b) {
            errors.push({
              code: 'effect-var-type',
              msg: `effects[${i}].vars.${name} 的关键帧值 ${JSON.stringify(kf.start)} 不匹配 Float/Vec2/Color 任一类型`
                + (Array.isArray(kf.start) && kf.start.length === 4 ? colorHint : ''),
            });
          } else if (a !== b) {
            errors.push({ code: 'effect-var-type', msg: `effects[${i}].vars.${name} 关键帧 start=${a} 与 end=${b} 类型不一致` });
          } else if (kf.easingType == null || !Number.isInteger(Number(kf.easingType))) {
            errors.push({ code: 'effect-var-kf', msg: `effects[${i}].vars.${name} 的关键帧缺少整数 easingType（prpr 里是必填 i32）` });
          }
          // untagged 只挑一个 V：同一数组里不能混 Float/Vec2/Color
          if (a && kfVarType && a !== kfVarType) {
            errors.push({ code: 'effect-var-mixed', msg: `effects[${i}].vars.${name} 的关键帧混用了 ${kfVarType} 与 ${a}（prpr 要求整组同一类型）` });
          }
          if (a && !kfVarType) kfVarType = a;
        }
      }
      vars[name] = evs;
    }
    // vignette 的引擎公式：vig = (u(1-u)v(1-v)*radius)^extend，mix(color, screen, vig)
    // u(1-u)v(1-v) 最大 = 1/16 → radius > 16 时 vig > 1，画面中心会被"提亮"（过曝/闪烁）
    if (e.shader === 'vignette') {
      const r = Number((e.vars || {}).radius);
      if (Number.isFinite(r) && r > 16) {
        warnings.push({
          code: 'fx-vignette-radius',
          msg: `effects[${i}].vars.radius=${r}：引擎里 vig=(u(1-u)v(1-v)*radius)^extend，radius>16 时中心 vig>1，`
            + '会整屏提亮、看着像在闪（参考值 15，最大别超 16）',
        });
      }
    }
    effects.push({ shader: e.shader, custom, start, end, global: !!e.global, vars });
  }
  return { effects, warnings, errors, file, bpm: ownBpm };
}

/** 求值一个 uniform：数字 / 数组 / 事件数组（RPE 语义：保持 + 区间插值） */
export function evalVar(v, t) {
  if (typeof v === 'number') return v;
  if (Array.isArray(v) && v.length && v[0] && typeof v[0] === 'object' && v[0].startTime) {
    const list = v;
    let last = null;
    for (const e of list) {
      const st = e.__st != null ? e.__st : beats(e.startTime);
      const et = e.__et != null ? e.__et : beats(e.endTime);
      if (st <= t) last = { st, et, start: e.start, end: e.end, ez: e.easingType || 1 };
    }
    if (!last) return 0;
    if (t <= last.et && last.et > last.st) {
      const k = clamp01((t - last.st) / (last.et - last.st));
      return lerpValue(last.start, last.end, k);
    }
    return last.end;
  }
  if (Array.isArray(v)) return v.map((x) => evalVar(x, t));
  return 0;
}

function lerpValue(a, b, k) {
  if (typeof a === 'number' && typeof b === 'number') return a + (b - a) * k;
  if (Array.isArray(a) && Array.isArray(b)) return a.map((x, i) => x + ((b[i] ?? x) - x) * k);
  return b;
}

/* ---------------- 10 个内置着色器的 JS 近似实现 ---------------- */

function srcCopy(surf) { return new Uint8ClampedArray(surf.data); }

export function applyEffect(surf, name, vars, t) {
  const d = surf.data, w = surf.w, h = surf.h;
  if (!w || !h) return;
  switch (name) {
    case 'grayscale': {
      const f = clamp01(evalVar(vars.factor, t));
      for (let i = 0; i < d.length; i += 4) {
        const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        d[i] += (g - d[i]) * f;
        d[i + 1] += (g - d[i + 1]) * f;
        d[i + 2] += (g - d[i + 2]) * f;
      }
      break;
    }
    case 'vignette': {
      // 严格按 prpr `core/shaders/vignette.glsl`：
      //   vec2 new_uv = uv * (1.0 - uv.yx);
      //   float vig = new_uv.x * new_uv.y * radius;
      //   vig = pow(vig, extend);
      //   gl_FragColor = mix(color, texture, vig);
      // 旧实现写成了一个完全不同的径向渐变（radius/100、extend 当偏移、^1.5），
      // 默认参数下预览会把整屏压黑，和实机差得很远。
      // 缺省参数用 shader 注释里的默认值（`// %0,0,0,1%` / `// %0.25%` / `// %15%`）；
      // 直接传 {} 时 evalVar 会返回 0，不能把 0 当成"用户设的值"（pow(0,0)=1 会让特效静默失效）
      const dv = PRESETS.vignette;
      const rawCol = vars.color === undefined ? dv.color : evalVar(vars.color, t);
      const col = Array.isArray(rawCol) && rawCol.length >= 3 ? rawCol : dv.color;
      const rawR = vars.radius === undefined ? dv.radius : evalVar(vars.radius, t);
      const rawE = vars.extend === undefined ? dv.extend : evalVar(vars.extend, t);
      const r0 = Number.isFinite(Number(rawR)) ? Number(rawR) : dv.radius;
      const e0 = Number.isFinite(Number(rawE)) ? Number(rawE) : dv.extend;
      const cr = Number(col[0]) || 0, cg = Number(col[1]) || 0, cb = Number(col[2]) || 0;
      const ca = Number.isFinite(Number(col[3])) ? Number(col[3]) / 255 : 1;
      for (let y = 0; y < h; y++) {
        const v = (y + 0.5) / h;
        for (let x = 0; x < w; x++) {
          const u = (x + 0.5) / w;
          let vig = u * (1 - v) * v * (1 - u) * r0;
          vig = Math.pow(Math.max(0, vig), e0);
          if (!Number.isFinite(vig)) vig = 0;
          vig = Math.max(0, Math.min(1, vig));
          const i = (y * w + x) * 4;
          d[i] = cr * (1 - vig) + d[i] * vig;
          d[i + 1] = cg * (1 - vig) + d[i + 1] * vig;
          d[i + 2] = cb * (1 - vig) + d[i + 2] * vig;
          d[i + 3] = Math.round((ca * (1 - vig) + (d[i + 3] / 255) * vig) * 255);
        }
      }
      break;
    }
    case 'pixel': {
      const size = Math.max(1, Math.round(evalVar(vars.size, t)));
      const s = srcCopy(surf);
      for (let y = 0; y < h; y += size) {
        for (let x = 0; x < w; x += size) {
          const i = (y * w + x) * 4;
          for (let yy = y; yy < Math.min(h, y + size); yy++) {
            for (let xx = x; xx < Math.min(w, x + size); xx++) {
              const j = (yy * w + xx) * 4;
              d[j] = s[i]; d[j + 1] = s[i + 1]; d[j + 2] = s[i + 2];
            }
          }
        }
      }
      break;
    }
    case 'chromatic': {
      const p = Math.max(0, Number(evalVar(vars.power, t)));
      const off = Math.round(p * w);
      if (!off) break;
      const s = srcCopy(surf);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          const xr = Math.min(w - 1, x + off), xb = Math.max(0, x - off);
          d[i] = s[(y * w + xr) * 4];
          d[i + 2] = s[(y * w + xb) * 4 + 2];
        }
      }
      break;
    }
    case 'noise': {
      const p = Math.max(0, Number(evalVar(vars.power, t)));
      const seed = Number(evalVar(vars.seed, t)) || 81;
      const frame = Math.floor(t * 24);
      for (let i = 0; i < d.length; i += 4) {
        const n = (Math.sin((i * 12.9898 + seed + frame * 78.233) * 0.5) * 43758.5453) % 1;
        const v = (n - Math.floor(n) - 0.5) * 255 * p;
        d[i] += v; d[i + 1] += v; d[i + 2] += v;
      }
      break;
    }
    case 'glitch': {
      const power = Number(evalVar(vars.power, t));
      const rate = clamp01(evalVar(vars.rate, t));
      const speed = Number(evalVar(vars.speed, t)) || 5;
      const blocks = Math.max(2, Math.round(evalVar(vars.blockCount, t)));
      const seed = Math.floor(t * speed);
      const on = ((Math.sin(seed * 12.9898) * 43758.5453) % 1 + 1) % 1 < rate;
      if (!on) break;
      const s = srcCopy(surf);
      const bh = Math.max(1, Math.floor(h / blocks));
      for (let b = 0; b < blocks; b++) {
        const rnd = ((Math.sin((seed + b) * 78.233) * 43758.5453) % 1 + 1) % 1;
        const shift = Math.round((rnd - 0.5) * 2 * power * w);
        for (let y = b * bh; y < Math.min(h, (b + 1) * bh); y++) {
          for (let x = 0; x < w; x++) {
            const sx = ((x + shift) % w + w) % w;
            const i = (y * w + x) * 4, j = (y * w + sx) * 4;
            d[i] = s[j]; d[i + 1] = s[j + 1]; d[i + 2] = s[j + 2];
          }
        }
      }
      break;
    }
    case 'fisheye': {
      const p = Number(evalVar(vars.power, t));
      const cx = 0.5, cy = 0.5;
      const s = srcCopy(surf);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const u = x / w, v = y / h;
          const dx = u - cx, dy = v - cy;
          const r = Math.hypot(dx, dy);
          const nr = Math.pow(r, 1 + p * 4);
          const k = r > 1e-6 ? nr / r : 1;
          const su = clamp01(cx + dx * k), sv = clamp01(cy + dy * k);
          const sx = Math.round(su * (w - 1)), sy = Math.round(sv * (h - 1));
          const i = (y * w + x) * 4, j = (sy * w + sx) * 4;
          d[i] = s[j]; d[i + 1] = s[j + 1]; d[i + 2] = s[j + 2];
        }
      }
      break;
    }
    case 'circleBlur': {
      const size = Math.max(1, Math.round(Number(evalVar(vars.size, t)) / 2));
      const s = srcCopy(surf);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let r = 0, g = 0, b = 0, n = 0;
          for (let yy = -size; yy <= size; yy += Math.max(1, size >> 1)) {
            for (let xx = -size; xx <= size; xx += Math.max(1, size >> 1)) {
              const px = Math.min(w - 1, Math.max(0, x + xx)), py = Math.min(h - 1, Math.max(0, y + yy));
              const j = (py * w + px) * 4;
              r += s[j]; g += s[j + 1]; b += s[j + 2]; n++;
            }
          }
          const i = (y * w + x) * 4;
          d[i] = r / n; d[i + 1] = g / n; d[i + 2] = b / n;
        }
      }
      break;
    }
    case 'radialBlur': {
      const cx = Number(evalVar(vars.centerX, t)) * w;
      const cy = Number(evalVar(vars.centerY, t)) * h;
      const power = Number(evalVar(vars.power, t));
      const count = Math.max(2, Math.min(16, Math.round(evalVar(vars.sampleCount, t))));
      const s = srcCopy(surf);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const dx = (x - cx) / w, dy = (y - cy) / h;
          let r = 0, g = 0, b = 0;
          for (let k = 0; k < count; k++) {
            const f = 1 - (k / count) * Math.min(1, power * 40);
            const px = Math.min(w - 1, Math.max(0, Math.round(cx + (x - cx) * f)));
            const py = Math.min(h - 1, Math.max(0, Math.round(cy + (y - cy) * f)));
            const j = (py * w + px) * 4;
            r += s[j]; g += s[j + 1]; b += s[j + 2];
          }
          const i = (y * w + x) * 4;
          d[i] = r / count; d[i + 1] = g / count; d[i + 2] = b / count;
        }
      }
      break;
    }
    case 'shockwave': {
      const progress = clamp01(evalVar(vars.progress, t));
      const cx = Number(evalVar(vars.centerX, t)) * w;
      const cy = Number(evalVar(vars.centerY, t)) * h;
      const width = Number(evalVar(vars.width, t)) || 0.1;
      const distortion = Number(evalVar(vars.distortion, t));
      const expand = Number(evalVar(vars.expand, t)) || 10;
      const radius = progress * expand * 0.1 * Math.hypot(w, h);
      const s = srcCopy(surf);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const dx = x - cx, dy = y - cy;
          const dist = Math.hypot(dx, dy);
          const band = Math.abs(dist - radius) / (width * 40 + 1);
          let su = x, sv = y;
          if (band < 1) {
            const k = (1 - band) * distortion * 10;
            su = x + (dx / (dist + 1e-3)) * k;
            sv = y + (dy / (dist + 1e-3)) * k;
          }
          const px = Math.min(w - 1, Math.max(0, Math.round(su)));
          const py = Math.min(h - 1, Math.max(0, Math.round(sv)));
          const i = (y * w + x) * 4, j = (py * w + px) * 4;
          d[i] = s[j]; d[i + 1] = s[j + 1]; d[i + 2] = s[j + 2];
        }
      }
      break;
    }
    default:
      break; // 自定义 GLSL 无法在 JS 里执行，预览时跳过（谱面在 Phira 里仍生效）
  }
}

/** 应用所有在 t 时刻生效的特效（按数组顺序） */
export function applyEffects(surf, effects, t) {
  let applied = 0;
  for (const e of effects || []) {
    if (t < e.start || t > e.end) continue;
    if (e.custom) { applied++; continue; } // 自定义 GLSL：预览跳过
    applyEffect(surf, e.shader, e.vars, t);
    applied++;
  }
  return applied;
}

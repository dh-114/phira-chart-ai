/**
 * 编排类工具注册：加音符 / 加事件 / 加判定线 / 手法生成 / AI 水印 / 元数据 / MIDI
 */
import fs from 'node:fs';
import path from 'node:path';
import { normalizeChart } from './rpe.js';
import { validate } from './validate.js';
import {
  addLine, addNotes, addEvents, applyPattern, applyAIMark, writeChart, writeInfo, bpmIndex, fixEventOverlaps } from './author.js';
import { parseMidi, midiToChartNotes } from './midi.js';
import { toJsonSchema } from './schema.js';
import { PRESET_NAMES } from './effects.js';
import { beats, toTriple } from './rpe.js';

const DEN = 192;
import { planChart, materializePlan, fmtPlan, chordCap, scalePlanDensity } from './plan.js';
import { predictDifficulty } from './analyze.js';
import { STYLES, STYLE_NAMES } from './styles.js';

const text = (s) => [{ type: 'text', text: String(s) }];

/**
 * prpr 的 extra.json 用 BpmForm：Single(f64) | List([{ time: Triple, bpm }])。
 * RPE 的 BPMList 是 [{ bpm, startTime }]，字段名不同 —— 直接写进去会让整个
 * extra.json 解析失败（data did not match any variant of untagged enum BpmForm）。
 */
export function bpmFormOf(bpmList, fallbackBpm = 120) {
  const list = (Array.isArray(bpmList) ? bpmList : []).filter((b) => b && Number.isFinite(Number(b.bpm)));
  if (!list.length) return Number(fallbackBpm);
  if (list.length === 1) return Number(list[0].bpm);
  return list.map((b) => {
    const t = Array.isArray(b.startTime) ? b.startTime : (Array.isArray(b.time) ? b.time : [0, 0, 1]);
    return { time: t.map(Number), bpm: Number(b.bpm) };
  });
}

/** 把已写坏的 bpm（RPE startTime 形式 / 空值）修成合法 BpmForm */
export function normalizeBpmForm(bpm, bpmList, fallbackBpm = 120) {
  if (typeof bpm === 'number' && Number.isFinite(bpm)) return bpm;
  if (Array.isArray(bpm) && bpm.length
    && bpm.every((it) => it && Array.isArray(it.time) && it.time.length === 3 && Number.isFinite(Number(it.bpm)))) {
    return bpm.map((it) => ({ time: it.time.map(Number), bpm: Number(it.bpm) }));
  }
  return bpmFormOf(bpmList, fallbackBpm);
}

export function registerEditorTools(ctx, helpers) {
  const { loadTarget, text: textFn } = helpers;
  const registerTool = (ctx, def) => ctx.tools.register({ ...def, parameters: toJsonSchema(def.parameters) });
  const T = textFn || text;

  /** 保存并返回校验摘要 */
  function commit(t, chart, extra) {
    writeChart(t.chartFile, chart);
    const r = validate(normalizeChart(chart), {});
    const bad = r.issues.filter((i) => i.level === 'error').slice(0, 5);
    const warn = r.issues.filter((i) => i.level === 'warn').slice(0, 3);
    const lines = [extra || '', `已写入：${t.chartFile}`,
      `校验：${r.counts.errors} error / ${r.counts.warnings} warning / ${r.counts.infos} info`,
      `统计：音符 ${r.stats.notes}，判定线 ${r.stats.lines}，事件 ${r.stats.events}，最大同刻 ${r.stats.maxChord}`];
    if (bad.length) lines.push('', '错误：', ...bad.map((i) => `  ${i.msg}`));
    if (warn.length) lines.push('', '警告：', ...warn.map((i) => `  ${i.msg}`));
    return lines.join('\n');
  }

  registerTool(ctx, {
    name: 'phira_chart_add_notes',
    description: '向指定判定线批量添加音符。时间可用 beat（拍）或 sec（秒）。Hold 需 endBeat。'
      + 'type: 1 Tap / 2 Hold / 3 Flick / 4 Drag；x 为 RPE 像素（±675）；fake=1 为装饰假音符。',
    parameters: {
      path: { type: 'string', required: true, description: '谱面目录或 chart.json' },
      line: { type: 'number', description: '判定线索引，默认 0' },
      notes: {
        type: 'array',
        required: true,
        description: '音符数组，元素形如 {"beat":4,"type":1,"x":-200} 或 {"sec":12.5,"type":2,"x":0,"endBeat":14}',
        items: { type: 'object' },
      },
    },
    output: { schema: { type: 'string' }, render: (a, v) => T(v) },
    async execute(args) {
      const t = loadTarget(args && args.path);
      const chart = JSON.parse(fs.readFileSync(t.chartFile, 'utf8'));
      const n = addNotes(chart, args && args.line != null ? Number(args.line) : 0, args && args.notes);
      return commit(t, chart, `已添加 ${n} 个音符（线 ${args && args.line != null ? args.line : 0}）`);
    },
  });

  registerTool(ctx, {
    name: 'phira_chart_add_events',
    description: '向判定线添加事件。key: moveX / moveY / rotate / alpha / speed / scaleX / scaleY / color / text / incline。'
      + '普通事件用 startBeat/endBeat + from/to（或 value）；color 用 [r,g,b]。',
    parameters: {
      path: { type: 'string', required: true, description: '谱面目录或 chart.json' },
      line: { type: 'number', description: '判定线索引，默认 0' },
      key: { type: 'string', required: true, description: '事件类型', enum: ['moveX', 'moveY', 'rotate', 'alpha', 'speed', 'scaleX', 'scaleY', 'color', 'text', 'incline'] },
      layer: { type: 'number', description: '事件层（0-4），默认 0' },
      events: { type: 'array', required: true, description: '[{"startBeat":0,"endBeat":4,"from":0,"to":300,"easing":4}]', items: { type: 'object' } },
    },
    output: { schema: { type: 'string' }, render: (a, v) => T(v) },
    async execute(args) {
      const t = loadTarget(args && args.path);
      const chart = JSON.parse(fs.readFileSync(t.chartFile, 'utf8'));
      const n = addEvents(chart, args && args.line != null ? Number(args.line) : 0, args && args.key, args && args.events, args && args.layer != null ? Number(args.layer) : 0);
      const clipped = fixEventOverlaps(chart);
      return commit(t, chart, (clipped ? `已自动收口 ${clipped} 处区间重叠事件；` : '') + `已添加 ${n} 个 ${args && args.key} 事件`);
    },
  });

  registerTool(ctx, {
    name: 'phira_chart_add_line',
    description: '新增一条判定线（默认带 RPE 样板字段）。x/y 为 RPE 像素（x±675、y±450），rot 为角度。',
    parameters: {
      path: { type: 'string', required: true, description: '谱面目录或 chart.json' },
      name: { type: 'string', description: '线名' },
      x: { type: 'number', description: '初始 X（RPE 像素）' },
      y: { type: 'number', description: '初始 Y（RPE 像素）' },
      rot: { type: 'number', description: '初始旋转（度）' },
      zOrder: { type: 'number', description: '层级 zOrder' },
      attachUI: { type: 'string', description: '绑定 UI（pause/combonumber/combo/score/bar/name/level）' },
    },
    output: { schema: { type: 'string' }, render: (a, v) => T(v) },
    async execute(args) {
      const t = loadTarget(args && args.path);
      const chart = JSON.parse(fs.readFileSync(t.chartFile, 'utf8'));
      const idx = addLine(chart, {
        name: (args && args.name) || 'AI Line',
        x: args && args.x, y: args && args.y, rot: args && args.rot,
        zOrder: args && args.zOrder, attachUI: args && args.attachUI,
      });
      return commit(t, chart, `已新增判定线 #${idx}`);
    },
  });

  registerTool(ctx, {
    name: 'phira_chart_apply_pattern',
    description: '按参数生成一段手法。pattern 可选：stairs / trill / jack / chord / hold / holdInner / holdMelody / tapDragChain / '
      + 'mirrorLines / belowDrag / dualLines / crossLines / holdFlick / fakePulse / holdFlickMelody / sweep / vertical / fourSide / freeze。'
      + 'params 例：{"line":0,"startBeat":8,"count":8,"stepBeat":0.5,"x0":-300,"x1":300}。'
      + 'x 会统一夹到 ±660（|x|>675 是出界，引擎坐标 = positionX/675）。',
    parameters: {
      path: { type: 'string', required: true, description: '谱面目录或 chart.json' },
      pattern: {
        type: 'string', required: true,
        enum: ['stairs', 'trill', 'jack', 'chord', 'hold', 'holdInner', 'holdMelody', 'tapDragChain', 'mirrorLines', 'belowDrag',
          'dualLines', 'crossLines', 'holdFlick', 'fakePulse', 'holdFlickMelody', 'sweep', 'vertical', 'fourSide', 'freeze'],
        description: '手法名',
      },
      params: { type: 'object', description: '手法参数（line/startBeat/count/stepBeat/x0/x1/...）' },
    },
    output: { schema: { type: 'string' }, render: (a, v) => T(v) },
    async execute(args) {
      const t = loadTarget(args && args.path);
      const chart = JSON.parse(fs.readFileSync(t.chartFile, 'utf8'));
      const r = applyPattern(chart, args && args.pattern, (args && args.params) || {});
      return commit(t, chart, `手法 ${args.pattern} 完成：新增音符 ${r.notes}${r.lines ? `，新增判定线 ${r.lines} 条` : ''}`);
    },
  });

  registerTool(ctx, {
    name: 'phira_chart_ai_mark',
    description: '写入「由 AI 生成」水印：一条只显示文字、不放音符的判定线（默认 0–6 拍、y=-420）。',
    parameters: {
      path: { type: 'string', required: true, description: '谱面目录或 chart.json' },
      text: { type: 'string', description: '水印文字，默认「本谱面由 AI 生成」' },
      startBeat: { type: 'number', description: '开始拍，默认 0' },
      endBeat: { type: 'number', description: '结束拍，默认 6' },
    },
    output: { schema: { type: 'string' }, render: (a, v) => T(v) },
    async execute(args) {
      const t = loadTarget(args && args.path);
      const chart = JSON.parse(fs.readFileSync(t.chartFile, 'utf8'));
      const idx = applyAIMark(chart, {
        text: (args && args.text) || '本谱面由 AI 生成',
        startBeat: args && args.startBeat != null ? Number(args.startBeat) : 0,
        endBeat: args && args.endBeat != null ? Number(args.endBeat) : 6,
      });
      // 同时写 info.yml 的 AI 标识
      const infoPath = path.join(t.dir, 'info.yml');
      const charter = (t.info && t.info.charter) || 'AI';
      const MARK = '本谱面由 AI 生成';
      const oldIntro = (t.info && t.info.intro) || '';
      const oldTags = Array.isArray(t.info && t.info.tags) ? t.info.tags : [];
      writeInfo(infoPath, {
        charter: charter.includes('(AI)') ? charter : `${charter} (AI)`,
        tags: oldTags.includes('AI生成') ? oldTags : oldTags.concat('AI生成'),
        // 幂等：已包含标识就不再追加（原来每调一次都会重复拼接）
        intro: oldIntro.includes(MARK) ? oldIntro : (oldIntro ? `${oldIntro} / ${MARK}` : MARK),
      });
      return commit(t, chart, `已写入 AI 水印线 #${idx}，并更新 info.yml 的 charter/tags/intro`);
    },
  });

  registerTool(ctx, {
    name: 'phira_chart_add_effect',
    description: '写入后处理特效（extra.json）。shader 可用内置 10 种之一（grayscale/vignette/pixel/chromatic/noise/glitch/fisheye/circleBlur/radialBlur/shockwave），或 "/xxx.glsl" 引用自定义着色器。'
      + 'startBeat/endBeat 为拍；vars 支持数字（Float）、[x,y]（Vec2）、[r,g,b,a]（Color）或关键帧数组。'
      + '【颜色必须是 0–255 整数（prpr 的 [u8;4]）；写成 0~1 浮点会被自动 ×255 换算】——'
      + '写错会让整个 extra.json 解析失败、谱面直接打不开（data did not match any variant of untagged enum Variable）。',
    parameters: {
      path: { type: 'string', required: true, description: '谱面目录或 chart.json' },
      effects: { type: 'array', description: '特效数组', items: { type: 'object' } },
      replace: { type: 'boolean', description: 'true = 覆盖已有 effects（默认追加）' },
    },
    output: { schema: { type: 'string' }, render: (a, v) => T(v) },
    async execute(args) {
      const t = loadTarget(args && args.path);
      const chart = JSON.parse(fs.readFileSync(t.chartFile, 'utf8'));
      const extraPath = path.join(t.dir, 'extra.json');
      let extra = { bpm: bpmFormOf(chart.BPMList), effects: [], videos: [] };
      if (fs.existsSync(extraPath)) {
        try { extra = JSON.parse(fs.readFileSync(extraPath, 'utf8')); } catch { throw new Error('已有 extra.json 解析失败，请先修好或删除'); }
      }
      // prpr 的 BpmForm 只接受 Single(f64) 或 List([{time,bpm}])；
      // RPE 的 BPMList 是 [{bpm,startTime}]，字段名不同，直接写会让整个 extra.json 解析失败。
      extra.bpm = normalizeBpmForm(extra.bpm, chart.BPMList);
      if (!Array.isArray(extra.effects)) extra.effects = [];
      if (args && args.replace) extra.effects = [];
      /**
       * 把用户给的 vars 值规范化成 prpr 能解析的形状（untagged Float/Vec2/Color）：
       *  - null → Default
       *  - 数字 → Float
       *  - [x,y] → Vec2
       *  - 4 元素：整数 0–255 直接用；**0~1 浮点自动 ×255**（作者最常写错的地方，写错就是整个 extra.json 解析失败）
       * 其余直接报错，不要写进文件后才在游戏里炸。
       */
      const normVarValue = (v, where) => {
        if (v == null) return null;
        if (typeof v === 'number') {
          if (!Number.isFinite(v)) throw new Error(`${where}：数值非法 ${v}`);
          return v;
        }
        if (!Array.isArray(v)) throw new Error(`${where}：只能是数字 / [x,y] / [0-255]×4 / 关键帧数组`);
        if (v.length === 2 && v.every((x) => typeof x === 'number' && Number.isFinite(x))) return v;
        if (v.length === 4 && v.every((x) => typeof x === 'number' && Number.isFinite(x))) {
          if (v.every((x) => Number.isInteger(x) && x >= 0 && x <= 255)) return v;
          if (v.every((x) => x >= 0 && x <= 1)) return v.map((x) => Math.round(x * 255));
          throw new Error(`${where}：4 元素颜色必须是 0–255 整数（或统一写 0~1 浮点，我会自动换算），收到 ${JSON.stringify(v)}`);
        }
        throw new Error(`${where}：数组长度 ${v.length} 不合法（Vec2 要 2 个、Color 要 4 个；关键帧请用对象数组）`);
      };

      const bpm = bpmIndex(chart);
      const toTripleOrBeat = (v, fallback) => {
        const check = (t) => {
          if (!Array.isArray(t) || t.length !== 3 || !t.every((x) => Number.isInteger(x))) {
            throw new Error(`拍三元组必须是整数 [a,b,c]（prpr 用 i32/u32，浮点会让整张 extra.json 解析失败）：${JSON.stringify(t)}`);
          }
          if (t[1] < 0 || t[2] <= 0) throw new Error(`拍三元组范围非法（b≥0、c>0）：${JSON.stringify(t)}`);
          return t;
        };
        if (v == null) return check(toTriple(fallback, DEN));
        if (Array.isArray(v)) return check(v);
        return check(toTriple(Number(v), DEN));
      };
      for (const e of (args && args.effects) || []) {
        const shader = String(e.shader || '');
        const isCustom = shader.startsWith('/');
        if (!isCustom && !PRESET_NAMES.includes(shader)) {
          throw new Error(`未知 shader：${shader}；内置可用：${PRESET_NAMES.join('/')}，自定义用 "/文件名.glsl"`);
        }
        if (isCustom && !fs.existsSync(path.join(t.dir, shader.slice(1)))) {
          throw new Error(`自定义着色器文件不存在：${shader.slice(1)}（先用 phira_chart_add_shader 写入）`);
        }
        const startBeat = e.startBeat == null ? 0 : Number(e.startBeat);
        const endBeat = e.endBeat == null ? startBeat + 8 : Number(e.endBeat);
        if (endBeat <= startBeat) throw new Error('endBeat 必须大于 startBeat');
        const vars = {};
        for (const [k, v] of Object.entries(e.vars || {})) {
          const isKf = Array.isArray(v) && v.length > 0 && v.every((x) => x && typeof x === 'object' && !Array.isArray(x));
          if (!isKf) { vars[k] = normVarValue(v, `effects[${extra.effects.length}].vars.${k}`); continue; }
          if (Array.isArray(v)) {
            vars[k] = v.map((kf) => ({
              startTime: kf.startTime ? toTripleOrBeat(kf.startTime, startBeat) : toTriple(Number(kf.startBeat == null ? startBeat : kf.startBeat), DEN),
              endTime: kf.endTime ? toTripleOrBeat(kf.endTime, endBeat) : toTriple(Number(kf.endBeat == null ? endBeat : kf.endBeat), DEN),
              start: normVarValue(kf.start != null ? kf.start : kf.from, `effects[${extra.effects.length}].vars.${k}.start`),
              end: normVarValue(kf.end != null ? kf.end : kf.to, `effects[${extra.effects.length}].vars.${k}.end`),
              easingType: Number(kf.easing || kf.easingType || 1),
              easingLeft: 0, easingRight: 1,
            }));
          }
        }
        extra.effects.push({
          shader,
          start: toTripleOrBeat(e.start, startBeat),
          end: toTripleOrBeat(e.end, endBeat),
          global: !!e.global,
          vars,
        });
      }
      writeChart(extraPath, extra); // 原子写（同名函数复用）
      const r = validate(normalizeChart(chart), {});
      return `已写入 ${extraPath}\n特效数：${extra.effects.length}\n`
        + (r.counts.errors ? `注意：谱面本身有 ${r.counts.errors} 个 error\n` : '');
    },
  });

  registerTool(ctx, {
    name: 'phira_chart_add_shader',
    description: '写入自定义着色器文件（.glsl）。着色器需用 `uniform float/vec2/vec4 名字; // %默认值%` 声明参数，'
      + '然后在 phira_chart_add_effect 里用 "/文件名.glsl" 引用。',
    parameters: {
      path: { type: 'string', required: true, description: '谱面目录' },
      name: { type: 'string', required: true, description: '文件名（不用带 .glsl）' },
      source: { type: 'string', required: true, description: 'GLSL 源码（Phira 用 #version 100 风格，varying vec2 uv）' },
    },
    output: { schema: { type: 'string' }, render: (a, v) => T(v) },
    async execute(args) {
      const t = loadTarget(args && args.path);
      const name = String((args && args.name) || '').replace(/\.glsl$/i, '').replace(/[^\w.-]/g, '');
      if (!name) throw new Error('name 不能为空');
      const src = String((args && args.source) || '');
      if (!src.includes('void main')) throw new Error('源码缺少 void main()');
      for (const m of src.matchAll(/smoothstep\s*\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,/g)) {
        if (Number(m[1]) >= Number(m[2])) {
          throw new Error(`smoothstep 边界反序：smoothstep(${m[1]}, ${m[2]}, ...) —— GLSL 规定 edge0 < edge1，否则行为未定义`);
        }
      }
      const decls = [...src.matchAll(/uniform\s+(float|vec2|vec4)\s+(\w+)\s*;\s*\/\/\s*%([^%]*)%/g)];
      if (!decls.length) throw new Error('没有找到 `uniform 类型 名字; // %默认值%` 形式的参数声明');
      const file = path.join(t.dir, `${name}.glsl`);
      fs.writeFileSync(file, src);
      return `已写入 ${file}\n声明参数：\n` + decls.map((d) => `  ${d[1]} ${d[2]} 默认 ${d[3]}`).join('\n')
        + `\n下一步：phira_chart_add_effect(path, { effects: [{ shader: "/${name}.glsl", startBeat, endBeat }] })`;
    },
  });

  registerTool(ctx, {
    name: 'phira_chart_patch',
    description: '对已有谱面做局部修改（不必重建）。ops 支持：'
      + 'prune-empty（删空事件数组）/ sort-events（按时间排序）/ delete-notes（按条件删音符）/ '
      + 'update-notes（按条件改音符属性）/ clamp-x（把越界音符拉回边界）/ '
      + 'set-line（改判定线基线位置/旋转/透明度/流速）/ delete-line（删整条线）/ dedupe-events（同一开始时间去重）/ refresh-counts（重算 numOfNotes）。',
    parameters: {
      path: { type: 'string', required: true, description: '谱面目录或 chart.json' },
      ops: { type: 'array', description: '操作列表，按顺序执行', items: { type: 'object' } },
    },
    output: { schema: { type: 'string' }, render: (a, v) => T(v) },
    async execute(args) {
      const t = loadTarget(args && args.path);
      const chart = JSON.parse(fs.readFileSync(t.chartFile, 'utf8'));
      const lines = chart.judgeLineList || [];
      const log = [];
      const bpm = bpmIndex(chart);
      const toBeat = (v) => (Array.isArray(v) ? beats(v) : Number(v));

      // 音符筛选：line / fromBeat / toBeat / types / minX / maxX
      const matchNote = (n, op) => {
        if (op.types && op.types.length && !op.types.map(Number).includes(Number(n.type))) return false;
        const b = toBeat(n.startTime);
        if (op.fromBeat != null && b < Number(op.fromBeat)) return false;
        if (op.toBeat != null && b > Number(op.toBeat)) return false;
        const x = Number(n.positionX || 0);
        if (op.minX != null && x < Number(op.minX)) return false;
        if (op.maxX != null && x > Number(op.maxX)) return false;
        return true;
      };
      const eachLine = (li) => lines.map((l, i) => [l, i]).filter(([, i]) => li == null || i === li);
      const refresh = (l) => { l.numOfNotes = (l.notes || []).filter((x) => !x.isFake).length; };

      for (const op of (args && args.ops) || []) {
        const kind = op && op.op;
        if (kind === 'prune-empty') {
          let n = 0;
          for (const l of lines) {
            for (const ly of l.eventLayers || []) {
              for (const key of Object.keys(ly)) {
                if (Array.isArray(ly[key]) && ly[key].length === 0) { delete ly[key]; n++; }
              }
            }
          }
          log.push(`prune-empty：删除 ${n} 个空事件数组`);
        } else if (kind === 'sort-events') {
          let n = 0;
          const sortArr = (arr) => {
            if (!Array.isArray(arr) || arr.length < 2) return;
            // beats() 对非法三元组返回 NaN，NaN 比较器会让 sort 静默不排 → 把非法项排到末尾并计数
            const key = (e) => { const b = beats(e && e.startTime); return Number.isFinite(b) ? b : Infinity; };
            const sorted = [...arr].sort((a, b) => key(a) - key(b));
            if (sorted.some((v, i) => v !== arr[i])) { arr.length = 0; arr.push(...sorted); n++; }
          };
          for (const l of lines) {
            for (const ly of l.eventLayers || []) for (const key of Object.keys(ly)) sortArr(ly[key]);
            for (const key of Object.keys(l.extended || {})) sortArr(l.extended[key]);
          }
          log.push(`sort-events：排序 ${n} 个数组`);
        } else if (kind === 'dedupe-events') {
          let n = 0;
          const dedupe = (arr) => {
            if (!Array.isArray(arr) || arr.length < 2) return;
            const seen = new Set();
            const out = [];
            for (const e of arr) {
              const k = JSON.stringify(e.startTime);
              if (seen.has(k)) { n++; continue; }
              seen.add(k);
              out.push(e);
            }
            if (out.length !== arr.length) { arr.length = 0; arr.push(...out); }
          };
          for (const l of lines) {
            for (const ly of l.eventLayers || []) for (const key of Object.keys(ly)) dedupe(ly[key]);
          }
          log.push(`dedupe-events：删除 ${n} 个重复事件`);
        } else if (kind === 'delete-notes') {
          let n = 0;
          for (const [l] of eachLine(op.line == null ? null : Number(op.line))) {
            const before = (l.notes || []).length;
            l.notes = (l.notes || []).filter((nn) => !matchNote(nn, op));
            n += before - l.notes.length;
            refresh(l);
          }
          log.push(`delete-notes：删除 ${n} 个音符`);
        } else if (kind === 'update-notes') {
          let n = 0;
          const RESERVED = new Set(['op', 'line', 'fromBeat', 'toBeat', 'types', 'minX', 'maxX', 'set']);
          const inline = Object.fromEntries(Object.entries(op).filter(([k]) => !RESERVED.has(k)));
          const set = op.set || inline; // 兼容两种写法：op.set 或直接写在顶层
          for (const [l] of eachLine(op.line == null ? null : Number(op.line))) {
            for (const nn of l.notes || []) {
              if (!matchNote(nn, op)) continue;
              if (set.x != null) nn.positionX = Number(set.x);
              if (set.xShift != null) nn.positionX = Number(nn.positionX || 0) + Number(set.xShift);
              if (set.type != null) nn.type = Number(set.type);
              if (set.alpha != null) nn.alpha = Number(set.alpha);
              if (set.size != null) nn.size = Number(set.size);
              if (set.speed != null) nn.speed = Number(set.speed);
              if (set.fake != null) nn.isFake = set.fake ? 1 : 0;
              if (set.beatShift != null) {
                const b = toBeat(nn.startTime) + Number(set.beatShift);
                const eb = nn.endTime ? toBeat(nn.endTime) + Number(set.beatShift) : null;
                nn.startTime = toTriple(b, DEN);
                if (eb != null) nn.endTime = toTriple(Math.max(b, eb), DEN);
              }
              if (set.beat != null) {
                const b = Number(set.beat);
                const oldB = toBeat(nn.startTime);
                const eb = nn.endTime ? toBeat(nn.endTime) - oldB : null;
                nn.startTime = toTriple(b, DEN);
                if (eb != null) nn.endTime = toTriple(b + Math.max(0, eb), DEN);
              }
              if (set.endBeat != null && nn.endTime) nn.endTime = toTriple(Number(set.endBeat), DEN);
              n++;
            }
            refresh(l);
          }
          log.push(`update-notes：修改 ${n} 个音符`);
        } else if (kind === 'clamp-x') {
          const lim = Number(op.limit == null ? 600 : op.limit);
          let n = 0;
          for (const [l] of eachLine(op.line == null ? null : Number(op.line))) {
            for (const nn of l.notes || []) {
              const x = Number(nn.positionX || 0);
              if (Math.abs(x) > lim) { nn.positionX = Math.sign(x) * lim; n++; }
            }
          }
          log.push(`clamp-x：把 ${n} 个音符拉回 ±${lim}`);
        } else if (kind === 'set-line') {
          const li = Number(op.line == null ? 0 : op.line);
          const l = lines[li];
          if (!l) throw new Error(`没有第 ${li} 条判定线`);
          l.eventLayers = l.eventLayers && l.eventLayers.length ? l.eventLayers : [{}];
          const ly = l.eventLayers[0];
          const KEY = { x: 'moveXEvents', y: 'moveYEvents', rot: 'rotateEvents', alpha: 'alphaEvents', speed: 'speedEvents' };
          const mk = (v) => ({
            bezier: 0, bezierPoints: [0, 0, 0, 0], easingLeft: 0, easingRight: 1, easingType: 1,
            end: v, endTime: toTriple(1, DEN), linkgroup: 0, start: v, startTime: toTriple(0, DEN),
          });
          const applied = [];
          for (const k of Object.keys(KEY)) {
            if (op[k] == null) continue;
            ly[KEY[k]] = [mk(Number(op[k]))];
            applied.push(`${k}=${op[k]}`);
          }
          log.push(`set-line：L${li} ${applied.join(' ')}`);
        } else if (kind === 'refresh-counts') {
          let n = 0;
          for (const l of lines) {
            const real = (l.notes || []).filter((x) => !x.isFake).length;
            if (Number(l.numOfNotes) !== real) { l.numOfNotes = real; n++; }
          }
          log.push(`refresh-counts：更新 ${n} 条线的 numOfNotes`);
        } else if (kind === 'delete-line') {
          const li = Number(op.line);
          if (!Number.isInteger(li) || !lines[li]) throw new Error(`没有第 ${li} 条判定线`);
          const removed = (lines[li].notes || []).length;
          lines.splice(li, 1);
          // 修正 father 指向
          for (const l of lines) if (Number(l.father) > li) l.father = Number(l.father) - 1;
          log.push(`delete-line：删除 L${li}（含 ${removed} 个音符）`);
        } else {
          throw new Error(`未知 op：${kind}；可用 prune-empty / sort-events / dedupe-events / delete-notes / update-notes / clamp-x / set-line / delete-line`);
        }
      }
      writeChart(t.chartFile, chart);
      const r = validate(normalizeChart(chart), {});
      return [`已修补：${t.chartFile}`, ...log,
        `校验：${r.counts.errors} error / ${r.counts.warnings} warning / ${r.counts.infos} info`].join('\n');
    },
  });

  registerTool(ctx, {
    name: 'phira_chart_edit',
    description: '通用 JSON 编辑（最大自由度）：按点号路径直接改/删/加 RPE 谱面的任意字段，'
      + '包括工具没封装的字段（paintEvents / gifEvents / posControl / 任意扩展）。'
      + '路径示例：META.name、judgeLineList.0.notes.3.positionX、judgeLineList.0.extended.inclineEvents。'
      + 'op 支持 set / delete / append。改完自动校验。',
    parameters: {
      path: { type: 'string', required: true, description: '谱面目录或 chart.json' },
      ops: { type: 'array', description: '操作：[{op:"set", path, value}], [{op:"delete", path}], [{op:"append", path, value}]', items: { type: 'object' } },
    },
    output: { schema: { type: 'string' }, render: (a, v) => T(v) },
    async execute(args) {
      const t = loadTarget(args && args.path);
      const chart = JSON.parse(fs.readFileSync(t.chartFile, 'utf8'));
      const parsePath = (p) => String(p || '').split('.').filter((x) => x !== '').map((x) => (/^\d+$/.test(x) ? Number(x) : x));
      const log = [];
      for (const op of (args && args.ops) || []) {
        const segs = parsePath(op && op.path);
        if (!segs.length) throw new Error('path 不能为空');
        if (segs.some((x) => x === '__proto__' || x === 'constructor' || x === 'prototype')) {
          throw new Error('path 含非法字段名');
        }
        let parent = chart;
        for (let i = 0; i < segs.length - 1; i++) {
          const k = segs[i];
          if (parent == null || typeof parent !== 'object') throw new Error(`路径不可达：${segs.join('.')}`);
          if (!(k in parent) || parent[k] == null) parent[k] = typeof segs[i + 1] === 'number' ? [] : {};
          parent = parent[k];
        }
        const last = segs[segs.length - 1];
        if (op.op === 'delete') {
          if (Array.isArray(parent) && typeof last === 'number') parent.splice(last, 1);
          else delete parent[last];
          log.push(`delete ${segs.join('.')}`);
        } else if (op.op === 'append') {
          if (!Array.isArray(parent[last])) parent[last] = [];
          parent[last].push(op.value);
          log.push(`append ${segs.join('.')} (+1)`);
        } else {
          parent[last] = op.value;
          log.push(`set ${segs.join('.')} = ${JSON.stringify(op.value).slice(0, 60)}`);
        }
      }
      writeChart(t.chartFile, chart);
      const r = validate(normalizeChart(chart), {});
      return [`已编辑：${t.chartFile}`, ...log.slice(0, 20),
        `校验：${r.counts.errors} error / ${r.counts.warnings} warning / ${r.counts.infos} info`].join('\n');
    },
  });

  registerTool(ctx, {
    name: 'phira_chart_set_meta',
    description: '修改谱面元数据（info.yml + META）：曲名/定数/等级/谱师/BPM/offset。',
    parameters: {
      path: { type: 'string', required: true, description: '谱面目录或 chart.json' },
      name: { type: 'string', description: '曲名' },
      difficulty: { type: 'number', description: '定数' },
      level: { type: 'string', description: '显示等级，如 IN Lv.13' },
      charter: { type: 'string', description: '谱师' },
      bpm: { type: 'number', description: '改写 BPM（单 BPM 谱面）' },
      offsetMs: { type: 'number', description: 'META.offset（毫秒）' },
      useRpe170Speed: { type: 'boolean', description: 'info.yml 的 useRpe170Speed（RPE 1.70 新速度缓动；true=启用，false=强制旧行为）' },
    },
    output: { schema: { type: 'string' }, render: (a, v) => T(v) },
    async execute(args) {
      const t = loadTarget(args && args.path);
      const chart = JSON.parse(fs.readFileSync(t.chartFile, 'utf8'));
      chart.META = chart.META || {};
      if (args.name) { chart.META.name = args.name; }
      if (args.charter) chart.META.charter = args.charter;
      if (args.level) chart.META.level = args.level;
      if (args.bpm != null) {
        if ((chart.BPMList || []).length !== 1) throw new Error('多 BPM 谱面请直接编辑 BPMList');
        chart.BPMList[0].bpm = Number(args.bpm);
      }
      if (args.offsetMs != null) chart.META.offset = Number(args.offsetMs);
      if (args.useRpe170Speed != null) {
        const infoPath = path.join(t.dir, 'info.yml');
        writeInfo(infoPath, { useRpe170Speed: !!args.useRpe170Speed });
      }
      // 资源名以 info.yml 为准：别让 chart.json 的 META 留着占位值（song.mp3 / background.png）
      if (t.info && t.info.music) chart.META.song = t.info.music; else delete chart.META.song;
      if (t.info && t.info.illustration) chart.META.background = t.info.illustration; else delete chart.META.background;
      const upd = {};
      if (args.name) upd.name = args.name;
      if (args.difficulty != null) upd.difficulty = Number(args.difficulty);
      if (args.level) upd.level = args.level;
      if (args.charter) upd.charter = args.charter;
      const infoPath = path.join(t.dir, 'info.yml');
      if (Object.keys(upd).length) writeInfo(infoPath, upd);
      return commit(t, chart, `已更新元数据${Object.keys(upd).length ? `：${Object.keys(upd).join('/')}` : ''}`);
    },
  });

  registerTool(ctx, {
    name: 'phira_midi_parse',
    description: '解析 MIDI（.mid/.midi）：返回轨道、tempo、音符数、时长，并按 pitch→x 映射生成谱面音符候选。'
      + '用于「AI 根据 MIDI 编排」的第一步。',
    parameters: {
      path: { type: 'string', required: true, description: 'MIDI 文件路径' },
      track: { type: 'number', description: '只取某条轨道（默认全部）' },
      bpm: { type: 'number', description: '谱面 BPM（把秒换算成拍）。默认取 MIDI 第一个 tempo，不再写死 180' },
      xSpan: { type: 'number', description: 'pitch 映射到 ±xSpan 像素，默认 400' },
      maxNotes: { type: 'number', description: '最多返回多少音符，默认 200（超出会截断并标记）' },
      bpmList: {
        type: 'array',
        description: '谱面 BPMList（RPE 格式 [{bpm,startTime:[a,b,c]}]）。多 BPM 曲子必须传，否则拍号会偏。',
        items: { type: 'object' },
      },
      holdThresholdSec: { type: 'number', description: '时值超过多少秒判为 Hold，默认 0.25' },
    },
    output: { schema: { type: 'string' }, render: (a, v) => T(v) },
    async execute(args) {
      const p = helpers.resolvePath(args && args.path);
      const midi = parseMidi(fs.readFileSync(p));
      // 默认 BPM 必须取 MIDI 自己的 tempo：之前默认 180，而输出里又显示 Tempo 120BPM，
      // 按 180 换算的拍号和它自报的 tempo 自相矛盾（盲测里被当场抓到）。
      const bpmForConv = args && args.bpm != null
        ? Number(args.bpm)
        : (midi.tempos && midi.tempos.length ? midi.tempos[0].bpm : 180);
      const conv = midiToChartNotes(midi, {
        track: args && args.track, bpm: bpmForConv, xSpan: args && args.xSpan,
        maxNotes: args && args.maxNotes != null ? Number(args.maxNotes) : 200,
        bpmList: args && args.bpmList,
        holdThresholdSec: args && args.holdThresholdSec != null ? Number(args.holdThresholdSec) : undefined,
      });
      const lines = [
        `MIDI：${p}`,
        `格式 ${midi.format} / PPQ ${midi.ppqValue} / 时长 ${midi.durationSec.toFixed(2)}s / 音符 ${midi.notes.length}`,
        `轨道：${midi.tracks.map((t) => `#${t.index} ${t.name}(${t.notes})`).join('，')}`,
        `Tempo：${midi.tempos.map((t) => `${t.bpm}BPM@${t.tick}`).join('，')}`,
        `换算用 BPM：${bpmForConv}${args && args.bpm != null ? '（手动指定）' : '（= MIDI 首个 tempo）'}`,
        `pitch 范围：${conv.pitchRange[0]}–${conv.pitchRange[1]}，映射到 x ±${args && args.xSpan != null ? args.xSpan : 400}`,
        '',
        `候选音符（前 ${Math.min(conv.notes.length, 40)} 条，共 ${conv.count}${conv.truncated ? '，已按 maxNotes 截断' : ''}）：`,
        ...conv.notes.slice(0, 40).map((n) => `  beat=${n.beat.toFixed(3)} sec=${n.sec.toFixed(2)} x=${n.x} type=${n.type} dur=${n.dur.toFixed(2)}`),
      ];
      return lines.join('\n');
    },
  });
  registerTool(ctx, {
    name: 'phira_chart_plan',
    description: '生成整谱"段落规划"（结构表：每段密度/同刻/手法/判定线演出）。'
      + '**style 默认 auto：由工具按音乐特征自动选择**（传 midiPath 更准），不需要 AI 手选；'
      + '也可显式指定 lineShow / multiFinger / visual / endurance / balanced。'
      + '给定 path 时会把规划写入 <谱面目录>/plan.json。',
    parameters: {
      path: { type: 'string', description: '谱面目录（可选，用于保存 plan.json）' },
      durationSec: { type: 'number', description: '时长秒数，默认 60' },
      bpm: { type: 'number', description: 'BPM，默认 180' },
      difficulty: { type: 'number', description: '目标定数，默认 13' },
      style: { type: 'string', enum: ['auto', 'custom', ...STYLE_NAMES], description: '风格；默认 auto（按音乐自动选）；custom = 用 custom 自定义段落/密度' },
      custom: { type: 'object', description: '自定义规划：{density, sections:[{name,frac,chord,density,tech,fx}]}' },
      midiPath: { type: 'string', description: 'MIDI 文件路径：给了就按它的密度/复音/长音自动选风格' },
      profile: { type: 'object', description: '也可直接给音乐画像 {avgDensity,peakDensity,polyphony,holdRatio,durationSec}' },
    },
    output: { schema: { type: 'string' }, render: (a, v) => T(v) },
    async execute(args) {
      const plan = planChart({
        durationSec: args && args.durationSec, bpm: args && args.bpm,
        difficulty: args && args.difficulty, style: (args && args.style) || 'auto',
        custom: args && args.custom,
        midiPath: args && args.midiPath,
        profile: args && args.profile,
      });
      let saved = '';
      if (args && args.path) {
        const t = loadTarget(args.path);
        const f = path.join(t.dir, 'plan.json');
        fs.writeFileSync(f, JSON.stringify(plan, null, 2) + '\n');
        saved = `\n\n已保存规划：${f}`;
      }
      return fmtPlan(plan) + saved + '\n\n下一步：phira_chart_build_from_plan 按此规划生成谱面。';
    },
  });

  registerTool(ctx, {
    name: 'phira_chart_build_from_plan',
    description: '按 plan.json（或内联 plan）生成谱面内容：音符 + 判定线演出 + AI 水印，并立即校验。',
    parameters: {
      path: { type: 'string', required: true, description: '谱面目录或 chart.json' },
      plan: { type: 'object', description: '内联规划（不填则读取 <谱面目录>/plan.json）' },
      planFile: { type: 'string', description: '规划文件路径（相对工作区）' },
      targetDifficulty: { type: 'number', description: '目标定数（默认取规划里的 difficulty）' },
    },
    output: { schema: { type: 'string' }, render: (a, v) => T(v) },
    async execute(args) {
      const t = loadTarget(args && args.path);
      let plan = args && args.plan;
      if (!plan) {
        const pf = (args && args.planFile) ? helpers.resolvePath(args.planFile) : path.join(t.dir, 'plan.json');
        if (!fs.existsSync(pf)) throw new Error(`找不到规划文件：${pf}，请先运行 phira_chart_plan 并传 path`);
        plan = JSON.parse(fs.readFileSync(pf, 'utf8'));
      }
      const base = JSON.parse(fs.readFileSync(t.chartFile, 'utf8'));
      const target = Number((args && args.targetDifficulty) || (plan.meta && plan.meta.difficulty) || 13);
      let work = plan;
      let best = null;
      const trace = [];
      for (let i = 0; i < 8; i++) {
        const clone = JSON.parse(JSON.stringify(base));
        const r = materializePlan(clone, work);
        const norm2 = normalizeChart(clone);
        const pred = predictDifficulty(norm2).predicted;
        trace.push(`第${i + 1}轮 密度 ${work.meta.density} → 预测 ${pred.toFixed(2)}`);
        if (!best || Math.abs(pred - target) < Math.abs(best.pred - target)) best = { clone, work, pred, r };
        if (Math.abs(pred - target) <= 0.25) break;
        const gap = target - pred;
        const step = Math.abs(gap) > 1.2 ? 1.22 : 1.09;
        work = scalePlanDensity(work, gap > 0 ? step : 1 / step);
      }
      writeChart(t.chartFile, best.clone);
      const v = validate(normalizeChart(best.clone), { maxFingers: chordCap(target) });
      return `已按规划生成（目标定数 ${target}，实际预测 ${best.pred.toFixed(2)}）\n`
        + trace.map((x) => '  ' + x).join('\n') + '\n'
        + `音符 ${best.r.notes}，事件 ${best.r.events}，判定线 ${best.r.lines}（演出线 #${best.r.fxLine}）\n`
        + `校验：${v.counts.errors} error / ${v.counts.warnings} warning / ${v.counts.infos} info\n`
        + `统计：音符 ${v.stats.notes}，最大同刻 ${v.stats.maxChord}，同线碰撞 ${v.stats.collisions}`
        + (v.issues.filter((i) => i.level === 'error').length
          ? '\n错误：\n' + v.issues.filter((i) => i.level === 'error').slice(0, 5).map((i) => '  ' + i.msg).join('\n')
          : '')
        + '\n下一步：phira_analyze 看难度、phira_preview_strip 抽帧检查。';
    },
  });

}

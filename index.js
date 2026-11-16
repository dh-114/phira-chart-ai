/**
 * Phira AI 谱面插件 · Host 侧
 * 工具：指南 / 校验 / 分析 / 建谱 / 预览 / 面板数据通道
 */
import fs from 'node:fs';
import path from 'node:path';
import { normalizeChart, emptyChart } from './lib/rpe.js';
import { validate } from './lib/validate.js';
import { predictDifficulty, playability, stats } from './lib/analyze.js';
import { guide } from './lib/guide.js';
import { renderFrame, renderStrip } from './lib/render.js';
import { encodePNG } from './lib/raster.js';
import { registerEditorTools } from './lib/editor-tools.js';
import { toJsonSchema } from './lib/schema.js';
import { registerRoutes } from './lib/routes.js';
import { parseExtra } from './lib/effects.js';
import { setPanelPath } from './lib/panel-state.js';
import { resolveSafe } from './lib/paths.js';
import { generateChart } from './lib/generator.js';

export const inject = ['tools'];

/** 路由补挂钩子（apply 里赋值；任何工具调用都会顺带尝试补挂） */
let ensureRoutes = null;

/** 统一注册入口：把参数简写规范化为标准 JSON Schema（否则模型 API 会拒绝请求） */
const registry = new Map(); // 工具名 → def（供批量工具派发）
const registerTool = (ctx, def) => {
  registry.set(def.name, def);
  return ctx.tools['register']({
  ...def,
  parameters: toJsonSchema(def.parameters),
  execute: async (args, exec) => {
    try { if (ensureRoutes) ensureRoutes(); } catch { /* 忽略 */ }
    return def.execute(args, exec);
  },
  });
};

const text = (s) => [{ type: 'text', text: String(s) }];

/**
 * 工具侧路径解析：必须和 HTTP 路由用同一套根目录白名单（README 承诺过）。
 * 旧实现是裸 path.resolve，phira_chart_init 可以在任意位置建目录/写文件。
 * 需要放行别处时用环境变量 PHIRA_ROOTS 追加根目录（报错信息里会提示）。
 */
function resolvePath(p) {
  if (!p) return resolveSafe(process.cwd());
  return resolveSafe(path.isAbsolute(p) ? p : path.resolve(process.cwd(), p));
}

function parseInfoYml(src) {
  const o = {};
  for (const line of String(src).split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (m) o[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return o;
}

/** 读取目标：目录（含 info.yml）或单个 json 文件 */
function loadTarget(input) {
  const p = resolvePath(input || '.');
  const st = fs.statSync(p);
  let dir = p, chartFile = null, info = {};
  if (st.isDirectory()) {
    const infoPath = path.join(p, 'info.yml');
    if (fs.existsSync(infoPath)) info = parseInfoYml(fs.readFileSync(infoPath, 'utf8'));
    const preferred = info.chart ? path.join(p, info.chart) : null;
    if (preferred && fs.existsSync(preferred)) chartFile = preferred;
    else {
      const cands = fs.readdirSync(p).filter((f) => f.toLowerCase().endsWith('.json'));
      for (const c of cands) {
        const full = path.join(p, c);
        const head = fs.readFileSync(full, 'utf8').slice(0, 4000);
        if (head.includes('"judgeLineList"') || head.includes('"BPMList"')) { chartFile = full; break; }
      }
    }
    if (!chartFile) throw new Error(`在目录中找不到 RPE 谱面文件：${p}`);
  } else {
    dir = path.dirname(p);
    chartFile = p;
    const infoPath = path.join(dir, 'info.yml');
    if (fs.existsSync(infoPath)) info = parseInfoYml(fs.readFileSync(infoPath, 'utf8'));
  }
  const src = fs.readFileSync(chartFile, 'utf8');
  let json;
  try { json = JSON.parse(src); } catch (e) {
    throw new Error(`JSON 解析失败（${chartFile}）：${e.message}。注意 PEC 是纯文本，不是 JSON。`);
  }
  return { dir, info, chartFile, json, bytes: Buffer.byteLength(src) };
}

function fmtIssue(i) {
  return `[${i.level}] ${i.code} · ${i.msg}${i.at ? `  @ ${i.at}` : ''}`;
}

/** info.yml 里的数值字段转成数字 */
function numericInfo(info) {
  const num = (v, d) => { const x = Number(v); return Number.isFinite(x) ? x : d; };
  return {
    aspectRatio: num(info.aspectRatio, 16 / 9),
    lineLength: num(info.lineLength, 6),
    forceAspectRatio: String(info.forceAspectRatio).toLowerCase() === 'true',
    offset: num(info.offset, 0),
  };
}

function previewDir(dir) {
  const out = path.join(dir, 'preview');
  fs.mkdirSync(out, { recursive: true });
  return out;
}

export function apply(ctx) {
  /* ---------------- 指南 ---------------- */
  registerTool(ctx, {
    name: 'phira_guide',
    description: 'Phira 谱面写作指南（基于源码与 26 个参考谱面实测）。'
      + 'topic 可选：summary / engine（引擎语义速查）/ platform（跨平台兼容）/ doc（完整引擎文档）/ shader（后处理着色器）/ glossary（专有名词）/ reference（参考谱面统计）/ source（关键源码摘录与位置）/ playability（手感审计标准）/ '
      + 'format / schema / notes / lines / judge / effects / timing / pitfalls / difficulty / patterns / workflow。'
      + '写谱前先读 engine + schema + pitfalls。',
    parameters: {
      topic: {
        type: 'string',
        description: '指南主题，默认 summary',
        enum: ['summary', 'engine', 'platform', 'doc', 'shader', 'glossary', 'reference', 'source', 'playability', 'format', 'schema', 'notes', 'lines', 'judge', 'effects', 'timing', 'pitfalls', 'difficulty', 'patterns', 'workflow'],
      },
    },
    output: { schema: { type: 'string' }, render: (a, v) => text(v) },
    async execute(args) {
      return guide(args && args.topic);
    },
  });

  /* ---------------- 校验 ---------------- */
  registerTool(ctx, {
    name: 'phira_validate',
    description: '校验 RPE 谱面是否会导致 Phira 崩溃/闪退/打不开，并给出错误/警告/建议三级问题清单。'
      + 'path 可以是谱面目录（自动找 info.yml 里的 chart）或 chart.json 文件。',
    parameters: {
      path: { type: 'string', description: '谱面目录或 chart.json 路径（相对工作区或绝对路径）' },
      allowImages: { type: 'boolean', description: '是否允许图片纹理（默认 false，本项目建议禁用）' },
      launchGapSec: { type: 'number', description: '开局无准备阈值秒数，默认 2' },
      maxFingers: { type: 'number', description: '该难度允许的最大同时手指数（不给则按定数自动封顶：<15→2）' },
      difficulty: { type: 'number', description: '定数（默认读 info.yml），用于自动判断手指数上限' },
      strict: { type: 'boolean', description: '严格模式：碰撞/长条冲突/多指升级为 error' },
    },
    output: { schema: { type: 'string' }, render: (a, v) => text(v) },
    async execute(args) {
      const t = loadTarget(args && args.path);
      const chart = normalizeChart(t.json);
      // info.yml 引用的资源是否存在（validate 只拿得到谱面对象，这里补文件系统检查）
      const fx = parseExtra(t.dir, chart.bpm);
      const assetIssues = [];
      const need = [
        ['music', t.info && t.info.music],
        ['illustration', t.info && t.info.illustration],
        ['chart', t.info && t.info.chart],
      ];
      for (const [field, name] of need) {
        if (!name) {
          if (field !== 'chart') assetIssues.push({ level: 'warn', code: 'missing-asset-field', msg: `info.yml 未写 ${field}（Phira 会回退默认值）`, at: 'info.yml' });
          continue;
        }
        if (!fs.existsSync(path.join(t.dir, name))) {
          assetIssues.push({ level: 'error', code: 'missing-asset', msg: `info.yml 的 ${field} 指向 ${name}，但目录里没有该文件`, at: `${t.dir}/${name}` });
        }
      }
      const r = validate(chart, {
        effects: fx.effects,
        allowImages: !!(args && args.allowImages),
        launchGapSec: args && args.launchGapSec != null ? Number(args.launchGapSec) : 2,
        maxFingers: args && args.maxFingers != null ? Number(args.maxFingers) : null,
        difficulty: args && args.difficulty != null ? Number(args.difficulty)
          : (Number.isFinite(Number(t.info && t.info.difficulty)) ? Number(t.info.difficulty) : null),
        strict: !!(args && args.strict),
        rpe170Speed: String(t.info && t.info.useRpe170Speed).toLowerCase() === 'true',
      });
      // extra.json 特效 / 着色器（已在上面为 fx-distort-line 预解析）
      for (const e of fx.errors) {
        assetIssues.push({ level: 'error', code: e.code, msg: e.msg, at: 'extra.json' });
      }
      for (const w of fx.warnings) {
        assetIssues.push({ level: 'warn', code: w.code, msg: w.msg, at: 'extra.json' });
      }
      // META 与 info.yml 不一致（生成器会同步；手改过的话要提示，否则客户端显示混乱）
      {
        const m = t.json.META || {};
        const pair = [['name', '曲名'], ['charter', '谱师'], ['level', '等级'], ['song', '音频'], ['background', '曲绘']];
        const diffs = [];
        for (const [k, label] of pair) {
          const a = String(m[k] == null ? '' : m[k]).trim();
          const b = String((t.info && t.info[k]) == null ? '' : t.info[k]).trim();
          if (a && b && a !== b) diffs.push(`${label}：chart.json=${a} / info.yml=${b}`);
        }
        if (diffs.length) {
          assetIssues.push({ level: 'info', code: 'meta-info-mismatch', msg: `META 与 info.yml 不一致（以 info.yml 为准）：${diffs.join('；')}`, at: 'META' });
        }
      }
      // normalizeChart 的结构性错误（null 元素/字段类型不对）现在记在 chart.errors 里，必须回显
      for (const e of chart.errors || []) {
        assetIssues.push({ level: 'error', code: e.code, msg: e.msg, at: 'chart.json' });
      }
      if (assetIssues.length) {
        for (const a of assetIssues) {
          r.issues.push(a);
          if (a.level === 'error') { r.counts.errors += 1; r.ok = false; }
          else if (a.level === 'warn') r.counts.warnings += 1;
          else r.counts.infos += 1;
        }
      }
      const head = `校验 ${t.chartFile}\n结果：${r.ok ? '✅ 通过（无 error）' : '❌ 有致命问题'}　${r.counts.errors} error / ${r.counts.warnings} warning / ${r.counts.infos} info`;
      const lines = [head, '', `特效：${fx.effects.length} 个${fx.effects.length ? '（' + [...new Set(fx.effects.map((e) => e.shader))].join('/') + '）' : ''}`, '', `统计：音符 ${r.stats.notes}（真 ${r.stats.real} / 假 ${r.stats.fake}），判定线 ${r.stats.lines}，事件 ${r.stats.events}，最大同刻 ${r.stats.maxChord}，点击碰撞 ${r.stats.collisions}，首音符 ${r.stats.firstSec == null ? '—' : r.stats.firstSec.toFixed(2) + 's'}`];
      if (r.issues.length) {
        lines.push('', '问题清单：');
        const order = { error: 0, warn: 1, info: 2 };
        for (const i of r.issues.slice().sort((a, b) => order[a.level] - order[b.level])) {
          lines.push('  ' + fmtIssue(i) + (i.t != null ? `  (t=${Number(i.t).toFixed(2)}s)` : ''));
        }
      } else lines.push('', '没有发现问题。');
      return lines.join('\n');
    },
  });

  /* ---------------- 分析 ---------------- */
  registerTool(ctx, {
    name: 'phira_analyze',
    description: '分析 RPE 谱面的难度与可玩性：定数预测（参考谱面标定）、物量/密度/手指数、10 项可玩性检查。',
    parameters: {
      path: { type: 'string', description: '谱面目录或 chart.json 路径' },
      maxFingers: { type: 'number', description: '该难度允许的最大同时手指数（可选）' },
    },
    output: { schema: { type: 'string' }, render: (a, v) => text(v) },
    async execute(args) {
      const t = loadTarget(args && args.path);
      const chart = normalizeChart(t.json);
      const s = stats(chart);
      const d = predictDifficulty(chart);
      const p = playability(chart, { maxFingers: args && args.maxFingers != null ? Number(args.maxFingers) : null });
      const out = [];
      out.push(`分析 ${t.chartFile}`);
      out.push(`难度预测：${d.predicted.toFixed(2)}　（置信度 ${(d.confidence * 100).toFixed(0)}%，参考谱面标定 MAE≈0.33）`);
      out.push(`依据：${d.reasons.join('；')}`);
      if (s.comboMarks && s.comboMarks.length) {
        out.push(`连击里程碑（按截图里的 combo 定位时间）：${s.comboMarks.map((m) => `${m.combo}→${m.sec}s`).join('  ')}`);
      }
      out.push('');
      out.push(`物量 ${s.notes}（Tap ${s.byType[1] || 0} / Hold ${s.byType[2] || 0} / Flick ${s.byType[3] || 0} / Drag ${s.byType[4] || 0}），假音符 ${s.fake}`);
      out.push(`时长 ${s.duration.toFixed(1)}s，平均 ${s.densityAvg.toFixed(2)} 音符/s，峰值 ${s.densityPeak}/s，相邻间隔中位 ${s.medianGap == null ? '—' : s.medianGap.toFixed(3) + 's'}（10% 分位 ${s.p10Gap == null ? '—' : s.p10Gap.toFixed(3) + 's'}）`);
      out.push(`最大同刻 ${s.maxChord}，判定线 ${s.lines} 条，事件 ${s.events}（${s.eventRate.toFixed(1)}/s），Drag 占比 ${(s.dragRatio * 100).toFixed(0)}%`);
      out.push(`长条 ${s.holdCount} 个，均值 ${s.holdAvg.toFixed(2)}s，最长 ${s.holdMax.toFixed(2)}s`);
      out.push('');
      out.push(p.items.length ? '可玩性：' : '可玩性：未发现问题');
      for (const i of p.items) out.push(`  [${i.level}] ${i.title} — ${i.detail}`);
      return out.join('\n');
    },
  });

  /* ---------------- 建谱骨架 ---------------- */
  registerTool(ctx, {
    name: 'phira_chart_init',
    description: '在指定目录创建一个可直接被 Phira 打开的 RPE 谱面骨架（chart.json + info.yml）。已存在则不覆盖。',
    parameters: {
      dir: { type: 'string', required: true, description: '目标目录（相对工作区或绝对路径）' },
      name: { type: 'string', description: '曲名' },
      bpm: { type: 'number', description: 'BPM，默认 180' },
      difficulty: { type: 'number', description: '定数，默认 12' },
      level: { type: 'string', description: '显示等级，如 "IN Lv.12"' },
      charter: { type: 'string', description: '谱师名义（自动追加 (AI)）' },
      lineY: { type: 'number', description: '主判定线高度，默认 -270（参考谱面中位；0 = 屏幕正中）' },
    },
    output: { schema: { type: 'string' }, render: (a, v) => text(v) },
    async execute(args) {
      const dir = resolvePath(args && args.dir);
      fs.mkdirSync(dir, { recursive: true });
      const chartPath = path.join(dir, 'chart.json');
      const infoPath = path.join(dir, 'info.yml');
      if (fs.existsSync(chartPath)) throw new Error(`已存在 ${chartPath}，不覆盖`);
      const name = (args && args.name) || 'AI Chart';
      const bpm = Number((args && args.bpm) || 180);
      const charter = ((args && args.charter) || 'AI') + ' (AI)';
      const chart = emptyChart({ bpm, title: name, charter, lineY: args && args.lineY != null ? Number(args.lineY) : -270 });
      fs.writeFileSync(chartPath, JSON.stringify(chart, null, 2) + '\n');
      const info = [
        `name: ${name}`,
        `difficulty: ${Number((args && args.difficulty) || 12)}`,
        `level: ${(args && args.level) || 'IN Lv.12'}`,
        `charter: ${charter}`,
        'composer: Unknown',
        'illustrator: Unknown',
        'chart: chart.json',
        'format: rpe',
        'music: song.mp3',
        'illustration: background.png',
        'previewStart: 0',
        'aspectRatio: 1.7777778',
        'lineLength: 6.0',
        'backgroundDim: 0.6',
        'offset: 0.0',
        'tags: [AI生成]',
        'intro: 本谱面由 AI 生成',
        'holdPartialCover: false',
        'noteUniformScale: false',
        'forceAspectRatio: false',
      ].join('\n') + '\n';
      fs.writeFileSync(infoPath, info);
      return `已创建谱面骨架：\n- ${chartPath}\n- ${infoPath}\n下一步：用音符/事件工具写入内容，或手工编辑后跑 phira_validate。`;
    },
  });

  /* ---------------- 预览：指定帧 ---------------- */
  registerTool(ctx, {
    name: 'phira_preview_frame',
    description: '按 prpr 源码数学把谱面在指定时间点渲染成一帧 PNG（含判定线、音符、长条、特效颜色）。'
      + '输出文件在谱面目录的 preview/ 下，返回绝对路径。',
    parameters: {
      path: { type: 'string', description: '谱面目录或 chart.json 路径' },
      time: { type: 'number', description: '渲染时间（秒）' },
      width: { type: 'number', description: '画面宽度像素，默认 960' },
      showFake: { type: 'boolean', description: '是否显示假音符（默认显示但近乎透明）' },
      debug: { type: 'boolean', description: '是否叠加调试信息（时间/物量/判定线/图例/总览时间轴），默认 true' },
    },
    output: { schema: { type: 'string' }, render: (a, v) => text(v) },
    async execute(args) {
      const t = loadTarget(args && args.path);
      const chart = normalizeChart(t.json);
      const info = numericInfo(t.info);
      const time = Number((args && args.time) || 0);
      const fx = parseExtra(t.dir, chart.bpm);
      const f = renderFrame(chart, info, time, {
        effects: fx.effects,
        width: Math.max(120, Math.min(1600, Math.round(Number((args && args.width) || 960)) || 960)),
        showFake: args && args.showFake !== false,
        debug: args && args.debug !== false,
      });
      const out = path.join(previewDir(t.dir), `frame_${time.toFixed(2)}.png`);
      fs.writeFileSync(out, encodePNG(f.surface));
      return `已渲染 t=${time.toFixed(2)}s\n文件：${out}\n画面：${f.stats.width}×${f.stats.height}（比例 ${f.stats.aspect.toFixed(4)}）\n可见判定线 ${f.stats.visibleLines} 条，绘制音符 ${f.stats.drawnNotes} 个`;
    },
  });

  /* ---------------- 预览：多帧胶片 ---------------- */
  registerTool(ctx, {
    name: 'phira_preview_strip',
    description: '把谱面在 [start,end] 区间均匀采样成 count 帧，排成网格输出一张 PNG（多帧预览）。',
    parameters: {
      path: { type: 'string', description: '谱面目录或 chart.json 路径' },
      start: { type: 'number', required: true, description: '起始时间（秒）' },
      end: { type: 'number', required: true, description: '结束时间（秒）' },
      count: { type: 'number', description: '帧数，默认 6' },
      cols: { type: 'number', description: '每行帧数，默认 2' },
      width: { type: 'number', description: '单帧宽度像素，默认 640' },
    },
    output: { schema: { type: 'string' }, render: (a, v) => text(v) },
    async execute(args) {
      const t = loadTarget(args && args.path);
      const chart = normalizeChart(t.json);
      const info = numericInfo(t.info);
      const start = Number((args && args.start) || 0);
      const end = Number((args && args.end) || start + 5);
      const count = Math.max(1, Math.min(24, Math.round(Number((args && args.count) || 6)) || 6));
      const fx = parseExtra(t.dir, chart.bpm);
      const f = renderStrip(chart, info, start, end, count, {
        effects: fx.effects,
        cols: Math.max(1, Math.min(20, Math.round(Number((args && args.cols) || 2)) || 2)),
        width: Math.max(120, Math.min(1600, Math.round(Number((args && args.width) || 640)) || 640)),
        showFake: args && args.showFake !== false,
        debug: args && args.debug !== false,
      });
      const out = path.join(previewDir(t.dir), `strip_${start.toFixed(1)}-${end.toFixed(1)}_${count}.png`);
      fs.writeFileSync(out, encodePNG(f.surface));
      return `已渲染 ${count} 帧（${start.toFixed(2)}s → ${end.toFixed(2)}s）\n文件：${out}\n尺寸：${f.size.W}×${f.size.H}\n每帧：` +
        f.stats.map((s) => `t=${s.t.toFixed(2)} ${s.drawnNotes}音`).join(' / ');
    },
  });

  /* ---------------- 编排类工具 ---------------- */
  registerEditorTools(ctx, { loadTarget, resolvePath, text });

  /* ---------------- 一键生成 / 体检 / 批量（省 token 的主力） ---------------- */
  registerTool(ctx, {
    name: 'phira_chart_generate',
    description:
      '一键从 MIDI 生成整张谱面（规划+音符+判定线事件+chart.json+info.yml），无需自己写生成脚本。'
      + '默认 source=midi：跟着旋律走，且构造即满足手感硬指标（长条收在下一个音符前、长条期间只放黄键、'
      + '双押只在整拍、相邻横移限速、经过音自动转黄键、前奏留白 2s）。'
      + '特效档位默认 light：source=midi 时只放 1 段假线压音；source=plan 时另加判定线换色。'
      + '要更花的演出线/扫线/淡入传 effects=normal，完全不要演出传 off。'
      + '定数默认按实测值写 info.yml（先测后标），要强行按目标写就传 lockDifficulty=true。',
    parameters: {
      midiPath: { type: 'string', description: 'MIDI 绝对路径（.mid/.midi）' },
      outDir: { type: 'string', description: '输出目录（默认与 MIDI 同目录）' },
      bpm: { type: 'number', description: 'BPM（默认取 MIDI tempo）' },
      difficulty: { type: 'number', description: '目标定数（默认 13）' },
      style: { type: 'string', description: '风格：auto/balanced/multiFinger/visual/endurance/custom（默认 auto）' },
      durationSec: { type: 'number', description: '谱面时长（默认 MIDI 长度）' },
      title: { type: 'string', description: '曲名' },
      seed: { type: 'number', description: '随机种子（复现同一结果）' },
      aiMark: { type: 'boolean', description: '是否写 AI 水印（默认 true）' },
      introPulse: { type: 'boolean', description: '开场/休息是否加假线压音（默认 true）' },
      introSec: { type: 'number', description: '前奏留白秒数（默认 2；首个音符不会早于该时刻）' },
      source: { type: 'string', description: '生成来源：midi（跟旋律，默认，手感最好）| plan（模板手法）' },
      midiTrack: { type: 'number', description: 'source=midi 时使用的轨道号（默认自动选旋律轨）' },
      effects: { type: 'string', description: '特效档位：off（纯判定线）/ light（默认：换色+1 段压音）/ normal（演出线+扫线+淡入）/ rich' },
      lockDifficulty: { type: 'boolean', description: 'true=info.yml 定数按 difficulty 写；默认 false=按实测预测值写（先测后标）' },
      melodyOnly: { type: 'boolean', description: 'true=只跟主旋律（不叠和弦、不追内声部），音符更少更好跟；默认 false' },
      charter: { type: 'string', description: '谱师名义（默认 AI）' },
      composer: { type: 'string', description: '作曲（写进 info.yml）' },
      illustrator: { type: 'string', description: '画师（写进 info.yml illustration 说明）' },
      music: { type: 'string', description: '音频文件名（默认自动探测目录里已有的音频；没有就不写进 info.yml）' },
      illustration: { type: 'string', description: '曲绘文件名（默认自动探测；没有就不写进 info.yml）' },
    },
    output: { schema: { type: 'string' }, render: (a, v) => text(v) },
    execute: async (args) => {
      const r = generateChart({
        midiPath: resolvePath(args.midiPath),
        outDir: args.outDir ? resolvePath(args.outDir) : undefined,
        bpm: args.bpm,
        difficulty: args.difficulty,
        style: args.style,
        durationSec: args.durationSec,
        title: args.title,
        seed: args.seed,
        aiMark: args.aiMark,
        introPulse: args.introPulse,
        introSec: args.introSec,
        source: args.source == null ? 'midi' : args.source,
        midiTrack: args.midiTrack,
        effects: args.effects,
        lockDifficulty: args.lockDifficulty,
        melodyOnly: args.melodyOnly === true,
        music: args.music,
        illustration: args.illustration,
        charter: args.charter,
        composer: args.composer,
        illustrator: args.illustrator,
      });
      const out = [
        `已生成：${r.outDir}`,
        `音符 ${r.notes} · 事件 ${r.events} · 线 ${r.lines} · 风格 ${r.style}`,
        `定数：实测 ${r.predicted.toFixed(2)}（置信 ${r.confidence}）→ info.yml 写 ${r.difficulty}`
          + (r.targetDifficulty !== r.difficulty ? `（目标 ${r.targetDifficulty} 与实测差 ${(r.targetDifficulty - r.predicted).toFixed(2)}，按实测标；要锁目标请传 lockDifficulty=true）` : ''),
        `手感自检：${r.warnings.errors} error / ${r.warnings.warnings} warn / ${r.warnings.infos} info`,
        r.issues.length ? `问题：${r.issues.join('、')}` : '问题：无',
      ];
      if (r.missingAssets && r.missingAssets.length) out.push(`待补资源：${r.missingAssets.join(' · ')}`);
      out.push('下一步建议：phira_validate / phira_analyze 复核，再补音频与曲绘。');
      return out.join('\n');
    },
  });

  registerTool(ctx, {
    name: 'phira_doctor',
    description: '一次调用完成全量体检：chart/info/extra 解析、资源是否存在、校验、难度预测（含公式各项贡献）。用于替代"读源码+反复跑"的排查。',
    parameters: {
      path: { type: 'string', description: '谱面目录或 chart.json' },
    },
    output: { schema: { type: 'string' }, render: (a, v) => text(v) },
    execute: async (args) => {
      const t = loadTarget(args.path);
      const chart = normalizeChart(t.json);
      const v = validate(chart, { difficulty: t.info.difficulty, rpe170Speed: String(t.info.useRpe170Speed).toLowerCase() === 'true' });
      const pred = predictDifficulty(chart);
      const lines = [];
      lines.push(`体检：${t.dir}`);
      const durSec = chart.notes.reduce((m, n) => Math.max(m, Number.isFinite(n.endSec) ? n.endSec : n.sec), 0);
      lines.push(`音符 ${chart.notes.length} · 线 ${chart.lines.length} · BPM ${(t.json.BPMList && t.json.BPMList[0] && t.json.BPMList[0].bpm) || '?'} · 时长 ${durSec.toFixed(1)}s`);
      lines.push(`校验：${v.counts.errors} error / ${v.counts.warnings} warn / ${v.counts.infos} info`);
      if (v.issues.length) lines.push(`主要问题：${v.issues.filter((i) => i.level !== 'info').slice(0, 6).map((i) => i.code).join('、') || '无'}`);
      lines.push(`难度预测 ${pred.predicted.toFixed(2)}（置信 ${pred.confidence}）`);
      for (const term of pred.terms || []) lines.push(`  ${term.name}: ${Number(term.value).toFixed(2)} × ${term.coef} = ${Number(term.contribution).toFixed(2)}`);
      const res = [];
      const AUDIO = ['.mp3', '.ogg', '.wav', '.flac', '.m4a'];
      const IMG = ['.png', '.jpg', '.jpeg', '.webp'];
      const pickAsset = (declared, exts) => {
        if (declared) {
          const p = path.isAbsolute(declared) ? declared : path.join(t.dir, declared);
          return { name: declared, ok: fs.existsSync(p) };
        }
        let found = null;
        try { found = fs.readdirSync(t.dir).find((f) => exts.includes(path.extname(f).toLowerCase())); } catch { /* ignore */ }
        return found ? { name: found, ok: true } : { name: exts[0].slice(1), ok: false };
      };
      for (const [label, a] of [['music', pickAsset(t.info.music, AUDIO)], ['illustration', pickAsset(t.info.illustration, IMG)]]) {
        res.push(`${label}: ${a.ok ? 'OK（' + a.name + '）' : '缺失（info.yml 未写且目录里没有）'}`);
      }
      const extraPath = path.join(t.dir, 'extra.json');
      if (fs.existsSync(extraPath)) {
        const fx = parseExtra(t.dir, chart.bpm);
        res.push(`extra.json: ${fx.errors.length ? '✗ ' + fx.errors[0].code : 'OK'}（特效 ${fx.effects.length}）`);
      }
      lines.push(`资源：${res.join(' · ')}`);
      return lines.join('\n');
    },
  });

  registerTool(ctx, {
    name: 'phira_chart_batch',
    description: '一次调用按顺序执行多条谱面操作（等价于多次工具调用），用于减少往返：ops=[{tool:"chart_add_notes",args:{...}}, ...]。path 会自动带入每条操作。',
    parameters: {
      path: { type: 'string', description: '谱面目录或 chart.json（会作为默认 path 传给每条操作）' },
      ops: {
        type: 'array',
        description: '操作列表：{tool, args}',
        items: { type: 'object' },
      },
    },
    output: { schema: { type: 'string' }, render: (a, v) => text(v) },
    execute: async (args) => {
      const ops = Array.isArray(args.ops) ? args.ops : [];
      if (!ops.length) throw new Error('ops 为空');
      if (ops.length > 40) throw new Error('一批最多 40 条操作');
      const out = [];
      for (const op of ops) {
        const name = String(op && op.tool || '');
        const def = registry.get(name);
        if (!def) { out.push(`${name}: 未知工具`); continue; }
        if (name === 'phira_chart_batch' || name === 'phira_chart_generate') { out.push(`${name}: 不支持嵌套`); continue; }
        const a = { path: args.path, ...(op.args || {}) };
        try {
          const r = await def.execute(a, {});
          const txt = def.output && def.output.render ? def.output.render(a, r)[0].text : String(r);
          out.push(`${name}: ${String(txt).split('\n')[0]}`);
        } catch (e) {
          out.push(`${name}: 失败 ${String(e && e.message || e)}`);
        }
      }
      return `批量执行 ${ops.length} 条：\n` + out.join('\n');
    },
  });

  /* ---------------- M6：面板数据通道 ---------------- */
  let routesMounted = false;
  const mountRoutes = () => {
    if (routesMounted) return true;
    const ws = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined;
    if (!ws) return false;
    try {
      const dispose = registerRoutes(ws, ctx, { loadTarget, resolvePath });
      if (typeof ctx.effect === 'function') ctx.effect(() => dispose);
      routesMounted = true;
      return true;
    } catch (e) {
      return false;
    }
  };
  ensureRoutes = mountRoutes;
  if (!mountRoutes()) {
    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      if (mountRoutes() || tries >= 40) clearInterval(timer);
    }, 500);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  /* ---------------- 让 AI 指定面板要加载的谱面 ---------------- */
  registerTool(ctx, {
    name: 'phira_panel_open',
    description: '让浏览器里的 Phira 面板加载指定谱面目录（AI 生成/修改谱面后调用，面板会自动切换并刷新）。',
    parameters: {
      path: { type: 'string', required: true, description: '谱面目录（绝对路径，需在允许根目录内）' },
    },
    output: { schema: { type: 'string' }, render: (a, v) => text(v) },
    async execute(args) {
      const p = resolvePath(args && args.path);
      const st = fs.statSync(p);
      if (!st.isDirectory() && !st.isFile()) throw new Error('路径既不是目录也不是文件');
      setPanelPath(p);
      return `已通知面板加载：${p}\n面板会在 1~2 秒内自动切换（若面板未打开，点输入框上方的「🎵 Phira 面板」）。`;
    },
  });

  /* ---------------- 面板自检 ---------------- */
  registerTool(ctx, {
    name: 'phira_panel_status',
    description: '检查 Phira 面板的数据通道是否就绪（/phira 路由是否注册、允许根目录、平台信息）。面板加载失败时先用它排查。',
    parameters: {},
    output: { schema: { type: 'string' }, render: (a, v) => text(v) },
    async execute() {
      const okNow = routesMounted || mountRoutes();
      const info = (await import('./lib/paths.js')).platformInfo();
      return [
        `面板路由：${okNow ? '✅ 已注册（/phira/info|list|chart|sheet|frame）' : '❌ 未注册（宿主进程可能未重启，或 webServer 不可用）'}`,
        `平台：${info.platform}/${info.arch}  node ${info.node}`,
        `默认目录：${info.defaultDir}`,
        `允许根目录：${info.roots.join(' , ')}`,
        okNow ? '面板应可正常加载。' : '请完全重启 DSH（不是刷新页面）后重试。',
      ].join('\n');
    },
  });
}

/**
 * 指南完整性检查：确保给 AI 的指南覆盖引擎语义、跨平台规则，并且文档可跨设备读取。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { guide, TOPICS } from '../lib/guide.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok, detail });

check('topic 覆盖引擎/平台/文档/着色器/术语/参考/源码/手感', ['engine', 'platform', 'doc', 'shader', 'glossary', 'reference', 'source', 'playability'].every((k) => TOPICS.includes(k)), TOPICS.join(','));

const e = guide('engine');
for (const kw of ['tween 0', '保持', '空事件数组', '零时长', '秒', 'FADEOUT', '一维', 'incline', '起', 'sort']) {
  // 用更稳的关键词集合
}
const engineKws = ['tween 0', '保持', '空事件数组', '零时长事件', '关键帧不排序', 'FADEOUT_TIME', 'incline', '一维'];
const missE = engineKws.filter((k) => !e.includes(k));
check('engine 主题内容完整', missE.length === 0, missE.join('/'));

const p = guide('platform');
const platKws = ['PHIRA_ROOTS', 'path.join', 'rename', 'UTF-8', 'Range', 'WebAudio', 'Canvas', 'ASCII'];
const missP = platKws.filter((k) => !p.includes(k));
check('platform 主题内容完整', missP.length === 0, missP.join('/'));

const sh = guide('shader');
const shaderKws = ['extra.json', 'grayscale', 'vignette', 'chromatic', 'glitch', 'fisheye', 'shockwave', '/文件名.glsl', 'uniform float'];
const missS = shaderKws.filter((k) => !sh.includes(k));
check('shader 主题内容完整', missS.length === 0, missS.join('/'));

const gl = guide('glossary');
const glKws = ['RPE', 'Tap', 'Hold', 'Flick', 'Drag', '判定线', '双押', '楼梯', '纵连', '压音', '偏移'];
const missG = glKws.filter((k) => !gl.includes(k));
check('glossary 专有名词完整', missG.length === 0, missG.join('/'));

const rf = guide('reference');
const rfKws = ['5,918', '5,012', '3,167', '2,822', '56.3%', '-270'];
const missR = rfKws.filter((k) => !rf.includes(k));
check('reference 参考统计完整', missR.length === 0, missR.join('/'));

const pt = guide('patterns');
const ptKws = ['mirrorLines', 'belowDrag', 'crossLines', 'holdFlick', 'fakePulse', 'holdFlickMelody', 'tapDragChain', '竖直', '什么时候用', '13–14'];
const missPt = ptKws.filter((k) => !pt.includes(k));
check('patterns 覆盖全部手法', missPt.length === 0, missPt.join('/'));

const src = guide('source');
const srcKws = ['docs/ref-src', 'parse_events', 'FADEOUT_TIME', 'X_DIFF_MAX', 'extra.json', 'GPLv3'];
const missSrc = srcKws.filter((k) => !src.includes(k));
check('source 主题含源码摘录', missSrc.length === 0, missSrc.join('/'));

const refDir = path.join(HERE, '..', 'docs', 'ref-src');
const refFiles = fs.existsSync(refDir) ? fs.readdirSync(refDir).filter((f) => f.endsWith('.rs')) : [];
check('docs/ref-src 含 9 个源码文件', refFiles.length === 9, refFiles.join(','));
check('参考源码附 NOTICE（GPLv3）', fs.existsSync(path.join(refDir, 'NOTICE.md'))
  && fs.readFileSync(path.join(refDir, 'NOTICE.md'), 'utf8').includes('GPL'), '');

const pl = guide('playability');
const plKws = ['hold-collision', 'finger-overload', 'key-clash', 'jack-repeat', 'big-jump', '最近手', 'JudgeStatus'];
const missPl = plKws.filter((k) => !pl.includes(k));
check('playability 手感标准完整', missPl.length === 0, missPl.join('/'));

const d = guide('doc');
check('doc 主题可读取完整文档', d.length > 2000 && d.includes('引擎语义'), `${d.length} 字符`);

const docFile = path.join(HERE, '..', 'docs', 'engine.md');
check('docs/engine.md 随插件分发（可移植）', fs.existsSync(docFile), docFile);
if (fs.existsSync(docFile)) {
  const txt = fs.readFileSync(docFile, 'utf8');
  check('文档无硬编码 Android 路径', !txt.includes('/storage/emulated/0'), '');
  check('文档包含关键章节', ['坐标', '事件', '判定', '坑'].every((k) => txt.includes(k)), '');
}

// 主线默认高度
{
  const { emptyChart, normalizeChart } = await import('../lib/rpe.js');
  const { addNotes } = await import('../lib/author.js');
  const { validate } = await import('../lib/validate.js');
  const c = emptyChart({ bpm: 120 });
  const norm = normalizeChart(c);
  const y = norm.lines[0].layers.flatMap((l) => l.moveYEvents)[0].start;
  check('新建谱面主线默认 y=-270', Math.abs(y + 270) < 1, String(y));
  addNotes(c, 0, [{ beat: 0, type: 1, x: 0 }]);
  check('默认谱面不报 line-height', !validate(normalizeChart(c)).issues.some((i) => i.code === 'line-height'));
  const c2 = emptyChart({ bpm: 120, lineY: 0 });
  addNotes(c2, 0, [{ beat: 0, type: 1, x: 0 }]);
  check('居中主线会被 line-height 提醒', validate(normalizeChart(c2)).issues.some((i) => i.code === 'line-height'));
}

// 新速度缓动：非 1 缓动的 speed 事件应触发 warn
{
  const { emptyChart, normalizeChart, toTriple } = await import('../lib/rpe.js');
  const { validate } = await import('../lib/validate.js');
  const c = emptyChart({ bpm: 120 });
  c.judgeLineList[0].eventLayers[0].speedEvents.push({
    bezier: 0, bezierPoints: [0, 0, 0, 0], easingLeft: 0, easingRight: 1, easingType: 4,
    start: 10, end: 20, startTime: toTriple(4, 192), endTime: toTriple(8, 192),
  });
  const v = validate(normalizeChart(c));
  check('非 1 缓动 speed 事件 → new-speed-easing warn', v.issues.some((i) => i.code === 'new-speed-easing'));
}

console.log('指南检查：');
let bad = 0;
for (const r of results) {
  console.log(`  ${r.ok ? '✅' : '❌'} ${r.name}${r.ok ? '' : '  ' + r.detail}`);
  if (!r.ok) bad++;
}
console.log(bad ? `\n${bad} 项失败` : '\n全部通过');
process.exit(bad ? 1 : 0);

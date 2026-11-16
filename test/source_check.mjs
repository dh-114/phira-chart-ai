/**
 * 源码一致性校验：把 prpr 源码里的常量/语义与插件实现逐一比对。
 * 找不到源码时跳过（CI/其他机器无源码副本也能通过）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RPE_WIDTH, RPE_HEIGHT, HEIGHT_RATIO, SPEED_RATIO, NOTE_WIDTH_RATIO_BASE, evalSeries,
} from '../lib/rpe.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CANDIDATES = [
  process.env.PHIRA_SRC,
  path.join(HERE, '..', '..', 'source code', 'prpr', 'src'),
  path.join(HERE, '..', '..', '..', 'source code', 'prpr', 'src'),
].filter(Boolean);

const SRC = CANDIDATES.find((p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
if (!SRC) {
  console.log('（未找到 prpr 源码，跳过源码一致性校验）');
  process.exit(0);
}

const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');
const num = (src, re, what) => {
  const m = re.exec(src);
  if (!m) throw new Error(`源码中找不到 ${what}`);
  return Number(m[1]);
};

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); };

/* ---- 1. 常量比对 ---- */
const core = read('core.rs');
const rpeSrc = read('parse/rpe.rs');
const noteSrc = read('core/note.rs');
const judgeSrc = read('judge.rs');

const srcNoteW = num(core, /NOTE_WIDTH_RATIO_BASE:\s*f64\s*=\s*([\d.]+)/, 'NOTE_WIDTH_RATIO_BASE');
const srcHeight = num(core, /HEIGHT_RATIO:\s*f64\s*=\s*([\d.]+)/, 'HEIGHT_RATIO');
const srcW = num(rpeSrc, /RPE_WIDTH:\s*f32\s*=\s*([\d.]+)/, 'RPE_WIDTH');
const srcH = num(rpeSrc, /RPE_HEIGHT:\s*f32\s*=\s*([\d.]+)/, 'RPE_HEIGHT');
const srcFade = num(noteSrc, /FADEOUT_TIME:\s*f64\s*=\s*([\d.]+)/, 'FADEOUT_TIME');
const srcPerfect = num(judgeSrc, /LIMIT_PERFECT:\s*f64\s*=\s*([\d.]+)/, 'LIMIT_PERFECT');
const srcGood = num(judgeSrc, /LIMIT_GOOD:\s*f64\s*=\s*([\d.]+)/, 'LIMIT_GOOD');
const srcBad = num(judgeSrc, /LIMIT_BAD:\s*f64\s*=\s*([\d.]+)/, 'LIMIT_BAD');
const srcXDiffNum = num(judgeSrc, /X_DIFF_MAX:\s*f64\s*=\s*([\d.]+)\s*\/\s*\(16\.\s*\/\s*9\.\)\s*\*\s*2\./, 'X_DIFF_MAX');

check('RPE 画布 1350×900', RPE_WIDTH === srcW && RPE_HEIGHT === srcH, `${RPE_WIDTH}×${RPE_HEIGHT} vs ${srcW}×${srcH}`);
check('NOTE_WIDTH_RATIO_BASE', NOTE_WIDTH_RATIO_BASE === srcNoteW, `${NOTE_WIDTH_RATIO_BASE} vs ${srcNoteW}`);
check('HEIGHT_RATIO', HEIGHT_RATIO === srcHeight, `${HEIGHT_RATIO} vs ${srcHeight}`);
const srcSpeed = 10 / 45 / srcHeight;
check('SPEED_RATIO', Math.abs(SPEED_RATIO - srcSpeed) < 1e-12, `${SPEED_RATIO.toFixed(8)} vs ${srcSpeed.toFixed(8)}`);

const renderSrc = fs.readFileSync(path.join(HERE, '..', 'lib', 'render.js'), 'utf8');
const fadeInOurs = /t\s*-\s*nt\)\s*\/\s*0\.16/.test(renderSrc) || /0\.16/.test(renderSrc);
check('音符淡出 0.16s', fadeInOurs, `源码 FADEOUT_TIME=${srcFade}`);

const guideSrc = fs.readFileSync(path.join(HERE, '..', 'lib', 'guide.js'), 'utf8');
check('判定窗口 0.08/0.16/0.22',
  guideSrc.includes(String(srcPerfect)) && guideSrc.includes(String(srcGood)) && guideSrc.includes(String(srcBad)),
  `源码 ${srcPerfect}/${srcGood}/${srcBad}`);
const xDiffReal = srcXDiffNum / (16 / 9) * 2;
check('X_DIFF_MAX = 0.21/(16/9)*2 ≈ 0.2363', Math.abs(xDiffReal - 0.23625) < 1e-4 && guideSrc.includes('0.236'), `源码分子 ${srcXDiffNum} → ${xDiffReal.toFixed(5)}`);

/* ---- 2. 语义比对：事件空隙「保持」而非插值 ---- */
const tweenSrc = read('core/tween.rs');
const stepHold = /\[\s*\|_\|\s*0\.\s*,\s*\|_\|\s*1\./.test(tweenSrc);
check('tween 0 是阶跃（常量 0）', stepHold, '源码 TWEEN_FUNCTIONS[0] = |_| 0.');
const evs = [
  { st: 0, et: 1, start: 0, end: 100, easingType: 1, easingLeft: 0, easingRight: 1 },
  { st: 10, et: 12, start: 0, end: 0, easingType: 1, easingLeft: 0, easingRight: 1 },
];
const held = evalSeries(evs, 5);
check('空隙保持上一事件结束值', held === 100, `t=5 期望 100，实际 ${held}`);
const beforeEnd = evalSeries(evs, 0.5);
check('事件区间内正常插值', Math.abs(beforeEnd - 50) < 1e-6, `t=0.5 期望 50，实际 ${beforeEnd}`);

/* ---- 3. 语义比对：关键帧 = start(tween) + end(const) ---- */
const parseEvents = read('parse/rpe.rs');
check('parse_events 为每个事件生成 start/end 两个关键帧',
  /kfs\.push\(Keyframe\s*\{\s*time:\s*r\.time\(&e\.start_time\)/.test(parseEvents)
  && /Keyframe::new\(r\.time\(&e\.end_time\), e\.end\.clone\(\)\.into\(\), 0\)/.test(parseEvents),
  'start 用事件缓动，end 用 tween 0（保持）');

/* ---- 4. 只有 speedEvents 被引擎排序；其余事件乱序 = 关键帧失效 ---- */
const speedFn = /fn parse_speed_events\([\s\S]*?\n}/.exec(parseEvents);
const speedSorted = !!speedFn && /events\.sort_by_key\(\|it\| it\.start_time\.beats\(\)/.test(speedFn[0]);
const plainFn = /fn parse_events<[\s\S]*?\n}/.exec(parseEvents);
const plainSorted = !!plainFn && /sort/.test(plainFn[0]);
check('parse_speed_events 会排序、parse_events 不排序',
  speedSorted && !plainSorted,
  `speedEvents 有 sort_by_key=${speedSorted}；通用 parse_events 里的 sort=${plainSorted} → 非 speed 事件乱序会让关键帧错位`);

/* ---- 5. 空事件数组 = 链上无关键帧节点 → panic（前驱有关键帧时） ---- */
const animSrc = read('core/anim.rs');
const chainSrc = /pub fn chain\([\s\S]*?\n    }/.exec(animSrc);
const chainLinks = !!chainSrc && /elements\.last_mut\(\)\.unwrap\(\)\.next = Some\(last\)/.test(chainSrc[0]);
const unwrapNext = /T::add\(&now, &next\.now_opt\(\)\.unwrap\(\)\)/.test(animSrc);
const emptyIsNone = /if self\.keyframes\.is_empty\(\)\s*\{\s*return None;/.test(animSrc);
check('空数组进事件链 → now_opt().unwrap() panic',
  chainLinks && unwrapNext && emptyIsNone,
  `chain 串联=${chainLinks}，unwrap=${unwrapNext}，空关键帧返回 None=${emptyIsNone}`);

/* ---- 6. extra.json 用「自己的 bpm」换算，不是 chart 的 BPMList ---- */
const extraSrc = read('parse/extra.rs');
const ownBpm = /let mut r: BpmList = ext\.bpm\.into\(\);/.test(extraSrc)
  && /r\.time\(&rpe\.start\)/.test(extraSrc);
check('extra.json 的时间基 = 自己的 bpm', ownBpm, 'parse_extra: BpmList::from(ext.bpm) 后 r.time(&effect.start)');

/* ---- 7. Drag 不需要按下（自动判定），不占手指 ---- */
const dragAuto = /if !matches!\(note\.kind, NoteKind::Drag\)\s*&&\s*\(self\.key_down_count == 0/.test(judgeSrc)
  && /reject by drag/.test(judgeSrc);
check('Drag 自动判定、不占手指', dragAuto, 'judge: 无按键时只有 Drag 继续走 PreJudge；点击不会判给 Drag（reject by drag）');

/* ---- 8. 每个触点只判「最近的一个」音符（不是双判） ---- */
const closestOne = /let mut closest = \(None, X_DIFF_MAX/.test(judgeSrc) && /if dt >= closest\.3/.test(judgeSrc);
check('每触点只判最近一个音符', closestOne, 'judge: closest 三元组 + `if dt >= closest.3 { break; }`');

/* ---- 9. 音符坐标 = positionX / 675（世界单位），屏幕 ±1 → |positionX|>675 出界 ---- */
const pxScale = /translation: AnimVector\(AnimFloat::fixed\(note\.position_x \/ \(RPE_WIDTH \/ 2\.\)\)/.test(rpeSrc);
check('音符局部坐标 = position_x / 675', pxScale, 'parse/rpe.rs: translation = position_x / (RPE_WIDTH/2)');

/* ---- 10. 判定横向容差按 judge_area 归一（÷ judge_area） ---- */
const judgeArea = /\(x\.now\(\) - pos\.x\)\.abs\(\) as f64 \/ note\.judge_area as f64/.test(judgeSrc);
check('判定容差 ÷ judge_area', judgeArea, 'judge: dist = |note.x - touch.x| / judge_area');

/* ---- 11. 整数字段清单 vs 源码（生成器写浮点会被这里拦下） ---- */
{
  const { INTEGER_FIELDS } = await import('../lib/validate.js');
  const structs = ['RPENote', 'RPEEvent', 'RPEJudgeLine', 'RPECtrlEvent', 'RPEBpmItem'];
  const INT_RE = /^(u8|u16|u32|i8|i16|i32|i64|isize|usize)\b/;
  const snakeToCamel = (x) => x.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  // serde rename：RPENote.kind 在 JSON 里叫 type
  const ALIAS = { kind: 'type' };
  const ours = new Set(Object.values(INTEGER_FIELDS).flat().map((x) => x.toLowerCase()));
  const miss = [];
  for (const name of structs) {
    const re = new RegExp(`struct ${name}[^{]*\\{([\\s\\S]*?)\\n\\}`);
    const m = re.exec(rpeSrc);
    if (!m) { miss.push(`${name}(结构体未找到)`); continue; }
    for (const line of m[1].split('\n')) {
      const f = /^\s*([a-z_]+):\s*([^,]+),/.exec(line);
      if (!f) continue;
      if (!INT_RE.test(f[2].trim())) continue;
      const camel = (ALIAS[f[1]] || snakeToCamel(f[1])).toLowerCase();
      if (!ours.has(camel) && !ours.has(f[1])) miss.push(`${name}.${f[1]}(${f[2].trim()})`);
    }
  }
  // Triple 是元组结构体（i32, u32, u32）单独核对
  const tripleOk = /struct Triple\(i32,\s*u32,\s*u32\)/.test(core); // core.rs:90
  if (!tripleOk) miss.push('Triple 不是 (i32,u32,u32)');
  check('整数字段清单覆盖 rpe.rs（浮点写入会被拦）', miss.length === 0, miss.join(' / '));
}

/* ---- 输出 ---- */
let bad = 0;
for (const r of results) {
  if (r.ok) console.log(`✅ ${r.name}`);
  else { console.log(`❌ ${r.name} — ${r.detail}`); bad++; }
}
console.log(bad === 0 ? `\n源码一致性校验通过（${results.length} 项，源码：${SRC}）` : `\n${bad} 项不一致`);
process.exit(bad === 0 ? 0 : 1);

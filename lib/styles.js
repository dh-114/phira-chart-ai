/**
 * 风格档案：从 26 个参考谱面统计出的五类"手感画像"（数值为中位数）
 * 供规划器选定结构参数，避免 AI 凭空发挥。
 */
export const STYLES = {
  multiFinger: {
    name: '多指型',
    desc: '同刻 3–8 个音符，单线或少数线承担全部音符，密度极高',
    refs: ['23375', '41292', '46213', '54712'],
    params: { density: 12.5, chord: 5, drag: 0.18, hold: 0.04, flick: 0.02, eventRate: 12 },
  },
  visual: {
    name: '观赏型',
    desc: '假音符与判定线演出为主，真实音符密度中等，重可看性',
    refs: ['28063', '48789', '47280', '38897'],
    params: { density: 6.6, chord: 4, drag: 0.26, hold: 0.08, flick: 0.05, eventRate: 63 },
  },
  endurance: {
    name: '耐力型',
    desc: '超长时长 + 持续高强度，Drag 占比高，靠体力而非爆发',
    refs: ['23375', '46213', '54712'],
    params: { density: 12.7, chord: 6, drag: 0.30, hold: 0.02, flick: 0.03, eventRate: 23 },
  },
  balanced: {
    name: '均衡型',
    desc: '结构规整、手法均衡，适合作为默认风格',
    refs: ['30818', '30907', '53602', '46779', '67921', '75892'],
    params: { density: 4.6, chord: 2, drag: 0.14, hold: 0.13, flick: 0.04, eventRate: 12 },
  },
};

/** 段落模板：比例之和为 1；density 为风格密度的倍数，chord 为同刻音符目标 */
export const SECTION_TEMPLATE = [
  { name: 'intro', frac: 0.06, density: 0.0, chord: 0, tech: [], fx: ['fade'] },
  { name: 'verse', frac: 0.18, density: 0.75, chord: 2, tech: ['stairs', 'trill'], fx: [] },
  { name: 'build', frac: 0.12, density: 0.95, chord: 2, tech: ['trill', 'jack'], fx: [] },
  { name: 'chorus', frac: 0.22, density: 1.15, chord: 2, tech: ['chord', 'stairs', 'hold'], fx: ['color'] },
  { name: 'rest', frac: 0.06, density: 0.0, chord: 0, tech: [], fx: ['fade'] },
  { name: 'verse2', frac: 0.14, density: 0.85, chord: 2, tech: ['stairs', 'jack'], fx: [] },
  { name: 'chorus2', frac: 0.16, density: 1.25, chord: 3, tech: ['chord', 'trill', 'hold'], fx: ['sweep', 'color'] },
  { name: 'outro', frac: 0.06, density: 0.4, chord: 2, tech: ['hold'], fx: ['fade'] },
];

export const STYLE_NAMES = Object.keys(STYLES);

/**
 * 参考谱面的音符分布（**24 个 RPE 谱面 / 22,752 个真音符**实测）。
 *
 * ⚠️ 统计口径排除 23375（耐力谱，693s / 13,868 音符 / 999 个黄键）：
 *    它单张就占全库 38% 的音符，形态极端（黄键 61%），会把分位、分桶、同刻间距全部拽偏 ——
 *    之前文档里的 "中线 25.8%"、同刻间距 "p50 260" 实际上就是这一张谱的形状。
 *
 * 实测（24 谱）：
 * - x 分位：p10 -390 / p25 -241 / p50 0 / p75 253 / p90 390
 * - |x|：p25 130 / p50 248 / p75 375 / p90 405；>400 占 17.9%，>500 仅 0.3%
 * - |x| 每 50px 占比：0-50 14.6%，50-100 5.8，100-150 14.7，150-200 6.9，
 *   200-250 8.0，250-300 10.7，300-350 11.4，350-400 10.0，400-450 13.4，450-500 4.2，>500 0.3
 * - 同刻同线间距：p25 300 / p50 506 / p75 675
 * - 相邻横跳（<0.6s）：p50 270 / p75 506 / p90 675
 * - 音符类型：Tap 56.9% / Hold 13.0% / Flick 5.3% / Drag 24.9%
 */

export const TYPE_MIX = { 1: 0.569, 2: 0.130, 3: 0.053, 4: 0.249 }; // 24 谱（排除耐力谱）

export const REF_DIST = {
  noteCount: 22752,
  charts: 24,
  xQuantiles: { p10: -390, p25: -241, p50: 0, p75: 253, p90: 390 },
  absBuckets: [
    [0, 50, 0.146], [50, 100, 0.058], [100, 150, 0.147], [150, 200, 0.069],
    [200, 250, 0.080], [250, 300, 0.107], [300, 350, 0.114], [350, 400, 0.100],
    [400, 450, 0.134], [450, 500, 0.042], [500, 520, 0.002],
  ],
  edge400: 0.179,
  chordGap: { p25: 300, p50: 506, p75: 675 },
  jump: { p50: 270, p75: 506, p90: 675 },
  minJudgementGap: 213.5, // 同线同刻防抢判定阈值
};

/** 可复现随机数（种子可选） */
export function makeRng(seed) {
  let s = (seed == null ? Date.now() : seed) >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const BUCKET_TOTAL = REF_DIST.absBuckets.reduce((a, b) => a + b[2], 0);

/** 按参考分布采样一个 x（约 15% 落在中线附近，300-450 是次要高点，>500 极少） */
export function sampleX(rng = Math.random) {
  let r = rng() * BUCKET_TOTAL;
  for (const [lo, hi, w] of REF_DIST.absBuckets) {
    r -= w;
    if (r <= 0) {
      const mag = lo + (hi - lo) * rng();
      return Math.round(rng() < 0.5 ? -mag : mag);
    }
  }
  return Math.round((rng() < 0.5 ? -1 : 1) * (300 + rng() * 150));
}

/** 参考分布的 |x| 反查：f∈[0,1] → 该分位对应的横向距离（保序映射用，比线性映射更贴参考） */
export function quantileX(f) {
  const p = Math.max(0, Math.min(0.9999, Number(f) || 0));
  let acc = 0;
  for (const [lo, hi, w] of REF_DIST.absBuckets) {
    const ww = w / BUCKET_TOTAL;
    if (p <= acc + ww) return Math.round(lo + (hi - lo) * ((p - acc) / (ww || 1)));
    acc += ww;
  }
  return 500;
}

/** 同刻 k 个音符的 x 数组：间距取参考中位 260 / p75 520，且不小于判定阈值 */
export function chordXs(k, opt = {}) {
  const lim = opt.limit == null ? 560 : Number(opt.limit);
  const minGap = REF_DIST.minJudgementGap;
  // 能在 ±lim 内放下几个音符且间距 ≥ 判定阈值的上限（8 指根本放不下：7×213.5 > 2×560）
  const maxN = Math.max(2, Math.floor((2 * lim) / minGap) + 1);
  const n = Math.max(2, Math.min(8, maxN, Number(k) || 2));
  const rng = opt.rng || Math.random;
  const wide = rng() < 0.4; // 参考里同刻间距 p50 506 / p75 675，但实际写谱用 300/500 两档更好读
  const want = Math.max(minGap, opt.gap ? Number(opt.gap) : (wide ? 500 : 300));
  // 关键：先按可用宽度**压缩间距**，再对称排布；逐点 clamp 会让 n≥5 时音符挤成 40px 甚至重合
  const gap = Math.min(want, (2 * lim) / (n - 1));
  const shift = opt.centerX == null ? 0 : Number(opt.centerX);
  const out = [];
  for (let i = 0; i < n; i++) out.push(Math.round(clampN((i - (n - 1) / 2) * gap + shift, -lim, lim)));
  return out;
}
const clampN = (v, a, b) => Math.max(a, Math.min(b, v));

/** 楼梯/单点流的横向范围（随难度略放宽，参考 p10–p90 约 ±386） */
export function stairsRange(difficulty = 13) {
  const d = Number(difficulty) || 13;
  const half = Math.round(Math.max(300, Math.min(450, 380 + (d - 13) * 12)));
  return { x0: -half, x1: half };
}

/** 相邻音符允许的最大横跳（参考 p90 ≈ 608，高难略放宽） */
export function maxJump(difficulty = 13) {
  const d = Number(difficulty) || 13;
  return Math.round(Math.max(420, Math.min(760, 600 + (d - 13) * 18)));
}

/** 目标密度（音符/秒）：参考谱面按定数的经验区间 */
export function densityHint(difficulty = 13) {
  const d = Number(difficulty) || 13;
  if (d <= 10) return [1.5, 3.0];
  if (d <= 12) return [2.5, 4.5];
  if (d <= 14) return [4.0, 6.0];
  if (d <= 16) return [5.5, 8.0];
  return [7.0, 10.0];
}

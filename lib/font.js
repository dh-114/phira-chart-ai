/**
 * 5×7 点阵字体 + 文字绘制（用于预览画面的调试信息）
 */
const G = {
  '0': [14, 17, 19, 21, 25, 17, 14], '1': [4, 12, 4, 4, 4, 4, 14], '2': [14, 17, 1, 2, 4, 8, 31],
  '3': [31, 2, 4, 2, 1, 17, 14], '4': [2, 6, 10, 18, 31, 2, 2], '5': [31, 16, 30, 1, 1, 17, 14],
  '6': [6, 8, 16, 30, 17, 17, 14], '7': [31, 1, 2, 4, 8, 8, 8], '8': [14, 17, 17, 14, 17, 17, 14],
  '9': [14, 17, 17, 15, 1, 2, 12],
  A: [14, 17, 17, 31, 17, 17, 17], B: [30, 17, 17, 30, 17, 17, 30], C: [14, 17, 16, 16, 16, 17, 14],
  D: [30, 17, 17, 17, 17, 17, 30], E: [31, 16, 16, 30, 16, 16, 31], F: [31, 16, 16, 30, 16, 16, 16],
  G: [14, 17, 16, 23, 17, 17, 15], H: [17, 17, 17, 31, 17, 17, 17], I: [14, 4, 4, 4, 4, 4, 14],
  J: [7, 2, 2, 2, 2, 18, 12], K: [17, 18, 20, 24, 20, 18, 17], L: [16, 16, 16, 16, 16, 16, 31],
  M: [17, 27, 21, 21, 17, 17, 17], N: [17, 25, 21, 19, 17, 17, 17], O: [14, 17, 17, 17, 17, 17, 14],
  P: [30, 17, 17, 30, 16, 16, 16], Q: [14, 17, 17, 17, 21, 18, 13], R: [30, 17, 17, 30, 20, 18, 17],
  S: [15, 16, 16, 14, 1, 1, 30], T: [31, 4, 4, 4, 4, 4, 4], U: [17, 17, 17, 17, 17, 17, 14],
  V: [17, 17, 17, 17, 17, 10, 4], W: [17, 17, 17, 21, 21, 27, 17], X: [17, 17, 10, 4, 10, 17, 17],
  Y: [17, 17, 10, 4, 4, 4, 4], Z: [31, 1, 2, 4, 8, 16, 31],
  ' ': [0, 0, 0, 0, 0, 0, 0], ':': [0, 4, 4, 0, 4, 4, 0], '.': [0, 0, 0, 0, 0, 4, 4],
  '-': [0, 0, 0, 31, 0, 0, 0], '/': [1, 1, 2, 4, 8, 16, 16], '%': [25, 26, 2, 4, 8, 11, 19],
  '(': [4, 8, 8, 8, 8, 8, 4], ')': [4, 2, 2, 2, 2, 2, 4], '+': [0, 4, 4, 31, 4, 4, 0],
  '=': [0, 0, 31, 0, 31, 0, 0], '_': [0, 0, 0, 0, 0, 0, 31], ',': [0, 0, 0, 0, 4, 4, 8],
  '#': [10, 10, 31, 10, 31, 10, 10], '!': [4, 4, 4, 4, 4, 0, 4], '?': [14, 17, 1, 2, 4, 0, 4],
  '<': [2, 4, 8, 16, 8, 4, 2], '>': [8, 4, 2, 1, 2, 4, 8], '*': [0, 10, 4, 31, 4, 10, 0],
};

export function textWidth(str, scale = 2, tracking = 1) {
  return String(str).length * (5 * scale + tracking * scale) - tracking * scale;
}

/** 在 Surface 上画文字；scale 为每个点的像素边长 */
export function drawText(surf, str, x, y, scale, rgb, alpha = 1, opts = {}) {
  const s = String(str).toUpperCase();
  const tracking = (opts.tracking == null ? 1 : opts.tracking) * scale;
  let cx = Math.round(x);
  const cy = Math.round(y);
  for (const ch of s) {
    const glyph = G[ch] || G['?'];
    for (let row = 0; row < 7; row++) {
      const bits = glyph[row];
      for (let col = 0; col < 5; col++) {
        if (!(bits & (1 << (4 - col)))) continue;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            surf.blend(cx + col * scale + dx, cy + row * scale + dy, rgb[0], rgb[1], rgb[2], alpha);
          }
        }
      }
    }
    cx += 5 * scale + tracking;
  }
  return cx;
}

export function fillRect(surf, x, y, w, h, rgb, alpha = 1) {
  for (let yy = Math.max(0, y | 0); yy < Math.min(surf.h, (y + h) | 0); yy++) {
    for (let xx = Math.max(0, x | 0); xx < Math.min(surf.w, (x + w) | 0); xx++) {
      surf.blend(xx, yy, rgb[0], rgb[1], rgb[2], alpha);
    }
  }
}

export function strokeRect(surf, x, y, w, h, rgb, alpha = 1) {
  surf.line(x, y, x + w, y, 1, rgb, alpha);
  surf.line(x + w, y, x + w, y + h, 1, rgb, alpha);
  surf.line(x + w, y + h, x, y + h, 1, rgb, alpha);
  surf.line(x, y + h, x, y, 1, rgb, alpha);
}

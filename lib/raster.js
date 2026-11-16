/**
 * 极简光栅器 + 纯 JS PNG 编码（无依赖）
 * 用于谱面预览帧输出：线条/圆点/四边形，alpha 混合。
 */
import zlib from 'node:zlib';

export class Surface {
  constructor(w, h) {
    this.w = w; this.h = h;
    this.data = new Uint8ClampedArray(w * h * 4);
  }
  clear(r = 12, g = 14, b = 20) {
    const d = this.data;
    for (let i = 0; i < d.length; i += 4) { d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255; }
  }
  blend(x, y, r, g, b, a = 1) {
    if (a <= 0) return;
    x |= 0; y |= 0;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4, d = this.data;
    const ia = 1 - a;
    d[i] = d[i] * ia + r * a;
    d[i + 1] = d[i + 1] * ia + g * a;
    d[i + 2] = d[i + 2] * ia + b * a;
    d[i + 3] = 255;
  }
  /** 粗线：沿线步进盖圆点 */
  line(x0, y0, x1, y1, width, rgb, a = 1) {
    const dx = x1 - x0, dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    // 半径 <1 时 disc 采样不到像素中心（1px 线会整条消失），这里给最小半径并加密步进
    const r = Math.max(0.71, width / 2);
    const steps = Math.max(1, Math.ceil(len / Math.max(0.35, r * 0.5)));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      this.disc(x0 + dx * t, y0 + dy * t, r, rgb, a);
    }
  }
  disc(cx, cy, r, rgb, a = 1) {
    const r2 = r * r;
    const x0 = Math.floor(cx - r), x1 = Math.ceil(cx + r), y0 = Math.floor(cy - r), y1 = Math.ceil(cy + r);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const ddx = x + 0.5 - cx, ddy = y + 0.5 - cy;
        const d2 = ddx * ddx + ddy * ddy;
        if (d2 <= r2) {
          const cover = Math.min(1, (r2 - d2) / Math.max(1, r * 2)); // 简易抗锯齿
          this.blend(x, y, rgb[0], rgb[1], rgb[2], a * Math.min(1, cover + 0.35));
        }
      }
    }
  }
  /** 凸四边形填充（扫描线） */
  quad(p, rgb, a = 1) {
    const xs = p.map((q) => q[0]), ys = p.map((q) => q[1]);
    const minY = Math.max(0, Math.floor(Math.min(...ys))), maxY = Math.min(this.h - 1, Math.ceil(Math.max(...ys)));
    for (let y = minY; y <= maxY; y++) {
      const cy = y + 0.5;
      const inter = [];
      for (let i = 0; i < 4; i++) {
        const A = p[i], B = p[(i + 1) % 4];
        if ((A[1] <= cy && B[1] > cy) || (B[1] <= cy && A[1] > cy)) {
          inter.push(A[0] + ((cy - A[1]) / (B[1] - A[1])) * (B[0] - A[0]));
        }
      }
      if (inter.length < 2) continue;
      const xa = Math.max(0, Math.floor(Math.min(...inter))), xb = Math.min(this.w - 1, Math.ceil(Math.max(...inter)));
      for (let x = xa; x <= xb; x++) this.blend(x, y, rgb[0], rgb[1], rgb[2], a);
    }
  }
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

export function encodePNG(surface) {
  const { w, h, data } = surface;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    data.subarray(y * w * 4, (y + 1) * w * 4).forEach((v, i) => { raw[y * (w * 4 + 1) + 1 + i] = v; });
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

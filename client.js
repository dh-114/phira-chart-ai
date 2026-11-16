/**
 * Phira 谱面面板（Client 半区 · 本地渲染版）
 * - 浏览器内 60fps 渲染（不再向宿主请求帧序列，消除"播几秒卡几秒"）
 * - 内联在输入框上方（conversation.input.dock），自适应列宽
 * - 轮询 /phira/state：AI 用 phira_panel_open 指定谱面时自动切换；谱面文件改动自动刷新
 */
window.__ModuleLoader__.load({
  id: '@local/phira-chart-ai',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useRef, useEffect, useCallback } = React;

    /* ================= 数学常量 ================= */
    const SPEED_RATIO = 10 / 45 / 0.83175;
    const NOTE_W = 2 * 0.13175016 * 675; // 音符全宽（RPE 像素）
    const PAL = {
      1: [86, 196, 255], 2: [110, 231, 160], 3: [255, 92, 138], 4: [255, 205, 96],
    };
    const LINE_COL = [232, 240, 252];

    /* ================= 缓动（1..29，与 RPE 一致） ================= */
    const PI = Math.PI;
    const p2 = (x) => Math.pow(2, x);
    const bounceOut = (x) => {
      const n1 = 7.5625, d1 = 2.75;
      if (x < 1 / d1) return n1 * x * x;
      if (x < 2 / d1) { const t = x - 1.5 / d1; return n1 * t * t + 0.75; }
      if (x < 2.5 / d1) { const t = x - 2.25 / d1; return n1 * t * t + 0.9375; }
      const t = x - 2.625 / d1; return n1 * t * t + 0.984375;
    };
    const F = {
      sine: (x) => 1 - Math.cos((x * PI) / 2),
      quad: (x) => x * x, cubic: (x) => x * x * x, quart: (x) => x ** 4, quint: (x) => x ** 5,
      expo: (x) => p2(10 * (x - 1)),
      circ: (x) => 1 - Math.sqrt(Math.max(0, 1 - x * x)),
      back: (x) => { const C1 = 1.70158, C3 = C1 + 1; return (C3 * x - C1) * x * x; },
      elastic: (x) => -(p2(10 * x - 10) * Math.sin((x * 10 - 0.75) * ((2 * PI) / 3))),
      bounce: (x) => 1 - bounceOut(1 - x),
    };
    const OUT = (f) => (x) => 1 - f(1 - x);
    const IO = (f) => (x) => { const y = x * 2; return y < 1 ? f(y) / 2 : 1 - f(2 - y) / 2; };
    const EASE = (() => {
      const a = [null, (x) => x];
      a.push(OUT(F.sine), F.sine, OUT(F.quad), F.quad, IO(F.sine), IO(F.quad),
        OUT(F.cubic), F.cubic, OUT(F.quart), F.quart, IO(F.cubic), IO(F.quart),
        OUT(F.quint), F.quint,
        (x) => (x === 1 ? 1 : 1 - p2(-10 * x)), (x) => (x === 0 ? 0 : p2(10 * x - 10)),
        OUT(F.circ), F.circ, OUT(F.back), F.back, IO(F.circ), IO(F.back),
        (x) => (x === 0 ? 0 : x === 1 ? 1 : p2(-10 * x) * Math.sin((x * 10 - 0.75) * ((2 * PI) / 3)) + 1),
        (x) => (x === 0 ? 0 : x === 1 ? 1 : -p2(10 * x - 10) * Math.sin((x * 10 - 10.75) * ((2 * PI) / 3))),
        OUT(F.bounce), F.bounce, IO(F.bounce),
        (x) => (x === 0 ? 0 : x === 1 ? 1 : x < 0.5
          ? -(p2(20 * x - 10) * Math.sin((20 * x - 11.125) * ((2 * PI) / 4.5))) / 2
          : (p2(-20 * x + 10) * Math.sin((20 * x - 11.125) * ((2 * PI) / 4.5))) / 2 + 1));
      return a;
    })();
    const ease = (type, x) => (EASE[Math.max(1, Math.min(29, type | 0))] || EASE[1])(Math.max(0, Math.min(1, x)));

    /* ================= 事件求值（同层首个命中，跨层相加） ================= */
    function evalSeries(evs, t) {
      if (!evs || !evs.length) return 0;
      let lo = 0, hi = evs.length - 1, idx = -1;
      while (lo <= hi) {
        const m = (lo + hi) >> 1;
        if (evs[m][0] <= t) { idx = m; lo = m + 1; } else hi = m - 1;
      }
      if (idx < 0) return evs[0][2] || 0;
      const e = evs[idx];
      const [s, en, a, b, ez, l, r] = e;
      if (t <= en) {
        const span = en - s;
        if (span <= 1e-9) return a || 0;
        let x = (t - s) / span;
        const L = l || 0, R = r == null ? 1 : r;
        if (!(R > L)) { x = Math.max(0, Math.min(1, x)); } else { x = L + Math.max(0, Math.min(1, x)) * (R - L); }
        return (a || 0) + ((b || 0) - (a || 0)) * ease(ez, x);
      }
      return b || 0; // prpr: 区间之间保持（tween 0 = 阶跃），不插值
    }
    const evalLayers = (layers, t, key) => {
      let v = 0;
      for (const ly of layers) v += evalSeries(ly[key], t);
      return v;
    };

    function rotPt(dx, dy, deg) {
      if (!deg) return { x: dx, y: dy };
      const r = (deg * PI) / 180, c = Math.cos(r), s = Math.sin(r);
      return { x: dx * c - dy * s, y: dx * s + dy * c };
    }

    function buildFloor(layers, duration) {
      const step = 0.05;
      const n = Math.ceil(duration / step) + 2;
      const arr = new Float32Array(n);
      let acc = 0;
      for (let i = 1; i < n; i++) {
        const t = (i - 0.5) * step;
        acc += evalLayers(layers, t, 'speed') * SPEED_RATIO * step;
        arr[i] = acc;
      }
      return arr;
    }
    function floorAt(arr, sec) {
      const x = Math.max(0, sec) / 0.05;
      const i = Math.floor(x), f = x - i;
      if (i + 1 >= arr.length) return arr[arr.length - 1];
      return arr[i] * (1 - f) + arr[i + 1] * f;
    }

    function colorAt(evs, t, fb) {
      for (const e of evs || []) {
        if (e[0] <= t && t <= e[1]) {
          const k = e[1] - e[0] <= 1e-9 ? 0 : Math.max(0, Math.min(1, (t - e[0]) / (e[1] - e[0])));
          const a = e[2] || fb, b = e[3] || fb;
          return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
        }
      }
      return fb;
    }

    /* ================= 渲染 ================= */
    function drawScene(ctx, W, H, t, data, opt) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#0a0c11';
      ctx.fillRect(0, 0, W, H);
      if (opt.bg) { // 曲绘背景（等比裁切居中 + 暗化）
        const bw = opt.bg.width, bh = opt.bg.height;
        const sc = Math.max(W / bw, H / bh);
        const dw = bw * sc, dh = bh * sc;
        ctx.globalAlpha = 1 - (opt.dim == null ? 0.6 : opt.dim);
        ctx.drawImage(opt.bg, (W - dw) / 2, (H - dh) / 2, dw, dh);
        ctx.globalAlpha = 1;
      }
      const px = W / 1350, py = H / 900;
      const X = (xr) => (xr + 675) * px;
      const Y = (yr) => (450 - yr) * py;
      const half = (opt.lineLength || 6) * 675;
      const showFake = opt.showFake !== false;
      const noteW = NOTE_W * px;
      let vis = 0, drawn = 0;
      const counts = { 1: 0, 2: 0, 3: 0, 4: 0 };

      for (const l of data.lines) {
        let gx = 0, gy = 0, rot = 0, al = 0;
        for (const ly of l.layers) {
          gx += evalSeries(ly.moveX, t);
          gy += evalSeries(ly.moveY, t);
          rot += evalSeries(ly.rotate, t);
          al += evalSeries(ly.alpha, t);
        }
        rot = -rot;
        al = Math.max(0, Math.min(1, al / 255));
        if (l.txt && l.text && l.text.length) {
          let str = '';
          for (const e of l.text) if (e[0] <= t) str = t <= e[1] ? e[2] : e[3];
          if (str) {
            ctx.save();
            ctx.globalAlpha = Math.max(0.06, Math.min(1, al));
            ctx.fillStyle = '#ffffff';
            ctx.font = `${Math.max(10, Math.round(W / 26))}px system-ui, -apple-system, sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(str, X(gx), Y(gy));
            ctx.restore();
          }
        }
        if (al > 0.02 && !l.txt && !l.ui) {
          vis++;
          const col = colorAt(l.col, t, LINE_COL);
          const p0 = rotPt(-half, 0, rot), p1 = rotPt(half, 0, rot);
          ctx.save();
          ctx.globalAlpha = Math.min(1, al);
          ctx.strokeStyle = `rgb(${col[0] | 0},${col[1] | 0},${col[2] | 0})`;
          ctx.lineWidth = Math.max(1, 0.01 * 675 * px);
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(X(gx + p0.x), Y(gy + p0.y));
          ctx.lineTo(X(gx + p1.x), Y(gy + p1.y));
          ctx.stroke();
          ctx.restore();
          if (opt.showIds) {
            ctx.save();
            ctx.font = `${Math.max(9, Math.round(W / 80))}px ui-monospace, monospace`;
            ctx.fillStyle = 'rgba(255,235,140,.9)';
            const lx = (X(gx + p0.x) + X(gx + p1.x)) / 2;
            const ly = (Y(gy + p0.y) + Y(gy + p1.y)) / 2;
            ctx.fillText(`L${l.idx} x${gx | 0} y${gy | 0} r${(-rot) | 0} a${Math.round(al * 255)}`, Math.max(4, Math.min(W - 190, lx)), Math.max(10, Math.min(H - 6, ly - 6)));
            ctx.restore();
          }
        }

        const notes = l.notes;
        if (!notes.length) continue;
        const incline = evalSeries(l.inc || [], t);           // 倾斜角（度）
        const incSin = Math.sin((incline * PI) / 180);
        const from = t - 0.3, to = t + 12;
        let lo = 0, hi = notes.length;
        while (lo < hi) { const m = (lo + hi) >> 1; if (notes[m].t < from) lo = m + 1; else hi = m; }
        for (let i = lo; i < notes.length; i++) {
          const n = notes[i];
          if (n.t > to) break;
          const isHold = n.ty === 2;
          if (isHold ? t > n.te + 0.05 : t > n.t + 0.06) continue;
          if (n.f && !showFake) continue;
          if (t < n.t - (n.vt || 999999)) continue;
          const spd = n.sp || 1;
          const base = (floorAt(l.floor, n.t) - floorAt(l.floor, t)) * 450 * spd;
          if (Math.abs(base) > 1200) continue;
          const yoff = (n.yo || 0) * spd;
          // prpr: incline_val = 1 - sin(incline) * (base*aspect + yOffset) * 450/360
          // 换算到 RPE 像素后等价于 1 - sin * (base + yoff) / 360
          const incVal = incSin === 0 ? 1 : 1 - incSin * ((base + yoff) / 360);
          const local = rotPt(n.x * incVal, base + yoff, rot);
          const above = n.a === 1;
          const sx = gx + local.x, sy = above ? gy + local.y : gy - local.y;
          const nrot = above ? rot : -rot; // prpr: 背面音符在 scaling(1,-1) 模型下绘制
          const cx = X(sx), cy = Y(sy);
          const wpx = noteW * (n.sz || 1);
          if (cx < -wpx || cx > W + wpx || cy < -wpx * 2 || cy > H + wpx * 2) continue;
          let alpha = Math.max(0, Math.min(1, (n.al == null ? 255 : n.al) / 255));
          if (n.f) alpha *= 0.13;
          if (!isHold && t > n.t) alpha *= Math.max(0, 1 - (t - n.t) / 0.16); // 判定后 0.16s 淡出
          if (alpha <= 0.02) continue;
          if (alpha <= 0.01) continue;
          const col = PAL[n.ty] || PAL[1];
          drawn++; counts[n.ty] = (counts[n.ty] || 0) + 1;

          ctx.save();
          ctx.globalAlpha = alpha;
          if (isHold) {
            const eBase = (floorAt(l.floor, n.te) - floorAt(l.floor, t)) * 450 * spd;
            const tl = rotPt(n.x, eBase + yoff, rot);
            const tx = gx + tl.x, ty = above ? gy + tl.y : gy - tl.y;
            const h = { x: sx, y: sy }, tl2 = { x: tx, y: ty };
            const dx = tl2.x - h.x, dy = tl2.y - h.y;
            const len = Math.hypot(dx, dy);
            if (len > 1) {
              const ux = -dy / len, uy = dx / len, hw = wpx / 2;
              ctx.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},0.3)`;
              ctx.strokeStyle = `rgb(${col[0]},${col[1]},${col[2]})`;
              ctx.lineWidth = 1.4;
              ctx.beginPath();
              ctx.moveTo(X(h.x + ux * hw), Y(h.y + uy * hw));
              ctx.lineTo(X(tl2.x + ux * hw), Y(tl2.y + uy * hw));
              ctx.lineTo(X(tl2.x - ux * hw), Y(tl2.y - uy * hw));
              ctx.lineTo(X(h.x - ux * hw), Y(h.y - uy * hw));
              ctx.closePath();
              ctx.fill(); ctx.stroke();
            }
            ctx.fillStyle = `rgb(${col[0]},${col[1]},${col[2]})`;
            const hw = wpx / 2;
            const hp = rotPt(-hw, 0, nrot), hp2 = rotPt(hw, 0, nrot);
            ctx.beginPath();
            ctx.ellipse(cx, cy, hw * 0.8, hw * 0.5, (nrot * PI) / 180, 0, PI * 2);
            ctx.fill();
          } else if (n.ty === 4) {
            ctx.fillStyle = `rgb(${col[0]},${col[1]},${col[2]})`;
            ctx.beginPath(); ctx.arc(cx, cy, wpx * 0.3, 0, PI * 2); ctx.fill();
          } else if (n.ty === 3) {
            ctx.fillStyle = `rgb(${col[0]},${col[1]},${col[2]})`;
            ctx.beginPath(); ctx.arc(cx, cy, wpx * 0.31, 0, PI * 2); ctx.fill();
            ctx.fillStyle = '#0a0c11';
            ctx.beginPath(); ctx.arc(cx, cy, wpx * 0.13, 0, PI * 2); ctx.fill();
          } else {
            ctx.fillStyle = `rgb(${col[0]},${col[1]},${col[2]})`;
            ctx.translate(cx, cy);
            ctx.rotate((nrot * PI) / 180);
            const hw = wpx / 2, hh = wpx * 0.21;
            ctx.beginPath();
            if (ctx.roundRect) { ctx.roundRect(-hw, -hh, hw * 2, hh * 2, hh * 0.6); ctx.fill(); }
            else ctx.fillRect(-hw, -hh, hw * 2, hh * 2);
          }
          ctx.restore();
        }
      }

      if (opt.debug !== false) {
        const fs = Math.max(10, Math.round(W / 62));
        ctx.save();
        ctx.font = `${fs}px ui-monospace, monospace`;
        ctx.textBaseline = 'top';
        ctx.fillStyle = 'rgba(8,10,14,.72)';
        ctx.fillRect(8, 8, Math.min(W - 16, fs * 34), fs * 4.4);
        ctx.fillStyle = '#d6e2ee';
        ctx.fillText(`T ${t.toFixed(2)}S / ${data.duration.toFixed(1)}S   BPM ${bpmAt(data.bpm, t).toFixed(0)}`, 14, 12);
        ctx.fillText(`NOTES ${data.stats.notes}   LINES ${data.stats.lines} (VIS ${vis})`, 14, 12 + fs * 1.4);
        ctx.fillStyle = '#8c9bac';
        ctx.fillText(`ON SCREEN ${drawn}   T1 ${counts[1]} T2 ${counts[2]} T3 ${counts[3]} T4 ${counts[4]}`, 14, 12 + fs * 2.8);
        ctx.restore();
      }
    }

    function bpmAt(points, t) {
      if (!points || !points.length) return 0;
      let bpm = points[0].bpm, beat = 0, i = 1;
      // 简化：按拍数累计（与引擎一致的分段换算）
      let cur = 0;
      for (i = 0; i < points.length; i++) {
        const p = points[i];
        const nb = i + 1 < points.length ? points[i + 1].b : null;
        const spb = 60 / p.bpm;
        const sec = (nb == null ? Infinity : (nb - p.b) * spb);
        if (t < cur + sec) return p.bpm;
        cur += sec;
        bpm = p.bpm;
      }
      return bpm;
    }

    /* ================= 样式 ================= */
    const CSS = `
.phira-wrap{width:100%;box-sizing:border-box;padding:0 2px 6px;font:12px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--dsw-alias-text-primary,#e6ebf2)}
.phira-pill{display:inline-flex;align-items:center;gap:4px;padding:4px 9px;border-radius:999px;background:var(--dsw-alias-bg-secondary,#1b1e26);color:var(--dsw-alias-text-primary,#e6ebf2);border:1px solid var(--dsw-alias-border-primary,#2a2f3a);cursor:pointer;font-size:12px;max-width:100%;opacity:.85;line-height:1}
.phira-pill-txt{font-size:11px}
@media (max-width:420px){.phira-pill-txt{display:none}}
.phira-panel{width:100%;box-sizing:border-box;display:flex;flex-direction:column;max-height:min(66vh,560px);background:var(--dsw-alias-bg-primary,#14161c);border:1px solid var(--dsw-alias-border-primary,#2a2f3a);border-radius:12px;overflow:hidden}
.phira-head{display:flex;align-items:center;gap:6px;padding:8px;flex-wrap:wrap;background:var(--dsw-alias-bg-secondary,#1b1e26);border-bottom:1px solid var(--dsw-alias-border-primary,#2a2f3a)}
.phira-title{font-weight:600;font-size:13px;white-space:nowrap}
.phira-input{flex:1 1 140px;min-width:0;min-height:32px;padding:5px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-primary,#2a2f3a);background:var(--dsw-alias-bg-primary,#14161c);color:var(--dsw-alias-text-primary,#e6ebf2);font:12px ui-monospace,monospace;box-sizing:border-box}
.phira-btn{min-height:32px;padding:5px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-primary,#2a2f3a);background:var(--dsw-alias-bg-secondary,#1b1e26);color:var(--dsw-alias-text-primary,#e6ebf2);cursor:pointer;font-size:12px;white-space:nowrap}
.phira-btn:disabled{opacity:.5}
.phira-body{padding:8px;overflow:auto;display:flex;flex-direction:column;gap:8px}
.phira-canvas{width:100%;height:auto;display:block;border-radius:8px;background:#000}
.phira-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.phira-range{flex:1 1 120px;min-width:90px;height:26px}
.phira-tiny{font-size:11px;color:var(--dsw-alias-text-secondary,#98a2b3)}
.phira-list{max-height:130px;overflow:auto;border:1px solid var(--dsw-alias-border-primary,#2a2f3a);border-radius:8px}
.phira-item{padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-primary,#2a2f3a);display:flex;gap:6px;align-items:flex-start}
.phira-item:last-child{border-bottom:none}
.phira-jump{cursor:pointer}
.phira-err{color:#ff8080;font-size:11px;word-break:break-all}
.phira-dot{width:7px;height:7px;border-radius:4px;margin-top:6px;flex:0 0 auto}
.phira-check{display:flex;align-items:center;gap:4px}
@media (max-width:640px){.phira-btn{min-height:40px;padding:8px 12px;font-size:13px}.phira-input{min-height:38px;font-size:13px}.phira-panel{max-height:72vh}}
.phira-float{position:fixed;right:8px;bottom:calc(8px + env(safe-area-inset-bottom,0px));z-index:70;width:min(560px,calc(100vw - 16px));padding:0}
.phira-float .phira-pill{margin-left:auto;display:flex;width:max-content;box-shadow:0 4px 16px rgba(0,0,0,.45)}
.phira-float .phira-panel{max-height:min(70vh,520px);box-shadow:0 8px 32px rgba(0,0,0,.55)}
`;
    const LEVEL_COLOR = { error: '#ff6b6b', warn: '#ffc861', info: '#7aa2ff' };
    let dockMounted = false; // dock 槽位是否真的渲染了（用于兜底）

    async function getJSON(url) {
      let r;
      try { r = await fetch(url, { cache: 'no-store' }); } catch (e) { throw new Error('无法连接 Host：' + (e.message || e)); }
      const txt = await r.text();
      let j;
      try { j = JSON.parse(txt); } catch {
        throw new Error(r.status === 404
          ? '/phira 路由不存在：宿主仍是旧版本，请【完全重启 DSH】（可用工具 phira_panel_status 自检）'
          : `HTTP ${r.status}：${txt.slice(0, 100)}`);
      }
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      return j;
    }

    /* ===== 按键音效（WebAudio：解码一次，缓冲区复用，可无限叠加） ===== */
    let __sfx = null;
    async function ensureSfx() {
      if (__sfx) return __sfx;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      const ctx = new AC();
      const buffers = {};
      __sfx = { ctx, buffers };
      await Promise.all(['click', 'drag', 'flick'].map(async (n) => {
        try {
          const r = await fetch(`/phira/sfx?name=${n}`);
          if (!r.ok) return;
          const ab = await r.arrayBuffer();
          buffers[n] = await ctx.decodeAudioData(ab);
        } catch { /* 单个失败不影响其它 */ }
      }));
      return __sfx;
    }
    function playSfx(name) {
      const st = __sfx;
      if (!st || !st.buffers || !st.buffers[name]) return;
      try {
        if (st.ctx.state === 'suspended') st.ctx.resume();
        const src = st.ctx.createBufferSource();
        src.buffer = st.buffers[name];
        const g = st.ctx.createGain();
        g.gain.value = 0.55;
        src.connect(g);
        g.connect(st.ctx.destination);
        src.start();
      } catch { /* 忽略 */ }
    }

    const Style = () => h('style', { 'data-phira-panel': '1' }, CSS);

    function Panel({ floating } = {}) {
      const [open, setOpen] = useState(false);
      const [path, setPath] = useState('');
      const [view, setView] = useState(null);      // { data, pre, report }
      const [err, setErr] = useState('');
      const [time, setTime] = useState(0);
      const [playing, setPlaying] = useState(false);
      const [showFake, setShowFake] = useState(true);
      const [debug, setDebug] = useState(true);
      const [showIds, setShowIds] = useState(false);
      const [bgmOn, setBgmOn] = useState(true);
      const [sfxOn, setSfxOn] = useState(true);
      const [hasMusic, setHasMusic] = useState(false);
      const [busy, setBusy] = useState(false);
      const [hint, setHint] = useState('谱面目录（绝对路径）');
      const [defDir, setDefDir] = useState('');
      const [used, setUsed] = useState(false);
      const bgRef = useRef(null);
      const audioRef = useRef(null);
      const sfxRef = useRef({});
      const sfxNotesRef = useRef([]);
      const lastSecRef = useRef(0);

      const canvasRef = useRef(null);
      const curveRef = useRef(null);
      const viewRef = useRef(null);
      const timeRef = useRef(0);
      const rafRef = useRef(0);
      const pathRef = useRef('');
      const optRef = useRef({ debug: true, showFake: true, lineLength: 6 });
      const lastRev = useRef(-1);
      const lastStat = useRef('');

      useEffect(() => { optRef.current = { ...optRef.current, debug, showFake, showIds }; }, [debug, showFake, showIds]);

      useEffect(() => {
        fetch('/phira/info', { cache: 'no-store' }).then((r) => r.json()).then((j) => {
          if (j && j.ok) { setDefDir(j.defaultDir || ''); setHint(`默认：${j.defaultDir || ''}（${j.platform}）`); }
        }).catch(() => {});
      }, []);

      const redraw = useCallback(() => {
        const cv = canvasRef.current, v = viewRef.current;
        if (!cv || !v) return;
        const ctx = cv.getContext('2d');
        drawScene(ctx, cv.width, cv.height, timeRef.current, v.data, { ...optRef.current, bg: bgRef.current, dim: v.dim });
      }, []);

      const load = useCallback(async (p) => {
        const target = (p || '').trim();
        if (!target) return;
        setBusy(true); setErr('');
        try {
          const [data, report] = await Promise.all([
            getJSON(`/phira/data?path=${encodeURIComponent(target)}`),
            getJSON(`/phira/chart?path=${encodeURIComponent(target)}`).catch(() => null),
          ]);
          // 预处理：排序 + floor 表
          const lines = data.lines.map((l, li) => ({
            ...l,
            idx: l.idx == null ? li : l.idx, // 只保留一个 idx：接口不下发时回退序号（否则显示 Lundefined）
            notes: (l.notes || []).slice().sort((a, b) => a.t - b.t),
            floor: buildFloor(l.layers || [], data.duration),
          })).sort((a, b) => a.z - b.z);
          const pre = { data: { ...data, lines }, report, dim: Number((report && report.info && report.info.backgroundDim) || 0.6) };
          viewRef.current = pre;
          setView(pre);
          pathRef.current = target;
          setPath(target);
          timeRef.current = 0;
          setTime(0);
          optRef.current = { ...optRef.current, lineLength: (data.info && data.info.lineLength) || 6 };
          // 背景曲绘（失败不影响渲染）
          bgRef.current = null;
          // 背景音乐
          try {
            if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
            const a = new Audio(`/phira/music?path=${encodeURIComponent(target)}`);
            a.preload = 'auto';
            a.volume = 0.8;
            a.addEventListener('error', () => setHasMusic(false));
            a.addEventListener('loadedmetadata', () => setHasMusic(true));
            audioRef.current = a;
            lastSecRef.current = 0;
          } catch { setHasMusic(false); }
          // 音效：解码一次（浏览器要求用户手势后才能播放，点播放时再 resume）
          ensureSfx().catch(() => {});
          sfxNotesRef.current = data.lines
            .flatMap((l) => l.notes.map((n) => ({ t: n.t, ty: n.ty, f: n.f, hs: n.hs })))
            .filter((n) => !n.f)
            .sort((x, y) => x.t - y.t);
          try {
            const r = await fetch(`/phira/bg?path=${encodeURIComponent(target)}`, { cache: 'no-store' });
            if (r.ok) {
              const blob = await r.blob();
              bgRef.current = await createImageBitmap(blob);
            }
          } catch { /* 没有背景也能看 */ }
          requestAnimationFrame(redraw);
        } catch (e) {
          setErr(String(e.message || e));
        } finally {
          setBusy(false);
        }
      }, [redraw]);

      /* 轮询面板状态：AI 设路径 / 文件变更自动刷新 */
      useEffect(() => {
        let stop = false;
        const tick = async () => {
          if (stop) return;
          try {
            const st = await getJSON('/phira/state');
            if (st.path) setUsed(true); // 只有插件被实际使用过才显示面板
            if (st.path && (st.rev !== lastRev.current || st.path !== pathRef.current)) {
              lastRev.current = st.rev;
              lastStat.current = `${st.mtime}|${st.size}`;
              await load(st.path);
            } else if (st.path && st.path === pathRef.current) {
              const sig = `${st.mtime}|${st.size}`;
              if (lastStat.current && sig !== lastStat.current) {
                lastStat.current = sig;
                await load(st.path); // 谱面文件变了 → 刷新
              } else if (!lastStat.current) lastStat.current = sig;
            }
          } catch { /* 忽略轮询错误 */ }
        };
        tick();
        const id = setInterval(tick, 1500);
        return () => { stop = true; clearInterval(id); };
      }, [load]);

      // 帧循环里触发按键音效
      const triggerSfx = useCallback((from, to) => {
        if (!sfxOn) return;
        const arr = sfxNotesRef.current;
        if (!arr.length || to <= from) return;
        let lo = 0, hi = arr.length;
        while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m].t <= from) lo = m + 1; else hi = m; }
        let n = 0;
        for (let i = lo; i < arr.length && arr[i].t <= to; i++, n++) {
          if (n > 8) break;
          const n0 = arr[i];
          let name = n0.ty === 3 ? 'flick' : n0.ty === 4 ? 'drag' : 'click'; // prpr: Hold → click
          const hs = String(n0.hs || '').toLowerCase().replace(/\.(ogg|wav|mp3)$/, '');
          if (hs === 'flick' || hs === 'drag' || hs === 'click') name = hs;
          else if (hs) name = name; // 自定义音效文件暂不支持 → 回落默认
          playSfx(name);
        }
      }, [sfxOn]);

      useEffect(() => {
        if (!playing) { cancelAnimationFrame(rafRef.current); return undefined; }
        let last = performance.now();
        const loop = (now) => {
          const dt = Math.min(0.1, (now - last) / 1000);
          last = now;
          const v = viewRef.current;
          const dur = v ? v.data.duration : 0;
          let t = timeRef.current + dt;
          const prev = timeRef.current;
          if (dur && t >= dur) t = 0;
          triggerSfx(prev, t);
          timeRef.current = t;
          setTime(t);
          redraw();
          rafRef.current = requestAnimationFrame(loop);
        };
        rafRef.current = requestAnimationFrame(loop);
        return () => cancelAnimationFrame(rafRef.current);
      }, [playing, redraw, triggerSfx]);

      useEffect(() => {
        const a = audioRef.current;
        if (!a) return;
        if (playing && bgmOn) {
          a.currentTime = Math.max(0, timeRef.current);
          a.play().catch(() => {});
        } else {
          a.pause();
        }
      }, [playing, bgmOn, hasMusic]);


      const seek = useCallback((tt) => {
        const v = viewRef.current;
        const t = Math.max(0, Math.min(tt, v ? v.data.duration : 0));
        timeRef.current = t;
        lastSecRef.current = t;
        const a = audioRef.current;
        if (a && hasMusic && Math.abs(a.currentTime - t) > 0.35) {
          try { a.currentTime = t; } catch { /* 忽略 */ }
        }
        setTime(t);
        redraw();
      }, [redraw]);

      /* 难度曲线 */
      useEffect(() => {
        const cv = curveRef.current, v = viewRef.current;
        if (!cv || !v || !v.report) return;
        const ctx = cv.getContext('2d');
        const W = cv.width, H = cv.height;
        ctx.clearRect(0, 0, W, H);
        const dens = v.report.series.density || [], chord = v.report.series.chord || [];
        const n = dens.length;
        let maxD = 1, maxC = 1;
        for (let i = 0; i < dens.length; i++) if (dens[i] > maxD) maxD = dens[i];
        for (let i = 0; i < chord.length; i++) if (chord[i] > maxC) maxC = chord[i];
        for (let i = 0; i < n; i++) {
          const x = (i / n) * W, w = Math.max(1, W / n - 0.5);
          const hh = (dens[i] / maxD) * (H - 12);
          ctx.fillStyle = 'rgba(86,196,255,.55)';
          ctx.fillRect(x, H - hh, w, hh);
        }
        ctx.strokeStyle = 'rgba(255,205,96,.9)';
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          const x = (i / n) * W, y = H - 4 - (chord[i] / maxC) * (H - 16);
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
        const dur = v.data.duration || 1;
        const mx = Math.min(1, time / dur) * W;
        ctx.strokeStyle = '#ff6b6b';
        ctx.beginPath(); ctx.moveTo(mx, 0); ctx.lineTo(mx, H); ctx.stroke();
      }, [view, time]);

      useEffect(() => { if (view) requestAnimationFrame(redraw); }, [view, redraw]);

      useEffect(() => {
        if (!floating) dockMounted = true; // dock 真的渲染了
      }, [floating]);

      if (!open) {
        return h('div', { className: 'phira-wrap' + (floating ? ' phira-float' : '') }, h(Style),
          h('button', { className: 'phira-pill', onClick: () => setOpen(true), title: 'Phira 谱面面板' }, '🎵', h('span', { className: 'phira-pill-txt' }, 'Phira')));
      }

      const dur = Number(view && view.data && view.data.duration) || 0;
      const report = view && view.report;
      const issues = report ? report.validate.issues : [];
      const d = report ? report.difficulty : null;

      return h('div', { className: 'phira-wrap' + (floating ? ' phira-float' : '') }, h(Style),
        h('div', { className: 'phira-panel' },
          h('div', { className: 'phira-head' },
            h('div', { className: 'phira-title' }, '🎵 Phira'),
            h('input', {
              className: 'phira-input', value: path, placeholder: hint,
              onChange: (e) => setPath(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') load(path); },
            }),
            h('button', { className: 'phira-btn', onClick: () => { if (defDir) setPath(defDir); } }, '默认'),
            h('button', { className: 'phira-btn', onClick: () => load(path), disabled: busy }, busy ? '…' : '加载'),
            h('button', { className: 'phira-btn', onClick: () => { setPlaying(false); setOpen(false); } }, '收起'),
          ),
          h('div', { className: 'phira-body' },
            err ? h('div', { className: 'phira-err' }, err) : null,
            h('canvas', { ref: canvasRef, width: 640, height: 360, className: 'phira-canvas' }),
            h('div', { className: 'phira-row' },
              h('button', { className: 'phira-btn', onClick: () => { ensureSfx().then(() => { try { __sfx && __sfx.ctx.resume(); } catch { /* */ } }).catch(() => {}); setPlaying((v2) => !v2); } }, playing ? '⏸ 暂停' : '▶ 播放'),
              h('input', {
                type: 'range', min: 0, max: Math.max(0.1, dur), step: 0.01, value: time,
                className: 'phira-range', onChange: (e) => seek(Number(e.target.value)),
              }),
              h('span', { className: 'phira-tiny' }, `${time.toFixed(2)} / ${dur.toFixed(1)}s`),
            ),
            h('div', { className: 'phira-row' },
              h('label', { className: 'phira-check phira-tiny' },
                h('input', { type: 'checkbox', checked: showFake, onChange: (e) => { setShowFake(e.target.checked); setTimeout(redraw, 0); } }), ' 假音符'),
              h('label', { className: 'phira-check phira-tiny' },
                h('input', { type: 'checkbox', checked: debug, onChange: (e) => { setDebug(e.target.checked); setTimeout(redraw, 0); } }), ' 调试信息'),
              h('label', { className: 'phira-check phira-tiny' },
                h('input', { type: 'checkbox', checked: showIds, onChange: (e) => { setShowIds(e.target.checked); setTimeout(redraw, 0); } }), ' 线号'),
              h('label', { className: 'phira-check phira-tiny' },
                h('input', { type: 'checkbox', checked: bgmOn && hasMusic, disabled: !hasMusic, onChange: (e) => setBgmOn(e.target.checked) }), hasMusic ? ' 音乐' : ' 无音乐'),
              h('label', { className: 'phira-check phira-tiny' },
                h('input', { type: 'checkbox', checked: sfxOn, onChange: (e) => setSfxOn(e.target.checked) }), ' 音效'),
              d ? h('span', { className: 'phira-tiny' }, `定数 ${d.predicted.toFixed(2)}`) : null,
              report ? h('span', { className: 'phira-tiny' }, `音符 ${report.stats.notes} / 线 ${report.stats.lines}`) : null,
            ),
            h('canvas', { ref: curveRef, width: 640, height: 60, className: 'phira-canvas' }),
            h('div', { className: 'phira-tiny' }, '难度曲线：蓝=每秒物量，黄=同刻，红线=当前时间'),
            h('div', { className: 'phira-tiny' },
              report ? `校验：${report.validate.counts.errors} error / ${report.validate.counts.warnings} warning / ${report.validate.counts.infos} info（点带时间的条目跳帧）` : '未加载谱面'),
            h('div', { className: 'phira-list' },
              issues.length ? issues.map((it, i) => h('div', {
                key: i,
                className: 'phira-item' + (it.t != null ? ' phira-jump' : ''),
                onClick: () => { if (it.t != null) seek(it.t); },
                title: it.at || '',
              },
                h('span', { className: 'phira-dot', style: { background: LEVEL_COLOR[it.level] || '#98a2b3' } }),
                h('span', { style: { flex: '1 1 0', minWidth: 0, wordBreak: 'break-word' } },
                  (it.t != null ? `[${Number(it.t).toFixed(2)}s] ` : '') + it.msg),
              )) : h('div', { className: 'phira-item phira-tiny' }, '没有发现问题'),
            ),
          ),
        ),
      );
    }

    function Launcher() {
      const [show, setShow] = useState(false);
      useEffect(() => {
        if (dockMounted) return undefined;
        const t = setTimeout(() => setShow(!dockMounted), 1500);
        // dock 可能晚于 1.5s 挂载：持续观察，挂上就收回浮动入口，避免两个入口并存
        const iv = setInterval(() => {
          if (dockMounted) { setShow(false); clearInterval(iv); }
        }, 700);
        return () => { clearTimeout(t); clearInterval(iv); };
      }, []);
      if (!show) return null;
      return h(Panel, { floating: true });
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock', id: 'phira-chart-panel', order: 60,
        }, Panel));
        // 兜底：dock 没渲染时，用浮动入口（右上角小药丸 / 浮动卡片）
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay', id: 'phira-chart-panel-float', order: 90,
        }, Launcher));
      },
    };
  },
});

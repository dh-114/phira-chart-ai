/**
 * 标准 MIDI 文件（SMF）解析：tempo map + 音符事件
 * 纯 JS，无依赖。用于把 MIDI 转成谱面时间轴候选。
 */
import fs from 'node:fs';
import { makeBpm } from './rpe.js';

function readVarint(buf, p) {
  let v = 0, i = 0, b;
  do { b = buf[p + i]; v = (v << 7) | (b & 0x7f); i++; } while (b & 0x80);
  return { value: v, next: p + i };
}

export function parseMidi(input) {
  // 兼容传文件路径（脚本常用）或 Buffer/Uint8Array（工具内部）
  const buffer = typeof input === 'string' ? fs.readFileSync(input) : input;
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.length < 14 || buf.toString('ascii', 0, 4) !== 'MThd') throw new Error('不是标准 MIDI 文件（缺少 MThd）');
  const format = buf.readUInt16BE(8);
  const ntrks = buf.readUInt16BE(10);
  const division = buf.readInt16BE(12); // 正数=PPQ，负数=SMPTE

  const tracks = [];
  let p = 14;
  for (let t = 0; t < ntrks && p + 8 <= buf.length; t++) {
    const id = buf.toString('ascii', p, p + 4);
    const len = buf.readUInt32BE(p + 4);
    const body = buf.subarray(p + 8, p + 8 + len);
    p += 8 + len;
    if (id !== 'MTrk') continue;
    tracks.push(parseTrack(body));
  }

  // 汇总 tempo map：tick → 秒
  const tempos = [];
  for (const tr of tracks) for (const ev of tr.events) if (ev.type === 'tempo') tempos.push({ tick: ev.tick, usPerQuarter: ev.usPerQuarter });
  tempos.sort((a, b) => a.tick - b.tick);
  if (!tempos.length) tempos.push({ tick: 0, usPerQuarter: 500000 });
  const ppq = division > 0 ? division : 480;
  const tickToSec = (tick) => {
    // SMF 规定：第一个 tempo 事件之前一律按默认 120BPM（=500000 µs/拍）播放。
    // 旧实现拿 tempos[0] 当起点，tempo 不在 tick 0 时整曲时间会被拉长。
    let sec = 0, last = 0, us = 500000;
    for (const tp of tempos) {
      if (tp.tick >= tick) break;
      sec += ((tp.tick - last) / ppq) * (us / 1e6);
      last = tp.tick; us = tp.usPerQuarter;
    }
    return sec + ((tick - last) / ppq) * (us / 1e6);
  };

  // 音符
  const notes = [];
  tracks.forEach((tr, ti) => {
    const open = new Map();
    for (const ev of tr.events) {
      if (ev.type === 'on' && ev.velocity > 0) {
        const key = `${ev.channel}:${ev.note}`;
        if (!open.has(key)) open.set(key, []);
        open.get(key).push({ tick: ev.tick, velocity: ev.velocity });
      } else if (ev.type === 'off' || (ev.type === 'on' && ev.velocity === 0)) {
        const key = `${ev.channel}:${ev.note}`;
        const arr = open.get(key);
        if (arr && arr.length) {
          const on = arr.shift();
          notes.push({
            track: ti, channel: ev.channel, pitch: ev.note,
            velocity: on.velocity,
            startSec: tickToSec(on.tick), endSec: tickToSec(ev.tick),
            startTick: on.tick, endTick: ev.tick,
          });
        }
      }
    }
  });
  notes.sort((a, b) => a.startSec - b.startSec);
  const lastSec = notes.length ? Math.max(...notes.map((n) => n.endSec)) : 0;
  return {
    format, ppq, tracks: tracks.map((t, i) => ({ index: i, name: t.name || `Track${i}`, notes: notes.filter((n) => n.track === i).length, events: t.events.length })),
    tempos: tempos.map((t) => ({ tick: t.tick, bpm: Math.round(6e7 / t.usPerQuarter) })),
    notes, durationSec: lastSec, tickToSec, ppqValue: ppq,
  };
}

function parseTrack(body) {
  const events = [];
  let p = 0, status = 0, lastChannel = 0, name = null, tick = 0;
  while (p < body.length) {
    const d = readVarint(body, p);
    tick += d.value; p = d.next;
    if (p >= body.length) break;
    const b = body[p];
    if (b & 0x80) {
      status = b;
      p += 1;
      if (status < 0xf0) lastChannel = status; // 记住通道状态，供 running status 复用
    } else if (lastChannel) {
      status = lastChannel; // running status：数据字节沿用上一个通道状态（跨 meta 也容忍）
    } else {
      throw new Error('MIDI 轨道数据损坏（数据字节前没有通道状态）');
    }
    const type = status & 0xf0, ch = status & 0x0f;
    const need = (n) => { const v = body.subarray(p, p + n); p += n; return v; };
    if (status === 0xff) {
      const metaType = body[p++];
      const len = readVarint(body, p); p = len.next;
      const data = body.subarray(p, p + len.value); p += len.value;
      if (metaType === 0x51 && data.length >= 3) events.push({ tick, type: 'tempo', usPerQuarter: (data[0] << 16) | (data[1] << 8) | data[2] });
      else if (metaType === 0x03) name = data.toString('utf8');
      else if (metaType === 0x2f) break;
      continue;
    }
    if (status === 0xf0 || status === 0xf7) {
      const len = readVarint(body, p); p = len.next + len.value;
      continue;
    }
    if (type === 0x90) { const d0 = need(2); events.push({ tick, type: d0[1] ? 'on' : 'off', note: d0[0] & 0x7f, velocity: d0[1] & 0x7f, channel: ch }); }
    else if (type === 0x80) { const d0 = need(2); events.push({ tick, type: 'off', note: d0[0] & 0x7f, velocity: d0[1] & 0x7f, channel: ch }); }
    else if (type === 0xa0) need(2);
    else if (type === 0xb0) need(2);
    else if (type === 0xc0) need(1);
    else if (type === 0xd0) need(1);
    else if (type === 0xe0) need(2);
    else throw new Error(`未知 MIDI 事件 0x${status.toString(16)}`);
  }
  return { events, name };
}

/**
 * 把 MIDI 音符映射成谱面音符候选（pitch → x，时间 → 拍）
 * @param {object} midi parseMidi 结果
 * @param {object} opt { track, pitchMin, pitchMax, xSpan, bpm, minGapSec, maxNotes }
 */
export function midiToChartNotes(midi, opt = {}) {
  const track = opt.track == null ? null : Number(opt.track);
  // BPM 可以是单一数字，也可以是 RPE 风格 [{bpm,startTime}]（多 BPM 曲子必须用后者）
  const bpmList = Array.isArray(opt.bpmList) && opt.bpmList.length ? opt.bpmList : null;
  const bpmIdx = bpmList ? makeBpm(bpmList) : null;
  const bpm = Number(opt.bpm || (bpmList ? bpmList[0].bpm : 180));
  const holdSec = Number(opt.holdThresholdSec == null ? 0.25 : opt.holdThresholdSec);
  const xSpan = Number(opt.xSpan || 400);
  const minGap = Number(opt.minGapSec || 0.02);
  const maxNotes = Number(opt.maxNotes || 2000);
  const list = midi.notes
    .filter((n) => (track == null ? true : n.track === track))
    .filter((n) => n.endSec - n.startSec >= 0);
  const pitches = list.map((n) => n.pitch);
  const pMin = opt.pitchMin != null ? Number(opt.pitchMin) : (pitches.length ? Math.min(...pitches) : 48);
  const pMax = opt.pitchMax != null ? Number(opt.pitchMax) : (pitches.length ? Math.max(...pitches) : 72);
  const span = Math.max(1, pMax - pMin);
  const out = [];
  for (const n of list) {
    if (out.length >= maxNotes) break;
    if (out.length && n.startSec - out[out.length - 1].sec < minGap) continue;
    const x = ((n.pitch - pMin) / span) * 2 * xSpan - xSpan;
    const dur = n.endSec - n.startSec;
    out.push({
      sec: n.startSec,
      beat: bpmIdx ? bpmIdx.beatAt(n.startSec) : (n.startSec * bpm) / 60,
      x: Math.round(Math.max(-600, Math.min(600, x))),
      dur,
      pitch: n.pitch,
      type: dur >= holdSec ? 2 : 1, // 阈值可配（默认 0.25s），避免把 16 分音符全标成长条
    });
  }
  return { notes: out, pitchRange: [pMin, pMax], bpm, bpmList, holdThresholdSec: holdSec, count: out.length, truncated: out.length >= maxNotes };
}

/**
 * Client 半区渲染冒烟：用最小 React polyfill 真跑一次组件，
 * 捕获「Hook 顺序 / TDZ / 渲染期异常」这类会让整个面板消失的错误。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(HERE, '..', 'client.js'), 'utf8');

let factory = null;
globalThis.window = { __ModuleLoader__: { load(o) { factory = o.factory; } } };
globalThis.Audio = function () {
  this.addEventListener = () => {};
  this.play = () => Promise.resolve();
  this.pause = () => {};
  this.cloneNode = () => new globalThis.Audio();
};
globalThis.fetch = () => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ ok: false }), text: () => Promise.resolve('') });
globalThis.performance = { now: () => 0 };
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
globalThis.createImageBitmap = async () => ({ width: 1, height: 1 });

const toggles = [];
const React = {
  createElement: (t, p, ...c) => ({ t, p, c }),
  useState: (v) => [typeof v === 'function' ? v() : v, (n) => toggles.push(n)],
  useRef: (v) => ({ current: v }),
  useEffect: (fn) => { try { fn(); } catch (e) { throw new Error('useEffect 执行失败：' + e.message); } },
  useCallback: (fn) => fn,
};
globalThis.__React__ = React;

// 以函数形式执行模块（client.js 是浏览器包，没有 import/export）
const run = new Function('window', 'Audio', 'fetch', 'performance', 'requestAnimationFrame', 'cancelAnimationFrame', 'createImageBitmap', 'require', src);
run(globalThis.window, globalThis.Audio, globalThis.fetch, globalThis.performance, globalThis.requestAnimationFrame, globalThis.cancelAnimationFrame, globalThis.createImageBitmap, (n) => (n === 'react' ? React : undefined));

if (!factory) { console.log('❌ 未捕获模块工厂'); process.exit(1); }
const registered = new Map();
const mod = factory((n) => (n === 'react' ? React : undefined));
mod.apply({ slots: { inject: (n, cb) => cb(), register: (o, Comp) => { registered.set(o.name, Comp); } } });
const Panel = registered.get('conversation.input.dock');
if (!Panel) { console.log('❌ 面板组件未注册（dock）'); process.exit(1); }
const Launcher = registered.get('shell.overlay');
if (!Launcher) { console.log('❌ 兜底启动器未注册（overlay）'); process.exit(1); }
try {
  const el = Panel();
  const ok = el && el.p && String(el.p.className || '').startsWith('phira-wrap');
  console.log(ok ? '✅ Client 面板渲染成功（折叠态药丸）' : '❌ 渲染结果异常');
  process.exit(ok ? 0 : 1);
} catch (e) {
  console.log('❌ 渲染抛错：' + e.message);
  process.exit(1);
}

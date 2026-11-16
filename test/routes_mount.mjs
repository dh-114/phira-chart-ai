import { apply } from '../index.js';

const routes = new Map();
const ws = { register(r) { routes.set(r.path, r); return () => routes.delete(r.path); } };
let calls = 0;
const ctx = {
  tools: { register() { return () => {}; } },
  // 模拟 webServer 晚于插件激活就绪：前 2 次查询返回 undefined
  get(name) { if (name !== 'webServer') return undefined; calls++; return calls >= 3 ? ws : undefined; },
  effect(fn) { return fn(); },
};
apply(ctx);
console.log('apply 后立即 routes:', [...routes.keys()].length);
setTimeout(() => {
  console.log('1.8s 后 routes:', [...routes.keys()]);
  const ok = routes.has('/phira/info') && routes.has('/phira/chart') && routes.has('/phira/sheet') && routes.has('/phira/frame');
  console.log(ok ? '✅ 延迟就绪也能补挂成功' : '❌ 未挂上');
  process.exit(ok ? 0 : 1);
}, 1800);

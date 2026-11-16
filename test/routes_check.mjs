import { registerRoutes } from '../lib/routes.js';
import { firstChartDir, chartBase } from './_fixtures.mjs';

const routes = new Map();
const ws = { register(route) { routes.set(route.path, route); return () => routes.delete(route.path); } };
registerRoutes(ws, {}, {});

function call(pathname, query = {}) {
  const u = new URL('http://x' + pathname);
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  const out = { headers: null, body: null, status: 200 };
  const res = {
    writeHead(status, headers) { out.status = status; out.headers = headers || {}; },
    end(buf) { out.body = buf; },
  };
  const route = [...routes.values()].find((r) => r.path === pathname.split('?')[0]);
  if (!route) throw new Error('路由未注册: ' + pathname);
  route.handler({ url: u.pathname + u.search }, res);
  return out;
}

const dir = firstChartDir();
if (!dir) { console.log('未找到参考铺面，跳过路由测试'); process.exit(0); }

const l = call('/phira/list', { dir: chartBase() });
const lj = JSON.parse(l.body);
console.log('list:', l.status, '目录数', lj.entries && lj.entries.length);

const c = call('/phira/chart', { path: dir });
const cj = JSON.parse(c.body);
console.log('chart:', c.status, '音符', cj.stats && cj.stats.notes, '校验', cj.validate && cj.validate.counts, '定数', cj.difficulty && cj.difficulty.predicted);
console.log('  series 长度', cj.series && cj.series.density.length, '带时间的告警', (cj.validate.issues || []).filter((i) => i.t != null).length);

const s = call('/phira/sheet', { path: dir, t0: '20', t1: '24', n: '12', w: '320' });
console.log('sheet:', s.status, s.headers['content-type'], 'frames', s.headers['x-frames'], 'frame', s.headers['x-frame-w'] + 'x' + s.headers['x-frame-h'], 'bytes', s.body.length);

const f = call('/phira/frame', { path: dir, t: '30', w: '480' });
console.log('frame:', f.status, f.headers['content-type'], 'bytes', f.body.length);

const bad = call('/phira/chart', { path: process.platform === 'win32' ? 'C:\\Windows' : '/etc' });
console.log('越界路径:', JSON.parse(bad.body).ok === false ? '已拒绝 ✅' : '未拦截 ❌');

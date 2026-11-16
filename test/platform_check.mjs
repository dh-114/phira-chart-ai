import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { roots, inRoots, resolveSafe, defaultDir, platformInfo } from '../lib/paths.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.dirname(HERE);
let bad = 0;
const ok = (name, cond, extra = '') => { console.log(`${cond ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`); if (!cond) bad++; };

const info = platformInfo();
console.log(`平台：${info.platform}/${info.arch}  node ${info.node}`);
console.log(`分隔符：${JSON.stringify(info.sep)}  cwd：${info.cwd}`);
console.log(`允许根目录：\n  ${info.roots.join('\n  ')}`);

ok('cwd 在允许根目录内', inRoots(process.cwd()));
ok('默认目录存在', fs.existsSync(defaultDir()), defaultDir());
const outside = process.platform === 'win32' ? 'C:\\Windows' : '/etc';
let rejected = false;
try { resolveSafe(outside); } catch { rejected = true; }
ok('越界路径被拒绝', rejected, outside);

// 源码里不应再出现硬编码的 Android 路径
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'test' || e.name === '.git') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (e.name.endsWith('.js') || e.name.endsWith('.json') || e.name.endsWith('.yml')) files.push(full);
  }
})(SRC);
const offenders = files.filter((f) => {
  if (['paths.js', 'guide.js'].includes(path.basename(f))) return false; // 平台声明 / 指南文案，允许出现示例路径
  if (!/\.(m?js)$/i.test(f)) return false;                // 只看源码，不扫运行时数据（.panel-state.json 等）
  const txt = fs.readFileSync(f, 'utf8');
  return txt.includes('/storage/emulated');
});
ok('源码无硬编码 Android 路径', offenders.length === 0, offenders.map((f) => path.basename(f)).join(', '));

// 中文路径/文件名可用
const tmpDir = path.join(defaultDir(), '..', '铺面测试', '路径 中文 空格');
try {
  fs.mkdirSync(tmpDir, { recursive: true });
  const f = path.join(tmpDir, '中文 文件.json');
  fs.writeFileSync(f, '{"a":1}');
  ok('中文/空格路径可读写', JSON.parse(fs.readFileSync(f, 'utf8')).a === 1);
  fs.rmSync(tmpDir, { recursive: true, force: true });
} catch (e) {
  ok('中文/空格路径可读写', false, String(e.message));
}

console.log(bad ? `\n${bad} 项失败` : '\n平台自检通过');
process.exit(bad ? 1 : 0);

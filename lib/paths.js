/**
 * 跨平台路径与根目录解析（Android / Linux / macOS / Windows）
 *
 * 规则：
 *  - 允许访问的根目录 = 环境变量 PHIRA_ROOTS（用系统路径分隔符分隔）+ cwd + ~/dsh + ~/phira
 *  - Windows 下大小写不敏感、盘符差异由 path.resolve 归一
 *  - 不再硬编码任何 Android 路径
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const isWin = process.platform === 'win32';

export function roots() {
  const raw = process.env.PHIRA_ROOTS || process.env.DSH_PHIRA_ROOTS || '';
  const list = raw.split(path.delimiter).map((s) => s.trim()).filter(Boolean);
  const cwd = process.cwd();
  const home = os.homedir();
  // 1) 工作目录及其上两级（覆盖工作区与项目根）
  list.push(cwd, path.dirname(cwd), path.dirname(path.dirname(cwd)));
  // 2) 用户目录与常见谱面目录
  list.push(home, path.join(home, 'dsh'), path.join(home, 'phira'), path.join(home, 'charts'));
  // 3) 平台常见挂载点
  if (isWin) {
    try { list.push(path.parse(cwd).root); } catch { /* ignore */ }
    try { list.push(path.parse(home).root); } catch { /* ignore */ }
  } else {
    list.push('/storage/emulated/0', '/sdcard'); // Android 外置存储
    list.push('/mnt', '/media', '/run/media');   // Linux / macOS 常见挂载
  }
  const out = [];
  for (const p of list) {
    let abs;
    try { abs = path.resolve(p); } catch { continue; }
    if (out.includes(abs)) continue;
    try { if (!fs.statSync(abs).isDirectory()) continue; } catch { continue; } // 只保留真实存在的目录
    out.push(abs);
  }
  if (!out.length) out.push(path.resolve(cwd));
  return out;
}

function norm(s) {
  const v = s.replace(/[\\/]+$/, '');
  return isWin ? v.toLowerCase() : v;
}

/**
 * 取「真实路径」：符号链接会被解析掉，这样"根内的软链指向根外"也能被挡住。
 * 路径不存在时沿父级向上找最近的已存在祖先，再把剩余部分接回去。
 */
function realOrSelf(p) {
  try { return fs.realpathSync(p); } catch { /* 不存在或没权限 */ }
  let cur = p;
  for (let i = 0; i < 32; i++) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
    try {
      if (!fs.existsSync(cur)) continue;
      return path.join(fs.realpathSync(cur), path.relative(cur, p));
    } catch { break; }
  }
  return p;
}

const match = (a, rr, sep2) => a === rr || a.startsWith(rr + sep2) || a.startsWith(rr + '/');

export function inRoots(abs, rs = roots()) {
  const candidates = [norm(abs)];
  const real = realOrSelf(abs);
  if (real !== abs) candidates.push(norm(real));
  return rs.some((r) => {
    const rootVariants = [norm(r)];
    const rr = realOrSelf(r);
    if (rr !== r) rootVariants.push(norm(rr));
    // 真实路径和字面路径任一落在根内即通过；但真实路径落在根外时仍要用它判否（软链逃逸）
    return candidates.some((a) => rootVariants.some((x) => match(a, x, path.sep)));
  }) && candidates.every((a) => rs.some((r) => match(a, norm(r), path.sep) || match(a, norm(realOrSelf(r)), path.sep)));
}

/** 默认浏览目录：第一个存在的 <root>/phira，否则 cwd */
export function defaultDir() {
  for (const r of roots()) {
    for (const sub of ['phira', path.join('dsh', 'phira'), path.join('.dsh', 'phira')]) {
      const cand = path.join(r, sub);
      try { if (fs.statSync(cand).isDirectory()) return cand; } catch { /* ignore */ }
    }
  }
  return process.cwd();
}

export function resolveSafe(p) {
  const abs = path.resolve(p || defaultDir());
  if (!inRoots(abs)) {
    throw new Error(`路径不在允许范围内：${abs}（可用环境变量 PHIRA_ROOTS 追加根目录，多个用 "${path.delimiter}" 分隔；当前根：${roots().join(' , ')}）`);
  }
  return abs;
}

export function platformInfo() {
  return {
    platform: process.platform,
    arch: process.arch,
    isWindows: isWin,
    sep: path.sep,
    cwd: process.cwd(),
    home: os.homedir(),
    roots: roots(),
    defaultDir: defaultDir(),
    node: process.version,
  };
}

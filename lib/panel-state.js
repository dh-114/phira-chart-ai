/**
 * 面板共享状态：AI 通过工具设置路径，浏览器面板轮询并自动加载/刷新。
 * 状态持久化到插件目录下的 .panel-state.json（重启后仍记得上一次的谱面）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(HERE, '..', '.panel-state.json');

const state = { path: '', rev: 0, updatedAt: 0 };

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (j && typeof j.path === 'string') { state.path = j.path; state.rev = Number(j.rev) || 0; state.updatedAt = Number(j.updatedAt) || 0; }
  } catch { /* 首次运行没有文件 */ }
}
function save() {
  try { fs.writeFileSync(FILE, JSON.stringify(state, null, 2)); } catch { /* 只读环境忽略 */ }
}
load();

export function setPanelPath(p) {
  state.path = p || '';
  state.rev += 1;
  state.updatedAt = Date.now();
  save();
  return { ...state };
}

export function getPanelState() {
  return { ...state };
}

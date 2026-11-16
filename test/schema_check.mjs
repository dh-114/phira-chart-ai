import { apply } from '../index.js';
import { checkJsonSchema } from '../lib/schema.js';

const defs = [];
const ctx = {
  tools: { register(def) { defs.push(def); return () => {}; } },
  get() { return undefined; },
  inject() {},
  on() {},
  effect() {},
};
apply(ctx);
console.log(`注册工具 ${defs.length} 个`);
let bad = 0;
for (const d of defs) {
  const errs = checkJsonSchema(d.parameters);
  const outOk = d.output && d.output.schema && typeof d.output.schema === 'object';
  if (errs.length || !outOk) {
    bad++;
    console.log(`❌ ${d.name}`);
    for (const e of errs) console.log('   ', e);
    if (!outOk) console.log('    output.schema 缺失或不是对象');
  } else {
    const req = (d.parameters.required || []).join(',') || '—';
    console.log(`✅ ${d.name.padEnd(28)} 参数 ${Object.keys(d.parameters.properties).length} 个，必填 ${req}`);
  }
}
console.log(bad ? `\n有 ${bad} 个工具 schema 不合法` : '\n全部 schema 合法');
process.exit(bad ? 1 : 0);

/**
 * 工具参数规范化：把「字段简写」转成标准 JSON Schema。
 * 原因：ctx.tools.register 期望 ToolSchema.parameters 是完整 JSON Schema；
 * 简写形式（{field:{type,required}}）只有 defineTool() 才会转换，直接用会被模型 API 拒绝。
 */
const VALID_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
const ALLOWED_KEYS = new Set(['type', 'description', 'enum', 'const', 'items', 'properties', 'required',
  'additionalProperties', 'default', 'examples', 'title', 'oneOf', 'anyOf', 'allOf']);

function cleanProperty(v, name) {
  if (!v || typeof v !== 'object') throw new Error(`参数 ${name} 的定义必须是对象`);
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    if (k === 'required') continue; // 顶层 required 数组统一收集
    if (!ALLOWED_KEYS.has(k)) continue; // 丢弃非法关键字，避免模型 API 拒绝
    out[k] = val;
  }
  if (out.type && !VALID_TYPES.has(out.type)) throw new Error(`参数 ${name} 的类型非法：${out.type}`);
  if (out.type === 'array' && out.items && typeof out.items === 'object') {
    out.items = cleanProperty(out.items, `${name}.items`);
  }
  if (out.type === 'object' && out.properties && typeof out.properties === 'object') {
    const props = {};
    const req = Array.isArray(v.required) ? v.required : [];
    for (const [pk, pv] of Object.entries(out.properties)) {
      props[pk] = cleanProperty(pv, `${name}.${pk}`);
      if (pv && pv.required === true && !req.includes(pk)) req.push(pk);
    }
    out.properties = props;
    if (req.length) out.required = req;
    if (out.additionalProperties === undefined) out.additionalProperties = false;
  }
  if (!out.type && !out.properties) out.type = 'string';
  return out;
}

/** 把简写或已规范的参数定义统一成标准 JSON Schema */
export function toJsonSchema(params) {
  if (!params) return { type: 'object', properties: {}, additionalProperties: false };
  if (params.type === 'object' && params.properties) {
    const props = {};
    for (const [k, v] of Object.entries(params.properties)) props[k] = cleanProperty(v, k);
    const required = Array.isArray(params.required) ? params.required.filter((k) => k in props) : [];
    return { type: 'object', properties: props, required, additionalProperties: false };
  }
  const properties = {};
  const required = [];
  for (const [k, v] of Object.entries(params)) {
    properties[k] = cleanProperty(v, k);
    if (v && v.required === true) required.push(k);
  }
  return { type: 'object', properties, required, additionalProperties: false };
}

/** 供自检：检查一个 parameters 是否是合法 JSON Schema 形状 */
export function checkJsonSchema(schema) {
  const errs = [];
  if (!schema || typeof schema !== 'object') return ['schema 不是对象'];
  if (schema.type !== 'object') errs.push('顶层 type 必须是 object');
  if (!schema.properties || typeof schema.properties !== 'object') errs.push('缺少 properties');
  if (schema.required && !Array.isArray(schema.required)) errs.push('required 必须是数组');
  for (const [k, v] of Object.entries(schema.properties || {})) {
    if (!v || typeof v !== 'object') { errs.push(`属性 ${k} 不是对象`); continue; }
    if ('required' in v) errs.push(`属性 ${k} 不应含 required（应放在顶层数组）`);
    if (v.type && !VALID_TYPES.has(v.type)) errs.push(`属性 ${k} 的类型非法：${v.type}`);
    for (const key of Object.keys(v)) if (!ALLOWED_KEYS.has(key)) errs.push(`属性 ${k} 含非法关键字 ${key}`);
  }
  for (const k of schema.required || []) if (!(k in (schema.properties || {}))) errs.push(`required 里的 ${k} 不在 properties 中`);
  return errs;
}

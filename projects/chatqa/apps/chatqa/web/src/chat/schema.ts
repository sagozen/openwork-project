// Kiểm dữ liệu component theo contracts/cqs-components.json trước khi vẽ (cùng luật với Go: internal/components).
// Hỗ trợ đúng phần schema hợp đồng dùng: type, required, properties, items, enum, anyOf, $ref "#/defs/..."; trường thừa được phép.
import contract from '@contracts/cqs-components.json';

type Schema = {
  type?: string | string[];
  required?: string[];
  properties?: Record<string, Schema>;
  items?: Schema;
  enum?: unknown[];
  anyOf?: Schema[];
  $ref?: string;
};

const KINDS = contract.kinds as unknown as Record<string, Schema>;
const DEFS = contract.defs as unknown as Record<string, Schema>;

export const COMPONENT_KINDS = Object.keys(KINDS);

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v === 'object' ? 'object' : typeof v;
}

function is(t: string, v: unknown): boolean {
  if (t === 'integer') return typeof v === 'number' && Number.isInteger(v);
  return typeOf(v) === t;
}

function check(s: Schema, v: unknown, path: string): string | null {
  if (s.$ref) {
    const def = DEFS[s.$ref.replace('#/defs/', '')];
    return def ? check(def, v, path) : `${path}: thiếu ${s.$ref}`;
  }
  if (s.anyOf) return s.anyOf.some((alt) => check(alt, v, path) === null) ? null : `${path}: không khớp dạng nào`;
  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    if (!types.some((t) => is(t, v))) return `${path}: cần ${types.join('|')}, nhận ${typeOf(v)}`;
  }
  if (s.enum && !s.enum.includes(v)) return `${path}: ${String(v)} không hợp lệ`;
  if (typeOf(v) === 'object') {
    const o = v as Record<string, unknown>;
    for (const r of s.required ?? []) if (!(r in o)) return `${path}: thiếu ${r}`;
    for (const [k, ps] of Object.entries(s.properties ?? {})) {
      if (k in o) {
        const err = check(ps, o[k], `${path}.${k}`);
        if (err) return err;
      }
    }
  }
  if (Array.isArray(v) && s.items) {
    for (let i = 0; i < v.length; i++) {
      const err = check(s.items, v[i], `${path}[${i}]`);
      if (err) return err;
    }
  }
  return null;
}

/** null = hợp lệ; chuỗi = vì sao không vẽ được (vẽ JSON thô thay thế). */
export function validateComponent(kind: string, data: unknown): string | null {
  const s = KINDS[kind];
  return s ? check(s, data, kind) : `kind ${kind} không có trong hợp đồng`;
}

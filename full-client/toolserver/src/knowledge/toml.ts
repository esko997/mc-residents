/**
 * Enough TOML to read a mod's `META-INF/mods.toml`: keys, strings (basic, literal, multi-line), booleans,
 * numbers, arrays, inline tables, `[table]` and `[[array of tables]]` headers. Dates and other rarities are
 * kept as their raw text. A malformed file throws; the caller treats that jar as having no metadata.
 */
export type TomlValue = string | number | boolean | TomlValue[] | { [key: string]: TomlValue };
export interface TomlTable { readonly header: string; readonly array: boolean; readonly values: Record<string, TomlValue> }
export interface TomlDocument { readonly root: Record<string, TomlValue>; readonly tables: TomlTable[] }

export function parseToml(text: string): TomlDocument {
  let i = 0;
  const root: Record<string, TomlValue> = {};
  const tables: TomlTable[] = [];
  let current = root;
  const fail = (what: string): never => { throw new Error(`TOML: ${what} at offset ${i}`); };
  const skip = (newlines: boolean) => {
    for (;;) {
      const c = text[i];
      if (c === " " || c === "\t" || c === "\r" || (newlines && c === "\n")) i++;
      else if (c === "#") { while (i < text.length && text[i] !== "\n") i++; }
      else return;
    }
  };
  const basic = (): string => {
    let out = "";
    for (i++; i < text.length && text[i] !== '"'; i++) {
      if (text[i] === "\n") fail("newline in string");
      if (text[i] !== "\\") { out += text[i]; continue; }
      const e = text[++i];
      if (e === "u" || e === "U") {
        const n = e === "u" ? 4 : 8;
        out += String.fromCodePoint(parseInt(text.slice(i + 1, i + 1 + n), 16)); i += n;
      } else out += ({ n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", '"': '"', "\\": "\\" } as Record<string, string>)[e!] ?? e;
    }
    if (text[i] !== '"') fail("unterminated string");
    i++;
    return out;
  };
  const multiline = (quote: string): string => {
    i += 3;
    if (text[i] === "\r") i++;
    if (text[i] === "\n") i++;
    const end = text.indexOf(quote, i);
    if (end < 0) fail("unterminated multi-line string");
    let out = text.slice(i, end);
    i = end + 3;
    if (quote === '"""') out = out.replace(/\\\r?\n\s*/g, "").replace(/\\(["\\nt])/g, (_, c: string) => (c === "n" ? "\n" : c === "t" ? "\t" : c));
    return out;
  };
  const key = (): string[] => {
    const parts: string[] = [];
    for (;;) {
      skip(false);
      if (text[i] === '"') parts.push(basic());
      else if (text[i] === "'") { const end = text.indexOf("'", i + 1); if (end < 0) fail("unterminated key"); parts.push(text.slice(i + 1, end)); i = end + 1; }
      else {
        const match = /^[A-Za-z0-9_-]+/.exec(text.slice(i, i + 200));
        if (!match) fail("expected key");
        parts.push(match![0]); i += match![0].length;
      }
      skip(false);
      if (text[i] !== ".") return parts;
      i++;
    }
  };
  const assign = (target: Record<string, TomlValue>, path: string[], value: TomlValue) => {
    let table = target;
    for (const part of path.slice(0, -1)) {
      const next = table[part];
      if (next && typeof next === "object" && !Array.isArray(next)) table = next;
      else { const made: Record<string, TomlValue> = {}; table[part] = made; table = made; }
    }
    table[path.at(-1)!] = value;
  };
  const value = (): TomlValue => {
    skip(false);
    const c = text[i];
    if (text.startsWith('"""', i)) return multiline('"""');
    if (text.startsWith("'''", i)) return multiline("'''");
    if (c === '"') return basic();
    if (c === "'") { const end = text.indexOf("'", i + 1); if (end < 0) fail("unterminated string"); const out = text.slice(i + 1, end); i = end + 1; return out; }
    if (c === "[") {
      i++;
      const list: TomlValue[] = [];
      for (;;) {
        skip(true);
        if (text[i] === "]") { i++; return list; }
        list.push(value());
        skip(true);
        if (text[i] === ",") i++;
        else if (text[i] !== "]") fail("expected , or ]");
      }
    }
    if (c === "{") {
      i++;
      const table: Record<string, TomlValue> = {};
      skip(false);
      if (text[i] === "}") { i++; return table; }
      for (;;) {
        const path = key();
        if (text[i] !== "=") fail("expected =");
        i++;
        assign(table, path, value());
        skip(false);
        if (text[i] === ",") { i++; continue; }
        if (text[i] === "}") { i++; return table; }
        fail("expected , or }");
      }
    }
    const match = /^[^\s,\]}#]+/.exec(text.slice(i, i + 200));
    if (!match) fail("expected value");
    i += match![0].length;
    const raw = match![0];
    if (raw === "true" || raw === "false") return raw === "true";
    const number = Number(raw.replace(/_/g, ""));
    return Number.isFinite(number) ? number : raw;
  };
  for (;;) {
    skip(true);
    if (i >= text.length) break;
    if (text[i] === "[") {
      const array = text[i + 1] === "[";
      i += array ? 2 : 1;
      const header = key().join(".");
      if (!text.startsWith(array ? "]]" : "]", i)) fail("expected ]");
      i += array ? 2 : 1;
      const table: TomlTable = { header, array, values: {} };
      tables.push(table);
      current = table.values;
      continue;
    }
    const path = key();
    if (text[i] !== "=") fail("expected =");
    i++;
    assign(current, path, value());
  }
  return { root, tables };
}

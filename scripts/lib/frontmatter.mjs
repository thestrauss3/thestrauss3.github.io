// Small reader/writer for the YAML front matter used by posts.
// Supports `key: value` lines with plain, "double-quoted" (JSON-style) or
// 'single-quoted' values, true/false, and one level of nesting: a list of
// flat items (used for `media`), written as
//
//   media:
//     - type: "image"
//       file: ""
//
// Anything more complex isn't supported.

export function parseFrontMatter(source) {
  const text = source.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text);
  if (!m) return { data: {}, body: text };
  const data = {};
  let list = null; // the list currently being filled
  const bare = new Set(); // keys written as a bare `key:`
  for (const line of m[1].split("\n")) {
    const kv = /^([A-Za-z0-9_-]+):(?:\s+(.*))?$/.exec(line);
    if (kv) {
      const raw = (kv[2] ?? "").trim();
      if (raw === "") {
        list = data[kv[1]] = [];
        bare.add(kv[1]);
      } else {
        list = null;
        data[kv[1]] = parseValue(raw);
      }
      continue;
    }
    const item = /^\s+-\s+([A-Za-z0-9_-]+):(?:\s+(.*))?$/.exec(line);
    if (item && list) { list.push({ [item[1]]: parseValue((item[2] ?? "").trim()) }); continue; }
    const field = /^\s+([A-Za-z0-9_-]+):(?:\s+(.*))?$/.exec(line);
    if (field && list?.length) list[list.length - 1][field[1]] = parseValue((field[2] ?? "").trim());
  }
  // A bare `key:` with nothing under it is an empty value, not a list.
  for (const k of bare) if (!data[k].length) data[k] = null;
  return { data, body: text.slice(m[0].length) };
}

function parseValue(raw) {
  if (raw === "" || raw === "~" || raw === "null") return null;
  if (raw === "[]") return [];
  if (raw.startsWith('"')) {
    const end = findClosingQuote(raw);
    try { return JSON.parse(raw.slice(0, end + 1)); } catch { return raw.slice(1, end); }
  }
  if (raw.startsWith("'")) {
    const m = /^'((?:[^']|'')*)'/.exec(raw);
    return m ? m[1].replace(/''/g, "'") : raw;
  }
  const value = raw.replace(/\s+#.*$/, "").trim();
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}

function findClosingQuote(raw) {
  for (let i = 1; i < raw.length; i++) {
    if (raw[i] === "\\") { i++; continue; }
    if (raw[i] === '"') return i;
  }
  return raw.length - 1;
}

export function stringifyFrontMatter(data, body = "") {
  const lines = [];
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      if (!v.length) { lines.push(`${k}: []`); continue; }
      lines.push(`${k}:`);
      for (const item of v) {
        Object.entries(item).forEach(([ik, iv], i) => lines.push(`${i ? "    " : "  - "}${ik}: ${formatValue(iv)}`));
      }
    } else {
      lines.push(`${k}: ${formatValue(v)}`);
    }
  }
  return `---\n${lines.join("\n")}\n---\n${body}`;
}

function formatValue(v) {
  if (v === null || v === undefined) return '""';
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  return JSON.stringify(String(v));
}

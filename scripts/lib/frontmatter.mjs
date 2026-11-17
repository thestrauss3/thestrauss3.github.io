// Small reader/writer for the YAML front matter used by posts.
// Supports `key: value` lines with plain, "double-quoted" (JSON-style) or
// 'single-quoted' values, true/false, and one level of nesting under a bare
// `key:` line: either a map (used for `links`) or a list of flat items (used
// for `media`):
//
//   links:
//     linkedin: "https://..."
//   media:
//     - type: "image"
//       file: ""
//
// Anything more complex isn't supported.

const KEY = "([A-Za-z0-9_-]+)";

export function parseFrontMatter(source) {
  const text = source.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text);
  if (!m) return { data: {}, body: text };
  const data = {};
  let parent = null; // key of the bare `key:` line being filled
  for (const line of m[1].split("\n")) {
    let r;
    if ((r = new RegExp(`^${KEY}:(?:\\s+(.*))?$`).exec(line))) {
      const raw = (r[2] ?? "").trim();
      if (raw === "") { parent = r[1]; data[parent] = null; }
      else { parent = null; data[r[1]] = parseValue(raw); }
    } else if (parent && (r = new RegExp(`^\\s+-\\s+${KEY}:(?:\\s+(.*))?$`).exec(line))) {
      if (!Array.isArray(data[parent])) data[parent] = [];
      data[parent].push({ [r[1]]: parseValue((r[2] ?? "").trim()) });
    } else if (parent && (r = new RegExp(`^\\s+${KEY}:(?:\\s+(.*))?$`).exec(line))) {
      const value = parseValue((r[2] ?? "").trim());
      const cur = data[parent];
      if (Array.isArray(cur) && cur.length) cur[cur.length - 1][r[1]] = value;
      else if (!Array.isArray(cur)) data[parent] = { ...(cur ?? {}), [r[1]]: value };
    }
  }
  return { data, body: text.slice(m[0].length) };
}

function parseValue(raw) {
  if (raw === "" || raw === "~" || raw === "null") return null;
  if (raw === "[]") return [];
  if (raw === "{}") return {};
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
    } else if (v && typeof v === "object") {
      const entries = Object.entries(v);
      if (!entries.length) { lines.push(`${k}: {}`); continue; }
      lines.push(`${k}:`);
      for (const [ik, iv] of entries) lines.push(`  ${ik}: ${formatValue(iv)}`);
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

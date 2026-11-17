// Small reader/writer for the flat YAML front matter used by posts.
// Supports `key: value` lines with plain, "double-quoted" (JSON-style) or
// 'single-quoted' values, plus true/false. Nested YAML is not supported.

export function parseFrontMatter(source) {
  const text = source.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text);
  if (!m) return { data: {}, body: text };
  const data = {};
  for (const line of m[1].split("\n")) {
    const kv = /^([A-Za-z0-9_-]+):(?:\s+(.*))?$/.exec(line);
    if (!kv) continue;
    data[kv[1]] = parseValue((kv[2] ?? "").trim());
  }
  return { data, body: text.slice(m[0].length) };
}

function parseValue(raw) {
  if (raw === "" || raw === "~" || raw === "null") return null;
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
  const lines = Object.entries(data)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${formatValue(v)}`);
  return `---\n${lines.join("\n")}\n---\n${body}`;
}

function formatValue(v) {
  if (v === null) return '""';
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  return JSON.stringify(String(v));
}

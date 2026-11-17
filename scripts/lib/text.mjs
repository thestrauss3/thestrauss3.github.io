// Text helpers for adding posts.

const ABBREVIATIONS = /(?:\b(?:e\.g|i\.e|etc|vs|Mr|Mrs|Ms|Dr|Jr|Sr|St|U\.S|a\.m|p\.m)\.)$/i;

export function normalizeWhitespace(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

// Split into sentences on ., ! or ? followed by whitespace, skipping common
// abbreviations. Good enough for excerpts; edit `summary` by hand when not.
export function splitSentences(text) {
  const flat = normalizeWhitespace(text);
  const out = [];
  let start = 0;
  const re = /[.!?]+["”’)\]]*\s+/g;
  let m;
  while ((m = re.exec(flat))) {
    const candidate = flat.slice(start, m.index + m[0].length).trim();
    if (ABBREVIATIONS.test(candidate.replace(/["”’)\]]+$/, ""))) continue;
    // "unquestionable.. until": a lowercase word next means the sentence goes on.
    if (/^[a-z]/.test(flat.slice(m.index + m[0].length))) continue;
    out.push(candidate);
    start = m.index + m[0].length;
  }
  if (start < flat.length) out.push(flat.slice(start).trim());
  return out.filter(Boolean);
}

// The first one or two complete sentences (two when the first is short).
export function summarize(text, { short = 140, max = 320 } = {}) {
  const sentences = splitSentences(text);
  if (!sentences.length) return "";
  let out = sentences[0];
  if (sentences.length > 1 && out.length < short) out += " " + sentences[1];
  if (out.length > max) out = truncateWords(out, max - 20);
  return out;
}

export function truncateWords(text, limit) {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const space = cut.lastIndexOf(" ");
  return (space > limit * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.–—-]+$/, "") + "…";
}

// LinkedIn text can contain API-style markup for hashtags and mentions.
export function cleanLinkedInText(text) {
  return String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/\{hashtag\|\\?#\|([^}]+)\}/g, "#$1")
    .replace(/@\[([^\]]+)\]\(urn:li:[^)]+\)/g, "$1")
    .trim();
}

// Escapes one line of plain text so Markdown (kramdown) and Liquid show it
// exactly as written:
// - `&` that looks like an entity, `<`, `>`  → HTML entities (no stray tags)
// - `{`  → &#123;, so Liquid never sees `{{` / `{%` and kramdown never sees `{:`
// - `~`  → &#126; (no ~~strikethrough~~ or ~~~ code fences)
// - \ ` * _ [ ] | $  → backslash-escaped (no emphasis, code, links, tables, math)
// - leading spaces dropped (4+ would make a code block)
// - a leading # + - = : or "1." is escaped (no headings, lists, definitions)
export function escapeMarkdownLine(line) {
  return line
    .trimStart()
    .replace(/&(?=#?\w+;)/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\{/g, "&#123;")
    .replace(/~/g, "&#126;")
    .replace(/[\\`*_[\]|$]/g, "\\$&")
    .replace(/^([#+=:-])/, "\\$1")
    .replace(/^(\d+)\.(\s|$)/, "$1\\.$2");
}

// Plain text (as pasted from LinkedIn) to Markdown that renders the same way:
// paragraphs stay paragraphs, "•" lines become a list, other single line
// breaks are kept, and everything else is escaped (see escapeMarkdownLine).
export function textToMarkdown(text) {
  const BULLET = /^\s*[•·▪‣◦]\s*/;
  const escapeLine = escapeMarkdownLine;
  const blocks = String(text ?? "").replace(/\r\n?/g, "\n").trim().split(/\n\s*\n/);
  const out = blocks.map((block) => {
    const lines = block.split("\n").map((l) => l.trimEnd());
    const parts = [];
    let prose = [];
    let list = [];
    const flushProse = () => { if (prose.length) parts.push(prose.map(escapeLine).join("\\\\\n")); prose = []; };
    const flushList = () => { if (list.length) parts.push(list.map((l) => `- ${escapeLine(l)}`).join("\n")); list = []; };
    for (const line of lines) {
      if (BULLET.test(line)) { flushProse(); list.push(line.replace(BULLET, "")); }
      else { flushList(); prose.push(line); }
    }
    flushProse();
    flushList();
    return parts.join("\n\n");
  }).join("\n\n");
  return out;
}

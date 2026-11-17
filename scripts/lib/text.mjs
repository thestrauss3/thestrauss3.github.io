// Text helpers shared by the LinkedIn importer and the publishing job.

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

// LinkedIn exports can contain API-style markup for hashtags and mentions.
export function cleanLinkedInText(text) {
  return String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/\{hashtag\|\\?#\|([^}]+)\}/g, "#$1")
    .replace(/@\[([^\]]+)\]\(urn:li:[^)]+\)/g, "$1")
    .trim();
}

// Rough Markdown-to-plain-text for the LinkedIn share commentary.
export function markdownToPlain(md) {
  return String(md ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/\{%[\s\S]*?%\}|\{\{[\s\S]*?\}\}/g, "")
    .replace(/```[^\n]*\n([\s\S]*?)```/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, "$1 ($2)")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "• ")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export const LINKEDIN_TEXT_LIMIT = 3000;

// Commentary for the LinkedIn share: the whole post when it fits, otherwise
// an excerpt. The canonical site URL always goes at the end.
export function buildShareText({ title, body, url, limit = LINKEDIN_TEXT_LIMIT }) {
  const heading = title ? `${title}\n\n` : "";
  const full = `${heading}${body}\n\nOriginally posted at ${url}`;
  if (full.length <= limit) return full;
  const tail = `\n\nRead the full post: ${url}`;
  const room = limit - heading.length - tail.length;
  const paragraphs = body.split(/\n{2,}/);
  let excerpt = "";
  for (const p of paragraphs) {
    const next = excerpt ? `${excerpt}\n\n${p}` : p;
    if (next.length > room - 4) break; // leave room for the trailing "\n\n…"
    excerpt = next;
  }
  if (!excerpt) excerpt = truncateWords(body.replace(/\s+/g, " "), room - 1);
  else excerpt += "\n\n…";
  return `${heading}${excerpt}${tail}`.slice(0, limit);
}

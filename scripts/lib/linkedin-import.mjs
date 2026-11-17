// Turns rows from LinkedIn's "Shares" export into archive entries.
import { cleanLinkedInText, summarize } from "./text.mjs";

const PUBLIC = new Set(["PUBLIC", "ANYONE"]);
const NONPUBLIC = new Set(["CONNECTIONS", "CONNECTIONS_ONLY", "CONTAINER", "LOGGED_IN", "PRIVATE", "GROUP"]);

// "urn:li:share:123" etc. from a ShareLink such as
// https://www.linkedin.com/feed/update/urn%3Ali%3Ashare%3A123
export function parseShareUrn(link) {
  let decoded = String(link ?? "");
  try { decoded = decodeURIComponent(decoded); } catch { /* keep raw */ }
  const m = /urn:li:(share|ugcPost|activity):(\d+)/.exec(decoded);
  return m ? `urn:li:${m[1]}:${m[2]}` : null;
}

export const permalinkFor = (urn) => `https://www.linkedin.com/feed/update/${urn}/`;

// LinkedIn export dates are UTC, e.g. "2025-11-16 14:22:11".
export function parseExportDate(raw) {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/.exec(String(raw ?? "").trim());
  if (!m) return null;
  const time = m[2].length === 5 ? `${m[2]}:00` : m[2];
  return `${m[1]} ${time} +0000`;
}

const isLinkedInPostUrl = (url) =>
  /linkedin\.com\/(feed\/update|posts)\//i.test(url ?? "") ||
  /urn(:|%3A)li(:|%3A)(share|ugcPost|activity)/i.test(url ?? "");

// Returns { decision: "import" | "exclude" | "review", reason, urn, entry }
export function classifyRow(row) {
  const urn = parseShareUrn(row.ShareLink);
  const date = parseExportDate(row.Date);
  const text = cleanLinkedInText(row.ShareCommentary);
  const visibility = String(row.Visibility ?? "").trim().toUpperCase();
  const sharedUrl = String(row.SharedUrl ?? "").trim();

  if (!urn) return { decision: "exclude", reason: "no post link" };
  if (!date) return { decision: "exclude", urn, reason: `unreadable date "${row.Date}"` };
  if (!text) return { decision: "exclude", urn, reason: "repost (no text of your own)" };

  const entry = {
    title: "",
    source: "linkedin",
    linkedin_id: urn,
    linkedin_url: permalinkFor(urn),
    date,
    summary: summarize(text),
    syndication: "imported",
    // The export gives at most one media link per post, and LinkedIn's media
    // links can expire: download the file and set `file` (see docs/posts.md).
    media: String(row.MediaUrl ?? "").trim()
      ? [{ type: /video/i.test(row.MediaUrl) ? "video" : "image", file: "", alt: "", source_url: row.MediaUrl.trim() }]
      : [],
    visibility: visibility || "UNKNOWN",
    text,
  };

  if (NONPUBLIC.has(visibility)) return { decision: "exclude", urn, reason: `not public (${visibility})`, entry };
  if (!PUBLIC.has(visibility)) return { decision: "review", urn, reason: `unclear visibility "${row.Visibility}"`, entry };
  if (isLinkedInPostUrl(sharedUrl)) return { decision: "review", urn, reason: "repost with your comment", entry };
  return { decision: "import", urn, reason: "original public post", entry };
}

export function fileNameFor(urn) {
  return urn.replace(/^urn:li:/, "").replace(/:/g, "-") + ".md";
}

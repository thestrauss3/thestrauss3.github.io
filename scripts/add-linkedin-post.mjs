#!/usr/bin/env node
// Adds a post you already published on LinkedIn to _posts/ (for backfilling).
//
//   node scripts/add-linkedin-post.mjs <post link> <slug> "<full post text>"
//          [--text-file <file>] [--title "Title"]
//          [--image "description"]... [--video "description"]...
//
// <post link>  the post's linkedin.com/feed/update/urn:li:... URL or a lnkd.in
//              short link (resolved online). The publication date is decoded
//              from the post ID, so you don't need to look it up.
// <slug>       a short name for the post's address, e.g. ai-is-still-a-tool
//              → /posts/2026/07/28/ai-is-still-a-tool/
// --text-file  read the post text from a file instead of the command line
// --image / --video  record each photo or video, in order (repeat per item).
//              Set each item's `file` once the media is in assets/posts/.
//
// Nothing is changed if a post with the same LinkedIn link already exists.
//
// RETIRED (Nov 2026): this was used once to backfill the posts in _posts/ and
// is kept only in case it's needed again. It was never fixed for the issues
// below. Check them before reusing it (each is marked "Known issue N" below):
//
//  1. Link format. Only links containing "urn:li:activity|share|ugcPost:<id>"
//     are recognized, e.g. linkedin.com/feed/update/urn:li:activity:123/.
//     LinkedIn's "⋯ → Copy link to post" usually gives
//     linkedin.com/posts/<user>_<words>-activity-<id>-<hash> instead, which is
//     rejected. Workaround: build the feed/update link from that <id>. Fix:
//     also match /activity-(\d+)/ in parseLinkedInUrn.
//  2. lnkd.in short links. resolveUrn doesn't check the response status, and
//     if the final URL has no ID it takes the first "urn:li:" anywhere in the
//     page. A login wall or interstitial page can contain other posts' IDs,
//     so the post could be saved with the wrong date and link. Workaround: use
//     the full link, not a lnkd.in one.
//  3. Duplicates across ID types. The duplicate check compares exact URNs, so
//     the same post added once by its ugcPost/share URN and once by its
//     activity URN is saved twice. Workaround: always use the activity link.
//  4. Duplicate vs. file-name check order. Both are checked file by file in
//     one loop, so a slug clash in an earlier file throws "already exists"
//     before the loop reaches the file that already has this post. Fix: check
//     every file for the URN first, then check the file name.
//  5. Time zone. siteDay hardcodes America/Los_Angeles instead of reading
//     `timezone` from _config.yml. If that setting changes, the date in the
//     file name and the date in the post's URL can differ near midnight.
//     Fix: read it from _config.yml, or update both together.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontMatter, stringifyFrontMatter } from "./lib/frontmatter.mjs";
import { cleanLinkedInText, summarize, textToMarkdown } from "./lib/text.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// "urn:li:activity:123" etc. from a LinkedIn post link.
// Known issue 1: misses linkedin.com/posts/...-activity-<id>-... links.
export function parseLinkedInUrn(link) {
  let decoded = String(link ?? "");
  try { decoded = decodeURIComponent(decoded); } catch { /* keep raw */ }
  const m = /urn:li:(share|ugcPost|activity):(\d+)/.exec(decoded);
  return m ? `urn:li:${m[1]}:${m[2]}` : null;
}

export const linkedInUrl = (urn) => `https://www.linkedin.com/feed/update/${urn}/`;

// LinkedIn IDs are Snowflake-style: the top 41 bits are milliseconds since 1970.
export function dateFromUrn(urn) {
  const id = BigInt(urn.split(":").pop());
  const d = new Date(Number(id >> 22n));
  if (Number.isNaN(d.getTime()) || d.getUTCFullYear() < 2010 || d > new Date(Date.now() + 86400000)) {
    throw new Error(`Couldn't read a date from ${urn}.`);
  }
  return d;
}

// The site's time zone decides which day a post belongs to.
// Known issue 5: must match `timezone` in _config.yml by hand.
const siteDay = (d) => d.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }); // YYYY-MM-DD
const frontMatterDate = (d) => d.toISOString().replace("T", " ").replace(/\.\d+Z$/, " +0000");

async function resolveUrn(link) {
  const direct = parseLinkedInUrn(link);
  if (direct) return direct;
  if (/^https?:\/\/lnkd\.in\//.test(link)) {
    // Follow redirects; the final URL (or the page) contains the post's ID.
    // Known issue 2: no res.ok check, and the page fallback can pick up
    // another post's ID.
    const res = await fetch(link, { redirect: "follow", headers: { "User-Agent": "Mozilla/5.0" } });
    const found = parseLinkedInUrn(res.url) ?? parseLinkedInUrn(await res.text());
    if (found) return found;
  }
  throw new Error("Couldn't find the post ID in that link. Use the post's ⋯ → Copy link to post.");
}

export function addPost({ urn, slug, text, title = "", media = [], postsDir }) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug ?? "")) {
    throw new Error(`Slug "${slug}" should be lowercase words joined by hyphens, e.g. ai-is-still-a-tool.`);
  }
  const clean = cleanLinkedInText(text);
  if (!clean) throw new Error("The post text is empty.");
  const url = linkedInUrl(urn);
  const date = dateFromUrn(urn);
  const fileName = `${siteDay(date)}-${slug}.md`;

  fs.mkdirSync(postsDir, { recursive: true });
  // Known issue 3: exact URN match only (ugcPost vs. activity IDs differ).
  // Known issue 4: a file-name clash can throw before the duplicate is found.
  for (const f of fs.readdirSync(postsDir).filter((f) => f.endsWith(".md"))) {
    const { data } = parseFrontMatter(fs.readFileSync(path.join(postsDir, f), "utf8"));
    if (parseLinkedInUrn(data.links?.linkedin) === urn) return { file: path.join(postsDir, f), added: false };
    if (f === fileName) throw new Error(`${f} already exists. Pick another slug.`);
  }

  const file = path.join(postsDir, fileName);
  fs.writeFileSync(file, stringifyFrontMatter({
    title,
    date: frontMatterDate(date),
    summary: summarize(clean),
    links: { linkedin: url },
    media: media.map((m) => ({ type: m.type, file: "", alt: m.alt ?? "" })),
  }, textToMarkdown(clean) + "\n"));
  return { file, added: true };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let title = "";
  let textFile = null;
  const media = [];
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--title") title = args[++i] ?? "";
    else if (args[i] === "--text-file") textFile = args[++i];
    else if (args[i] === "--image" || args[i] === "--video") media.push({ type: args[i].slice(2), alt: args[++i] ?? "" });
    else rest.push(args[i]);
  }
  const [link, slug] = rest;
  const text = textFile ? fs.readFileSync(textFile, "utf8") : rest[2];
  if (!link || !slug || !text) {
    console.log('Usage: node scripts/add-linkedin-post.mjs <post link> <slug> "<full post text>" [--text-file <file>] [--title "Title"] [--image "description"]... [--video "description"]...');
    process.exit(1);
  }
  try {
    const urn = await resolveUrn(link);
    const { file, added } = addPost({ urn, slug, text, title, media, postsDir: path.join(repoRoot, "_posts") });
    console.log(`${added ? "Added" : "Already there, left unchanged:"} ${path.relative(repoRoot, file)}`);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

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
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontMatter, stringifyFrontMatter } from "./lib/frontmatter.mjs";
import { cleanLinkedInText, summarize, textToMarkdown } from "./lib/text.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// "urn:li:activity:123" etc. from a LinkedIn post link.
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
const siteDay = (d) => d.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }); // YYYY-MM-DD
const frontMatterDate = (d) => d.toISOString().replace("T", " ").replace(/\.\d+Z$/, " +0000");

async function resolveUrn(link) {
  const direct = parseLinkedInUrn(link);
  if (direct) return direct;
  if (/^https?:\/\/lnkd\.in\//.test(link)) {
    // Follow redirects; the final URL (or the page) contains the post's ID.
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

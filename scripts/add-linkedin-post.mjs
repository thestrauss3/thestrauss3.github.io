#!/usr/bin/env node
// Adds one LinkedIn post to _linkedin/ by hand (no data export needed).
//
//   node scripts/add-linkedin-post.mjs <post link> "<full post text>" [--title "Article title"]
//          [--image "description"]... [--video "description"]...
//
// --image / --video record each photo or video the post has, in order (repeat
// the flag for each one). The description doubles as alt text later. The
// media files themselves are added by hand: set each item's `file`.
//
// The link can be the post's https://www.linkedin.com/feed/update/urn:li:... URL
// (best) or a lnkd.in short link, which is resolved online. The publication
// date is decoded from the post ID, so you don't need to look it up.
// Rerunning with the same post does nothing (edit the file instead).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stringifyFrontMatter } from "./lib/frontmatter.mjs";
import { fileNameFor, parseShareUrn, permalinkFor } from "./lib/linkedin-import.mjs";
import { cleanLinkedInText, summarize } from "./lib/text.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// LinkedIn IDs are Snowflake-style: the top 41 bits are milliseconds since 1970.
export function dateFromUrn(urn) {
  const id = BigInt(urn.split(":").pop());
  const d = new Date(Number(id >> 22n));
  if (Number.isNaN(d.getTime()) || d.getUTCFullYear() < 2010 || d > new Date(Date.now() + 86400000)) {
    throw new Error(`Couldn't read a date from ${urn}.`);
  }
  return d;
}

const exportDate = (d) => d.toISOString().replace("T", " ").replace(/\.\d+Z$/, " +0000");

async function resolveUrn(link) {
  const direct = parseShareUrn(link);
  if (direct) return direct;
  if (/^https?:\/\/lnkd\.in\//.test(link)) {
    // Follow redirects; the final URL (or the page) contains the post's URN.
    const res = await fetch(link, { redirect: "follow", headers: { "User-Agent": "Mozilla/5.0" } });
    const found = parseShareUrn(res.url) ?? parseShareUrn(await res.text());
    if (found) return found;
  }
  throw new Error("Couldn't find the post ID in that link. Use the post's linkedin.com/feed/update/urn:li:... link (⋯ menu → Copy link to post).");
}

export function addPost({ urn, text, title = "", media = [], outDir }) {
  const clean = cleanLinkedInText(text);
  if (!clean) throw new Error("Give the post's first sentence or two.");
  const file = path.join(outDir, fileNameFor(urn));
  if (fs.existsSync(file)) return { file, added: false };
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(file, stringifyFrontMatter({
    title,
    source: "linkedin",
    linkedin_id: urn,
    linkedin_url: permalinkFor(urn),
    date: exportDate(dateFromUrn(urn)),
    summary: summarize(clean),
    syndication: "imported",
    // Photos/videos on the original post. `file` is empty until the media is
    // downloaded into the repo; the site doesn't display media yet.
    media: media.map((m) => ({ type: m.type, file: "", alt: m.alt ?? "" })),
    text: clean,
  }));
  return { file, added: true };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let title = "";
  const media = [];
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--title") title = args[++i] ?? "";
    else if (args[i] === "--image" || args[i] === "--video") media.push({ type: args[i].slice(2), alt: args[++i] ?? "" });
    else rest.push(args[i]);
  }
  const [link, text] = rest;
  if (!link || !text) {
    console.log('Usage: node scripts/add-linkedin-post.mjs <post link> "<full post text>" [--title "Article title"] [--image "description"]... [--video "description"]...');
    process.exit(1);
  }
  try {
    const urn = await resolveUrn(link);
    const { file, added } = addPost({ urn, text, title, media, outDir: path.join(repoRoot, "_linkedin") });
    const date = dateFromUrn(urn).toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", dateStyle: "medium" });
    console.log(`${added ? "Added" : "Already there, left unchanged:"} ${path.relative(repoRoot, file)} (${date})`);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

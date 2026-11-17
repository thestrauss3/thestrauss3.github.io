#!/usr/bin/env node
// Shares newly published site posts to LinkedIn. Run by
// .github/workflows/linkedin-syndication.yml; see docs/posts.md.
//
//   node scripts/syndicate.mjs --state-dir <checkout of the linkedin-syndication branch>
//
// Environment:
//   LINKEDIN_ACCESS_TOKEN       OAuth token with w_member_social (GitHub secret)
//   LINKEDIN_AUTHOR_URN         optional, urn:li:person:... (skips the userinfo lookup)
//   LINKEDIN_TOKEN_EXPIRES_AT   optional ISO date, for an early warning
//   SITE_URL                    e.g. https://josephstrauss.dev
//   MODE                        process (default) | retry | record | skip
//   POST_SLUG, LINKEDIN_URL     for the manual modes
//   NO_GIT=1                    write state.json but don't commit/push (local dry runs)
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { applyManual, createLinkedInApi, discover, emptyState, loadPosts, processPending } from "./lib/syndication.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = process.env;

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
}

const stateDir = path.resolve(arg("--state-dir") ?? ".syndication-state");
const stateFile = path.join(stateDir, "state.json");
const siteUrl = (env.SITE_URL || "https://josephstrauss.dev").replace(/\/$/, "");
const liveWaitMs = Number(env.LIVE_WAIT_MS ?? 12 * 60 * 1000);
const mode = (env.MODE || "process").trim();

const git = (...args) => execFileSync("git", ["-C", stateDir, ...args], { stdio: ["ignore", "pipe", "pipe"] }).toString();

let lastSaved = null;
function save(state) {
  const { updated_at, ...content } = state;
  const snapshot = JSON.stringify(content);
  if (snapshot === lastSaved && fs.existsSync(stateFile)) return;
  lastSaved = snapshot;
  state.updated_at = new Date().toISOString();
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n");
}

// Commits and pushes the state. Throws if the push fails, which stops the run
// before any share is sent without its record saved.
function persistWith(state) {
  return async (message) => {
    save(state);
    if (env.NO_GIT === "1") return;
    git("add", "state.json");
    if (!git("status", "--porcelain").trim()) return;
    git("commit", "-q", "-m", message);
    git("push", "-q", "origin", "HEAD:linkedin-syndication");
  };
}

// Waits (once per run, shared across posts) for the post's page to be served.
let liveDeadline = null;
async function checkLive(url, slug) {
  liveDeadline ??= Date.now() + liveWaitMs;
  const marker = `<meta name="post-id" content="${slug}">`;
  for (;;) {
    try {
      const res = await fetch(`${url}?v=${Date.now()}`, { cache: "no-store", signal: AbortSignal.timeout(15000) });
      if (res.ok && (await res.text()).includes(marker)) return true;
    } catch { /* not up yet */ }
    if (Date.now() >= liveDeadline) return false;
    await new Promise((r) => setTimeout(r, 20000));
  }
}

function summarize(report, state, notes) {
  const lines = ["## LinkedIn cross-posting", ""];
  for (const n of notes) lines.push(`> ${n}`, "");
  if (report.posted.length) {
    lines.push("**Shared**", ...report.posted.map((p) => `- \`${p.slug}\` → ${p.url}${p.verified ? "" : " (permalink not verified)"}`), "");
  }
  if (report.waiting.length) {
    lines.push("**Pending (saved, will be shared later)**", ...report.waiting.map((w) => `- \`${w.slug}\`: ${w.reason}`), "");
  }
  if (report.problems.length) {
    lines.push("**Needs attention**", ...report.problems.map((p) => `- \`${p.slug}\` (${p.status}): ${p.action}${p.error ? ` Details: ${p.error}` : ""}`), "");
  }
  if (report.unverified.length) {
    lines.push("**Shared, link not verified yet** (the site hides the Discuss link until it is; rechecked every run. " +
      "If the link opens the post, run the workflow with mode=record and that URL.)",
      ...report.unverified.map((u) => `- \`${u.slug}\` → ${u.url}`), "");
  }
  const counts = {};
  for (const e of Object.values(state.posts)) counts[e.status] = (counts[e.status] ?? 0) + 1;
  lines.push(`State: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ") || "no site posts yet"}.`);
  const text = lines.join("\n");
  console.log(text);
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, text + "\n");
}

async function main() {
  const now = new Date();
  const notes = [];
  let state;
  if (fs.existsSync(stateFile)) {
    state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    const { updated_at, ...content } = state;
    lastSaved = JSON.stringify(content);
  } else {
    // Posts dated on or after SHARE_POSTS_SINCE (a fixed date set in the
    // workflow) are eligible; anything older counts as backfill.
    const since = new Date(`${env.SHARE_POSTS_SINCE || now.toISOString().slice(0, 10)}T00:00:00-08:00`);
    if (Number.isNaN(since.getTime())) throw new Error(`SHARE_POSTS_SINCE "${env.SHARE_POSTS_SINCE}" isn't a YYYY-MM-DD date.`);
    state = emptyState(since);
    notes.push(`Started a new state file. Posts dated before ${env.SHARE_POSTS_SINCE || "today"} won't be shared automatically.`);
  }
  const persist = persistWith(state);
  const posts = loadPosts(path.join(repoRoot, "_posts"));

  if (mode !== "process") {
    applyManual(state, { mode, slug: env.POST_SLUG?.trim(), linkedinUrl: env.LINKEDIN_URL }, posts, now);
    await persist(`LinkedIn: manual ${mode} ${env.POST_SLUG}`);
    notes.push(`Applied manual "${mode}" to \`${env.POST_SLUG}\`.`);
  }

  const found = discover(state, posts, now);
  if (found.length || !fs.existsSync(stateFile)) await persist(`LinkedIn: found ${found.length} new post(s)`);

  const expires = env.LINKEDIN_TOKEN_EXPIRES_AT ? new Date(env.LINKEDIN_TOKEN_EXPIRES_AT) : null;
  if (expires && !Number.isNaN(expires.getTime())) {
    const days = Math.floor((expires - now) / 86400000);
    if (days < 10) notes.push(`⚠️ The LinkedIn token ${days < 0 ? "expired" : `expires in ${days} day(s)`} (${expires.toISOString().slice(0, 10)}). Reauthorize: see docs/posts.md.`);
  }

  const api = createLinkedInApi({ token: env.LINKEDIN_ACCESS_TOKEN, authorUrn: env.LINKEDIN_AUTHOR_URN?.trim() || undefined });
  const report = await processPending({ state, posts, api, persist, checkLive, siteUrl, log: console.log });
  await persist("LinkedIn: update state");
  summarize(report, state, notes);

  if (report.waiting.length || report.problems.length) {
    console.error("::error::Some posts still need LinkedIn attention. See the run summary.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`::error::${err.message}`);
  process.exit(1);
});

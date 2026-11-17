import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyManual, createLinkedInApi, discover, emptyState, loadPosts, processPending } from "../lib/syndication.mjs";
import { buildShareText, summarize } from "../lib/text.mjs";

const NOW = new Date("2026-11-20T18:00:00Z");
const SITE = "https://josephstrauss.dev";

function postsDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "posts-"));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  return dir;
}

const NEW_POST = '---\ntitle: "Search that scales"\n---\nOpenSearch made it fast. Here is how.\n';

// Fake LinkedIn: records every request; `share` decides the POST response.
function fakeLinkedIn({ share = () => ({ status: 201, id: "urn:li:share:7000000000000000001" }), userinfo = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, method: opts.method ?? "GET", body: opts.body, headers: opts.headers });
    if (url.endsWith("/v2/userinfo")) {
      return new Response(JSON.stringify({ sub: "abc123" }), { status: userinfo });
    }
    if (url.endsWith("/v2/ugcPosts")) {
      const r = share(calls.filter((c) => c.url.endsWith("/v2/ugcPosts")).length);
      if (r.throws) throw Object.assign(new Error("timed out"), { name: r.throws });
      return new Response(r.body ?? "", { status: r.status, headers: r.id ? { "x-restli-id": r.id } : {} });
    }
    if (url.startsWith("https://www.linkedin.com/feed/update/")) {
      return new Response("<html>post 7000000000000000001</html>", { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const posts = () => calls.filter((c) => c.url.endsWith("/v2/ugcPosts"));
  return { calls, posts, fetchImpl };
}

async function run(state, dir, li, { token = "tok", live = true } = {}) {
  const posts = loadPosts(dir);
  discover(state, posts, NOW);
  const persisted = [];
  const report = await processPending({
    state, posts, siteUrl: SITE, now: () => NOW,
    api: createLinkedInApi({ token, fetchImpl: li.fetchImpl, timeoutMs: 1000 }),
    persist: async (msg) => persisted.push([msg, JSON.parse(JSON.stringify(state))]),
    checkLive: async () => live,
  });
  return { report, persisted };
}

function freshState() {
  return emptyState(new Date("2026-11-01T00:00:00Z"));
}

test("first publication shares once; reruns and edits skip it", async () => {
  const dir = postsDir({ "2026-11-20-search-that-scales.md": NEW_POST });
  const state = freshState();
  const li = fakeLinkedIn();

  const { report, persisted } = await run(state, dir, li);
  assert.equal(li.posts().length, 1);
  const entry = state.posts["search-that-scales"];
  assert.equal(entry.status, "posted");
  assert.equal(entry.linkedin_id, "urn:li:share:7000000000000000001");
  assert.equal(entry.linkedin_url, "https://www.linkedin.com/feed/update/urn:li:share:7000000000000000001/");
  assert.equal(entry.permalink_verified, true);
  assert.equal(report.posted.length, 1);
  // The in-flight record was saved before the request went out.
  assert.equal(persisted[0][1].posts["search-that-scales"].status, "in_flight");

  const body = JSON.parse(li.posts()[0].body);
  const share = body.specificContent["com.linkedin.ugc.ShareContent"];
  assert.equal(body.author, "urn:li:person:abc123");
  assert.equal(share.media[0].originalUrl, `${SITE}/posts/search-that-scales/`);
  assert.match(share.shareCommentary.text, /OpenSearch made it fast/);
  assert.match(share.shareCommentary.text, /https:\/\/josephstrauss\.dev\/posts\/search-that-scales\//);
  assert.equal(body.visibility["com.linkedin.ugc.MemberNetworkVisibility"], "PUBLIC");

  await run(state, dir, li);
  fs.writeFileSync(path.join(dir, "2026-11-20-search-that-scales.md"), NEW_POST + "\nAn edit.\n");
  await run(state, dir, li);
  assert.equal(li.posts().length, 1);
});

test("drafts, future posts, opted-out and backfilled posts never share", async () => {
  const dir = postsDir({
    "2026-11-19-draft.md": "---\npublished: false\n---\nNot yet.\n",
    "2026-12-25-future.md": "---\ntitle: \"\"\n---\nLater.\n",
    "2026-11-19-quiet.md": "---\nsyndicate: false\n---\nSite only.\n",
    "2024-01-10-old-article.md": "---\ntitle: \"Old\"\n---\nBackfilled.\n",
    "2026-10-20-before-cutoff.md": "---\n---\nBefore setup.\n",
  });
  const state = freshState();
  const li = fakeLinkedIn();
  await run(state, dir, li);
  assert.equal(li.posts().length, 0);
  assert.equal(state.posts.draft, undefined);
  assert.equal(state.posts.future, undefined);
  assert.equal(state.posts.quiet.status, "skipped");
  assert.equal(state.posts["old-article"].status, "skipped");
  assert.equal(state.posts["before-cutoff"].status, "skipped");
});

test("imported LinkedIn posts are never read by the publisher", () => {
  // The publisher only reads _posts/; imports live in _linkedin/.
  const dir = postsDir({ "share-111.md": "---\nsource: \"linkedin\"\nsyndication: \"imported\"\n---\n" });
  assert.deepEqual(loadPosts(dir), []);
});

test("a timeout is held for reconciliation, then a manual retry shares once", async () => {
  const dir = postsDir({ "2026-11-20-flaky.md": NEW_POST });
  const state = freshState();
  let fail = true;
  const li = fakeLinkedIn({ share: () => (fail ? { throws: "TimeoutError" } : { status: 201, id: "urn:li:share:7000000000000000001" }) });

  const first = await run(state, dir, li);
  assert.equal(state.posts.flaky.status, "unknown");
  assert.equal(first.report.problems[0].slug, "flaky");

  fail = false;
  await run(state, dir, li);
  assert.equal(li.posts().length, 1, "unknown shares are not retried automatically");

  applyManual(state, { mode: "retry", slug: "flaky" }, loadPosts(dir), NOW);
  await run(state, dir, li);
  assert.equal(state.posts.flaky.status, "posted");
  assert.equal(li.posts().length, 2);
});

test("a run that died mid-request (in_flight) is not retried", async () => {
  const dir = postsDir({ "2026-11-20-crashed.md": NEW_POST });
  const state = freshState();
  state.posts.crashed = { status: "in_flight", date: NOW.toISOString(), attempts: 1 };
  const li = fakeLinkedIn();
  const { report } = await run(state, dir, li);
  assert.equal(li.posts().length, 0);
  assert.equal(report.problems[0].status, "in_flight");
});

test("record mode stores an existing LinkedIn post without sharing", async () => {
  const dir = postsDir({ "2026-11-20-crashed.md": NEW_POST });
  const state = freshState();
  state.posts.crashed = { status: "unknown", date: NOW.toISOString() };
  applyManual(state, { mode: "record", slug: "crashed", linkedinUrl: "https://www.linkedin.com/feed/update/urn:li:share:42/" }, loadPosts(dir), NOW);
  const li = fakeLinkedIn();
  const { report } = await run(state, dir, li);
  assert.equal(li.posts().length, 0);
  assert.equal(state.posts.crashed.status, "posted");
  assert.equal(state.posts.crashed.linkedin_id, "urn:li:share:42");
  assert.equal(report.problems.length, 0);
});

test("expired or missing authorization keeps the share pending", async () => {
  const dir = postsDir({ "2026-11-20-a.md": NEW_POST, "2026-11-20-b.md": NEW_POST });
  const state = freshState();

  const missing = await run(state, dir, fakeLinkedIn(), { token: "" });
  assert.match(missing.report.authProblem, /not set/);
  assert.equal(state.posts.a.status, "pending");

  const expired = fakeLinkedIn({ userinfo: 401 });
  const r = await run(state, dir, expired);
  assert.match(r.report.authProblem, /expired/);
  assert.equal(expired.posts().length, 0);
  assert.equal(r.report.waiting.length, 2);

  const revokedOnPost = fakeLinkedIn({ share: () => ({ status: 401, body: "revoked" }) });
  await run(state, dir, revokedOnPost);
  assert.equal(revokedOnPost.posts().length, 1, "stops after the first refusal");
  assert.equal(state.posts.a.status, "pending");
  assert.equal(state.posts.b.status, "pending");

  const ok = fakeLinkedIn();
  await run(state, dir, ok);
  assert.equal(ok.posts().length, 2);
  assert.equal(state.posts.a.status, "posted");
});

test("a rejected request is marked failed (nothing was posted)", async () => {
  const dir = postsDir({ "2026-11-20-bad.md": NEW_POST });
  const state = freshState();
  const li = fakeLinkedIn({ share: () => ({ status: 422, body: "duplicate" }) });
  const { report } = await run(state, dir, li);
  assert.equal(state.posts.bad.status, "failed");
  assert.equal(report.problems[0].status, "failed");
  await run(state, dir, li);
  assert.equal(li.posts().length, 1);
});

test("a 5xx or missing X-RestLi-Id is treated as unknown", async () => {
  for (const share of [() => ({ status: 503 }), () => ({ status: 201 })]) {
    const dir = postsDir({ "2026-11-20-x.md": NEW_POST });
    const state = freshState();
    await run(state, dir, fakeLinkedIn({ share }));
    assert.equal(state.posts.x.status, "unknown");
  }
});

test("a page that isn't live yet stays pending", async () => {
  const dir = postsDir({ "2026-11-20-slow.md": NEW_POST });
  const state = freshState();
  const li = fakeLinkedIn();
  const { report } = await run(state, dir, li, { live: false });
  assert.equal(state.posts.slow.status, "pending");
  assert.equal(li.posts().length, 0);
  assert.equal(report.waiting.length, 1);
});

test("long posts are cut to an excerpt that fits, ending with the site link", () => {
  const url = "https://josephstrauss.dev/posts/long/";
  const body = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} ${"word ".repeat(30)}`.trim()).join("\n\n");
  const text = buildShareText({ title: "Long", body, url });
  assert.ok(text.length <= 3000, `length ${text.length}`);
  assert.ok(text.endsWith(url));
  assert.match(text, /^Long\n\nParagraph 0/);
  const short = buildShareText({ title: "", body: "Short.", url });
  assert.equal(short, `Short.\n\nOriginally posted at ${url}`);
});

test("summaries keep one or two complete sentences", () => {
  assert.equal(summarize("Short one. Second one. Third."), "Short one. Second one.");
  assert.equal(summarize("We use e.g. caching here. Then more."), "We use e.g. caching here. Then more.");
  const long = "A".repeat(150) + ". Next.";
  assert.equal(summarize(long), "A".repeat(150) + ".");
});

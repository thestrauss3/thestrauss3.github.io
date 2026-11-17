// Cross-posting site posts to LinkedIn: which posts to share, and the share
// state machine. Everything with side effects (HTTP, git) is passed in, so the
// logic can be tested with mocks.
//
// State (state.json on the `linkedin-syndication` branch):
// {
//   "cutoff": "<ISO time>",       posts dated before this are never shared (backfill)
//   "posts": { "<slug>": {
//     "status": "pending" | "in_flight" | "posted" | "failed" | "unknown" | "skipped",
//     ... } }
// }
//
//   pending    found; waiting for its page to go live / for valid authorization
//   in_flight  share request about to be sent (saved first, so a crash mid-request
//              is never retried blindly)
//   posted     LinkedIn returned the post ID (X-RestLi-Id)
//   failed     LinkedIn rejected the request; nothing was posted
//   unknown    the request may or may not have created a post: check LinkedIn,
//              then run the workflow with mode "record" or "retry"
//   skipped    never shared (backfill, `syndicate: false`, or skipped by hand)
import fs from "node:fs";
import path from "node:path";
import { parseFrontMatter } from "./frontmatter.mjs";
import { buildShareText, markdownToPlain } from "./text.mjs";

const POST_FILE = /^(\d{4}-\d{2}-\d{2})-(.+)\.(md|markdown|html)$/;
const DAY = 24 * 60 * 60 * 1000;
export const BACKFILL_WINDOW_DAYS = 14;

export function emptyState(now) {
  return { cutoff: now.toISOString(), posts: {} };
}

// Approximates Jekyll's date handling (site time zone is America/Los_Angeles).
function parsePostDate(fileDate, frontDate) {
  if (frontDate) {
    const s = String(frontDate).trim().replace(" ", "T").replace(/ ([+-]\d{2}):?(\d{2})$/, "$1:$2");
    const d = new Date(/T/.test(s) ? s : `${s}T00:00:00-08:00`);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date(`${fileDate}T00:00:00-08:00`);
}

export function loadPosts(postsDir) {
  if (!fs.existsSync(postsDir)) return [];
  return fs.readdirSync(postsDir)
    .map((file) => ({ file, m: POST_FILE.exec(file) }))
    .filter(({ m }) => m)
    .map(({ file, m }) => {
      const { data, body } = parseFrontMatter(fs.readFileSync(path.join(postsDir, file), "utf8"));
      return {
        file,
        slug: data.slug || m[2],
        date: parsePostDate(m[1], data.date),
        title: typeof data.title === "string" ? data.title.trim() : "",
        published: data.published !== false,
        syndicate: data.syndicate !== false,
        manualLinkedInUrl: data.linkedin_url || "",
        body,
      };
    });
}

// Adds newly published posts to the state. Returns the slugs it changed.
export function discover(state, posts, now, { windowDays = BACKFILL_WINDOW_DAYS } = {}) {
  const cutoff = new Date(state.cutoff);
  const oldest = new Date(now.getTime() - windowDays * DAY);
  const changed = [];
  for (const post of posts) {
    if (state.posts[post.slug]) continue;          // already handled: edits never reshare
    if (!post.published || post.date > now) continue; // not on the site yet
    const base = { date: post.date.toISOString(), detected_at: now.toISOString() };
    if (!post.syndicate) {
      state.posts[post.slug] = { ...base, status: "skipped", reason: "syndicate: false" };
    } else if (post.manualLinkedInUrl) {
      state.posts[post.slug] = { ...base, status: "skipped", reason: "linkedin_url set by hand" };
    } else if (post.date < cutoff || post.date < oldest) {
      state.posts[post.slug] = { ...base, status: "skipped", reason: "backfill (older than the publishing cutoff)" };
    } else {
      state.posts[post.slug] = { ...base, status: "pending" };
    }
    changed.push(post.slug);
  }
  return changed;
}

// Manual recovery from the workflow_dispatch form.
export function applyManual(state, { mode, slug, linkedinUrl }, posts, now) {
  if (!slug) throw new Error(`Mode "${mode}" needs the post slug.`);
  const entry = state.posts[slug];
  const post = posts.find((p) => p.slug === slug);
  const stamp = now.toISOString();
  if (mode === "retry") {
    if (!post) throw new Error(`No post with slug "${slug}" in _posts/.`);
    if (entry?.status === "posted") throw new Error(`"${slug}" is already on LinkedIn (${entry.linkedin_url}). Nothing to retry.`);
    state.posts[slug] = { ...(entry ?? { date: post.date.toISOString(), detected_at: stamp }), status: "pending", manual_retry_at: stamp };
  } else if (mode === "record") {
    const m = /^https:\/\/www\.linkedin\.com\/\S+$/.exec(String(linkedinUrl ?? "").trim());
    if (!m) throw new Error("Mode \"record\" needs the LinkedIn post URL (https://www.linkedin.com/...).");
    const urn = /urn:li:(share|ugcPost|activity):\d+/.exec(decodeURIComponent(m[0]))?.[0] ?? null;
    state.posts[slug] = {
      ...(entry ?? { date: post?.date.toISOString() ?? null }),
      status: "posted", linkedin_id: urn, linkedin_url: m[0],
      permalink_verified: true, verified_by: "manual", posted_at: entry?.posted_at ?? stamp, recorded_at: stamp,
    };
  } else if (mode === "skip") {
    state.posts[slug] = { ...(entry ?? { date: post?.date.toISOString() ?? null }), status: "skipped", reason: "skipped by hand", skipped_at: stamp };
  } else {
    throw new Error(`Unknown mode "${mode}".`);
  }
}

export function shareTextFor(post, siteUrl) {
  const url = `${siteUrl.replace(/\/$/, "")}/posts/${post.slug}/`;
  return { url, text: buildShareText({ title: post.title, body: markdownToPlain(post.body), url }) };
}

// Shares every pending post whose page is live. Returns a report.
export async function processPending({ state, posts, api, persist, checkLive, siteUrl, now = () => new Date(), log = () => {} }) {
  const report = { posted: [], waiting: [], problems: [], unverified: [] };
  let author = null;
  let authProblem = null;

  const pending = Object.entries(state.posts)
    .filter(([, e]) => e.status === "pending")
    .sort(([, a], [, b]) => String(a.date).localeCompare(String(b.date)));

  for (const [slug, entry] of pending) {
    if (authProblem) { report.waiting.push({ slug, reason: authProblem }); continue; }
    const post = posts.find((p) => p.slug === slug);
    if (!post) {
      Object.assign(entry, { status: "skipped", reason: "post no longer in _posts/" });
      await persist(`LinkedIn: skip ${slug} (post removed)`);
      continue;
    }
    const { url, text } = shareTextFor(post, siteUrl);

    if (!(await checkLive(url, slug))) {
      entry.last_error = `Site page not live yet: ${url}`;
      report.waiting.push({ slug, reason: entry.last_error });
      continue;
    }

    if (!author) {
      try {
        author = await api.getAuthor();
      } catch (err) {
        authProblem = err.message;
        entry.last_error = authProblem;
        report.waiting.push({ slug, reason: authProblem });
        continue;
      }
    }

    // Save the intent before sending, so a crash after LinkedIn accepts the post
    // can't lead to a second share.
    Object.assign(entry, { status: "in_flight", attempts: (entry.attempts ?? 0) + 1, started_at: now().toISOString() });
    delete entry.last_error;
    await persist(`LinkedIn: sharing ${slug}`);

    const result = await api.createShare({ author, text, url, title: post.title });
    const at = now().toISOString();
    if (result.kind === "ok") {
      const verified = await api.verifyPermalink(result.permalink);
      Object.assign(entry, {
        status: "posted", linkedin_id: result.id, linkedin_url: result.permalink,
        permalink_verified: verified, posted_at: at,
      });
      report.posted.push({ slug, url: result.permalink, verified });
      log(`Shared ${slug}: ${result.permalink}${verified ? "" : " (permalink not verified yet)"}`);
    } else if (result.kind === "auth" || result.kind === "retry_later") {
      // LinkedIn refused before creating anything: safe to try again later.
      Object.assign(entry, { status: "pending", last_error: result.message });
      if (result.kind === "auth") authProblem = result.message;
      report.waiting.push({ slug, reason: result.message });
    } else if (result.kind === "rejected") {
      Object.assign(entry, { status: "failed", last_error: result.message, failed_at: at });
    } else {
      Object.assign(entry, { status: "unknown", last_error: result.message, failed_at: at });
    }
    await persist(`LinkedIn: ${entry.status} ${slug}`);
  }

  for (const [slug, e] of Object.entries(state.posts)) {
    if (e.status === "in_flight" || e.status === "unknown") {
      report.problems.push({ slug, status: e.status, action: "Check LinkedIn for this post. If it's there, run the workflow with mode=record and its URL; if not, use mode=retry.", error: e.last_error });
    } else if (e.status === "failed") {
      report.problems.push({ slug, status: e.status, action: "LinkedIn rejected the share (nothing was posted). Fix the cause, then run the workflow with mode=retry, or mode=skip.", error: e.last_error });
    } else if (e.status === "posted" && !e.permalink_verified) {
      // Shared fine, but the public link didn't check out yet; try again each run.
      if (await api.verifyPermalink(e.linkedin_url)) {
        Object.assign(e, { permalink_verified: true, verified_at: now().toISOString() });
        await persist(`LinkedIn: verified ${slug}`);
      } else {
        report.unverified.push({ slug, url: e.linkedin_url });
      }
    }
  }
  report.authProblem = authProblem;
  return report;
}

// LinkedIn "Share on LinkedIn" (w_member_social) via the UGC Posts endpoint.
export function createLinkedInApi({ token, authorUrn, fetchImpl = fetch, timeoutMs = 30000 }) {
  const headers = () => ({
    Authorization: `Bearer ${token}`,
    "X-Restli-Protocol-Version": "2.0.0",
    "Content-Type": "application/json",
  });
  const authError = (msg) => Object.assign(new Error(msg), { auth: true });

  return {
    async getAuthor() {
      if (!token) throw authError("LinkedIn isn't authorized: the LINKEDIN_ACCESS_TOKEN secret is not set. See docs/posts.md.");
      if (authorUrn) return authorUrn;
      let res;
      try {
        res = await fetchImpl("https://api.linkedin.com/v2/userinfo", { headers: headers(), signal: AbortSignal.timeout(timeoutMs) });
      } catch (err) {
        throw new Error(`Couldn't reach LinkedIn to check authorization (${err.name}). Will retry on the next run.`);
      }
      if (res.status === 401) throw authError("LinkedIn authorization has expired or was revoked (401). Reauthorize: see docs/posts.md.");
      if (!res.ok) throw authError(`LinkedIn authorization check failed (HTTP ${res.status}). Set the LINKEDIN_AUTHOR_URN variable or reauthorize with the openid and profile scopes.`);
      const body = await res.json();
      if (!body.sub) throw authError("LinkedIn userinfo response had no member ID.");
      return `urn:li:person:${body.sub}`;
    },

    async createShare({ author, text, url, title }) {
      const payload = {
        author,
        lifecycleState: "PUBLISHED",
        specificContent: {
          "com.linkedin.ugc.ShareContent": {
            shareCommentary: { text },
            shareMediaCategory: "ARTICLE",
            media: [{ status: "READY", originalUrl: url, ...(title ? { title: { text: title } } : {}) }],
          },
        },
        visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
      };
      let res;
      try {
        res = await fetchImpl("https://api.linkedin.com/v2/ugcPosts", {
          method: "POST", headers: headers(), body: JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        return { kind: "unknown", message: `No response from LinkedIn (${err.name}); the post may or may not exist.` };
      }
      const detail = async () => (await res.text().catch(() => "")).slice(0, 300);
      if (res.status === 201 || res.status === 200) {
        const id = res.headers.get("x-restli-id");
        if (!id || !/^urn:li:(share|ugcPost):\d+$/.test(id)) {
          return { kind: "unknown", message: `LinkedIn answered ${res.status} without a usable X-RestLi-Id (${id ?? "missing"}).` };
        }
        return { kind: "ok", id, permalink: `https://www.linkedin.com/feed/update/${id}/` };
      }
      if (res.status === 401 || res.status === 403) {
        return { kind: "auth", message: `LinkedIn refused the token (HTTP ${res.status}). Reauthorize: see docs/posts.md. ${await detail()}` };
      }
      if (res.status === 429) return { kind: "retry_later", message: "LinkedIn rate limit (HTTP 429). Will retry on the next run." };
      if (res.status >= 400 && res.status < 500) return { kind: "rejected", message: `LinkedIn rejected the share (HTTP ${res.status}): ${await detail()}` };
      return { kind: "unknown", message: `LinkedIn server error (HTTP ${res.status}); the post may or may not exist. ${await detail()}` };
    },

    async verifyPermalink(permalink) {
      try {
        const res = await fetchImpl(permalink, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) return false;
        const html = await res.text();
        const num = /(\d+)\/?$/.exec(permalink)?.[1];
        return Boolean(num && html.includes(num) && !/authwall|uas\/login/.test(res.url));
      } catch {
        return false;
      }
    },
  };
}

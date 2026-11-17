#!/usr/bin/env node
// Authorizes the LinkedIn app to post as you (3-legged OAuth) and stores the
// token in GitHub Actions. Run it once at setup and again when the token
// expires (about every 60 days). See docs/posts.md.
//
//   LINKEDIN_CLIENT_ID=... LINKEDIN_CLIENT_SECRET=... node scripts/linkedin-auth.mjs
//
// Requires the GitHub CLI (`gh auth login`) to save the secret. Pass --print to
// print the token instead (then paste it into GitHub yourself, and clear your
// terminal afterwards).
import http from "node:http";
import crypto from "node:crypto";
import { spawn, execFileSync } from "node:child_process";

const PORT = Number(process.env.LINKEDIN_REDIRECT_PORT ?? 8765);
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const SCOPES = "openid profile w_member_social";
const REPO = "thestrauss3/thestrauss3.github.io";
const printOnly = process.argv.includes("--print");

const clientId = process.env.LINKEDIN_CLIENT_ID;
const clientSecret = process.env.LINKEDIN_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error("Set LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET (from the app's Auth tab) first.");
  process.exit(1);
}

const state = crypto.randomBytes(16).toString("hex");
const authUrl = "https://www.linkedin.com/oauth/v2/authorization?" + new URLSearchParams({
  response_type: "code", client_id: clientId, redirect_uri: REDIRECT_URI, state, scope: SCOPES,
});

function gh(args, input) {
  execFileSync("gh", [...args, "--repo", REPO], { input, stdio: ["pipe", "inherit", "inherit"] });
}

async function finish(code) {
  const res = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, client_id: clientId, client_secret: clientSecret }),
  });
  const body = await res.json();
  if (!res.ok || !body.access_token) throw new Error(`Token exchange failed (HTTP ${res.status}): ${body.error_description ?? body.error ?? "no token"}`);

  const me = await fetch("https://api.linkedin.com/v2/userinfo", { headers: { Authorization: `Bearer ${body.access_token}` } });
  const profile = me.ok ? await me.json() : {};
  if (!profile.sub) throw new Error(`Authorized, but couldn't read your member ID (HTTP ${me.status}). Does the app have "Sign In with LinkedIn using OpenID Connect"?`);

  const authorUrn = `urn:li:person:${profile.sub}`;
  const expiresAt = new Date(Date.now() + body.expires_in * 1000).toISOString();
  console.log(`\nAuthorized as ${profile.name ?? authorUrn}. Token expires ${expiresAt.slice(0, 10)}.`);
  if (body.refresh_token) console.log("LinkedIn also issued a refresh token; this setup doesn't use it, so you'll reauthorize by rerunning this script.");

  if (printOnly) {
    console.log("\nAdd these in GitHub → Settings → Secrets and variables → Actions:");
    console.log(`  Secret   LINKEDIN_ACCESS_TOKEN      = ${body.access_token}`);
    console.log(`  Variable LINKEDIN_AUTHOR_URN        = ${authorUrn}`);
    console.log(`  Variable LINKEDIN_TOKEN_EXPIRES_AT  = ${expiresAt}`);
    return;
  }
  gh(["secret", "set", "LINKEDIN_ACCESS_TOKEN"], body.access_token);
  gh(["variable", "set", "LINKEDIN_AUTHOR_URN", "--body", authorUrn]);
  gh(["variable", "set", "LINKEDIN_TOKEN_EXPIRES_AT", "--body", expiresAt]);
  console.log(`Saved the token as a GitHub Actions secret on ${REPO}.`);
  console.log("If posts were waiting on authorization, run the workflow (Actions → Share new posts on LinkedIn → Run workflow).");
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT_URI);
  if (url.pathname !== "/callback") { res.writeHead(404).end(); return; }
  const reply = (msg) => res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end(msg);
  try {
    if (url.searchParams.get("state") !== state) throw new Error("State mismatch; ignoring this callback.");
    if (url.searchParams.get("error")) throw new Error(`${url.searchParams.get("error")}: ${url.searchParams.get("error_description")}`);
    await finish(url.searchParams.get("code"));
    reply("LinkedIn is authorized. You can close this tab and return to the terminal.");
    server.close();
  } catch (err) {
    reply(`Authorization failed: ${err.message}`);
    console.error(`Error: ${err.message}`);
    server.close();
    process.exitCode = 1;
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Opening LinkedIn to authorize. If no browser opens, visit:\n\n${authUrl}\n`);
  const opener = process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", authUrl]]
    : process.platform === "darwin" ? ["open", [authUrl]] : ["xdg-open", [authUrl]];
  spawn(opener[0], opener[1], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
});

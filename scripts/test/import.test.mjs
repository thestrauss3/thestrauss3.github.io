import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseCsv } from "../lib/csv.mjs";
import { parseFrontMatter } from "../lib/frontmatter.mjs";
import { classifyRow } from "../lib/linkedin-import.mjs";
import { runImport } from "../import-linkedin.mjs";

const link = (type, n) => `https://www.linkedin.com/feed/update/urn%3Ali%3A${type}%3A${n}`;
const CSV = [
  "Date,ShareLink,ShareCommentary,SharedUrl,MediaUrl,Visibility",
  `2025-03-01 10:00:00,${link("share", 111)},"First public post. It has two sentences! And a third.",,,PUBLIC`,
  `2025-04-02 18:30:15,${link("activity", 222)},"Line one with ""quotes"", commas
and a second line. {hashtag|\\#|search} rocks.",https://example.com/article,,PUBLIC`,
  `2025-05-03 09:00:00,${link("share", 333)},Connections only post.,,,CONNECTIONS`,
  `2025-06-04 09:00:00,${link("share", 444)},,${link("activity", 999)},,PUBLIC`,
  `2025-07-05 09:00:00,${link("share", 555)},Great point here.,${link("activity", 998)},,PUBLIC`,
  `2025-08-06 09:00:00,${link("ugcPost", 666)},Visibility is odd.,,,MEMBER_NETWORK`,
  `2025-03-01 10:00:00,${link("share", 111)},"First public post. It has two sentences! And a third.",,,PUBLIC`,
  "",
].join("\r\n");

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "li-import-"));
  fs.writeFileSync(path.join(dir, "Shares.csv"), CSV);
  return { dir, csvPath: path.join(dir, "Shares.csv"), outDir: path.join(dir, "_linkedin") };
}

test("CSV parser handles quotes, doubled quotes and embedded newlines", () => {
  const rows = parseCsv('a,b\r\n"x, ""y""","multi\nline"\r\n');
  assert.deepEqual(rows, [["a", "b"], ['x, "y"', "multi\nline"]]);
});

test("classifies originals, nonpublic posts, reposts and ambiguous rows", () => {
  const row = (Visibility, ShareCommentary = "Hi.", SharedUrl = "") => ({ Date: "2025-01-01 00:00:00", ShareLink: link("share", 1), ShareCommentary, SharedUrl, Visibility });
  assert.equal(classifyRow(row("PUBLIC")).decision, "import");
  assert.equal(classifyRow(row("CONNECTIONS")).decision, "exclude");
  assert.equal(classifyRow(row("PUBLIC", "")).decision, "exclude");
  assert.equal(classifyRow(row("PUBLIC", "Nice.", link("activity", 2))).decision, "review");
  assert.equal(classifyRow(row("MEMBER_NETWORK")).decision, "review");
});

test("imports only original public posts, and a second run changes nothing", () => {
  const t = tmp();
  const quiet = () => {};
  const first = runImport({ csvPath: t.csvPath, outDir: t.outDir, log: quiet });
  assert.equal(first.imported.length, 2);
  assert.equal(first.duplicates, 1);
  assert.deepEqual(first.review.map((r) => r.urn).sort(), ["urn:li:share:555", "urn:li:ugcPost:666"]);
  assert.deepEqual(first.excluded.map((r) => r.urn).sort(), ["urn:li:share:333", "urn:li:share:444"]);

  const files = fs.readdirSync(t.outDir).sort();
  assert.deepEqual(files, ["activity-222.md", "share-111.md"]);
  const { data, body } = parseFrontMatter(fs.readFileSync(path.join(t.outDir, "activity-222.md"), "utf8"));
  assert.equal(data.linkedin_id, "urn:li:activity:222");
  assert.equal(data.linkedin_url, "https://www.linkedin.com/feed/update/urn:li:activity:222/");
  assert.equal(data.date, "2025-04-02 18:30:15 +0000");
  assert.equal(data.syndication, "imported");
  assert.equal(data.title, "");
  assert.equal(body, "");
  assert.match(data.text, /#search rocks\./);
  assert.equal(data.summary, 'Line one with "quotes", commas and a second line. #search rocks.');

  // Hand edits survive a rerun.
  const edited = path.join(t.outDir, "share-111.md");
  fs.writeFileSync(edited, fs.readFileSync(edited, "utf8").replace('title: ""', 'title: "My edit"'));
  const second = runImport({ csvPath: t.csvPath, outDir: t.outDir, log: quiet });
  assert.equal(second.imported.length, 0);
  assert.equal(second.already.length, 2);
  assert.deepEqual(fs.readdirSync(t.outDir).sort(), files);
  assert.match(fs.readFileSync(edited, "utf8"), /title: "My edit"/);
});

test("--include adds a reviewed row; --exclude wins", () => {
  const t = tmp();
  const r = runImport({ csvPath: t.csvPath, outDir: t.outDir, include: ["666", "555"], exclude: ["555", "111"], log: () => {} });
  assert.deepEqual(r.imported.map((i) => i.urn).sort(), ["urn:li:activity:222", "urn:li:ugcPost:666"]);
});

test("--dry-run writes nothing", () => {
  const t = tmp();
  runImport({ csvPath: t.csvPath, outDir: t.outDir, dryRun: true, log: () => {} });
  assert.equal(fs.existsSync(t.outDir), false);
});

test("add-linkedin-post decodes the date from the ID and is safe to rerun", async () => {
  const { addPost, dateFromUrn } = await import("../add-linkedin-post.mjs");
  assert.equal(dateFromUrn("urn:li:activity:7487913641938399232").toISOString(), "2026-07-28T16:55:30.946Z");
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "li-add-"));
  const args = { urn: "urn:li:activity:7487913641938399232", text: "One.\n\nTwo.", outDir };
  assert.equal(addPost(args).added, true);
  assert.equal(addPost({ ...args, text: "Changed." }).added, false);
  const { data } = parseFrontMatter(fs.readFileSync(path.join(outDir, "activity-7487913641938399232.md"), "utf8"));
  assert.equal(data.date, "2026-07-28 16:55:30 +0000");
  assert.equal(data.summary, "One. Two.");
});

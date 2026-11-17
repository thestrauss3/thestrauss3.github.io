import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addPost, dateFromUrn, parseLinkedInUrn } from "../add-linkedin-post.mjs";
import { parseFrontMatter, stringifyFrontMatter } from "../lib/frontmatter.mjs";
import { summarize, textToMarkdown } from "../lib/text.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "posts-"));
const URN = "urn:li:activity:7487913641938399232";

test("reads the post ID from long links and decodes its date", () => {
  assert.equal(parseLinkedInUrn("https://www.linkedin.com/feed/update/urn%3Ali%3Aactivity%3A7487913641938399232"), URN);
  assert.equal(dateFromUrn(URN).toISOString(), "2026-07-28T16:55:30.946Z");
});

test("writes a post named by its Pacific date and slug", () => {
  const dir = tmp();
  // 01:28 UTC on Jul 24 is still Jul 23 in San Diego.
  const r = addPost({ urn: "urn:li:activity:7486230877665075200", slug: "what-will-we-get-wrong", text: "Question?\n\nMore.", postsDir: dir });
  assert.equal(path.basename(r.file), "2026-07-23-what-will-we-get-wrong.md");
  const { data, body } = parseFrontMatter(fs.readFileSync(r.file, "utf8"));
  assert.equal(data.title, "");
  assert.equal(data.date, "2026-07-24 01:28:48 +0000");
  assert.deepEqual(data.links, { linkedin: "https://www.linkedin.com/feed/update/urn:li:activity:7486230877665075200/" });
  assert.deepEqual(data.media, []);
  assert.equal(body, "Question?\n\nMore.\n");
});

test("skips a post that's already there and refuses a taken slug", () => {
  const dir = tmp();
  assert.equal(addPost({ urn: URN, slug: "ai", text: "Hi.", postsDir: dir }).added, true);
  assert.equal(addPost({ urn: URN, slug: "other", text: "Changed.", postsDir: dir }).added, false);
  assert.throws(() => addPost({ urn: "urn:li:activity:7487913641938399233", slug: "ai", text: "Same day.", postsDir: dir }), /already exists/);
  assert.equal(addPost({ urn: "urn:li:activity:7487913641938399233", slug: "ai-2", text: "Same day.", postsDir: dir }).added, true);
  assert.throws(() => addPost({ urn: URN, slug: "Bad Slug", text: "x", postsDir: dir }), /lowercase/);
});

test("records media in order", () => {
  const dir = tmp();
  const media = [{ type: "image", alt: 'A "chart"' }, { type: "video", alt: "" }];
  const r = addPost({ urn: URN, slug: "m", text: "Hi.", media, postsDir: dir });
  assert.deepEqual(parseFrontMatter(fs.readFileSync(r.file, "utf8")).data.media,
    [{ type: "image", file: "", alt: 'A "chart"' }, { type: "video", file: "", alt: "" }]);
});

test("front matter round-trips maps and lists", () => {
  const data = { title: "", links: { linkedin: "https://a", facebook: "https://b" }, media: [{ type: "image", file: "/x.png", alt: "" }], empty: [] };
  assert.deepEqual(parseFrontMatter(stringifyFrontMatter(data, "")).data, data);
  assert.equal(parseFrontMatter("---\ntitle:\nx: 1\n---\n").data.title, null);
});

test("LinkedIn text becomes equivalent Markdown", () => {
  const md = textToMarkdown("Intro:\n• one\n• two\n\nLine a\nLine b\n\n# not a heading\n\n1. not a list");
  assert.equal(md, "Intro:\n\n- one\n- two\n\nLine a\\\\\nLine b\n\n\\# not a heading\n\n1\\. not a list");
});

test("Markdown, HTML and Liquid characters are shown as written", () => {
  assert.equal(textToMarkdown("Use {{ x }} and {% y %}"), "Use &#123;&#123; x }} and &#123;% y %}");
  assert.equal(textToMarkdown("List<string> & 2*3*4 a_b `c` [d](e) |f| $$ ~~g~~"),
    "List&lt;string&gt; & 2\\*3\\*4 a\\_b \\`c\\` \\[d\\](e) \\|f\\| \\$\\$ &#126;&#126;g&#126;&#126;");
  assert.equal(textToMarkdown("&amp; stays literal"), "&amp;amp; stays literal");
  assert.equal(textToMarkdown("    not code\n\n= not a heading\n\n: not a definition"),
    "not code\n\n\\= not a heading\n\n\\: not a definition");
  assert.equal(textToMarkdown("• *bold?*"), "- \\*bold?\\*");
});

test("summaries keep one or two complete sentences", () => {
  assert.equal(summarize("Short one. Second one. Third."), "Short one. Second one.");
  assert.equal(summarize("It seemed unquestionable.. until it wasn't. Next."), "It seemed unquestionable.. until it wasn't. Next.");
  assert.equal(summarize("A".repeat(150) + ". Next."), "A".repeat(150) + ".");
});

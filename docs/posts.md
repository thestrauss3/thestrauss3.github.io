# Posts: writing, importing, and sharing to LinkedIn

The homepage's **Latest posts** (newest three) and the **All posts** archive at
`/posts/` read from one list, built by `_includes/posts-all.html`:

| Where | What | Shared to LinkedIn? |
| --- | --- | --- |
| `_posts/` | Posts written on this site; each gets a page at `/posts/<slug>/` | Yes, automatically, once |
| `_drafts/` | Unpublished drafts; never built on the live site | No |
| `_linkedin/` | Posts imported from your LinkedIn export (list entries only, no page) | Never (already on LinkedIn) |

`/posts/index.json` is generated from the same list; the archive uses it to
load older posts as you scroll.

## Write a post

1. Create `_drafts/my-post-slug.md`:

   ```markdown
   ---
   title: ""          # optional. Leave "" for an untitled post (don't delete the line,
                      # or Jekyll invents a title from the file name)
   summary: ""        # optional. Otherwise the list shows the first one or two sentences
   ---
   The first paragraph should work as the excerpt. Write the rest in Markdown.
   ```

   Preview drafts locally with
   `docker compose run --rm --service-ports jekyll sh -c "bundle install && bundle exec jekyll serve --host 0.0.0.0 --drafts"`.

2. To publish, move it to `_posts/YYYY-MM-DD-my-post-slug.md` (the date is the
   publication date) and merge the PR to `master`.

The slug (`my-post-slug`) is the post's permanent ID: its URL and its LinkedIn
record both use it. Don't rename a post after it's published.

Optional front matter:

- `syndicate: false` keeps the post on the site only.
- `linkedin_url: "https://www.linkedin.com/feed/update/..."` links a post you
  shared by hand. The job won't share it again.
- `published: false` hides a post without moving it back to `_drafts/`.

## Import your LinkedIn posts (one-time, safe to rerun)

1. On LinkedIn: **Me → Settings & Privacy → Data privacy → Get a copy of your
   data**. Pick **Shares** (posts) if offered, or the larger archive, then
   **Request archive**. Download the ZIP from LinkedIn's email and unzip it
   **outside this repository** (for example, `Downloads\linkedin-export\`).
2. Preview, then import:

   ```sh
   node scripts/import-linkedin.mjs ~/Downloads/linkedin-export/Shares.csv --dry-run
   node scripts/import-linkedin.mjs ~/Downloads/linkedin-export/Shares.csv
   ```

   The import keeps only your original public posts. It skips reposts (rows
   with no text of your own) and posts that aren't public. Rows it can't decide
   (a repost with your comment, or an unfamiliar visibility value) are listed
   under **Needs review**. Add the ones you want with `--include <id>[,<id>…]`
   and leave out any post with `--exclude <id>`.
3. Each post becomes `_linkedin/<type>-<id>.md`. Reruns never duplicate a post
   and never overwrite one, so you can edit `title` (for example, an article's
   published title) or `summary` by hand.

The script refuses to read a CSV that's inside the repo. `.gitignore` also
blocks the usual export file names.

## Automatic LinkedIn cross-posting

`.github/workflows/linkedin-syndication.yml` runs whenever `_posts/` changes on
`master`, daily, and on demand. For each new post it:

1. Waits for the post's page to go live on josephstrauss.dev (GitHub Pages
   builds the site separately, so the website never depends on LinkedIn).
2. Records that it's about to share, **then** posts once to your profile via
   the official Share on LinkedIn API (`w_member_social`). The share includes
   the post text (or an excerpt if it's over LinkedIn's 3,000-character limit)
   and the post's URL.
3. Saves LinkedIn's `X-RestLi-Id` and permalink, then checks that the permalink
   opens. Once it does, the site shows **Discuss on LinkedIn →** for that post.

Share records live in `state.json` on the `linkedin-syndication` branch (it's
created on the first run). `master` is protected, so the bot never pushes
there. Each run handles one share at a time. Drafts, imported posts, edits,
posts dated before 2026-11-16, and posts more than 14 days old are never
shared.

### One-time setup

1. **Create a LinkedIn app** at <https://www.linkedin.com/developers/apps>.
   LinkedIn requires you to link the app to a Company Page. Any page you
   administer works, and the share still posts to your personal profile.
2. **Products** tab: add **Share on LinkedIn** and **Sign In with LinkedIn
   using OpenID Connect**. Both are free and self-service.
3. **Auth** tab: under *Authorized redirect URLs*, add
   `http://localhost:8765/callback`. Copy the **Client ID** and **Primary
   Client Secret**. Keep the secret private and out of this repo.
4. Install the GitHub CLI and run `gh auth login`, so the script can save the
   token straight into GitHub. (Or add `--print` in step 5 to paste it into
   GitHub by hand.)
5. Authorize. In PowerShell:

   ```powershell
   $env:LINKEDIN_CLIENT_ID = "<client id>"
   $env:LINKEDIN_CLIENT_SECRET = "<client secret>"
   node scripts/linkedin-auth.mjs
   ```

   Approve the request in the browser. The script saves these settings on the
   repo:
   - secret `LINKEDIN_ACCESS_TOKEN`
   - variable `LINKEDIN_AUTHOR_URN` (your member ID)
   - variable `LINKEDIN_TOKEN_EXPIRES_AT`
6. Under the repo's **Settings → Actions → General → Workflow permissions**,
   make sure Actions may have **Read and write** access. (The workflow asks
   for `contents: write` to push the share records.)

### Renewing the token (about every 60 days)

LinkedIn access tokens expire after about 60 days. Refreshing them
automatically is limited to approved LinkedIn partners, so you renew by hand:
rerun step 5. The run summary starts warning 10 days before expiry. After the
token expires, new posts stay **pending**: nothing is lost or posted twice.
Reauthorize, then run the workflow (**Actions → Share new posts on LinkedIn →
Run workflow**), or wait for the daily run.

### When a share needs attention

A run fails (and GitHub emails you) when a post is waiting or stuck. The run
summary says which post and what to do. To fix it, go to **Actions → Share new
posts on LinkedIn → Run workflow** and pick a mode:

| Status | Meaning | Fix |
| --- | --- | --- |
| pending | Waiting for the page to go live, or for authorization | Usually resolves on its own; reauthorize if the summary says so |
| unknown / in_flight | The request may have created a post (timeout, LinkedIn error, or the run died mid-request). It is **not** retried automatically, to avoid a duplicate | Check your LinkedIn activity. If the post is there: `record` + slug + its URL. If not: `retry` + slug |
| failed | LinkedIn rejected the request; nothing was posted | Fix the cause, then `retry`, or `skip` |
| posted, link not verified | Shared, but the permalink check didn't pass, so the site hides the link | Rechecked every run. If the link opens your post: `record` + slug + URL |

`retry` can also share a post the job skipped (for example, a backfilled one).

# Posts

Every post is a Markdown file in `_posts/` named `YYYY-MM-DD-slug.md`. It's
published at `/posts/YYYY/MM/DD/slug/` and listed in **Latest posts** (the
newest three, on the homepage) and **All posts** (`/posts/`). The slug is the
short name in the address. It only has to be unique within its day.

## A post file

```markdown
---
title: ""            # optional. Leave "" for an untitled post (don't delete the
                     # line, or Jekyll invents a title from the slug)
summary: ""          # optional. Otherwise the lists show the first sentence or two
links:               # optional: the same post on other platforms
  linkedin: "https://www.linkedin.com/feed/update/urn:li:activity:…/"
media:               # optional: photos/videos, shown under the post
  - type: "image"    # or "video"
    file: "/assets/posts/2026-01-22-my-post-1.png"
    alt: "What the image shows"
---
The post, in Markdown.
```

Each entry under `links` adds a "View on …" link with that platform's icon.
To support a new platform, add it to `_data/platforms.yml` and put its icon in
`_includes/icons/` (icons from <https://simpleicons.org>, CC0).

Drafts go in `_drafts/` (no date in the file name) and are never published.
Preview them with
`docker compose run --rm --service-ports jekyll sh -c "bundle install && bundle exec jekyll serve --host 0.0.0.0 --drafts"`.

## Add a post you already published on LinkedIn

```sh
node scripts/add-linkedin-post.mjs "<post link>" <slug> "<full post text>"
# or, for long posts:
node scripts/add-linkedin-post.mjs "<post link>" <slug> --text-file post.txt
```

- **Link:** the post's **⋯ → Copy link to post** (a `lnkd.in` short link works).
- **Date:** read from the post ID, so you never look it up.
- **Text:** "•" bullets become a list.
- **Duplicates:** adding the same post twice does nothing.
- **Media:** add `--image "description"` / `--video "description"` once per item,
  in order, then save the files in `assets/posts/` and set each `file`.

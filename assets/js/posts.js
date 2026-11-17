// Posts: "All posts" archive loading and "Discuss on LinkedIn" links.
// The page works without this script: the archive shows its first batch and
// every post keeps its own links.
(function () {
  "use strict";

  var script = document.currentScript;
  var syndicationUrl = script && script.getAttribute("data-syndication-url");

  // --- "Discuss on LinkedIn" -------------------------------------------------
  // Site posts are cross-posted by a GitHub Actions job, which records each
  // share on a separate branch. Show the link only for shares it verified.
  var syndication = null;

  function loadSyndication() {
    if (!syndication) {
      syndication = !syndicationUrl
        ? Promise.resolve({})
        : fetch(syndicationUrl, { cache: "no-cache" })
            .then(function (r) { return r.ok ? r.json() : {}; })
            .then(function (state) { return (state && state.posts) || {}; })
            .catch(function () { return {}; });
    }
    return syndication;
  }

  function isLinkedInPermalink(url) {
    return /^https:\/\/www\.linkedin\.com\/feed\/update\/urn:li:(share|ugcPost|activity):\d+\/?$/.test(url || "");
  }

  function fillDiscussLinks(root) {
    var links = (root || document).querySelectorAll("a[data-discuss][hidden]");
    if (!links.length) return;
    loadSyndication().then(function (posts) {
      links.forEach(function (a) {
        var share = posts[a.getAttribute("data-discuss")];
        if (share && share.status === "posted" && share.permalink_verified && isLinkedInPermalink(share.linkedin_url)) {
          a.href = share.linkedin_url;
          a.hidden = false;
        }
      });
    });
  }

  // --- "All posts" archive ---------------------------------------------------
  function initArchive() {
    var loader = document.getElementById("archive-loader");
    var list = document.getElementById("post-list");
    if (!loader || !list) return;

    var indexUrl = loader.getAttribute("data-index-url");
    var batchSize = parseInt(loader.getAttribute("data-batch-size"), 10) || 10;
    var moreButton = loader.querySelector('[data-action="more"]');
    var errorBox = loader.querySelector(".archive-error");
    var retryButton = loader.querySelector('[data-action="retry"]');
    var endNote = document.querySelector(".archive-end");
    var live = document.querySelector(".archive-live");

    var index = null;      // every post, newest first (fetched once)
    var loading = false;   // blocks overlapping loads
    var finished = false;  // the archive has ended
    var failed = false;    // pause auto-loading until the reader retries
    var observer = null;

    function shownIds() {
      var ids = {};
      list.querySelectorAll(".post-item[data-id]").forEach(function (el) {
        ids[el.getAttribute("data-id")] = true;
      });
      return ids;
    }

    function finish() {
      finished = true;
      if (observer) observer.disconnect();
      loader.hidden = true;
      if (endNote) endNote.hidden = false;
    }

    function fetchIndex() {
      if (index) return Promise.resolve(index);
      return fetch(indexUrl, { cache: "no-cache" }).then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      }).then(function (data) {
        if (!data || !Array.isArray(data.posts)) throw new Error("Bad index");
        index = data.posts;
        return index;
      });
    }

    function loadMore(fromClick) {
      if (loading || finished) return;
      loading = true;
      failed = false;
      errorBox.hidden = true;
      moreButton.disabled = true;
      moreButton.textContent = "Loading…";

      fetchIndex().then(function (posts) {
        var seen = shownIds();
        var remaining = posts.filter(function (p) { return !seen[p.id]; });
        var next = remaining.slice(0, batchSize);
        var firstNew = null;

        next.forEach(function (p) {
          var tpl = document.createElement("template");
          tpl.innerHTML = p.html;
          var item = tpl.content.firstElementChild;
          if (!item) return;
          if (!firstNew) firstNew = item;
          list.appendChild(item);
        });
        fillDiscussLinks(list);
        if (live) live.textContent = next.length ? "Loaded " + next.length + " more posts." : "";

        // Keyboard users who pressed the button continue at the first new post.
        if (fromClick && firstNew) {
          firstNew.setAttribute("tabindex", "-1");
          firstNew.focus();
        }
        if (remaining.length <= next.length) finish();
      }).catch(function () {
        failed = true;
        errorBox.hidden = false;
        if (live) live.textContent = "Older posts didn’t load.";
        if (fromClick) retryButton.focus();
      }).then(function () {
        loading = false;
        moreButton.disabled = false;
        moreButton.textContent = "Load more";
        moreButton.hidden = finished || failed;
        // If the reader is still near the bottom, keep going.
        if (!finished && !failed && observer) {
          observer.unobserve(moreButton);
          observer.observe(moreButton);
        }
      });
    }

    moreButton.hidden = false;
    moreButton.addEventListener("click", function () { loadMore(true); });
    retryButton.addEventListener("click", function () { loadMore(true); });

    if ("IntersectionObserver" in window) {
      observer = new IntersectionObserver(function (entries) {
        if (!failed && entries.some(function (e) { return e.isIntersecting; })) loadMore(false);
      }, { rootMargin: "0px 0px 600px 0px" });
      observer.observe(moreButton);
    }
  }

  function start() {
    fillDiscussLinks(document);
    initArchive();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();

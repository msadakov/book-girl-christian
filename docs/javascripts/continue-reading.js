/**
 * Continue reading: remember part + chapter in a cookie and offer resume.
 * UMD: browser auto-init; Node can require() the exported API for tests.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (typeof root !== "undefined") {
    root.FatherBookContinue = api;
    if (typeof document !== "undefined" && typeof window !== "undefined") {
      api.autoInit(window, document);
    }
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var COOKIE_NAME = "fb_reading";
  var SESSION_DISMISS_KEY = "fb_continue_dismissed";
  var MAX_AGE_SEC = 60 * 60 * 24 * 400; // ~13 months (browser upper bound)
  var SAVE_THROTTLE_MS = 400;
  var CHAPTER_ID_RE = /^ch-\d+$/;
  var BANNER_ID = "fb-continue";

  /* ——— Cookie helpers ——— */

  function encodeProgress(progress) {
    return encodeURIComponent(JSON.stringify(progress));
  }

  function decodeProgress(raw) {
    if (!raw || typeof raw !== "string") return null;
    try {
      var data = JSON.parse(decodeURIComponent(raw));
      return normalizeProgress(data);
    } catch (e) {
      return null;
    }
  }

  function normalizeProgress(data) {
    if (!data || typeof data !== "object") return null;
    var path = typeof data.path === "string" ? data.path.trim() : "";
    var chapter = typeof data.chapter === "string" ? data.chapter.trim() : "";
    if (!path || !CHAPTER_ID_RE.test(chapter)) return null;
    if (path.indexOf("//") !== -1 || path.indexOf(":") !== -1) return null;
    if (path.charAt(0) !== "/") return null;

    var partTitle =
      typeof data.partTitle === "string" ? data.partTitle.trim().slice(0, 200) : "";
    var chapterTitle =
      typeof data.chapterTitle === "string"
        ? data.chapterTitle.trim().slice(0, 200)
        : "";

    return {
      path: path,
      chapter: chapter,
      partTitle: partTitle,
      chapterTitle: chapterTitle,
      updatedAt: typeof data.updatedAt === "number" ? data.updatedAt : Date.now(),
    };
  }

  function readCookie(cookieString, name) {
    if (!cookieString) return null;
    var parts = cookieString.split("; ");
    var prefix = name + "=";
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].indexOf(prefix) === 0) {
        return parts[i].slice(prefix.length);
      }
    }
    return null;
  }

  function buildCookieString(name, value, options) {
    var opts = options || {};
    var chunks = [name + "=" + value];
    chunks.push("Path=" + (opts.path || "/"));
    chunks.push("Max-Age=" + (opts.maxAge != null ? opts.maxAge : MAX_AGE_SEC));
    chunks.push("SameSite=Lax");
    if (opts.secure) chunks.push("Secure");
    return chunks.join("; ");
  }

  function writeProgressCookie(doc, progress, siteBasePath, isSecure) {
    var normalized = normalizeProgress(progress);
    if (!normalized) return false;
    doc.cookie = buildCookieString(COOKIE_NAME, encodeProgress(normalized), {
      path: siteBasePath || "/",
      secure: !!isSecure,
    });
    return true;
  }

  function readProgressCookie(cookieString) {
    return decodeProgress(readCookie(cookieString, COOKIE_NAME));
  }

  /* ——— Location / URL ——— */

  function continueHref(progress) {
    if (!progress) return "";
    return progress.path + "#" + progress.chapter;
  }

  function isSamePosition(progress, pathname, hash) {
    if (!progress) return false;
    var h = hash || "";
    if (h.charAt(0) === "#") h = h.slice(1);
    return progress.path === pathname && progress.chapter === h;
  }

  function shouldOfferContinue(progress, pathname, hash, dismissed) {
    if (dismissed) return false;
    if (!progress) return false;
    return !isSamePosition(progress, pathname, hash);
  }

  function linkLabel(progress) {
    if (!progress) return "";
    var part = progress.partTitle || "Часть";
    var chapter = progress.chapterTitle;
    if (!chapter) {
      if (progress.chapter === "ch-0") chapter = "Вступление";
      else chapter = "Глава " + progress.chapter.replace(/^ch-/, "");
    }
    return part + " · " + chapter;
  }

  function detectSiteBasePath(scriptSrc) {
    if (!scriptSrc) return "/";
    try {
      var path = new URL(scriptSrc, "http://local.invalid").pathname;
      var marker = "/javascripts/continue-reading.js";
      var idx = path.indexOf(marker);
      if (idx === -1) return "/";
      var base = path.slice(0, idx + 1);
      return base || "/";
    } catch (e) {
      return "/";
    }
  }

  /* ——— DOM: chapters ——— */

  function collectChapters(root) {
    var anchors = root.querySelectorAll('a[id^="ch-"]');
    var chapters = [];
    for (var i = 0; i < anchors.length; i++) {
      var anchor = anchors[i];
      var id = anchor.id;
      if (!CHAPTER_ID_RE.test(id)) continue;
      var heading = findChapterHeading(anchor);
      if (!heading) continue;
      chapters.push({
        id: id,
        anchor: anchor,
        heading: heading,
        title: (heading.textContent || "").replace(/\s+/g, " ").trim(),
      });
    }
    return chapters;
  }

  function findChapterHeading(anchor) {
    var start =
      anchor.parentElement && anchor.parentElement.tagName === "P"
        ? anchor.parentElement
        : anchor;
    var el = start.nextElementSibling;
    while (el) {
      if (el.tagName === "H2") return el;
      var inner = el.querySelector && el.querySelector("h2");
      if (inner) return inner;
      if (el.querySelector && el.querySelector('a[id^="ch-"]')) break;
      if (el.tagName === "HR") break;
      el = el.nextElementSibling;
    }
    return null;
  }

  function getPartTitle(root) {
    var titleEl =
      root.querySelector("h1.iv-page-title") ||
      root.querySelector("article h1") ||
      root.querySelector("h1");
    if (!titleEl) return "";
    return (titleEl.textContent || "").replace(/\s+/g, " ").trim();
  }

  function isPartPage(pathname) {
    return /\/part-\d{2}-[^/]+\/?$/.test(pathname);
  }

  /**
   * Active chapter: last chapter whose heading has crossed the reading line
   * (25% of viewport height from the top).
   */
  function resolveActiveChapter(chapters, viewportHeight, getRect) {
    if (!chapters || !chapters.length) return null;
    var line = (viewportHeight || 0) * 0.25;
    var active = chapters[0];
    for (var i = 0; i < chapters.length; i++) {
      var top = getRect(chapters[i].heading).top;
      if (top <= line) active = chapters[i];
      else break;
    }
    return active;
  }

  /* ——— Banner ——— */

  function createBanner(doc) {
    var existing = doc.getElementById(BANNER_ID);
    if (existing) return existing;

    var bar = doc.createElement("div");
    bar.id = BANNER_ID;
    bar.className = "fb-continue";
    bar.setAttribute("role", "region");
    bar.setAttribute("aria-label", "Продолжить чтение");
    bar.hidden = true;

    bar.innerHTML =
      '<div class="fb-continue__inner">' +
      '<p class="fb-continue__question">Продолжить?</p>' +
      '<a class="fb-continue__link" href="#"></a>' +
      '<button type="button" class="fb-continue__close" aria-label="Закрыть"></button>' +
      "</div>";

    doc.body.appendChild(bar);
    return bar;
  }

  function updateBanner(bar, progress) {
    if (!bar || !progress) return;
    var link = bar.querySelector(".fb-continue__link");
    if (!link) return;
    link.href = continueHref(progress);
    link.textContent = linkLabel(progress);
  }

  function showBanner(bar, progress) {
    if (!bar || !progress) return;
    updateBanner(bar, progress);
    bar.hidden = false;
    if (bar.ownerDocument && bar.ownerDocument.documentElement) {
      bar.ownerDocument.documentElement.classList.add("fb-continue-visible");
    }
  }

  function hideBanner(bar) {
    if (!bar) return;
    bar.hidden = true;
    if (bar.ownerDocument && bar.ownerDocument.documentElement) {
      bar.ownerDocument.documentElement.classList.remove("fb-continue-visible");
    }
  }

  /* ——— Runtime ——— */

  function createController(win, doc, storage) {
    var siteBasePath = "/";
    var banner = null;
    var chapters = [];
    var partTitle = "";
    var saveTimer = null;
    var lastSavedKey = "";
    var scrollListening = false;
    /** Snapshot for the resume offer this session (not overwritten by browsing). */
    var offeredProgress = null;
    var offerReady = false;

    function scriptSrc() {
      var scripts = doc.getElementsByTagName("script");
      for (var i = scripts.length - 1; i >= 0; i--) {
        var src = scripts[i].src || "";
        if (src.indexOf("continue-reading.js") !== -1) return src;
      }
      return "";
    }

    function secure() {
      return win.location.protocol === "https:";
    }

    function dismissed() {
      try {
        return storage.getItem(SESSION_DISMISS_KEY) === "1";
      } catch (e) {
        return false;
      }
    }

    function setDismissed() {
      try {
        storage.setItem(SESSION_DISMISS_KEY, "1");
      } catch (e) {
        /* ignore quota / private mode */
      }
    }

    function currentProgress() {
      return readProgressCookie(doc.cookie);
    }

    function captureOfferFromCookie() {
      if (offerReady) return;
      offeredProgress = currentProgress();
      offerReady = true;
    }

    function offerIsActive() {
      return (
        !!offeredProgress &&
        !dismissed() &&
        shouldOfferContinue(
          offeredProgress,
          win.location.pathname,
          win.location.hash,
          false
        )
      );
    }

    function saveChapter(chapter) {
      if (!chapter || !isPartPage(win.location.pathname)) return;
      // Keep the resume cookie intact while the bottom offer is still relevant.
      if (offerIsActive()) return;

      var key = win.location.pathname + "#" + chapter.id;
      if (key === lastSavedKey) return;

      var progress = {
        path: win.location.pathname,
        chapter: chapter.id,
        partTitle: partTitle,
        chapterTitle: chapter.title,
        updatedAt: Date.now(),
      };

      if (writeProgressCookie(doc, progress, siteBasePath, secure())) {
        lastSavedKey = key;
      }
    }

    function scheduleSave() {
      if (saveTimer) win.clearTimeout(saveTimer);
      saveTimer = win.setTimeout(function () {
        saveTimer = null;
        var active = resolveActiveChapter(chapters, win.innerHeight, function (el) {
          return el.getBoundingClientRect();
        });
        if (active) saveChapter(active);
      }, SAVE_THROTTLE_MS);
    }

    function onScrollOrResize() {
      scheduleSave();
      refreshOffer();
    }

    function bindScroll() {
      if (scrollListening) return;
      scrollListening = true;
      win.addEventListener("scroll", onScrollOrResize, { passive: true });
      win.addEventListener("resize", onScrollOrResize, { passive: true });
      win.addEventListener("hashchange", onHashChange);
    }

    function onHashChange() {
      var hash = (win.location.hash || "").replace(/^#/, "");
      if (CHAPTER_ID_RE.test(hash)) {
        for (var i = 0; i < chapters.length; i++) {
          if (chapters[i].id === hash) {
            saveChapter(chapters[i]);
            break;
          }
        }
      }
      refreshOffer();
    }

    function refreshOffer() {
      captureOfferFromCookie();
      if (
        shouldOfferContinue(
          offeredProgress,
          win.location.pathname,
          win.location.hash,
          dismissed()
        )
      ) {
        showBanner(banner, offeredProgress);
      } else {
        hideBanner(banner);
      }
    }

    function onCloseClick(event) {
      event.preventDefault();
      setDismissed();
      hideBanner(banner);
      // After dismiss, resume normal progress tracking on this page.
      scheduleSave();
    }

    function onLinkClick() {
      setDismissed();
      hideBanner(banner);
    }

    function scanPage() {
      chapters = collectChapters(doc);
      partTitle = getPartTitle(doc);
      if (chapters.length) {
        bindScroll();
        scheduleSave();
        // Immediate save for deep links / restored hash
        var hash = (win.location.hash || "").replace(/^#/, "");
        if (CHAPTER_ID_RE.test(hash)) {
          for (var i = 0; i < chapters.length; i++) {
            if (chapters[i].id === hash) {
              saveChapter(chapters[i]);
              break;
            }
          }
        } else if (!offerIsActive()) {
          var active = resolveActiveChapter(
            chapters,
            win.innerHeight,
            function (el) {
              return el.getBoundingClientRect();
            }
          );
          if (active) saveChapter(active);
        }
      }
    }

    function init() {
      siteBasePath = detectSiteBasePath(scriptSrc());
      banner = createBanner(doc);
      var closeBtn = banner.querySelector(".fb-continue__close");
      var link = banner.querySelector(".fb-continue__link");
      if (closeBtn && !closeBtn._fbBound) {
        closeBtn.addEventListener("click", onCloseClick);
        closeBtn._fbBound = true;
      }
      if (link && !link._fbBound) {
        link.addEventListener("click", onLinkClick);
        link._fbBound = true;
      }
      // Capture resume target before any page scan can rewrite the cookie.
      captureOfferFromCookie();
      refreshOffer();
      scanPage();
      refreshOffer();
    }

    function onDocumentChange() {
      scanPage();
      refreshOffer();
    }

    return {
      init: init,
      onDocumentChange: onDocumentChange,
      refreshOffer: refreshOffer,
      saveChapter: saveChapter,
      getChapters: function () {
        return chapters.slice();
      },
    };
  }

  var started = false;

  function autoInit(win, doc) {
    if (started) return;
    started = true;

    var storage;
    try {
      storage = win.sessionStorage;
    } catch (e) {
      storage = {
        _data: {},
        getItem: function (k) {
          return this._data[k] || null;
        },
        setItem: function (k, v) {
          this._data[k] = String(v);
        },
      };
    }

    var controller = createController(win, doc, storage);

    function boot() {
      controller.init();
    }

    if (doc.readyState === "loading") {
      doc.addEventListener("DOMContentLoaded", boot);
    } else {
      boot();
    }

    // Material for MkDocs instant navigation
    if (typeof win.document$ !== "undefined" && win.document$.subscribe) {
      win.document$.subscribe(function () {
        controller.onDocumentChange();
      });
    }
  }

  return {
    COOKIE_NAME: COOKIE_NAME,
    SESSION_DISMISS_KEY: SESSION_DISMISS_KEY,
    CHAPTER_ID_RE: CHAPTER_ID_RE,
    encodeProgress: encodeProgress,
    decodeProgress: decodeProgress,
    normalizeProgress: normalizeProgress,
    readCookie: readCookie,
    buildCookieString: buildCookieString,
    writeProgressCookie: writeProgressCookie,
    readProgressCookie: readProgressCookie,
    continueHref: continueHref,
    isSamePosition: isSamePosition,
    shouldOfferContinue: shouldOfferContinue,
    linkLabel: linkLabel,
    detectSiteBasePath: detectSiteBasePath,
    collectChapters: collectChapters,
    findChapterHeading: findChapterHeading,
    getPartTitle: getPartTitle,
    isPartPage: isPartPage,
    resolveActiveChapter: resolveActiveChapter,
    createBanner: createBanner,
    updateBanner: updateBanner,
    showBanner: showBanner,
    hideBanner: hideBanner,
    createController: createController,
    autoInit: autoInit,
  };
});

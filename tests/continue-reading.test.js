"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const api = require("../docs/javascripts/continue-reading.js");

const {
  COOKIE_NAME,
  SESSION_DISMISS_KEY,
  encodeProgress,
  decodeProgress,
  normalizeProgress,
  readCookie,
  buildCookieString,
  readProgressCookie,
  continueHref,
  isSamePosition,
  shouldOfferContinue,
  linkLabel,
  detectSiteBasePath,
  isPartPage,
  resolveActiveChapter,
  collectChapters,
  findChapterHeading,
  getPartTitle,
  createBanner,
  updateBanner,
  showBanner,
  hideBanner,
  createController,
} = api;

function validProgress(overrides) {
  return Object.assign(
    {
      path: "/part-01-vera/",
      chapter: "ch-5",
      partTitle: "Часть 1. Вера и Бог",
      chapterTitle: "Глава 5. Как разговаривать с Невидимым Царём?",
      updatedAt: 1700000000000,
    },
    overrides || {}
  );
}

/* ——— Minimal DOM for chapter markup (no external deps) ——— */

function createNode(tagName, attrs) {
  attrs = attrs || {};
  const node = {
    tagName: String(tagName).toUpperCase(),
    id: attrs.id || "",
    className: attrs.className || "",
    textContent: attrs.textContent || "",
    parentElement: null,
    nextElementSibling: null,
    childNodes: [],
    ownerDocument: null,
    hidden: false,
    _listeners: {},
    setAttribute(name, value) {
      if (name === "id") this.id = value;
      if (name === "class" || name === "className") this.className = value;
      this["_" + name] = value;
    },
    getAttribute(name) {
      if (name === "href") return this.href;
      if (name === "id") return this.id;
      return this["_" + name];
    },
    appendChild(child) {
      child.parentElement = this;
      child.ownerDocument = this.ownerDocument || this;
      this.childNodes.push(child);
      return child;
    },
    addEventListener(type, fn) {
      this._listeners[type] = this._listeners[type] || [];
      this._listeners[type].push(fn);
    },
    querySelector(sel) {
      return queryAll(this, sel)[0] || null;
    },
    querySelectorAll(sel) {
      return queryAll(this, sel);
    },
  };

  Object.defineProperty(node, "innerHTML", {
    configurable: true,
    set(html) {
      this.childNodes = [];
      // Support the banner template only.
      if (html.indexOf("fb-continue__inner") === -1) return;
      const inner = createNode("div", { className: "fb-continue__inner" });
      const question = createNode("p", { className: "fb-continue__question" });
      question.textContent = "Продолжить?";
      const link = createNode("a", { className: "fb-continue__link" });
      link.href = "#";
      const close = createNode("button", { className: "fb-continue__close" });
      inner.appendChild(question);
      inner.appendChild(link);
      inner.appendChild(close);
      this.appendChild(inner);
    },
    get() {
      return "";
    },
  });

  return node;
}

function matches(node, sel) {
  if (sel === "h2") return node.tagName === "H2";
  if (sel === "h1") return node.tagName === "H1";
  if (sel === "h1.iv-page-title") {
    return node.tagName === "H1" && /\biv-page-title\b/.test(node.className);
  }
  if (sel === "article h1") return false; // not needed in fixtures
  if (sel === ".fb-continue__link") {
    return /\bfb-continue__link\b/.test(node.className);
  }
  if (sel === ".fb-continue__close") {
    return /\bfb-continue__close\b/.test(node.className);
  }
  if (sel === 'a[id^="ch-"]') {
    return node.tagName === "A" && /^ch-/.test(node.id);
  }
  return false;
}

function walk(node, out) {
  out.push(node);
  for (let i = 0; i < node.childNodes.length; i++) {
    walk(node.childNodes[i], out);
  }
}

function queryAll(root, sel) {
  const all = [];
  walk(root, all);
  // skip root itself for querySelectorAll semantics on descendants? include all
  return all.filter((n) => n !== root && matches(n, sel));
}

function linkSiblings(nodes) {
  for (let i = 0; i < nodes.length - 1; i++) {
    nodes[i].nextElementSibling = nodes[i + 1];
  }
}

function makePartDocument() {
  const doc = createNode("#document");
  doc.documentElement = createNode("html");
  doc.documentElement.classList = {
    _set: new Set(),
    add(c) {
      this._set.add(c);
    },
    remove(c) {
      this._set.delete(c);
    },
    contains(c) {
      return this._set.has(c);
    },
  };
  doc.body = createNode("body");
  doc.body.ownerDocument = doc;
  doc.documentElement.ownerDocument = doc;

  const title = createNode("h1", {
    className: "iv-page-title",
    textContent: "Часть 1. Вера и Бог",
  });
  const p0 = createNode("p");
  const a0 = createNode("a", { id: "ch-0" });
  p0.appendChild(a0);
  const h0 = createNode("h2", { textContent: "Вступление: Время для нас двоих" });
  const p1 = createNode("p");
  const a1 = createNode("a", { id: "ch-1" });
  p1.appendChild(a1);
  const h1 = createNode("h2", { textContent: "Глава 1. Ты — Божье чудо" });
  const junkP = createNode("p");
  const junkA = createNode("a", { id: "ignore-me" });
  junkP.appendChild(junkA);
  const junkH = createNode("h2", { textContent: "Not a chapter" });

  const article = createNode("article");
  const sequence = [title, p0, h0, p1, h1, junkP, junkH];
  linkSiblings(sequence);
  sequence.forEach((n) => {
    n.ownerDocument = doc;
    article.appendChild(n);
  });
  // Re-link after append: title.. are direct children of article
  linkSiblings(article.childNodes);

  doc.body.appendChild(title);
  // Put chapter blocks under body as well for querySelectorAll from doc
  [p0, h0, p1, h1, junkP, junkH].forEach((n) => doc.body.appendChild(n));
  linkSiblings([title, p0, h0, p1, h1, junkP, junkH]);

  doc.getElementById = function (id) {
    const all = [];
    walk(doc.body, all);
    return all.find((n) => n.id === id) || null;
  };
  doc.createElement = function (tag) {
    const n = createNode(tag);
    n.ownerDocument = doc;
    return n;
  };
  doc.querySelector = function (sel) {
    return queryAll(doc.body, sel)[0] || null;
  };
  doc.querySelectorAll = function (sel) {
    return queryAll(doc.body, sel);
  };
  doc.cookie = "";
  Object.defineProperty(doc, "cookie", {
    configurable: true,
    get() {
      return this._cookie || "";
    },
    set(v) {
      // Keep last assignment simple for tests (single cookie write)
      const name = v.split("=")[0];
      const existing = (this._cookie || "")
        .split("; ")
        .filter(Boolean)
        .filter((c) => c.split("=")[0] !== name);
      existing.push(v.split(";")[0]);
      this._cookie = existing.join("; ");
    },
  });

  return doc;
}

describe("normalizeProgress", () => {
  it("accepts a well-formed progress object", () => {
    const p = normalizeProgress(validProgress());
    assert.equal(p.path, "/part-01-vera/");
    assert.equal(p.chapter, "ch-5");
    assert.equal(p.partTitle, "Часть 1. Вера и Бог");
  });

  it("rejects missing path or bad chapter id", () => {
    assert.equal(normalizeProgress({ path: "/x/", chapter: "nope" }), null);
    assert.equal(normalizeProgress({ path: "", chapter: "ch-1" }), null);
    assert.equal(normalizeProgress(null), null);
  });

  it("rejects absolute URLs and protocol-relative paths", () => {
    assert.equal(
      normalizeProgress(validProgress({ path: "https://evil.test/x" })),
      null
    );
    assert.equal(
      normalizeProgress(validProgress({ path: "//evil.test/x" })),
      null
    );
    assert.equal(
      normalizeProgress(validProgress({ path: "part-01-vera/" })),
      null
    );
  });

  it("accepts ch-0", () => {
    assert.equal(
      normalizeProgress(validProgress({ chapter: "ch-0" })).chapter,
      "ch-0"
    );
  });
});

describe("cookie encode/decode", () => {
  it("round-trips Cyrillic titles through encodeURIComponent JSON", () => {
    const raw = encodeProgress(validProgress());
    const decoded = decodeProgress(raw);
    assert.equal(decoded.path, "/part-01-vera/");
    assert.equal(decoded.chapter, "ch-5");
    assert.equal(decoded.partTitle, "Часть 1. Вера и Бог");
    assert.equal(
      decoded.chapterTitle,
      "Глава 5. Как разговаривать с Невидимым Царём?"
    );
  });

  it("returns null for garbage cookie payloads", () => {
    assert.equal(decodeProgress("not-json"), null);
    assert.equal(decodeProgress("%7B%22path%22%3A1%7D"), null);
    assert.equal(decodeProgress(""), null);
  });

  it("reads the named cookie from a document.cookie string", () => {
    const value = encodeProgress(validProgress());
    const jar = `other=1; ${COOKIE_NAME}=${value}; theme=slate`;
    assert.equal(readCookie(jar, COOKIE_NAME), value);
    assert.equal(readProgressCookie(jar).chapter, "ch-5");
  });

  it("builds a Lax cookie with Path and Max-Age", () => {
    const s = buildCookieString(COOKIE_NAME, "abc", {
      path: "/father_book/",
      maxAge: 60,
      secure: true,
    });
    assert.match(s, new RegExp("^" + COOKIE_NAME + "=abc;"));
    assert.match(s, /Path=\/father_book\//);
    assert.match(s, /Max-Age=60/);
    assert.match(s, /SameSite=Lax/);
    assert.match(s, /Secure/);
  });
});

describe("continue offer decisions", () => {
  const progress = validProgress();

  it("builds href with hash chapter", () => {
    assert.equal(continueHref(progress), "/part-01-vera/#ch-5");
  });

  it("detects same position with or without leading hash", () => {
    assert.equal(isSamePosition(progress, "/part-01-vera/", "#ch-5"), true);
    assert.equal(isSamePosition(progress, "/part-01-vera/", "ch-5"), true);
    assert.equal(isSamePosition(progress, "/part-01-vera/", "#ch-4"), false);
    assert.equal(isSamePosition(progress, "/", "#ch-5"), false);
  });

  it("offers continue on other pages, not on the saved chapter", () => {
    assert.equal(shouldOfferContinue(progress, "/", "", false), true);
    assert.equal(shouldOfferContinue(progress, "/part-02-telo/", "", false), true);
    assert.equal(
      shouldOfferContinue(progress, "/part-01-vera/", "#ch-5", false),
      false
    );
    assert.equal(shouldOfferContinue(progress, "/", "", true), false);
    assert.equal(shouldOfferContinue(null, "/", "", false), false);
  });

  it("formats the link label from part and chapter titles", () => {
    assert.equal(
      linkLabel(progress),
      "Часть 1. Вера и Бог · Глава 5. Как разговаривать с Невидимым Царём?"
    );
    assert.equal(
      linkLabel(
        validProgress({ chapterTitle: "", chapter: "ch-0", partTitle: "Часть 1" })
      ),
      "Часть 1 · Вступление"
    );
    assert.equal(
      linkLabel(
        validProgress({ chapterTitle: "", chapter: "ch-12", partTitle: "Часть 1" })
      ),
      "Часть 1 · Глава 12"
    );
  });
});

describe("site base path", () => {
  it("derives cookie Path from the script URL", () => {
    assert.equal(
      detectSiteBasePath(
        "https://example.github.io/father_book/javascripts/continue-reading.js"
      ),
      "/father_book/"
    );
    assert.equal(
      detectSiteBasePath("http://127.0.0.1:8000/javascripts/continue-reading.js"),
      "/"
    );
    assert.equal(detectSiteBasePath(""), "/");
  });
});

describe("part page detection", () => {
  it("recognizes part URLs only", () => {
    assert.equal(isPartPage("/part-01-vera/"), true);
    assert.equal(isPartPage("/father_book/part-16-zabota/"), true);
    assert.equal(isPartPage("/father_book/part-17-rastem/"), true);
    assert.equal(isPartPage("/father_book/part-18-dengi/"), true);
    assert.equal(isPartPage("/"), false);
    assert.equal(isPartPage("/index.html"), false);
  });
});

describe("resolveActiveChapter", () => {
  it("picks the last chapter whose heading crossed the reading line", () => {
    const chapters = [
      { id: "ch-0", heading: "h0" },
      { id: "ch-1", heading: "h1" },
      { id: "ch-2", heading: "h2" },
    ];
    const rects = {
      h0: { top: -100 },
      h1: { top: 50 },
      h2: { top: 400 },
    };
    const active = resolveActiveChapter(chapters, 800, (el) => rects[el]);
    assert.equal(active.id, "ch-1");
  });

  it("returns the first chapter when all are below the line", () => {
    const chapters = [
      { id: "ch-0", heading: "h0" },
      { id: "ch-1", heading: "h1" },
    ];
    const active = resolveActiveChapter(chapters, 800, () => ({ top: 500 }));
    assert.equal(active.id, "ch-0");
  });

  it("returns null for empty list", () => {
    assert.equal(resolveActiveChapter([], 800, () => ({ top: 0 })), null);
  });
});

describe("DOM chapter extraction and banner", () => {
  it("collects only ch-N anchors and their following h2 titles", () => {
    const doc = makePartDocument();
    assert.equal(getPartTitle(doc), "Часть 1. Вера и Бог");

    const a0 = doc.querySelectorAll('a[id^="ch-"]')[0];
    assert.equal(a0.id, "ch-0");
    assert.equal(
      findChapterHeading(a0).textContent,
      "Вступление: Время для нас двоих"
    );

    const chapters = collectChapters(doc);
    assert.equal(chapters.length, 2);
    assert.equal(chapters[0].id, "ch-0");
    assert.equal(chapters[0].title, "Вступление: Время для нас двоих");
    assert.equal(chapters[1].id, "ch-1");
    assert.equal(chapters[1].title, "Глава 1. Ты — Божье чудо");
  });

  it("renders and toggles the continue banner", () => {
    const doc = makePartDocument();
    const bar = createBanner(doc);
    assert.equal(bar.id, "fb-continue");
    assert.equal(bar.hidden, true);

    updateBanner(bar, validProgress());
    const link = bar.querySelector(".fb-continue__link");
    assert.equal(link.href, "/part-01-vera/#ch-5");
    assert.match(link.textContent, /Часть 1/);

    showBanner(bar, validProgress());
    assert.equal(bar.hidden, false);
    assert.equal(doc.documentElement.classList.contains("fb-continue-visible"), true);

    hideBanner(bar);
    assert.equal(bar.hidden, true);
    assert.equal(doc.documentElement.classList.contains("fb-continue-visible"), false);
  });
});

describe("controller: offer vs cookie protection", () => {
  function mockWin(pathname, hash) {
    const listeners = {};
    return {
      location: {
        pathname: pathname,
        hash: hash || "",
        protocol: "http:",
      },
      innerHeight: 800,
      addEventListener(type, fn) {
        listeners[type] = listeners[type] || [];
        listeners[type].push(fn);
      },
      setTimeout(fn) {
        fn();
        return 1;
      },
      clearTimeout() {},
      _listeners: listeners,
    };
  }

  function memoryStorage() {
    const data = {};
    return {
      getItem(k) {
        return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null;
      },
      setItem(k, v) {
        data[k] = String(v);
      },
    };
  }

  it("shows resume banner on home when cookie has a chapter", () => {
    const doc = makePartDocument();
    const progress = validProgress();
    doc.cookie = COOKIE_NAME + "=" + encodeProgress(progress);

    const win = mockWin("/", "");
    const storage = memoryStorage();
    // Pretend script URL for base path
    const script = createNode("script");
    script.src = "http://127.0.0.1:8000/javascripts/continue-reading.js";
    doc.getElementsByTagName = function (tag) {
      if (tag === "script") return [script];
      return [];
    };

    // Home: no chapters in body for collect — wipe chapter nodes for this case
    const homeDoc = makePartDocument();
    homeDoc.cookie = COOKIE_NAME + "=" + encodeProgress(progress);
    homeDoc.body.childNodes = [createNode("h1", { textContent: "Начало" })];
    homeDoc.getElementsByTagName = doc.getElementsByTagName;
    homeDoc.getElementById = function (id) {
      const all = [];
      walk(homeDoc.body, all);
      return all.find((n) => n.id === id) || null;
    };
    homeDoc.createElement = doc.createElement;
    homeDoc.querySelector = function (sel) {
      return queryAll(homeDoc.body, sel)[0] || null;
    };
    homeDoc.querySelectorAll = function (sel) {
      return queryAll(homeDoc.body, sel);
    };
    homeDoc.documentElement = doc.documentElement;

    const controller = createController(win, homeDoc, storage);
    controller.init();

    const bar = homeDoc.getElementById("fb-continue");
    assert.ok(bar);
    assert.equal(bar.hidden, false);
    assert.equal(
      bar.querySelector(".fb-continue__link").href,
      "/part-01-vera/#ch-5"
    );
  });

  it("does not overwrite resume cookie while offer is visible on another part", () => {
    const doc = makePartDocument();
    const saved = validProgress({
      path: "/part-05-serdtse/",
      chapter: "ch-50",
      partTitle: "Часть 5. Экраны и сердце",
      chapterTitle: "Глава 50",
    });
    doc.cookie = COOKIE_NAME + "=" + encodeProgress(saved);

    const script = createNode("script");
    script.src = "http://127.0.0.1:8000/javascripts/continue-reading.js";
    doc.getElementsByTagName = function (tag) {
      if (tag === "script") return [script];
      return [];
    };

    // Chapter headings need getBoundingClientRect for save path
    const chaptersBefore = collectChapters(doc);
    chaptersBefore.forEach((ch) => {
      ch.heading.getBoundingClientRect = () => ({ top: 10 });
    });

    const win = mockWin("/part-01-vera/", "");
    const storage = memoryStorage();
    const controller = createController(win, doc, storage);
    controller.init();

    assert.equal(readProgressCookie(doc.cookie).chapter, "ch-50");
    assert.equal(readProgressCookie(doc.cookie).path, "/part-05-serdtse/");

    const bar = doc.getElementById("fb-continue");
    assert.equal(bar.hidden, false);
  });

  it("hides banner after dismiss and remembers session dismiss", () => {
    const doc = makePartDocument();
    doc.cookie = COOKIE_NAME + "=" + encodeProgress(validProgress());
    const script = createNode("script");
    script.src = "http://127.0.0.1:8000/javascripts/continue-reading.js";
    doc.getElementsByTagName = function (tag) {
      if (tag === "script") return [script];
      return [];
    };

    const win = mockWin("/", "");
    // empty home body
    doc.body.childNodes = [];
    const storage = memoryStorage();
    const controller = createController(win, doc, storage);
    controller.init();

    const bar = doc.getElementById("fb-continue");
    assert.equal(bar.hidden, false);

    const close = bar.querySelector(".fb-continue__close");
    close._listeners.click[0]({ preventDefault() {} });
    assert.equal(bar.hidden, true);
    assert.equal(storage.getItem(SESSION_DISMISS_KEY), "1");

    controller.refreshOffer();
    assert.equal(bar.hidden, true);
  });

  it("does not show banner on first visit when cookie is created while reading", () => {
    const doc = makePartDocument();
    doc.cookie = "";
    const script = createNode("script");
    script.src = "http://127.0.0.1:8000/javascripts/continue-reading.js";
    doc.getElementsByTagName = function (tag) {
      if (tag === "script") return [script];
      return [];
    };
    collectChapters(doc).forEach((ch) => {
      ch.heading.getBoundingClientRect = () => ({ top: 10 });
    });

    const win = mockWin("/part-01-vera/", "");
    const storage = memoryStorage();
    const controller = createController(win, doc, storage);
    controller.init();

    assert.ok(readProgressCookie(doc.cookie), "progress is saved while reading");
    assert.equal(doc.getElementById("fb-continue").hidden, true);

    controller.refreshOffer();
    assert.equal(
      doc.getElementById("fb-continue").hidden,
      true,
      "later saves must not open the offer in the same session"
    );
  });
});

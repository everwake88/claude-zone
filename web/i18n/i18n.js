/* Everwake — language engine.

   Translations are keyed by the English text itself. Each language file
   (ar.js, es.js, fr.js) is a plain list of pairs:

       "Pricing": "الأسعار",

   Any sentence without a translation simply stays in English, so a missing
   entry never breaks a page. Add ?i18n-debug=1 to any address to list, in the
   browser console, every sentence on that page still waiting for a
   translation.

   Must load synchronously in <head>, after site-config.js. */
(function () {
  "use strict";

  var LANGS = {
    en: { name: "English",  short: "EN",   dir: "ltr" },
    ar: { name: "العربية",  short: "عربي", dir: "rtl" },
    es: { name: "Español",  short: "ES",   dir: "ltr" },
    fr: { name: "Français", short: "FR",   dir: "ltr" }
  };
  var STORE_KEY = "ew-lang";
  var html = document.documentElement;
  var script = document.currentScript;
  var base = script && script.src ? script.src.replace(/[^\/]*$/, "") : "i18n/";
  var cfg = (window.EVERWAKE && window.EVERWAKE.languages) || {};

  function readStore() { try { return localStorage.getItem(STORE_KEY); } catch (e) { return null; } }
  function writeStore(v) { try { localStorage.setItem(STORE_KEY, v); return true; } catch (e) { return false; } }
  function urlLang() {
    var m = /[?&]lang=([a-z]{2})\b/i.exec(location.search);
    return m ? m[1].toLowerCase() : "";
  }

  /* ---- Decide the language before the page paints ------------------------ */
  var lang = urlLang();
  if (LANGS[lang]) {
    writeStore(lang);
  } else {
    lang = readStore();
    if (!LANGS[lang]) {
      lang = "en";
      if (cfg.autoDetect !== false) {
        var prefs = navigator.languages || [navigator.language || ""];
        for (var i = 0; i < prefs.length; i++) {
          var code = String(prefs[i]).slice(0, 2).toLowerCase();
          if (LANGS[code]) { lang = code; break; }
        }
      }
    }
  }

  var dicts = {};

  if (lang !== "en") {
    html.lang = lang;
    html.dir = LANGS[lang].dir;
    /* Hide the page for the instant between parsing and translating, so a
       visitor never sees the English text flash first. */
    html.classList.add("ew-i18n-pending");
    document.write('<style>.ew-i18n-pending body{visibility:hidden}</style>');
    /* A plain script tag rather than fetch(): it loads before the body is
       parsed, and it also works when the site is opened straight from disk. */
    document.write('<script src="' + base + lang + '.js"><\/script>');
  }

  /* ---- Normalising keys ---------------------------------------------------- */
  function norm(s) { return String(s).replace(/\s+/g, " ").trim(); }
  function normHtml(s) {
    return norm(s).replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/<br\s*\/?>/gi, "<br>");
  }
  function hasWords(s) { return /[A-Za-zÀ-ɏ]{2,}/.test(s); }
  /* Emails, phone numbers and web addresses are never translated. */
  function isLiteral(s) { return /@|^https?:|^[+\d][\d\s().-]{5,}$/.test(s); }
  function has(d, k) { return Object.prototype.hasOwnProperty.call(d, k); }

  /* ---- Walking the page ----------------------------------------------------
     A "unit" is an element holding only text plus simple formatting
     (<strong>, <em>, <br>…). A unit is translated whole, so a sentence with
     a bold phrase in it can be reordered for Arabic word order. Anything
     else is descended into, and its loose text pieces translated alone. */
  var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, CODE: 1, PRE: 1, TEXTAREA: 1, IFRAME: 1 };
  var INLINE = { STRONG: 1, B: 1, EM: 1, I: 1, BR: 1, SMALL: 1, SUP: 1, SUB: 1, ABBR: 1, MARK: 1, WBR: 1 };

  function skipped(el) {
    return SKIP[el.nodeName] || el.namespaceURI === "http://www.w3.org/2000/svg" ||
           el.hasAttribute("data-i18n-skip") || el.getAttribute("translate") === "no";
  }
  function inlineOnly(el) {
    for (var c = el.firstElementChild; c; c = c.nextElementSibling) {
      if (!INLINE[c.nodeName] || c.attributes.length || !inlineOnly(c)) return false;
    }
    return true;
  }
  function walk(el, visit) {
    if (skipped(el)) return;
    if (/\S/.test(el.textContent) && inlineOnly(el)) {
      visit(el.firstElementChild ? "html" : "text", el);
      return;
    }
    for (var n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 1) walk(n, visit);
      else if (n.nodeType === 3 && /\S/.test(n.nodeValue)) visit("node", n);
    }
  }
  function keyOf(kind, n) {
    return kind === "node" ? norm(n.nodeValue)
         : kind === "text" ? norm(n.textContent)
         : normHtml(n.innerHTML);
  }

  var ATTRS = ["placeholder", "aria-label", "title", "alt"];
  var done = typeof WeakSet === "function" ? new WeakSet() : null;

  /* Text that scripts already translated (via t()) shows up here in the
     target language; it is recognised as a translation, not reported missing. */
  var translated = null;
  function isTranslation(d, k) {
    if (!translated) {
      translated = {};
      for (var key in d) if (has(d, key)) translated[norm(d[key])] = 1;
    }
    return has(translated, k);
  }

  function apply(root) {
    var d = dicts[lang], missing = [];
    if (lang === "en" || !d) return missing;
    root = root || document.body;

    walk(root, function (kind, n) {
      if (done && done.has(n)) return;
      var k = keyOf(kind, n);
      if (!hasWords(k) || isLiteral(k)) return;
      if (!has(d, k)) { if (!isTranslation(d, k)) missing.push(k); return; }
      if (kind === "node") {
        var m = /^(\s*)[\s\S]*?(\s*)$/.exec(n.nodeValue);
        n.nodeValue = m[1] + d[k] + m[2];
      } else if (kind === "text") {
        n.textContent = d[k];
      } else {
        n.innerHTML = d[k];
      }
      if (done) done.add(n);
    });

    var withAttrs = root.querySelectorAll("[placeholder],[aria-label],[title],[alt]");
    for (var i = 0; i < withAttrs.length; i++) {
      var el = withAttrs[i];
      if (el.closest("[data-i18n-skip]")) continue;
      for (var a = 0; a < ATTRS.length; a++) {
        var v = el.getAttribute(ATTRS[a]);
        if (!v) continue;
        var k = norm(v);
        if (!hasWords(k) || isLiteral(k)) continue;
        if (has(d, k)) el.setAttribute(ATTRS[a], d[k]);
        else if (!isTranslation(d, k) && missing.indexOf(k) === -1) missing.push(k);
      }
    }
    return missing;
  }

  function collect(root) {
    var keys = [];
    function add(k) { if (hasWords(k) && !isLiteral(k) && keys.indexOf(k) === -1) keys.push(k); }
    walk(root || document.body, function (kind, n) { add(keyOf(kind, n)); });
    var withAttrs = (root || document.body).querySelectorAll("[placeholder],[aria-label],[title],[alt]");
    for (var i = 0; i < withAttrs.length; i++) {
      if (withAttrs[i].closest("[data-i18n-skip]")) continue;
      for (var a = 0; a < ATTRS.length; a++) {
        var v = withAttrs[i].getAttribute(ATTRS[a]);
        if (v) add(norm(v));
      }
    }
    return keys;
  }

  function translateHead() {
    var d = dicts[lang];
    if (lang === "en" || !d) return;
    var t = norm(document.title);
    if (has(d, t)) document.title = d[t];
    var meta = document.querySelector('meta[name="description"]');
    if (meta) {
      var k = norm(meta.getAttribute("content") || "");
      if (has(d, k)) meta.setAttribute("content", d[k]);
    }
  }

  function reveal() { html.classList.remove("ew-i18n-pending"); }

  var I = window.EW_I18N = {
    lang: lang,
    languages: LANGS,
    missing: [],
    register: function (code, dict) { dicts[code] = dict; },
    /* For text that scripts create after the page has loaded. */
    t: function (s) {
      var d = dicts[lang];
      if (lang === "en" || !d) return s;
      var k = norm(s);
      return has(d, k) ? d[k] : s;
    },
    apply: apply,
    collect: collect,
    setLang: function (code) {
      if (!LANGS[code]) return;
      var saved = writeStore(code);
      var url = location.pathname + location.search.replace(/([?&])lang=[a-z]{2}&?/i, "$1").replace(/[?&]$/, "");
      /* If storage is blocked (private mode), carry the choice in the URL. */
      if (!saved) url += (url.indexOf("?") === -1 ? "?" : "&") + "lang=" + code;
      location.href = url + location.hash;
    }
  };

  document.addEventListener("DOMContentLoaded", function () {
    I.missing = apply(document.body);
    translateHead();
    reveal();
    if (/[?&]i18n-debug=1/.test(location.search) && window.console) {
      console.info("[Everwake i18n] " + lang + ": " + I.missing.length + " untranslated", I.missing);
    }
  });
  /* Never leave the page hidden if something goes wrong. */
  setTimeout(reveal, 2500);
})();

/* Everwake — site behaviour.
   Reads web/site-config.js and builds everything that depends on it:
   contact details, social links, the WhatsApp button and the contact form.
   Anything left empty in the settings is hidden, never shown as a gap. */
(function () {
  "use strict";

  var CFG = window.EVERWAKE || {};
  var contact = CFG.contact || {};
  var social = CFG.social || {};
  var I18N = window.EW_I18N;
  var t = I18N ? I18N.t : function (s) { return s; };
  var desktop = window.matchMedia("(min-width: 1081px) and (hover: hover) and (pointer: fine)");

  function filled(v) { return typeof v === "string" && v.trim() !== ""; }
  function safeUrl(v) { return /^https?:\/\//i.test((v || "").trim()) ? v.trim() : ""; }
  function el(tag, attrs, text) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) if (attrs.hasOwnProperty(k)) n.setAttribute(k, attrs[k]);
    if (text != null) n.textContent = text;
    return n;
  }
  function digits(raw) { return String(raw).replace(/\D/g, ""); }
  function prettyPhone(raw) {
    var m = String(raw).replace(/[^\d+]/g, "").match(/^(\+\d{1,3})(\d{3})(\d{3})(\d{4})$/);
    return m ? m[1] + " " + m[2] + " " + m[3] + " " + m[4] : raw;
  }
  function telHref(raw) { return "tel:+" + digits(raw); }
  function waHref(raw, text) {
    return "https://wa.me/" + digits(raw) + (text ? "?text=" + encodeURIComponent(text) : "");
  }
  function phones() {
    var list = Array.isArray(contact.phones) ? contact.phones.filter(filled) : [];
    return list.filter(function (p, i) { return list.indexOf(p) === i; });
  }

  var WA_PATH = "M12.04 2a9.9 9.9 0 00-8.5 14.95L2 22l5.2-1.5A9.9 9.9 0 1012.04 2zm0 1.9a8 8 0 016.9 12.03l-.2.33.86 3.14-3.22-.85-.32.19a8 8 0 11-4.02-14.84zm4.6 10.1c-.25-.13-1.47-.73-1.7-.81-.23-.09-.4-.13-.56.12-.17.25-.65.81-.8.98-.14.16-.29.19-.54.06a6.5 6.5 0 01-1.92-1.18 7.2 7.2 0 01-1.33-1.65c-.14-.25-.02-.38.11-.5.11-.11.25-.29.37-.44.12-.15.16-.25.25-.42.08-.17.04-.31-.02-.44-.06-.12-.56-1.35-.77-1.85-.2-.48-.4-.42-.56-.42h-.47c-.16 0-.43.06-.65.31-.23.25-.86.84-.86 2.05s.88 2.38 1 2.54c.13.17 1.73 2.64 4.2 3.7.58.26 1.04.41 1.4.52.59.19 1.12.16 1.55.1.47-.07 1.46-.6 1.67-1.18.2-.57.2-1.07.14-1.17-.06-.1-.23-.16-.48-.29z";

  /* ---- 1. Dropdown menus (Services, language) ------------------------------
     Click or keyboard opens them everywhere; on a desktop with a mouse,
     hovering opens them too. Escape or a click elsewhere closes them. */
  var menus = Array.prototype.slice.call(document.querySelectorAll("[data-ew-menu]"));
  function setMenu(host, open) {
    host.setAttribute("data-open", String(open));
    var trig = host.querySelector("[aria-controls]");
    if (trig) trig.setAttribute("aria-expanded", String(open));
  }
  function closeAll(except) { menus.forEach(function (m) { if (m !== except) setMenu(m, false); }); }

  menus.forEach(function (host) {
    var trig = host.querySelector("[aria-controls]");
    var timer, hoverOpened = false;
    if (!trig) return;
    trig.addEventListener("click", function (e) {
      e.stopPropagation();
      /* With a mouse, reaching the button has already opened the menu by
         hover. The click that naturally follows must not close it again. */
      if (hoverOpened) { hoverOpened = false; setMenu(host, true); return; }
      var open = host.getAttribute("data-open") !== "true";
      closeAll(host);
      setMenu(host, open);
    });
    host.addEventListener("mouseenter", function () {
      if (!desktop.matches) return;
      clearTimeout(timer);
      if (host.getAttribute("data-open") !== "true") hoverOpened = true;
      closeAll(host); setMenu(host, true);
    });
    host.addEventListener("mouseleave", function () {
      if (!desktop.matches) return;
      hoverOpened = false;
      timer = setTimeout(function () { setMenu(host, false); }, 160);
    });
    host.addEventListener("focusout", function (e) {
      if (desktop.matches && !host.contains(e.relatedTarget)) setMenu(host, false);
    });
  });
  document.addEventListener("click", function (e) {
    menus.forEach(function (m) { if (!m.contains(e.target)) setMenu(m, false); });
  });
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    menus.forEach(function (m) {
      if (m.getAttribute("data-open") === "true") {
        setMenu(m, false);
        var trig = m.querySelector("[aria-controls]");
        if (trig && m.contains(document.activeElement)) trig.focus();
      }
    });
  });

  /* ---- 2. Mobile navigation ----------------------------------------------- */
  (function mobileNav() {
    var toggle = document.querySelector(".nav-toggle");
    var nav = document.getElementById("nav");
    if (!toggle || !nav) return;
    var label = toggle.querySelector(".visually-hidden");
    function setOpen(open) {
      nav.setAttribute("data-open", String(open));
      toggle.setAttribute("aria-expanded", String(open));
      if (label) label.textContent = t(open ? "Close menu" : "Menu");
    }
    toggle.addEventListener("click", function () { setOpen(nav.getAttribute("data-open") !== "true"); });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && nav.getAttribute("data-open") === "true") { setOpen(false); toggle.focus(); }
    });
    nav.addEventListener("click", function (e) { if (e.target.closest("a")) setOpen(false); });
  })();

  /* ---- 3. Language switcher ----------------------------------------------- */
  (function languages() {
    var current = I18N ? I18N.lang : "en";
    var langs = I18N ? I18N.languages : { en: { short: "EN" } };
    document.querySelectorAll('[data-ew="lang-current"]').forEach(function (n) {
      n.textContent = (langs[current] || langs.en).short;
    });
    document.querySelectorAll("[data-lang]").forEach(function (b) {
      if (b.getAttribute("data-lang") === current) b.setAttribute("aria-current", "true");
      b.addEventListener("click", function () {
        if (I18N && b.getAttribute("data-lang") !== current) I18N.setLang(b.getAttribute("data-lang"));
      });
    });
  })();

  /* ---- 4. Contact details --------------------------------------------------- */
  (function footerContacts() {
    document.querySelectorAll('[data-ew="footer-contacts"]').forEach(function (list) {
      var items = [];
      if (filled(contact.email)) items.push(["mailto:" + contact.email, contact.email]);
      phones().forEach(function (p) { items.push([telHref(p), prettyPhone(p)]); });
      if (!items.length) items.push(["#get-in-touch", "Send us a message"]);
      items.forEach(function (pair) {
        var li = el("li");
        li.appendChild(el("a", { href: pair[0] }, pair[1]));
        list.appendChild(li);
      });
    });
  })();

  var ICON = {
    email: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 6.5 8.5 6.5 8.5-6.5"/></svg>',
    phone: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h3.2l1.8 4.6-2.3 1.5a11.5 11.5 0 0 0 6.2 6.2l1.5-2.3L20 15.8V19a2 2 0 0 1-2.2 2A17 17 0 0 1 3 6.2 2 2 0 0 1 5 4z"/></svg>',
    whatsapp: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + WA_PATH + '"/></svg>'
  };

  (function contactDirect() {
    document.querySelectorAll('[data-ew="contact-direct"]').forEach(function (host) {
      var rows = [];
      if (filled(contact.email)) rows.push(["email", "Email", contact.email, "mailto:" + contact.email]);
      if (filled(contact.whatsapp)) rows.push(["whatsapp", "WhatsApp", prettyPhone(contact.whatsapp), waHref(contact.whatsapp)]);
      /* The WhatsApp number already has its own row; list only the others. */
      phones().forEach(function (p) {
        if (digits(p) !== digits(contact.whatsapp || "")) rows.push(["phone", "Phone", prettyPhone(p), telHref(p)]);
      });
      if (filled(contact.location)) rows.push(["email", "Based in", contact.location, null]);

      rows.forEach(function (r) {
        var item = el(r[3] ? "a" : "div", { class: "contact-direct__item" });
        if (r[3]) {
          item.setAttribute("href", r[3]);
          if (r[0] === "whatsapp") { item.setAttribute("target", "_blank"); item.setAttribute("rel", "noopener noreferrer"); }
        }
        var icon = el("span", { class: "contact-direct__icon" + (r[0] === "whatsapp" ? " contact-direct__icon--wa" : "") });
        icon.innerHTML = ICON[r[0]];
        var text = el("span");
        text.appendChild(el("span", { class: "contact-direct__label" }, t(r[1])));
        text.appendChild(el("span", { class: "contact-direct__value" }, r[2]));
        item.appendChild(icon); item.appendChild(text);
        host.appendChild(item);
      });
    });
  })();

  /* ---- 5. Social links ------------------------------------------------------ */
  var SOCIAL_ICONS = {
    linkedin:  "M4.98 3.5a2.5 2.5 0 11-.02 5 2.5 2.5 0 01.02-5zM3 9h4v12H3zM10 9h3.8v1.7h.05c.53-.95 1.83-1.95 3.77-1.95 4.03 0 4.78 2.5 4.78 5.76V21h-4v-5.6c0-1.34-.03-3.06-1.9-3.06-1.9 0-2.2 1.45-2.2 2.96V21h-4z",
    instagram: "M12 2.2c3.2 0 3.58.01 4.85.07 3.25.15 4.77 1.69 4.92 4.92.06 1.27.07 1.65.07 4.85s-.01 3.58-.07 4.85c-.15 3.23-1.66 4.77-4.92 4.92-1.27.06-1.64.07-4.85.07s-3.58-.01-4.85-.07c-3.26-.15-4.77-1.7-4.92-4.92C2.21 15.58 2.2 15.2 2.2 12s.01-3.58.07-4.85C2.42 3.92 3.93 2.38 7.15 2.23 8.42 2.18 8.8 2.2 12 2.2zm0 4.9a4.9 4.9 0 100 9.8 4.9 4.9 0 000-9.8zm0 8.08a3.18 3.18 0 110-6.36 3.18 3.18 0 010 6.36zm5.1-9.44a1.15 1.15 0 100 2.3 1.15 1.15 0 000-2.3z",
    facebook:  "M22 12.06C22 6.5 17.52 2 12 2S2 6.5 2 12.06c0 5 3.66 9.15 8.44 9.94v-7.03H7.9v-2.91h2.54V9.85c0-2.52 1.49-3.91 3.77-3.91 1.1 0 2.24.2 2.24.2v2.46h-1.26c-1.24 0-1.63.78-1.63 1.57v1.89h2.78l-.45 2.91h-2.33V22c4.78-.79 8.44-4.94 8.44-9.94z",
    x:         "M17.53 3h3.04l-6.64 7.59L21.75 21h-5.9l-4.62-6.04L5.94 21H2.9l7.1-8.12L2.5 3h6.05l4.18 5.52L17.53 3zm-1.07 16.2h1.69L7.63 4.72H5.82l10.64 14.48z",
    youtube:   "M21.58 7.19a2.52 2.52 0 00-1.77-1.78C18.25 5 12 5 12 5s-6.25 0-7.81.41a2.52 2.52 0 00-1.77 1.78A26.2 26.2 0 002 12a26.2 26.2 0 00.42 4.81 2.52 2.52 0 001.77 1.78C5.75 19 12 19 12 19s6.25 0 7.81-.41a2.52 2.52 0 001.77-1.78A26.2 26.2 0 0022 12a26.2 26.2 0 00-.42-4.81zM10 15.02V8.98L15.2 12z",
    tiktok:    "M16.6 5.82A4.28 4.28 0 0115.54 3h-3.09v12.4a2.59 2.59 0 01-2.59 2.5 2.59 2.59 0 01-2.59-2.59 2.59 2.59 0 013.19-2.52V9.66a5.72 5.72 0 00-.6-.03A5.69 5.69 0 004.17 15.3 5.69 5.69 0 009.86 21a5.69 5.69 0 005.69-5.69V9.01a7.35 7.35 0 004.29 1.37V7.3a4.3 4.3 0 01-3.24-1.48z",
    whatsapp:  WA_PATH
  };
  var SOCIAL_LABELS = { linkedin: "LinkedIn", instagram: "Instagram", facebook: "Facebook", x: "X", youtube: "YouTube", tiktok: "TikTok", whatsapp: "WhatsApp" };

  (function renderSocial() {
    var links = [];
    Object.keys(SOCIAL_ICONS).forEach(function (key) {
      var url = social[key];
      /* WhatsApp already has the green button and a contact row, so it joins
         the social icons only when a profile link is set explicitly. */
      url = safeUrl(url);
      if (url) links.push({ key: key, url: url });
    });
    document.querySelectorAll('[data-ew="social"]').forEach(function (host) {
      if (!links.length) { host.remove(); return; }
      var ul = el("ul", { class: "social-row" });
      links.forEach(function (l) {
        var li = el("li");
        /* Platform names are brands: the same in every language. */
        var a = el("a", { href: l.url, class: "social-link", "aria-label": SOCIAL_LABELS[l.key],
                          title: SOCIAL_LABELS[l.key], target: "_blank", rel: "noopener noreferrer",
                          "data-i18n-skip": "" });
        a.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + SOCIAL_ICONS[l.key] + '"/></svg>';
        li.appendChild(a); ul.appendChild(li);
      });
      host.appendChild(ul);
    });
  })();

  /* ---- 6. The green WhatsApp button ---------------------------------------- */
  (function whatsappButton() {
    var wb = CFG.whatsappButton || {};
    if (wb.show === false || !filled(contact.whatsapp)) return;
    var a = el("a", {
      class: "wa-float", href: waHref(contact.whatsapp, filled(wb.message) ? t(wb.message) : ""),
      target: "_blank", rel: "noopener noreferrer"
    });
    a.innerHTML = '<span class="wa-float__icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + WA_PATH + '"/></svg></span>';
    a.appendChild(el("span", { class: "wa-float__label" }, t(filled(wb.label) ? wb.label : "Chat on WhatsApp")));
    document.body.appendChild(a);
  })();

  /* ---- 7. Contact form -------------------------------------------------------- */
  (function forms() {
    var fc = CFG.form || {};
    var mode = fc.mode || "auto";
    function want(m) { return mode === "auto" || mode === m; }
    var channel =
        want("web3forms") && filled(fc.web3formsKey) ? "web3forms"
      : want("formspree") && safeUrl(fc.formspreeUrl) ? "formspree"
      : want("whatsapp") && filled(contact.whatsapp) ? "whatsapp"
      : want("email") && filled(contact.email) ? "email"
      : "none";

    document.querySelectorAll('[data-ew="contact-form"]').forEach(function (form) {
      var btn = form.querySelector('button[type="submit"]');
      var note = form.querySelector('[data-ew="form-note"]');
      var status = form.querySelector('[data-ew="form-status"]');
      var btnHtml = btn ? btn.innerHTML : "";

      if (note) {
        note.textContent = t(channel === "whatsapp"
          ? "Sending opens WhatsApp with your message ready — just press send."
          : channel === "email"
          ? "Sending opens your email app with the message ready."
          : "We reply within one business day.");
      }
      if (channel === "none") {
        if (btn) btn.disabled = true;
        if (note) note.textContent = t("The enquiry form is not connected yet.");
        return;
      }

      function show(kind, message, link) {
        if (!status) return;
        status.className = "form-status form-status--" + kind;
        status.textContent = message;
        if (link) {
          status.appendChild(document.createTextNode(" "));
          status.appendChild(el("a", { href: link[0], target: "_blank", rel: "noopener noreferrer" }, link[1]));
        }
      }
      function busy(on) {
        if (!btn) return;
        btn.disabled = on;
        if (on) btn.textContent = t("Sending…"); else btn.innerHTML = btnHtml;
      }
      function fallbackLink() {
        if (filled(contact.whatsapp)) return [waHref(contact.whatsapp), t("Message us on WhatsApp")];
        if (filled(contact.email)) return ["mailto:" + contact.email, contact.email];
        return null;
      }

      form.addEventListener("submit", function (e) {
        e.preventDefault();
        if (form.reportValidity && !form.reportValidity()) return;
        var d = new FormData(form);
        if (d.get("botcheck")) { show("ok", t("Thank you — your message has been sent.")); form.reset(); return; }

        var fields = {
          name: d.get("name") || "", email: d.get("email") || "", company: d.get("company") || "",
          phone: d.get("phone") || "", interest: d.get("interest") || "", message: d.get("message") || ""
        };
        var labels = [["name", "Name"], ["company", "Company"], ["email", "Email"], ["phone", "WhatsApp"],
                      ["interest", "Interested in"], ["message", "Message"]];
        var summary = labels.filter(function (l) { return filled(fields[l[0]]); })
          .map(function (l) { return t(l[1]) + ": " + fields[l[0]]; }).join("\n");
        var subject = (fc.subject || "New enquiry from everwake.tech") + (fields.company ? " — " + fields.company : "");

        if (channel === "whatsapp") {
          window.open(waHref(contact.whatsapp, t("New enquiry — Everwake website") + "\n\n" + summary), "_blank", "noopener");
          show("ok", t("WhatsApp has opened with your message. Press send and we will reply there."));
          return;
        }
        if (channel === "email") {
          location.href = "mailto:" + contact.email + "?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(summary);
          show("ok", t("Your email app has opened with the message ready. Press send to deliver it."));
          return;
        }

        var payload = {
          name: fields.name, email: fields.email, company: fields.company, phone: fields.phone,
          interest: fields.interest, message: fields.message,
          language: I18N ? I18N.lang : "en", page: location.href
        };
        var req;
        if (channel === "web3forms") {
          payload.access_key = fc.web3formsKey;
          payload.subject = subject;
          payload.from_name = "Everwake website";
          payload.botcheck = false;
          req = fetch("https://api.web3forms.com/submit", {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify(payload)
          }).then(function (r) { return r.json(); }).then(function (j) { if (!j || !j.success) throw new Error("rejected"); });
        } else {
          payload._subject = subject;
          req = fetch(safeUrl(fc.formspreeUrl), {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify(payload)
          }).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); });
        }

        busy(true);
        req.then(function () {
          form.reset();
          show("ok", t("Thank you — your message has been sent. We reply within one business day."));
        }).catch(function () {
          show("error", t("Your message could not be sent. Please try again, or reach us directly:"), fallbackLink());
        }).then(function () { busy(false); });
      });
    });
  })();

  /* ---- 8. Small bindings ----------------------------------------------------- */
  document.querySelectorAll('[data-ew="year"]').forEach(function (n) { n.textContent = String(new Date().getFullYear()); });

  (function setupHints() {
    var todo = [];
    if (!filled(contact.email)) todo.push("contact.email");
    if (!filled(contact.whatsapp)) todo.push("contact.whatsapp");
    if (!filled((CFG.form || {}).web3formsKey) && !safeUrl((CFG.form || {}).formspreeUrl)) todo.push("form.web3formsKey (form falls back to WhatsApp)");
    if (!safeUrl((CFG.agent || {}).webhookUrl)) todo.push("agent.webhookUrl (AI chat hidden)");
    if (todo.length && window.console) console.info("[Everwake] Optional settings not filled in web/site-config.js → " + todo.join(", "));
  })();
})();

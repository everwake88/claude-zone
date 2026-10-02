/* Everwake — site behaviour.
   Reads web/site-config.js and fills in every contact detail, social link and
   form target. Anything left empty in that file is hidden rather than shown
   as a placeholder, so the site is always safe to publish half-filled. */
(function () {
  "use strict";

  var CFG = window.EVERWAKE || {};
  var contact = CFG.contact || {};
  var social = CFG.social || {};
  var company = CFG.company || {};

  function filled(v) { return typeof v === "string" && v.trim() !== ""; }
  function safeUrl(v) { return /^https?:\/\//i.test((v || "").trim()) ? v.trim() : ""; }
  function el(tag, attrs, text) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    if (text != null) n.textContent = text;
    return n;
  }
  /* "+20 155 435 4929" reads better than "+201554354929" but only the raw
     digits are valid in a tel: or wa.me link. */
  function prettyPhone(raw) {
    var d = raw.replace(/[^\d+]/g, "");
    var m = d.match(/^(\+\d{1,3})(\d{3})(\d{3})(\d{4})$/);
    return m ? m[1] + " " + m[2] + " " + m[3] + " " + m[4] : raw;
  }
  function telHref(raw) { return "tel:" + raw.replace(/[^\d+]/g, ""); }
  function waHref(raw, text) {
    var n = raw.replace(/\D/g, "");
    return "https://wa.me/" + n + (text ? "?text=" + encodeURIComponent(text) : "");
  }

  /* ---- 1. Mobile navigation --------------------------------------------- */
  (function nav() {
    var toggle = document.querySelector(".nav-toggle");
    var menu = document.getElementById("nav");
    if (!toggle || !menu) return;
    function setOpen(open) {
      menu.setAttribute("data-open", String(open));
      toggle.setAttribute("aria-expanded", String(open));
      toggle.textContent = open ? "Close" : "Menu";
    }
    toggle.addEventListener("click", function () {
      setOpen(menu.getAttribute("data-open") !== "true");
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && menu.getAttribute("data-open") === "true") {
        setOpen(false); toggle.focus();
      }
    });
    menu.addEventListener("click", function (e) { if (e.target.closest("a")) setOpen(false); });
  })();

  /* ---- 2. Footer contact list ------------------------------------------- */
  (function footerContacts() {
    document.querySelectorAll('[data-ew="footer-contacts"]').forEach(function (list) {
      var items = [];
      if (filled(contact.email)) items.push(["mailto:" + contact.email, contact.email]);
      if (filled(contact.whatsapp)) items.push([telHref(contact.whatsapp), prettyPhone(contact.whatsapp)]);
      (contact.people || []).forEach(function (p) {
        if (filled(p.phone) && p.phone !== contact.whatsapp) {
          items.push([telHref(p.phone), prettyPhone(p.phone)]);
        }
      });

      if (!items.length) {
        /* Nothing configured yet — point at the contact page instead of
           leaving an empty column in the footer. */
        var li = el("li");
        li.appendChild(el("a", { href: "contact.html" }, "Send us a message"));
        list.appendChild(li);
        return;
      }
      items.forEach(function (pair) {
        var li = el("li");
        li.appendChild(el("a", { href: pair[0] }, pair[1]));
        list.appendChild(li);
      });
    });
  })();

  /* ---- 3. Social links --------------------------------------------------- */
  var ICONS = {
    linkedin:  "M4.98 3.5a2.5 2.5 0 11-.02 5 2.5 2.5 0 01.02-5zM3 9h4v12H3zM10 9h3.8v1.7h.05c.53-.95 1.83-1.95 3.77-1.95 4.03 0 4.78 2.5 4.78 5.76V21h-4v-5.6c0-1.34-.03-3.06-1.9-3.06-1.9 0-2.2 1.45-2.2 2.96V21h-4z",
    instagram: "M12 2.2c3.2 0 3.58.01 4.85.07 3.25.15 4.77 1.69 4.92 4.92.06 1.27.07 1.65.07 4.85s-.01 3.58-.07 4.85c-.15 3.23-1.66 4.77-4.92 4.92-1.27.06-1.64.07-4.85.07s-3.58-.01-4.85-.07c-3.26-.15-4.77-1.7-4.92-4.92C2.21 15.58 2.2 15.2 2.2 12s.01-3.58.07-4.85C2.42 3.92 3.93 2.38 7.15 2.23 8.42 2.18 8.8 2.2 12 2.2zm0 4.9a4.9 4.9 0 100 9.8 4.9 4.9 0 000-9.8zm0 8.08a3.18 3.18 0 110-6.36 3.18 3.18 0 010 6.36zm5.1-9.44a1.15 1.15 0 100 2.3 1.15 1.15 0 000-2.3z",
    facebook:  "M22 12.06C22 6.5 17.52 2 12 2S2 6.5 2 12.06c0 5 3.66 9.15 8.44 9.94v-7.03H7.9v-2.91h2.54V9.85c0-2.52 1.49-3.91 3.77-3.91 1.1 0 2.24.2 2.24.2v2.46h-1.26c-1.24 0-1.63.78-1.63 1.57v1.89h2.78l-.45 2.91h-2.33V22c4.78-.79 8.44-4.94 8.44-9.94z",
    x:         "M17.53 3h3.04l-6.64 7.59L21.75 21h-5.9l-4.62-6.04L5.94 21H2.9l7.1-8.12L2.5 3h6.05l4.18 5.52L17.53 3zm-1.07 16.2h1.69L7.63 4.72H5.82l10.64 14.48z",
    youtube:   "M21.58 7.19a2.52 2.52 0 00-1.77-1.78C18.25 5 12 5 12 5s-6.25 0-7.81.41a2.52 2.52 0 00-1.77 1.78A26.2 26.2 0 002 12a26.2 26.2 0 00.42 4.81 2.52 2.52 0 001.77 1.78C5.75 19 12 19 12 19s6.25 0 7.81-.41a2.52 2.52 0 001.77-1.78A26.2 26.2 0 0022 12a26.2 26.2 0 00-.42-4.81zM10 15.02V8.98L15.2 12z",
    tiktok:    "M16.6 5.82A4.28 4.28 0 0115.54 3h-3.09v12.4a2.59 2.59 0 01-2.59 2.5 2.59 2.59 0 01-2.59-2.59 2.59 2.59 0 013.19-2.52V9.66a5.72 5.72 0 00-.6-.03A5.69 5.69 0 004.17 15.3 5.69 5.69 0 009.86 21a5.69 5.69 0 005.69-5.69V9.01a7.35 7.35 0 004.29 1.37V7.3a4.3 4.3 0 01-3.24-1.48z",
    whatsapp:  "M12.04 2a9.9 9.9 0 00-8.5 14.95L2 22l5.2-1.5A9.9 9.9 0 1012.04 2zm0 1.9a8 8 0 016.9 12.03l-.2.33.86 3.14-3.22-.85-.32.19a8 8 0 11-4.02-14.84zm4.6 10.1c-.25-.13-1.47-.73-1.7-.81-.23-.09-.4-.13-.56.12-.17.25-.65.81-.8.98-.14.16-.29.19-.54.06a6.5 6.5 0 01-1.92-1.18 7.2 7.2 0 01-1.33-1.65c-.14-.25-.02-.38.11-.5.11-.11.25-.29.37-.44.12-.15.16-.25.25-.42.08-.17.04-.31-.02-.44-.06-.12-.56-1.35-.77-1.85-.2-.48-.4-.42-.56-.42h-.47c-.16 0-.43.06-.65.31-.23.25-.86.84-.86 2.05s.88 2.38 1 2.54c.13.17 1.73 2.64 4.2 3.7.58.26 1.04.41 1.4.52.59.19 1.12.16 1.55.1.47-.07 1.46-.6 1.67-1.18.2-.57.2-1.07.14-1.17-.06-.1-.23-.16-.48-.29z"
  };
  var LABELS = {
    linkedin: "LinkedIn", instagram: "Instagram", facebook: "Facebook",
    x: "X", youtube: "YouTube", tiktok: "TikTok", whatsapp: "WhatsApp"
  };

  function socialLinks() {
    var out = [];
    Object.keys(ICONS).forEach(function (key) {
      var url = social[key];
      /* The WhatsApp link can be built from the phone number alone. */
      if (key === "whatsapp" && !filled(url) && filled(contact.whatsapp)) {
        url = waHref(contact.whatsapp);
      }
      url = safeUrl(url);
      if (url) out.push({ key: key, url: url, label: LABELS[key] });
    });
    return out;
  }

  (function renderSocial() {
    var links = socialLinks();
    document.querySelectorAll('[data-ew="social"]').forEach(function (host) {
      if (!links.length) { host.remove(); return; }
      var ul = el("ul", { class: "social-row" });
      links.forEach(function (l) {
        var li = el("li");
        var a = el("a", {
          href: l.url, class: "social-link",
          "aria-label": l.label, title: l.label,
          target: "_blank", rel: "noopener noreferrer"
        });
        a.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
                      '<path d="' + ICONS[l.key] + '"/></svg>';
        li.appendChild(a); ul.appendChild(li);
      });
      host.appendChild(ul);
    });
  })();

  /* ---- 4. Contact page details ------------------------------------------ */
  (function contactDetails() {
    var host = document.querySelector('[data-ew="contact-details"]');
    if (!host) return;
    var rows = [];
    if (filled(contact.email))    rows.push(["Email", contact.email, "mailto:" + contact.email]);
    if (filled(contact.whatsapp)) rows.push(["WhatsApp", prettyPhone(contact.whatsapp), waHref(contact.whatsapp)]);
    (contact.people || []).forEach(function (p) {
      if (filled(p.phone) && p.phone !== contact.whatsapp) {
        rows.push([p.name, prettyPhone(p.phone), telHref(p.phone)]);
      } else if (filled(p.name) && filled(p.role)) {
        rows.push([p.name, p.role, null]);
      }
    });
    if (filled(contact.location)) rows.push(["Based in", contact.location, null]);
    if (filled(company.markets))   rows.push(["Markets", company.markets, null]);
    if (filled(company.languages)) rows.push(["Languages", company.languages, null]);

    rows.forEach(function (r) {
      var row = el("div", { class: "deflist__row", style: "border-bottom-color:var(--ew-hairline)" });
      row.appendChild(el("dt", { class: "deflist__key", style: "color:var(--ew-ink-muted)" }, r[0]));
      var dd = el("dd", { class: "deflist__val" });
      if (r[2]) dd.appendChild(el("a", { class: "link", href: r[2] }, r[1]));
      else dd.textContent = r[1];
      row.appendChild(dd);
      host.appendChild(row);
    });

    if (!rows.length) {
      host.appendChild(el("p", { class: "muted" },
        "Contact details are being finalised. Please use the form and we will come back to you."));
    }
  })();

  /* ---- 5. Contact form target ------------------------------------------- */
  (function contactForm() {
    var form = document.querySelector('[data-ew="contact-form"]');
    if (!form) return;
    var cfgForm = CFG.form || {};
    var note = form.querySelector('[data-ew="form-note"]');

    if (cfgForm.mode === "formspree" && filled(cfgForm.formspreeUrl)) {
      form.setAttribute("action", cfgForm.formspreeUrl);
      form.setAttribute("method", "POST");
      return;
    }

    /* Without a form backend a static page cannot send mail, so the submit
       button composes the message instead of silently failing. */
    var channel = cfgForm.mode === "whatsapp" && filled(contact.whatsapp) ? "whatsapp"
                : filled(contact.email) ? "email" : "none";

    if (channel === "none") {
      form.querySelector('button[type="submit"]').disabled = true;
      if (note) note.textContent = "The enquiry form is not connected yet.";
      return;
    }

    form.setAttribute("action", "#");
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var d = new FormData(form);
      var lines = [];
      ["name", "company", "email", "phone", "interest", "message"].forEach(function (k) {
        if (filled(d.get(k) || "")) lines.push(k.charAt(0).toUpperCase() + k.slice(1) + ": " + d.get(k));
      });
      var body = lines.join("\n");
      if (channel === "whatsapp") {
        window.open(waHref(contact.whatsapp, body), "_blank", "noopener");
      } else {
        window.location.href = "mailto:" + contact.email +
          "?subject=" + encodeURIComponent("Discovery call request — " + (d.get("company") || d.get("name") || "")) +
          "&body=" + encodeURIComponent(body);
      }
    });
    if (note) {
      note.textContent = channel === "whatsapp"
        ? "Sending opens WhatsApp with your message ready. We reply within one business day."
        : "Sending opens your email app with the message ready. We reply within one business day.";
    }
  })();

  /* ---- 6. Simple text substitutions -------------------------------------- */
  (function textBindings() {
    document.querySelectorAll("[data-ew-text]").forEach(function (node) {
      var path = node.getAttribute("data-ew-text").split(".");
      var val = CFG;
      for (var i = 0; i < path.length && val != null; i++) val = val[path[i]];
      if (filled(val)) node.textContent = val;
    });
  })();

  /* ---- 7. A quiet reminder of what is still unfilled ---------------------- */
  (function setupHints() {
    var todo = [];
    if (!filled(contact.email)) todo.push("contact.email");
    if (!filled(contact.whatsapp)) todo.push("contact.whatsapp");
    if (!socialLinks().length) todo.push("social (all empty)");
    if ((CFG.agent || {}).mode !== "off" && !filled((CFG.agent || {}).webhookUrl)) {
      todo.push("agent.webhookUrl");
    }
    if (todo.length && window.console) {
      console.info("[Everwake] Still to fill in web/site-config.js → " + todo.join(", "));
    }
  })();
})();

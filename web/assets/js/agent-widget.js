/* Everwake — the AI agent chat bubble.
   Configured entirely from web/site-config.js. It renders nothing at all
   unless there is somewhere for a message to go, so it is safe to ship
   before the agent exists. */
(function () {
  "use strict";

  var CFG = (window.EVERWAKE || {});
  var A = CFG.agent || {};
  var contact = CFG.contact || {};

  function filled(v) { return typeof v === "string" && v.trim() !== ""; }

  /* ---- Decide what this bubble actually does ----------------------------- */
  var mode = A.mode || "auto";
  if (mode === "auto") {
    mode = filled(A.webhookUrl) ? "webhook"
         : filled(contact.whatsapp) ? "whatsapp"
         : "off";
  }
  /* Only an http(s) endpoint is ever called. */
  if (mode === "webhook" && !/^https?:\/\//i.test((A.webhookUrl || "").trim())) mode = "off";
  if (mode === "whatsapp" && !filled(contact.whatsapp)) mode = "off";
  if (mode === "off") return;

  var NAME = filled(A.name) ? A.name : "Everwake Agent";

  /* ---- WhatsApp mode is just a link ------------------------------------- */
  if (mode === "whatsapp") {
    var wa = "https://wa.me/" + contact.whatsapp.replace(/\D/g, "");
    var link = document.createElement("a");
    link.className = "ew-agent-bubble";
    link.href = wa;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.setAttribute("aria-label", "Chat with us on WhatsApp");
    link.innerHTML = bubbleIcon() + '<span class="ew-agent-bubble__text">Chat with us</span>';
    document.body.appendChild(link);
    return;
  }

  /* ---- Webhook mode: a real chat panel ----------------------------------- */
  var sessionId = readSession();
  var history = [];
  var busy = false;

  var root = document.createElement("div");
  root.className = "ew-agent";
  root.innerHTML =
    '<button class="ew-agent-bubble" type="button" aria-expanded="false" aria-controls="ew-agent-panel">' +
      bubbleIcon() + '<span class="ew-agent-bubble__text">Ask the agent</span>' +
    '</button>' +
    '<section class="ew-agent-panel" id="ew-agent-panel" role="dialog" aria-modal="false" aria-label="' + esc(NAME) + '" hidden>' +
      '<header class="ew-agent-panel__head">' +
        '<span class="ew-agent-panel__dot" aria-hidden="true"></span>' +
        '<h2>' + esc(NAME) + '</h2>' +
        '<button class="ew-agent-panel__close" type="button" aria-label="Close chat">&times;</button>' +
      '</header>' +
      '<div class="ew-agent-log" role="log" aria-live="polite" aria-atomic="false"></div>' +
      '<div class="ew-agent-suggest"></div>' +
      '<form class="ew-agent-form">' +
        '<label class="visually-hidden" for="ew-agent-input">Your message</label>' +
        '<textarea id="ew-agent-input" rows="1" placeholder="Type your question…" autocomplete="off"></textarea>' +
        '<button type="submit" aria-label="Send message">' +
          '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.4 20.4L21 12 3.4 3.6 3.39 9.9 15 12 3.39 14.1z"/></svg>' +
        '</button>' +
      '</form>' +
    '</section>';
  document.body.appendChild(root);

  var bubble  = root.querySelector(".ew-agent-bubble");
  var panel   = root.querySelector(".ew-agent-panel");
  var closeEl = root.querySelector(".ew-agent-panel__close");
  var log     = root.querySelector(".ew-agent-log");
  var suggest = root.querySelector(".ew-agent-suggest");
  var form    = root.querySelector(".ew-agent-form");
  var input   = root.querySelector("#ew-agent-input");

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function bubbleIcon() {
    return '<svg class="ew-agent-bubble__icon" viewBox="0 0 24 24" aria-hidden="true">' +
           '<path d="M12 3C7 3 3 6.4 3 10.6c0 2.4 1.3 4.5 3.4 5.9l-.8 3.3 3.5-1.8c.9.2 1.9.4 2.9.4 5 0 9-3.4 9-7.8S17 3 12 3z"/></svg>';
  }

  /* Render one message. Agent replies are inserted as escaped text, never as
     HTML, so nothing a server returns can inject markup into the page. */
  function addMessage(who, text) {
    var row = document.createElement("div");
    row.className = "ew-agent-msg ew-agent-msg--" + who;
    var b = document.createElement("div");
    b.className = "ew-agent-msg__body";
    b.textContent = text;
    row.appendChild(b);
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
    return row;
  }

  function addTyping() {
    var row = document.createElement("div");
    row.className = "ew-agent-msg ew-agent-msg--agent ew-agent-typing";
    row.innerHTML = '<div class="ew-agent-msg__body"><span></span><span></span><span></span></div>';
    row.setAttribute("aria-label", NAME + " is typing");
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
    return row;
  }

  function renderSuggestions() {
    suggest.innerHTML = "";
    var list = Array.isArray(A.suggestions) ? A.suggestions : [];
    if (!list.length || history.length) return;
    list.forEach(function (q) {
      if (!filled(q)) return;
      var b = document.createElement("button");
      b.type = "button";
      b.className = "ew-agent-chip";
      b.textContent = q;
      b.addEventListener("click", function () { send(q); });
      suggest.appendChild(b);
    });
  }

  function readSession() {
    try {
      var k = "ew-agent-session";
      var v = sessionStorage.getItem(k);
      if (!v) {
        v = (Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
        sessionStorage.setItem(k, v);
      }
      return v;
    } catch (e) {
      /* Private browsing or blocked storage — a per-page id still works. */
      return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    }
  }

  /* Accept whatever shape the endpoint replies with, rather than forcing the
     owner to reshape their n8n workflow to match this widget. */
  function extractReply(data) {
    if (data == null) return "";
    if (typeof data === "string") return data;
    if (Array.isArray(data)) return extractReply(data[0]);
    var keys = [A.responseField, "reply", "output", "message", "text", "answer", "response"];
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (k && typeof data[k] === "string" && data[k].trim()) return data[k];
    }
    if (data.data) return extractReply(data.data);
    if (data.json) return extractReply(data.json);
    return "";
  }

  function send(text) {
    if (busy || !filled(text)) return;
    busy = true;
    input.value = "";
    autoGrow();
    addMessage("user", text);
    history.push({ role: "user", content: text });
    renderSuggestions();
    var typing = addTyping();

    fetch(A.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: text,
        sessionId: sessionId,
        history: history.slice(-20),
        source: "website",
        page: location.pathname
      })
    })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        var ct = r.headers.get("content-type") || "";
        return ct.indexOf("application/json") !== -1 ? r.json() : r.text();
      })
      .then(function (data) {
        typing.remove();
        var reply = extractReply(data);
        if (!filled(reply)) reply = A.errorMessage || "Sorry — I did not get that. Could you try again?";
        addMessage("agent", reply);
        history.push({ role: "assistant", content: reply });
      })
      .catch(function () {
        typing.remove();
        addMessage("agent", A.errorMessage || "I could not reach the server just now. Please try again.");
      })
      .then(function () { busy = false; input.focus(); });
  }

  function open() {
    panel.hidden = false;
    bubble.setAttribute("aria-expanded", "true");
    root.classList.add("is-open");
    if (!log.childElementCount && filled(A.greeting)) addMessage("agent", A.greeting);
    renderSuggestions();
    setTimeout(function () { input.focus(); }, 60);
  }
  function close() {
    panel.hidden = true;
    bubble.setAttribute("aria-expanded", "false");
    root.classList.remove("is-open");
    bubble.focus();
  }

  function autoGrow() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 120) + "px";
  }

  bubble.addEventListener("click", function () { panel.hidden ? open() : close(); });
  closeEl.addEventListener("click", close);
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !panel.hidden) close();
  });
  form.addEventListener("submit", function (e) { e.preventDefault(); send(input.value.trim()); });
  input.addEventListener("input", autoGrow);
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(input.value.trim()); }
  });
})();

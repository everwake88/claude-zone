/* Everwake — the only script on the site. Progressive: without it the nav
   simply stays visible on desktop and the page still works on mobile. */
(function () {
  "use strict";
  var toggle = document.querySelector(".nav-toggle");
  var nav = document.getElementById("nav");
  if (!toggle || !nav) return;

  function setOpen(open) {
    nav.setAttribute("data-open", String(open));
    toggle.setAttribute("aria-expanded", String(open));
    toggle.textContent = open ? "Close" : "Menu";
  }

  toggle.addEventListener("click", function () {
    setOpen(nav.getAttribute("data-open") !== "true");
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && nav.getAttribute("data-open") === "true") {
      setOpen(false);
      toggle.focus();
    }
  });

  // Close the menu when a link inside it is followed.
  nav.addEventListener("click", function (e) {
    if (e.target.closest("a")) setOpen(false);
  });
})();

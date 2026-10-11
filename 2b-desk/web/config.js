/* 2B Desk — settings for the dashboard page.

   When the dashboard is served by the 2B Desk server itself (the normal
   setup), leave apiUrl empty.

   Only if you host these files somewhere else (Vercel, Cloudflare Pages),
   put the address of the 2B Desk server here, for example
   "https://desk-api.example.com", and add this site's address to the
   server's CORS_ORIGINS setting. */
window.DESK_CONFIG = {
  apiUrl: "",
  brandName: "2B Desk",
  // Any #rrggbb colour. Empty keeps the default indigo.
  brandColor: "",
  // Shown small on the sign-in page.
  poweredBy: "Built by Everwake"
};

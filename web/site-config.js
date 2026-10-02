/* ===========================================================================
   EVERWAKE — SITE SETTINGS
   ===========================================================================

   This is the ONLY file you need to edit to change your contact details,
   social media links, and the AI agent on your website.

   HOW TO EDIT:
     - Change only the text between the quote marks "like this".
     - Keep the quote marks and the comma at the end of each line.
     - Leave something as ""  (empty) and it is hidden from the website
       automatically. Nothing breaks. Fill it in whenever you are ready.

   After editing, save the file and refresh your website.
   =========================================================================== */

window.EVERWAKE = {

  /* -----------------------------------------------------------------------
     1. COMPANY
     ----------------------------------------------------------------------- */
  company: {
    name:     "Everwake",
    tagline:  "Building the AI workforce of tomorrow",
    markets:  "Qatar & the GCC · Egypt · remote delivery worldwide",
    languages:"Arabic, including Gulf dialect · English"
  },

  /* -----------------------------------------------------------------------
     2. CONTACT DETAILS
     Leave any line empty ("") and it disappears from the site.
     ----------------------------------------------------------------------- */
  contact: {
    // Your main email address. Example: "hello@everwake.com"
    email: "everwake88@gmail.com",

    // Your main WhatsApp / phone number, in full international format
    // with no spaces or symbols except the leading +.
    // Example: "+201554354929"
    whatsapp: "",

    // Office or city line shown on the contact page. Example: "Cairo, Egypt"
    location: "",

    // The people a client can call directly. Add or remove whole blocks.
    // Delete a block by removing everything from { to },
    people: [
      {
        name:  "Abdelrhman Basem",
        role:  "Co-founder",
        phone: ""            // Example: "+201554354929"
      },
      {
        name:  "Ahmed El-Qady",
        role:  "Co-founder",
        phone: ""
      }
    ]
  },

  /* -----------------------------------------------------------------------
     3. SOCIAL MEDIA
     Paste the FULL web address of each profile, starting with https://
     Any line left empty is hidden from the website.
     ----------------------------------------------------------------------- */
  social: {
    linkedin:  "",   // https://www.linkedin.com/company/everwake
    instagram: "",   // https://www.instagram.com/everwake
    facebook:  "",   // https://www.facebook.com/everwake
    x:         "",   // https://x.com/everwake
    youtube:   "",   // https://www.youtube.com/@everwake
    tiktok:    "",   // https://www.tiktok.com/@everwake
    whatsapp:  ""    // Leave empty to build this automatically from the
                     // WhatsApp number above.
  },

  /* -----------------------------------------------------------------------
     4. THE CONTACT FORM
     Where enquiries are delivered when someone fills in the form.
     ----------------------------------------------------------------------- */
  form: {
    // "formspree"  — free, no server needed. Sign up at formspree.io, create
    //                a form, and paste the address they give you below.
    // "email"      — no form at all; the page shows your email instead.
    // "whatsapp"   — the form button opens WhatsApp with the message ready.
    mode: "email",

    // Only used when mode is "formspree". Looks like:
    // "https://formspree.io/f/abcdwxyz"
    formspreeUrl: ""
  },

  /* -----------------------------------------------------------------------
     5. YOUR AI AGENT ON THE WEBSITE
     The chat bubble in the bottom corner. This is your own product, so the
     website should demonstrate it.

     mode options:
       "auto"     — recommended. Uses the webhook below if you have filled
                    it in; otherwise falls back to WhatsApp; otherwise stays
                    hidden. You do not have to change this.
       "webhook"  — always use your own AI endpoint (n8n, API, anything).
       "whatsapp" — the bubble opens a WhatsApp chat instead.
       "off"      — no bubble at all.
     ----------------------------------------------------------------------- */
  agent: {
    mode: "auto",

    // The name shown at the top of the chat panel.
    name: "Everwake Agent",

    // The first message the visitor sees.
    greeting: "Ask me anything about what Everwake builds — what it costs, how long it takes, or whether it fits your business.",

    // Suggested questions shown as buttons. Remove any you do not want.
    suggestions: [
      "What exactly do you build?",
      "How long does a project take?",
      "Can I own the system outright?"
    ],

    // ---- Connecting your real agent --------------------------------------
    // Paste your n8n Webhook URL (or any API address) here. It should accept
    // a POST request and reply with JSON.
    // Example: "https://n8n.everwake.com/webhook/site-agent"
    webhookUrl: "",

    // The name of the field in YOUR reply that contains the answer text.
    // n8n commonly returns { "reply": "..." } or { "output": "..." }.
    // The widget also tries "message", "text" and "answer" automatically.
    responseField: "reply",

    // Shown if your agent cannot be reached.
    errorMessage: "I could not reach the server just now. Please try again, or message us on WhatsApp."
  }
};

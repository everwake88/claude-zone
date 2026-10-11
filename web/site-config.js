/* ===========================================================================
   EVERWAKE — SITE SETTINGS
   ===========================================================================

   The ONLY file you need to edit for contact details, social media, the
   WhatsApp button, the contact form, languages and the AI agent.

   HOW TO EDIT:
     - Change only the text between the quote marks "like this".
     - Keep the quote marks and the comma at the end of each line.
     - Leave something as ""  (empty) and it is hidden from the website.
       Nothing breaks. Fill it in whenever you are ready.

   Save the file, commit and push. The live site updates in about a minute.
   =========================================================================== */

window.EVERWAKE = {

  /* -----------------------------------------------------------------------
     1. COMPANY
     ----------------------------------------------------------------------- */
  company: {
    name:      "Everwake",
    tagline:   "Building the AI workforce of tomorrow",
    markets:   "Qatar & the GCC · Egypt · remote delivery worldwide",
    languages: "Arabic, including Gulf and Egyptian dialects · English"
  },

  /* -----------------------------------------------------------------------
     2. CONTACT DETAILS
     Phone numbers in full international format: + then country code,
     no spaces. Egypt 01144017735 becomes "+201144017735".
     ----------------------------------------------------------------------- */
  contact: {
    email: "everwake88@gmail.com",

    // The number the WhatsApp button opens — your AI agent's line.
    whatsapp: "+201144017735",

    // Every number shown on the website. Add or remove lines freely.
    phones: [
      "+201144017735",
      "+201554354929"
    ],

    // Optional city line on the contact page. Example: "Cairo, Egypt"
    location: ""
  },

  /* -----------------------------------------------------------------------
     3. SOCIAL MEDIA
     Paste the FULL address of each profile, starting with https://
     Empty lines are hidden.
     ----------------------------------------------------------------------- */
  social: {
    linkedin:  "",   // https://www.linkedin.com/company/everwake
    instagram: "",   // https://www.instagram.com/everwake
    facebook:  "",   // https://www.facebook.com/everwake
    x:         "",   // https://x.com/everwake
    youtube:   "",   // https://www.youtube.com/@everwake
    tiktok:    "",   // https://www.tiktok.com/@everwake
    whatsapp:  ""    // Optional — the green button already covers WhatsApp
  },

  /* -----------------------------------------------------------------------
     4. THE GREEN WHATSAPP BUTTON
     Floats in the bottom corner of every page and opens a chat with the
     WhatsApp number in section 2.
     ----------------------------------------------------------------------- */
  whatsappButton: {
    show: true,                // true = visible, false = hidden
    label: "Chat on WhatsApp",
    // The message already typed for the visitor when WhatsApp opens.
    message: "Hello Everwake, I would like to know more about your services."
  },

  /* -----------------------------------------------------------------------
     5. THE CONTACT FORM (bottom of every page)
     ----------------------------------------------------------------------- */
  form: {
    // "auto" is recommended. It picks the best option you have filled in:
    //   Web3Forms key  →  messages arrive in your inbox (best)
    //   Formspree URL  →  same, through Formspree
    //   otherwise      →  the form opens WhatsApp with the message ready
    mode: "auto",

    // RECOMMENDED — free, two minutes: go to web3forms.com, enter your
    // email, and they email you an "Access Key". Paste it here.
    web3formsKey: "",

    // Alternative: a Formspree form address, e.g. "https://formspree.io/f/abcd1234"
    formspreeUrl: "",

    // The subject line of the email you receive.
    subject: "New enquiry from everwake.tech"
  },

  /* -----------------------------------------------------------------------
     6. LANGUAGES
     Translations live in the web/i18n/ folder, one file per language.
     ----------------------------------------------------------------------- */
  languages: {
    // Open the site in the visitor's own browser language when we have it.
    autoDetect: true
  },

  /* -----------------------------------------------------------------------
     7. AI AGENT CHAT ON THE WEBSITE
     A chat panel in the bottom corner that talks to your own AI agent.
     It stays hidden until you paste a webhook address below.
     ----------------------------------------------------------------------- */
  agent: {
    name: "Everwake Agent",
    greeting: "Ask me anything about what Everwake builds — what it costs, how long it takes, or whether it fits your business.",
    suggestions: [
      "What exactly do you build?",
      "How long does a project take?",
      "Can I own the system outright?"
    ],

    // Your n8n Production Webhook URL (or any API address).
    // Example: "https://n8n.everwake.tech/webhook/site-agent"
    webhookUrl: "",

    // The field in your agent's reply that holds the answer text.
    // "reply", "output", "message", "text" and "answer" are all tried.
    responseField: "reply",

    errorMessage: "I could not reach the server just now. Please try again, or message us on WhatsApp."
  }
};

// =====================================================================
// EVERWAKE — Main · NODE: Brain Request
// The planning call, built for OpenAI's Responses API: brain.md as the
// instructions, the brief as the input. The restaurant's model and how
// hard it thinks come from its AI settings (the developer page), else
// from the build. Each restaurant has its own prompt cache key, so the
// steady start of its brief (the business, the menu, the chat) is found
// in OpenAI's cache. store: false — nothing is kept at OpenAI.
// =====================================================================
// @include shared/basics.js
// @include shared/cache_layout.js

const b = $input.first().json;                       // Route Without AI: the brief and the AI settings
const ai = obj(b.ai_settings);
const tenant = str(obj($('Intake').first().json.r).tenant_id);
const EFFORTS = ['minimal', 'low', 'medium', 'high'];
const effort = EFFORTS.includes(ai.brain_effort) ? ai.brain_effort : '__BRAIN_EFFORT__';

return [{
  json: {
    brain_started_at: new Date().toISOString(),
    body: {
      model: str(ai.brain_model) || '__MODEL__',
      input: cachedInput("__BRAIN_PROMPT__", b.steady_text, b.chat_blocks,
                         [b.facts_text, '', '================ THE CUSTOMER\'S LATEST MESSAGE ================', b.latest_text].join('\n')),
      prompt_cache_options: CACHE_OPTIONS,
      reasoning: { effort },
      max_output_tokens: 16000,
      store: false,
      prompt_cache_key: `ew-${tenant}-brain`
    }
  }
}];

// =====================================================================
// EVERWAKE — Main · NODE: Agent Request
// One round of the Agent's tool loop, built for OpenAI's Responses API.
// The first round starts from Attach Plan's message; each later round
// carries everything so far: the model's own items (its thinking, kept
// encrypted, and its tool calls) and what each tool answered. The start
// never changes within a turn (agent.md, the tools, the restaurant, the
// menu, the chat), so OpenAI's prompt cache covers it on every round.
// store: false — nothing is kept at OpenAI between calls.
// =====================================================================
// @include shared/basics.js
// @include shared/cache_layout.js

const j = $input.first().json;
const ai = obj($('Route Without AI').first().json.ai_settings);
const tenant = str(obj($('Intake').first().json.r).tenant_id);
const EFFORTS = ['minimal', 'low', 'medium', 'high'];
// the writer-only Main thinks at the effort it was built with (medium); the two-step Main follows the developer page
const FIXED = '__AGENT_EFFORT_FIXED__' === 'yes';
const effort = !FIXED && EFFORTS.includes(ai.agent_effort) ? ai.agent_effort : '__AGENT_EFFORT__';

// the loop so far (from Agent Tool Result), or a new one from Attach Plan
const loop = j.agent_loop ? obj(j.agent_loop) : {
  round: 0,
  started_at: new Date().toISOString(),
  input: (() => { const a = $('Attach Plan').first().json;
                  return cachedInput("__AGENT_PROMPT__", a.steady_text, a.chat_blocks, a.agent_rest); })(),
  steps: [],
  calls: []
};

return [{
  json: {
    agent_loop: loop,
    call_started_at: new Date().toISOString(),
    body: {
      model: str(ai.agent_model) || '__MODEL__',
      input: arr(loop.input),
      tools: "__AGENT_TOOLS__",
      tool_choice: 'auto',
      parallel_tool_calls: false,
      reasoning: { effort },
      include: ['reasoning.encrypted_content'],
      max_output_tokens: 6000,
      store: false,
      prompt_cache_options: CACHE_OPTIONS,
      prompt_cache_key: `ew-${tenant}-agent`
    }
  }
}];

// =====================================================================
// EVERWAKE SALARY — Main · NODE: Agent Request
// One round of the agent's tool loop, for OpenAI's Responses API.
// The first round is built from Load Turn Context:
//   developer   the instructions (prompts/agent.md) — the same for everyone
//   COMPANY     the company, what HR asks for — the same for every employee
//   CHAT        the latest messages, one block each (the cache reuses them)
//   NOW         where this employee stands: verified or not, what is in, what is missing
// Each later round carries everything so far: the model's own items (its
// thinking, kept encrypted, and its tool calls) and what each tool answered.
// store: false — nothing is kept at OpenAI between calls.
// =====================================================================
// @include shared/basics.js
// @include shared/cache_layout.js

const j = $input.first().json;
const LABEL = {
  full_name: 'the full name as written on the national ID card',
  national_id: 'the national ID number (14 digits)',
  work_id: 'the work ID (employee code)',
  phone: 'their mobile number'
};

function firstInput() {
  const t = row($('Load Turn Context').first().json);
  const asked = arr(t.asked_fields);
  const company = [
    'COMPANY',
    `- company: ${str(t.company_name)}`,
    `- you: ${str(t.agent_name)}`,
    `- HR contact, for anything you cannot settle: ${str(t.hr_contact) || 'not set — say "HR" (الموارد البشرية)'}`,
    `- what an employee gives before any salary detail, in this order: ${asked.map(f => LABEL[f] + (f === 'full_name' ? ` (at least ${num(t.name_min_words, 3)} names)` : '')).join('; ')}`,
    `- the WhatsApp number they write from must also be the number on their payroll record: ${t.phone_must_match_sender ? 'yes (checked by verify_identity)' : 'no'}`,
    ...(t.phone_must_match_sender ? [`- when WhatsApp hides that number: ${t.hidden_number_ask_phone ? 'ask for their mobile number instead; verify_identity matches it with the payroll record' : 'it cannot be checked; send them to HR'}`] : [])
  ].join('\n');

  const who = { employee: 'employee', agent: 'you', hr: 'HR (a person)' };
  const chat = arr(t.history).map(m => `[${str(m.at)}] ${who[m.who] || m.who}${m.new ? ' (new)' : ''}: ${str(m.text) || '[empty]'}`);
  chat.unshift('CHAT (oldest first; the messages marked (new) are the ones to answer now, together)');

  const collected = obj(t.collected);
  const now = [`NOW (today is ${str(t.today)}, Cairo)`];
  if (t.verified) {
    const periods = arr(t.periods).map(p => `${p.period}${str(p.title) ? ` (${str(p.title)})` : ''}`);
    now.push(`- verified: yes — ${str(t.employee_name)}${t.verified_until ? ` (until ${t.verified_until})` : ''}`,
             `- payroll months on file for them, newest first: ${periods.join(', ') || 'none'}`,
             '- their payroll figures are not in this message: get_payslip returns them.');
  } else {
    const given = Object.keys(collected).map(f => `${f} = "${str(collected[f])}"`);
    now.push('- verified: no — nothing about any salary can be shared yet',
             `- already given and valid: ${given.join(', ') || 'nothing yet'}`,
             `- still needed: ${arr(t.still_needed).join(', ') || 'nothing (call verify_identity to check them)'}`,
             `- failed identity checks so far: ${num(t.failed_attempts)}`);
    if (t.phone_must_match_sender && !t.sender_phone_known) {
      now.push(t.hidden_number_ask_phone
        ? '- WhatsApp hides the number they write from, so their mobile number is asked for instead (it is in still needed): the one registered with HR'
        : '- WhatsApp hides the number they write from, so it cannot be matched: verify_identity will answer sender_hidden');
    }
  }
  return cachedInput("__AGENT_PROMPT__", company, chat, now.join('\n'));
}

const loop = j.agent_loop ? obj(j.agent_loop) : { round: 0, input: firstInput() };

return [{
  json: {
    agent_loop: loop,
    body: {
      model: '__MODEL__',
      input: arr(loop.input),
      tools: "__AGENT_TOOLS__",
      tool_choice: 'auto',
      parallel_tool_calls: false,
      reasoning: { effort: '__AGENT_EFFORT__' },
      include: ['reasoning.encrypted_content'],
      max_output_tokens: 4000,
      store: false,
      prompt_cache_options: CACHE_OPTIONS,
      prompt_cache_key: 'everwake-salary-agent'
    }
  }
}];

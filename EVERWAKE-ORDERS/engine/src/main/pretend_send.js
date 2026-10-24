// =====================================================================
// EVERWAKE — Main · NODE: Pretend Send (test chat)
// A Test Runner chat (Normalize Inbound is_test): nothing goes out on
// WhatsApp. Answers like Evolution would, so Record Send logs the
// message and the agent remembers it next turn.
// =====================================================================
return [{ json: { body: { key: { id: 'TEST' + Date.now() + Math.random().toString(36).slice(2, 8) } } } }];

// Sends an agent's reply to n8n, which delivers it on WhatsApp, Messenger or
// Instagram. The channel credentials stay in n8n; the desk never holds them.
//
// n8n must answer with JSON. Anything 2xx without "ok": false counts as sent;
// return { "ok": true, "external_message_id": "..." } when you can.
export function createOutbound({ url, secret, timeoutMs = 20_000, fetchImpl = globalThis.fetch, log = console }) {
  return {
    enabled: !!url,
    async send(payload) {
      if (!url) {
        // Demo mode: no n8n configured, pretend the customer received it.
        return { ok: true, external_id: null, simulated: true };
      }
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-desk-secret': secret },
          body: JSON.stringify(payload),
          signal: ctrl.signal,
        });
        const text = await res.text();
        let data = {};
        try {
          data = text ? JSON.parse(text) : {};
        } catch {
          data = {};
        }
        if (Array.isArray(data)) data = data[0] ?? {};
        if (!res.ok || data.ok === false) {
          const error = data.error || data.message || `n8n answered HTTP ${res.status}`;
          log.warn?.(`[outbound] message ${payload.message_id} failed: ${error}`);
          return { ok: false, error: String(typeof error === 'string' ? error : JSON.stringify(error)) };
        }
        return { ok: true, external_id: data.external_message_id ?? data.message_id ?? null };
      } catch (err) {
        const error = err.name === 'AbortError' ? 'n8n did not answer in time' : `Could not reach n8n (${err.message})`;
        log.warn?.(`[outbound] message ${payload.message_id} failed: ${error}`);
        return { ok: false, error };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

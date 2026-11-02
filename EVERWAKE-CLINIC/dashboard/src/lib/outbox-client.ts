// the route that asks n8n to send queued WhatsApp messages now (lib/outbox.ts on the server)
export const PING = '/api/outbox/ping';
export const ping = () => fetch(PING, { method: 'POST' }).catch(() => null);

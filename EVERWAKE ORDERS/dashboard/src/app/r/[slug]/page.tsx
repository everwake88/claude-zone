'use client';
import { CheckCircle2, Circle, Rocket } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Badge, Button, Card, PageHeader, Spinner, useAction } from '@/components/ui';
import { useTenant } from '@/components/tenant';
import { money, timeAgo, displayName } from '@/lib/format';
import { sb } from '@/lib/supabase/client';
import type { Checklist, Conversation, Order } from '@/lib/types';

interface Stats { orders: number; revenue: number; average_order: number; conversations: number; conversion_percent: number; commission_saved: number }

export default function Overview() {
  const { tenant, base, can } = useTenant();
  const [list, setList] = useState<Checklist | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [waiting, setWaiting] = useState<Order[]>([]);
  const [attention, setAttention] = useState<Conversation[]>([]);
  const { busy, run } = useAction();

  const load = async () => {
    const db = sb();
    const from = new Date(); from.setHours(0, 0, 0, 0);
    const [c, s, o, a] = await Promise.all([
      db.rpc('onboarding_checklist', { p_tenant: tenant.id }),
      can.edit ? db.rpc('analytics', { p_tenant: tenant.id, p_from: from.toISOString(), p_to: new Date(Date.now() + 60000).toISOString() }) : Promise.resolve({ data: null }),
      db.from('orders').select('*').eq('tenant_id', tenant.id).eq('status', 'placed').order('placed_at').limit(5),
      db.from('conversations').select('*, customers(display_name, full_name, phone, phone_hidden, orders_count, is_blocked)')
        .eq('tenant_id', tenant.id).eq('needs_attention', true).order('attention_at', { ascending: false }).limit(5)
    ]);
    setList(c.data as Checklist);
    setStats(s.data as Stats);
    setWaiting((o.data || []) as Order[]);
    setAttention((a.data || []) as Conversation[]);
  };
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [tenant.id]);

  const goLive = () => run(async () => {
    const { data, error } = await sb().rpc('go_live', { p_tenant: tenant.id });
    if (error) throw new Error(error.message);
    if (!(data as { live: boolean }).live) throw new Error('Finish the required steps first.');
    window.location.reload();
  }, 'You are live! Every customer who writes now reaches the agent.');

  if (!list) return <Spinner />;
  const required = list.items.filter(i => i.required);
  const done = required.filter(i => i.done).length;

  return (
    <div className="space-y-6">
      <PageHeader title={`Good to see you`} subtitle={`${tenant.name_en || tenant.name_ar} · ${tenant.status === 'live' ? 'live on WhatsApp' : 'getting ready to go live'}`} />

      {tenant.status !== 'live' && (
        <Card title={<span className="flex items-center gap-2"><Rocket className="size-4 text-gold" /> Go-live checklist — {done} of {required.length} required steps done</span>}
          action={can.owner && <Button variant="gold" size="sm" disabled={!list.ready} busy={busy} onClick={goLive}>Go live</Button>}>
          <p className="mb-4 text-sm text-muted">Until you go live, only the test numbers in Settings → Ordering reach the agent — your staff keep answering everyone else from the phone as usual.</p>
          <ul className="divide-y divide-hairline">
            {list.items.map(i => (
              <li key={i.key} className="flex items-center gap-3 py-2.5">
                {i.done ? <CheckCircle2 className="size-5 text-positive" /> : <Circle className="size-5 text-hairline" />}
                <div className="flex-1">
                  <p className="text-sm font-medium">{i.label} {!i.required && <span className="font-normal text-muted">(recommended)</span>}</p>
                  <p className="text-xs text-muted">{i.detail}</p>
                </div>
                <Link href={`${base}/${i.href}`} className="text-sm font-medium text-gold-ink hover:underline">{i.done ? 'Edit' : 'Set up'}</Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {stats && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          {[
            ['Orders today', String(stats.orders)],
            ['Revenue today', money(stats.revenue, tenant.currency_symbol)],
            ['Average order', money(stats.average_order, tenant.currency_symbol)],
            ['Chats → orders', `${stats.conversion_percent}%`],
            ['Commission saved today', money(stats.commission_saved, tenant.currency_symbol)]
          ].map(([k, v]) => (
            <div key={k} className="rounded-xl border border-hairline bg-white p-4">
              <p className="label-caps">{k}</p>
              <p className="mt-1 text-xl font-semibold">{v}</p>
            </div>
          ))}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Orders waiting to be accepted" action={<Link href={`${base}/orders`} className="text-sm text-gold-ink">Open the board</Link>}>
          {waiting.length === 0 ? <p className="text-sm text-muted">Nothing waiting. New orders ring here and on every page.</p> : (
            <ul className="divide-y divide-hairline">
              {waiting.map(o => (
                <li key={o.id} className="flex items-center justify-between py-2 text-sm">
                  <span><strong>{o.order_no}</strong> · {displayName(o.customer as never)} · {timeAgo(o.placed_at)}</span>
                  <span className="font-medium">{money(o.total, tenant.currency_symbol)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Conversations that need a person" action={<Link href={`${base}/inbox?filter=attention`} className="text-sm text-gold-ink">Open the inbox</Link>}>
          {attention.length === 0 ? <p className="text-sm text-muted">The agent has everything under control.</p> : (
            <ul className="divide-y divide-hairline">
              {attention.map(c => (
                <li key={c.id} className="py-2 text-sm">
                  <Link href={`${base}/inbox?c=${c.id}`} className="flex items-center justify-between gap-2 hover:text-gold-ink">
                    <span className="truncate"><strong>{displayName(c.customers)}</strong> — <span dir="auto">{c.attention_reason || c.last_message_preview}</span></span>
                    <Badge tone="critical">needs you</Badge>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

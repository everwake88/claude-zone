'use client';
import { CheckCircle2, Circle, Rocket } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { SavingsHero } from '@/components/growth/SavingsHero';
import { Badge, Button, Card, CountUp, PageHeader, Spinner, useAction } from '@/components/ui';
import { useTenant } from '@/components/tenant';
import { cx, money, timeAgo, displayName } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { sb } from '@/lib/supabase/client';
import type { Checklist, Conversation, Order } from '@/lib/types';

// the checklist comes from the database in English; its details carry counts
const DETAILS: [RegExp, string][] = [
  [/^(\d+) of (\d+) branches complete$/, '{a} of {b} branches complete'],
  [/^(\d+) of (\d+) delivering branches have a zone or a map pin$/, '{a} of {b} delivering branches have a zone or a map pin'],
  [/^(\d+) of (\d+) dishes have a price$/, '{a} of {b} dishes have a price'],
  [/^(\d+) of (\d+) dishes have a photo$/, '{a} of {b} dishes have a photo'],
  [/^(\d+) of (\d+) numbers connected$/, '{a} of {b} numbers connected'],
  [/^(\d+) pages$/, '{a} pages'],
  [/^(\d+) answers$/, '{a} answers'],
  [/^(\d+) orders so far$/, '{a} orders so far']
];
function detailText(t: (k: string, v?: Record<string, string>) => string, key: string, d: string): string {
  if (key === 'payment') return d.split(',').map(x => t(x.trim())).join('، ');
  for (const [re, tpl] of DETAILS) { const m = re.exec(d); if (m) return t(tpl, { a: m[1], b: m[2] }); }
  return t(d);
}

// what each step gives the restaurant, so the checklist says why and not only what
const WHY: Record<string, string> = {
  profile: 'The agent introduces itself by this name and tells customers only these facts about you.',
  branches: 'Every order goes to a branch; its hours decide when the agent takes orders.',
  zones: 'A customer’s location decides which branch delivers, the fee and the minimum.',
  menu: 'The agent offers only the dishes here, at these prices.',
  photos: 'Customers who ask what a dish looks like get its photo.',
  menu_pages: 'Customers who ask for the menu get these pictures.',
  payment: 'The agent promises only the ways of paying you tick.',
  knowledge: 'Questions that are not about food (parking, parties…) get your own answer.',
  whatsapp: 'The number customers message — nothing reaches the agent without it.',
  test_order: 'Order from your own phone first, so you see what customers will see.'
};

interface Stats { orders: number; revenue: number; average_order: number; conversations: number; conversion_percent: number }

export default function Overview() {
  const { tenant, base, can } = useTenant();
  const [list, setList] = useState<Checklist | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [waiting, setWaiting] = useState<Order[]>([]);
  const [attention, setAttention] = useState<Conversation[]>([]);
  const { busy, run } = useAction();
  const t = useT();

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
    if (!(data as { live: boolean }).live) throw new Error(t('Finish the required steps first.'));
    window.location.reload();
  }, t('You are live! Every customer who writes now reaches the agent.'));

  if (!list) return <Spinner />;
  const required = list.items.filter(i => i.required);
  const done = required.filter(i => i.done).length;
  // the first required step still to do, then the first recommended one
  const next = required.find(i => !i.done) || list.items.find(i => !i.done);
  const later = list.items.filter(i => !i.required && !i.done);

  return (
    <div className="space-y-6">
      <PageHeader title={t('Good to see you')} subtitle={`${tenant.name_en || tenant.name_ar} · ${tenant.status === 'live' ? t('live on WhatsApp') : t('getting ready to go live')}`} />
      <SavingsHero />

      {tenant.status !== 'live' && (
        <Card title={<span className="flex items-center gap-2"><Rocket className="size-4 text-gold" /> {t('Go-live checklist — {done} of {total} required steps done', { done, total: required.length })}</span>}
          action={can.owner && <Button variant="gold" size="sm" disabled={!list.ready} busy={busy} onClick={goLive}>{t('Go live')}</Button>}>
          <p className="mb-4 text-sm text-muted">{t('Until you go live, only the test numbers in Settings → Ordering rules reach the agent — your staff keep answering everyone else from the phone as usual.')}</p>
          <ol className="divide-y divide-hairline">
            {list.items.map((i, n) => {
              const isNext = next?.key === i.key;
              return (
                <li key={i.key} className={cx('flex items-start gap-3 py-3', isNext && '-mx-3 rounded-lg bg-gold-wash px-3')}>
                  {i.done ? <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-positive" aria-label={t('Done')} />
                    : <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border border-hairline text-xs text-muted" aria-hidden>{n + 1}</span>}
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{t(i.label)} {!i.required && <span className="font-normal text-muted">{t('(recommended)')}</span>}
                      {isNext && <Badge tone="gold" className="ms-2">{t('Start here')}</Badge>}</p>
                    {WHY[i.key] && <p className="text-sm text-muted">{t(WHY[i.key])}</p>}
                    {i.detail && i.key !== 'profile' && <p className="text-xs text-muted">{detailText(t, i.key, i.detail)}</p>}
                  </div>
                  {isNext
                    ? <Link href={`${base}/${i.href}`}><Button size="sm" variant="gold">{t('Set up')}</Button></Link>
                    : <Link href={`${base}/${i.href}`} className="shrink-0 text-sm font-medium text-gold-ink hover:underline">{i.done ? t('Edit') : t('Set up')}</Link>}
                </li>
              );
            })}
          </ol>
        </Card>
      )}

      {tenant.status === 'live' && can.edit && later.length > 0 && (
        <Card title={t('Worth doing next')}>
          <ul className="divide-y divide-hairline">
            {later.map(i => (
              <li key={i.key} className="flex items-start gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{t(i.label)}</p>
                  {WHY[i.key] && <p className="text-sm text-muted">{t(WHY[i.key])}</p>}
                </div>
                <Link href={`${base}/${i.href}`} className="shrink-0 text-sm font-medium text-gold-ink hover:underline">{t('Set up')}</Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {stats && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {([
            ['Orders today', stats.orders, (v: number) => String(v)],
            ['Revenue today', stats.revenue, (v: number) => money(v, tenant.currency_symbol)],
            ['Average order', stats.average_order, (v: number) => money(v, tenant.currency_symbol)],
            ['Chats → orders', stats.conversion_percent, (v: number) => `${v}%`]
          ] as [string, number, (v: number) => string][]).map(([k, v, f]) => (
            <div key={k} className="rounded-2xl border border-hairline/80 bg-white p-4 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
              <p className="label-caps">{t(k)}</p>
              <p className="board mt-1.5 text-[30px] text-ink"><CountUp value={Number(v) || 0} format={f} /></p>
            </div>
          ))}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={t('Orders waiting to be accepted')} action={<Link href={`${base}/orders`} className="text-sm text-gold-ink">{t('Open the board')}</Link>}>
          {waiting.length === 0 ? <p className="text-sm text-muted">{t('Nothing waiting. New orders ring here and on every page.')}</p> : (
            <ul className="divide-y divide-hairline">
              {waiting.map(o => (
                <li key={o.id} className="flex items-center justify-between py-2 text-sm">
                  <span><strong>{o.order_no}</strong> · <bdi>{displayName(o.customer as never)}</bdi> · {timeAgo(o.placed_at)}</span>
                  <span className="font-medium">{money(o.total, tenant.currency_symbol)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title={t('Conversations that need a person')} action={<Link href={`${base}/inbox?filter=attention`} className="text-sm text-gold-ink">{t('Open the inbox')}</Link>}>
          {attention.length === 0 ? <p className="text-sm text-muted">{t('The agent has everything under control.')}</p> : (
            <ul className="divide-y divide-hairline">
              {attention.map(c => (
                <li key={c.id} className="py-2 text-sm">
                  <Link href={`${base}/inbox?c=${c.id}`} className="flex items-center justify-between gap-2 hover:text-gold-ink">
                    <span className="truncate"><strong><bdi>{displayName(c.customers)}</bdi></strong> — <span dir="auto">{c.attention_reason || c.last_message_preview}</span></span>
                    <Badge tone="critical">{t('needs you')}</Badge>
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

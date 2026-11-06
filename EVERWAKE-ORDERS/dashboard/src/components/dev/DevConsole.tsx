'use client';
import { ArrowLeft, Check, Coins, Database, MessageSquare, Plus, Receipt, ShoppingBag, Sparkles, X } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { Columns, RankList } from '@/components/charts';
import { Button, Card, Checkbox, Input, Select, Spinner, Tabs, useAction } from '@/components/ui';
import { cx } from '@/lib/format';
import { sb } from '@/lib/supabase/client';
import { useCached } from '@/lib/use-cached';
import { zonedMidnight } from '@/lib/zoned';

// Everwake's developer console (English only: it is ours, not the restaurants'). What the AI costs —
// per message, per order, per restaurant, with the cache — and the settings behind it: each
// restaurant's percent, its AI settings, the model prices.

type Step = { step: string; model: string | null; in: number; cached: number; out: number; thinking: number; cost: number | null; priced: boolean; seconds: number | null; ms: number | null; status: number | null };
interface Costs {
  usd_egp: number;
  totals: { calls: number; cost_usd: number; input: number; cached: number; output: number; thinking: number; unpriced: number; cache_hit_calls: number };
  messages: number; orders: number; no_order_usd: number; test_usd: number;
  per_order: { avg_usd: number | null; min_usd: number | null; max_usd: number | null; avg_messages: number | null };
  by_step: { step: string; calls: number; cost_usd: number; input: number; cached: number; output: number; thinking: number }[];
  by_kind: { kind: string; messages: number; cost_usd: number }[];
  by_effort?: { step: string; effort: string; calls: number; cost_usd: number; avg_usd: number | null; thinking: number }[];
  by_day: { day: string; cost_usd: number; messages: number }[];
  by_tenant: { tenant_id: string; name: string; slug: string; messages: number; cost_usd: number; orders: number; avg_order_usd: number | null; min_order_usd: number | null; max_order_usd: number | null; cache_share: number | null }[];
  orders_list: { order_id: number; order_no: string; tenant: string; slug: string; placed_at: string; total: number; messages: number; cost_usd: number; to_order_usd: number | null; after_usd: number | null; cache_share: number | null; conversation_id: number | null }[];
}
interface Msg { run_id: string; at: string; tenant: string; slug: string; customer: string | null; kind: string; calls: number; input: number; cached: number; output: number; thinking: number; cost_usd: number; part: string; order_no: string | null; steps: Step[]; message: string | null }
interface AiCfg { brain_model?: string | null; brain_effort?: string | null; agent_model?: string | null; agent_effort?: string | null; details_by_code?: boolean | null; react_no_reply?: boolean | null; usd_egp?: number | null; wait_seconds?: number | null }
interface DevTenant { id: string; slug: string; name: string; status: string; bill: { fee_percent: number; include_delivery_fee: boolean; include_vat: boolean; starts_on: string | null }; ai: AiCfg; ai_own: AiCfg | null }
interface Price { model: string; input_per_m: number; cached_per_m: number; output_per_m: number; audio_per_minute: number | null }

const TZ = 'Africa/Cairo';
const RANGES = { today: 'Today', '7': '7 days', '30': '30 days', month: 'This month' } as const;
type Range = keyof typeof RANGES;
const periodOf = (r: Range) => {
  const to = new Date(Date.now() + 60000);
  if (r === 'today') return { from: zonedMidnight(TZ), to };
  if (r === 'month') { const d = zonedMidnight(TZ); const day = Number(new Intl.DateTimeFormat('en-GB', { day: 'numeric', timeZone: TZ }).format(d)); return { from: zonedMidnight(TZ, day - 1), to }; }
  return { from: zonedMidnight(TZ, Number(r) - 1), to };
};
const n0 = (v: number) => Math.round(Number(v) || 0).toLocaleString('en-US');
const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : '—');

export function DevConsole() {
  const [tab, setTab] = useState<'costs' | 'messages' | 'restaurants' | 'prices'>('costs');
  const [range, setRange] = useState<Range>('7');
  const [tenant, setTenant] = useState('');
  const tenants = useCached('dev:tenants', async () => ((await sb().rpc('dev_tenants')).data || []) as DevTenant[]);
  const p = useMemo(() => periodOf(range), [range]);
  const key = `${range}:${tenant}`;
  const costs = useCached(tab === 'costs' ? `dev:costs:${key}` : null, async () => {
    const { data, error } = await sb().rpc('dev_costs', { p_from: p.from.toISOString(), p_to: p.to.toISOString(), p_tenant: tenant || null });
    if (error) throw new Error(error.message);
    return data as Costs;
  });
  const msgs = useCached(tab === 'messages' ? `dev:msgs:${key}` : null, async () => {
    const { data, error } = await sb().rpc('dev_messages', { p_from: p.from.toISOString(), p_to: p.to.toISOString(), p_tenant: tenant || null, p_limit: 300 });
    if (error) throw new Error(error.message);
    return data as Msg[];
  });
  const fx = costs.data?.usd_egp || 50;
  const egp = (usd: number | null | undefined, digits = 2) => usd == null ? '—' : `${(Number(usd) * fx).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })} EGP`;
  const usd = (v: number | null | undefined) => v == null ? '—' : `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;

  return (
    <div className="ew-app min-h-dvh bg-paper text-ink">
      <header className="sticky top-0 z-20 border-b border-hairline/70 bg-[color-mix(in_oklab,var(--color-paper)_85%,transparent)] backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-3 px-4 py-3 lg:px-7">
          <Link href="/" className="flex items-center gap-1.5 text-sm text-muted hover:text-ink"><ArrowLeft className="size-4" /> Restaurants</Link>
          <h1 className="text-lg font-bold">Everwake · Developer</h1>
          <span className="rounded-full bg-navy px-2 py-0.5 text-[11px] font-semibold text-white">only you</span>
          <span className="flex-1" />
          <Tabs value={tab} onChange={setTab} tabs={[{ value: 'costs', label: 'AI costs' }, { value: 'messages', label: 'Messages' },
            { value: 'restaurants', label: 'Restaurants' }, { value: 'prices', label: 'Prices' }]} />
        </div>
      </header>

      <main className="mx-auto max-w-[1400px] space-y-5 px-4 py-6 lg:px-7">
        {(tab === 'costs' || tab === 'messages') && (
          <div className="flex flex-wrap items-center gap-3">
            <Tabs value={range} onChange={setRange} tabs={Object.entries(RANGES).map(([value, label]) => ({ value: value as Range, label }))} />
            <div className="w-64"><Select value={tenant} onChange={e => setTenant(e.target.value)} aria-label="Restaurant">
              <option value="">All restaurants</option>
              {(tenants.data || []).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select></div>
            {(costs.loading || msgs.loading) && <span className="text-xs text-muted">Updating…</span>}
          </div>
        )}

        {tab === 'costs' && (!costs.data ? <Spinner /> : <CostsView c={costs.data} egp={egp} usd={usd} />)}
        {tab === 'messages' && (!msgs.data ? <Spinner /> : <MessagesView rows={msgs.data} egp={egp} />)}
        {tab === 'restaurants' && (!tenants.data ? <Spinner /> : <RestaurantsView list={tenants.data} reload={tenants.refresh} />)}
        {tab === 'prices' && <PricesView />}
      </main>
    </div>
  );
}

function Tile({ icon: Icon, label, value, note, tint }: { icon: typeof Coins; label: string; value: string; note?: string; tint: number }) {
  return (
    <div className={cx('ew-card p-5', `ew-tint-${tint}`)}>
      <span className="flex size-9 items-center justify-center rounded-[12px] text-white" style={{ background: `var(--ui-tint-ink-${tint}, var(--color-gold-ink))` }}><Icon className="size-[18px]" aria-hidden /></span>
      <p className="mt-3 text-sm text-ink/70">{label}</p>
      <p className="mt-0.5 text-[24px] font-bold leading-tight tracking-[-0.02em] tabular-nums">{value}</p>
      {note && <p className="mt-1 text-xs text-ink/70">{note}</p>}
    </div>
  );
}

function CostsView({ c, egp, usd }: { c: Costs; egp: (v: number | null | undefined, d?: number) => string; usd: (v: number | null | undefined) => string }) {
  const T = c.totals;
  const days = c.by_day.map(d => ({ label: d.day.slice(5).replace('-', '/'), long: d.day, value: Number(d.cost_usd) * c.usd_egp }));
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Tile icon={Coins} tint={1} label="AI cost" value={egp(T.cost_usd)} note={`${usd(T.cost_usd)} · ${n0(T.calls)} calls${T.unpriced ? ` · ${T.unpriced} without a price` : ''}`} />
        <Tile icon={ShoppingBag} tint={2} label="Per order (average)" value={egp(c.per_order.avg_usd, 4)}
              note={`${c.orders} orders · lowest ${egp(c.per_order.min_usd, 4)} · highest ${egp(c.per_order.max_usd, 4)}`} />
        <Tile icon={MessageSquare} tint={3} label="Per message (average)" value={egp(c.messages ? T.cost_usd / c.messages : null, 4)}
              note={`${n0(c.messages)} messages · ${c.per_order.avg_messages ? Math.round(Number(c.per_order.avg_messages)) : '—'} per order`} />
        <Tile icon={Database} tint={4} label="Cache" value={pct(T.cached, T.input)} note={`of input tokens came from the cache · hit on ${pct(T.cache_hit_calls, T.calls)} of calls`} />
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2" title="AI cost per day (EGP)">
          {days.length ? <Columns bars={days} format={v => String(Math.round(v))} /> : <p className="text-sm text-muted">No AI calls in this period yet.</p>}
        </Card>
        <Card title="Where it goes">
          <div className="space-y-4">
            <RankList format={v => egp(v / c.usd_egp)} rows={c.by_step.map(s => ({ label: s.step, value: Number(s.cost_usd) * c.usd_egp, sub: `${n0(s.calls)} calls` }))} />
            <dl className="grid grid-cols-2 gap-2 text-xs">
              {[['Chats with no order', egp(c.no_order_usd)], ['Test chats', egp(c.test_usd)],
                ['Input tokens', n0(T.input)], ['…of them cached', n0(T.cached)], ['Output tokens', n0(T.output)], ['…of them thinking', n0(T.thinking)]].map(([k, v]) => (
                <div key={k} className="rounded-[var(--ui-radius-inner)] bg-paper/70 p-2.5"><dt className="text-muted">{k}</dt><dd className="mt-0.5 font-semibold tabular-nums">{v}</dd></div>
              ))}
            </dl>
          </div>
        </Card>
      </div>

      {!!c.by_effort?.length && (
        <Card title="By how hard each step thinks">
          <Table head={['Step', 'Thinks', 'Calls', 'Cost', 'Per call', 'Thinking tokens per call']}
            rows={c.by_effort.map(e => [e.step, e.effort, n0(e.calls), egp(e.cost_usd), egp(e.avg_usd, 4), n0(e.calls ? e.thinking / e.calls : 0)])} />
        </Card>
      )}

      <Card title="By kind of message">
        <div className="flex flex-wrap gap-3">
          {c.by_kind.map(k => (
            <div key={k.kind} className="rounded-[var(--ui-radius-inner)] bg-paper/70 px-4 py-3">
              <p className="text-xs capitalize text-muted">{k.kind}</p>
              <p className="font-semibold tabular-nums">{egp(k.cost_usd)} <span className="text-xs font-normal text-muted">· {n0(k.messages)} messages · {egp(k.messages ? k.cost_usd / k.messages : 0, 4)} each</span></p>
            </div>
          ))}
        </div>
      </Card>

      <Card title="Restaurants">
        <Table head={['Restaurant', 'Messages', 'Orders', 'AI cost', 'Per order', 'Lowest', 'Highest', 'Cached input']}
          rows={c.by_tenant.map(t => [<Link key="n" className="font-medium hover:underline" href={`/r/${t.slug}`}>{t.name}</Link>, n0(t.messages), n0(t.orders),
            egp(t.cost_usd), egp(t.avg_order_usd, 4), egp(t.min_order_usd, 4), egp(t.max_order_usd, 4), t.cache_share == null ? '—' : `${Math.round(t.cache_share * 100)}%`])} />
      </Card>

      <Card title="Orders (the chat that led to each, and the questions after it)">
        <Table head={['Order', 'Restaurant', 'Placed', 'Total', 'Messages', 'AI cost', 'To order', 'After', 'Cached input']}
          rows={c.orders_list.map(o => [<Link key="o" className="font-medium hover:underline" href={`/r/${o.slug}/orders?o=${o.order_id}`}><bdi>{o.order_no}</bdi></Link>, o.tenant,
            new Date(o.placed_at).toLocaleString('en-GB', { timeZone: TZ, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
            `${n0(o.total)} EGP`, n0(o.messages), <b key="c">{egp(o.cost_usd, 4)}</b>, egp(o.to_order_usd, 4), egp(o.after_usd, 4),
            o.cache_share == null ? '—' : `${Math.round(o.cache_share * 100)}%`])} />
      </Card>
    </div>
  );
}

function MessagesView({ rows, egp }: { rows: Msg[]; egp: (v: number | null | undefined, d?: number) => string }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!rows.length) return <p className="text-sm text-muted">No AI calls in this period yet.</p>;
  return (
    <Card title={`The last ${rows.length} messages`}>
      <ul className="-mx-5 -my-5 divide-y divide-hairline/60">
        {rows.map(m => {
          const hit = m.cached > 0, on = open === m.run_id;
          return (
            <li key={m.run_id}>
              <button type="button" onClick={() => setOpen(on ? null : m.run_id)} className="flex w-full flex-wrap items-center gap-3 px-5 py-3 text-start text-sm hover:bg-paper/60">
                <span className="w-24 shrink-0 text-xs tabular-nums text-muted">{new Date(m.at).toLocaleString('en-GB', { timeZone: TZ, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                <span className={cx('rounded-full px-2 py-0.5 text-[11px] font-semibold', m.kind === 'test' ? 'bg-caution-wash text-caution' : m.kind === 'voice' ? 'bg-gold-wash text-gold-ink' : m.kind === 'image' ? 'bg-positive-wash text-positive' : 'bg-paper-sunk text-muted')}>{m.kind}</span>
                <span className="w-32 shrink-0 truncate text-xs text-muted">{m.tenant}</span>
                <span className="min-w-0 flex-1 truncate"><bdi>{m.message || '—'}</bdi></span>
                {m.order_no && <span className="text-xs text-muted">{m.part === 'to_order' ? '→' : '↩'} <bdi>{m.order_no}</bdi></span>}
                <span className="flex items-center gap-1 text-xs" title={hit ? 'the cache was used' : 'no cached input'}>
                  {hit ? <Check className="size-3.5 text-positive" /> : <X className="size-3.5 text-muted" />}{m.input ? `${Math.round((m.cached / m.input) * 100)}%` : ''}
                </span>
                <span className="w-24 shrink-0 text-end font-semibold tabular-nums">{egp(m.cost_usd, 4)}</span>
              </button>
              {on && (
                <div className="bg-paper/50 px-5 pb-4">
                  <Table head={['Step', 'Model', 'Input', 'Cached', 'Output', 'Thinking', 'Time', 'Cost']}
                    rows={m.steps.map(s => [s.step, s.model || '—', n0(s.in), <span key="c" className={s.cached ? 'text-positive' : 'text-muted'}>{n0(s.cached)}</span>,
                      n0(s.out), n0(s.thinking), s.ms ? `${(s.ms / 1000).toFixed(1)} s` : (s.seconds ? `${s.seconds} s audio` : '—'),
                      s.priced ? <span key="p" title={`$${Number(s.cost).toFixed(8)}`}>{egp(s.cost, 4)}</span> : 'no price'])} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

const EFF = ['', 'minimal', 'low', 'medium', 'high'];
const tri = (v: boolean | null | undefined) => (v == null ? '' : v ? 'on' : 'off');
const fromTri = (v: string) => (v === '' ? null : v === 'on');

function RestaurantsView({ list, reload }: { list: DevTenant[]; reload: () => Promise<void> }) {
  const { busy, run } = useAction();
  const global = useCached('dev:ai-global', async () => ((await sb().from('ai_config').select('*').eq('scope', 'global').maybeSingle()).data || {}) as AiCfg);
  const [g, setG] = useState<AiCfg | null>(null);
  const cfg = g || global.data || {};
  const saveGlobal = () => run(async () => {
    const { error } = await sb().from('ai_config').upsert({ scope: 'global', ...cfg, updated_at: new Date().toISOString() });
    if (error) throw new Error(error.message);
    await global.refresh(); setG(null); await reload();
  }, 'Saved for every restaurant');
  return (
    <div className="space-y-5">
      <Card title="AI settings for every restaurant" action={<Button size="sm" variant="gold" busy={busy} onClick={saveGlobal}>Save</Button>}>
        <AiFields value={cfg} onChange={v => setG({ ...cfg, ...v })} global />
        <p className="mt-3 text-xs text-muted">A model left empty keeps the one the workflow was built with (gpt-6-luna). Every cost here is OpenAI's own count of each call, priced with the price list at the time of the call. A restaurant's own setting below wins over these.</p>
      </Card>
      {list.map(t => <RestaurantRow key={t.id} t={t} reload={reload} />)}
    </div>
  );
}

function AiFields({ value, onChange, global }: { value: AiCfg; onChange: (v: AiCfg) => void; global?: boolean }) {
  const opt = (xs: string[], inherit: string) => xs.map(x => <option key={x} value={x}>{x || inherit}</option>);
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <label className="text-xs text-muted">Planning model<Input className="mt-1" placeholder={global ? 'gpt-6-luna (as built)' : 'as for everyone'} value={value.brain_model || ''} onChange={e => onChange({ brain_model: e.target.value || null })} /></label>
      <label className="text-xs text-muted">Planning thinks<Select className="mt-1" value={value.brain_effort || ''} onChange={e => onChange({ brain_effort: e.target.value || null })}>{opt(EFF, global ? 'low (default)' : 'as for everyone')}</Select></label>
      <label className="text-xs text-muted">Reply model<Input className="mt-1" placeholder={global ? 'gpt-6-luna (as built)' : 'as for everyone'} value={value.agent_model || ''} onChange={e => onChange({ agent_model: e.target.value || null })} /></label>
      <label className="text-xs text-muted">Reply thinks<Select className="mt-1" value={value.agent_effort || ''} onChange={e => onChange({ agent_effort: e.target.value || null })}>{opt(EFF, global ? 'low (default)' : 'as for everyone')}</Select></label>
      <label className="text-xs text-muted">Details asked by code<Select className="mt-1" value={tri(value.details_by_code)} onChange={e => onChange({ details_by_code: fromTri(e.target.value) })}>{opt(['', 'on', 'off'], global ? 'off' : 'as for everyone')}</Select></label>
      <label className="text-xs text-muted">❤️ for messages that need no reply<Select className="mt-1" value={tri(value.react_no_reply)} onChange={e => onChange({ react_no_reply: fromTri(e.target.value) })}>{opt(['', 'on', 'off'], global ? 'off' : 'as for everyone')}</Select></label>
      <label className="text-xs text-muted">Wait before replying (seconds)<Input className="mt-1" type="number" min="2" max="10" step="1" placeholder={global ? '5 (default)' : 'as for everyone'}
        value={value.wait_seconds ?? ''} onChange={e => onChange({ wait_seconds: e.target.value === '' ? null : Math.min(10, Math.max(2, Math.round(Number(e.target.value)))) })} /></label>
      {global && <label className="text-xs text-muted">EGP per dollar<Input className="mt-1" type="number" step="0.01" value={value.usd_egp ?? ''} onChange={e => onChange({ usd_egp: e.target.value === '' ? null : Number(e.target.value) })} /></label>}
    </div>
  );
}

function RestaurantRow({ t, reload }: { t: DevTenant; reload: () => Promise<void> }) {
  const { busy, run } = useAction();
  const [bill, setBill] = useState(t.bill);
  const [ai, setAi] = useState<AiCfg>(t.ai_own || {});
  const save = () => run(async () => {
    const b = await sb().rpc('save_bill_rule', { p_tenant: t.id, p: { ...bill, fee_percent: Number(bill.fee_percent) } });
    if (b.error) throw new Error(b.error.message);
    const own = Object.values(ai).some(v => v !== null && v !== undefined && v !== '');
    const a = own ? await sb().from('ai_config').upsert({ scope: t.id, brain_model: ai.brain_model || null, brain_effort: ai.brain_effort || null,
                                                          agent_model: ai.agent_model || null, agent_effort: ai.agent_effort || null,
                                                          details_by_code: ai.details_by_code ?? null, react_no_reply: ai.react_no_reply ?? null,
                                                          wait_seconds: ai.wait_seconds ?? null,
                                                          updated_at: new Date().toISOString() })
                  : await sb().from('ai_config').delete().eq('scope', t.id);
    if (a.error) throw new Error(a.error.message);
    await reload();
  }, `${t.name} saved`);
  return (
    <Card title={<span className="flex items-center gap-2">{t.name} <span className="text-xs font-normal text-muted">{t.status}</span></span>}
      action={<span className="flex items-center gap-2"><Link href={`/r/${t.slug}/billing`} className="text-sm text-gold-ink hover:underline"><Receipt className="me-1 inline size-4" />Their bills</Link>
        <Button size="sm" variant="gold" busy={busy} onClick={save}>Save</Button></span>}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-end gap-4">
          <label className="text-xs text-muted">Everwake's percent<div className="mt-1 flex items-center gap-1"><Input className="w-24" type="number" min="0" max="100" step="0.1" value={bill.fee_percent} onChange={e => setBill({ ...bill, fee_percent: e.target.value as unknown as number })} /><span className="text-sm">%</span></div></label>
          <Checkbox checked={bill.include_delivery_fee} onChange={v => setBill({ ...bill, include_delivery_fee: v })} label="with the delivery fee" />
          <Checkbox checked={bill.include_vat} onChange={v => setBill({ ...bill, include_vat: v })} label="with VAT" />
          <label className="text-xs text-muted">Bill orders from<Input className="mt-1 w-44" type="date" value={bill.starts_on || ''} onChange={e => setBill({ ...bill, starts_on: e.target.value || null })} /></label>
          <p className="text-xs text-muted"><Sparkles className="me-1 inline size-3.5" />WhatsApp orders: the food after discounts{bill.include_delivery_fee ? ' + delivery' : ''}{bill.include_vat ? ' + VAT' : ''}. QR orders: their total.</p>
        </div>
        <AiFields value={ai} onChange={v => setAi({ ...ai, ...v })} />
        <p className="text-xs text-muted">In use now: planning {t.ai.brain_model || 'gpt-6-luna'} · {t.ai.brain_effort} · reply {t.ai.agent_model || 'gpt-6-luna'} · {t.ai.agent_effort} · details by code {t.ai.details_by_code ? 'on' : 'off'} · ❤️ {t.ai.react_no_reply ? 'on' : 'off'} · waits {t.ai.wait_seconds ?? 5} s</p>
      </div>
    </Card>
  );
}

function PricesView() {
  const { busy, run } = useAction();
  const prices = useCached('dev:prices', async () => ((await sb().from('ai_prices').select('*').order('model')).data || []) as Price[]);
  const [rows, setRows] = useState<Price[] | null>(null);
  const list = rows || prices.data || [];
  const set = (i: number, k: keyof Price, v: string) => setRows(list.map((r, j) => (j === i ? { ...r, [k]: k === 'model' ? v : v === '' ? null : Number(v) } : r)));
  const save = () => run(async () => {
    const { error } = await sb().from('ai_prices').upsert(list.filter(r => r.model.trim()).map(r => ({ ...r, model: r.model.trim(), updated_at: new Date().toISOString() })));
    if (error) throw new Error(error.message);
    await prices.refresh(); setRows(null);
  }, 'Prices saved');
  if (!prices.data) return <Spinner />;
  return (
    <Card title="Model prices ($ per 1M tokens)" action={<span className="flex gap-2">
      <Button size="sm" variant="outline" onClick={() => setRows([...list, { model: '', input_per_m: 0, cached_per_m: 0, output_per_m: 0, audio_per_minute: null }])}><Plus className="size-4" /> Model</Button>
      <Button size="sm" variant="gold" busy={busy} onClick={save}>Save</Button></span>}>
      <p className="mb-3 text-xs text-muted">A model's name is matched from its start: "gpt-6-luna" prices "gpt-6-luna-2026-10-01" too. A call priced at the time it was made keeps that price.</p>
      <Table head={['Model', 'Input', 'Cached input', 'Output', 'Audio per minute']}
        rows={list.map((r, i) => [
          <Input key="m" value={r.model} onChange={e => set(i, 'model', e.target.value)} />,
          <Input key="i" type="number" step="0.001" value={r.input_per_m} onChange={e => set(i, 'input_per_m', e.target.value)} />,
          <Input key="c" type="number" step="0.001" value={r.cached_per_m} onChange={e => set(i, 'cached_per_m', e.target.value)} />,
          <Input key="o" type="number" step="0.001" value={r.output_per_m} onChange={e => set(i, 'output_per_m', e.target.value)} />,
          <Input key="a" type="number" step="0.001" value={r.audio_per_minute ?? ''} onChange={e => set(i, 'audio_per_minute', e.target.value)} />])} />
    </Card>
  );
}

function Table({ head, rows }: { head: string[]; rows: React.ReactNode[][] }) {
  if (!rows.length) return <p className="text-sm text-muted">Nothing here yet.</p>;
  return (
    <div className="-mx-1 overflow-x-auto">
      <table className="w-full min-w-[640px] text-sm">
        <thead className="text-xs text-muted"><tr>{head.map((h, i) => <th key={h} className={cx('whitespace-nowrap px-2 py-2 font-medium', i ? 'text-end' : 'text-start')}>{h}</th>)}</tr></thead>
        <tbody className="divide-y divide-hairline/60">
          {rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className={cx('whitespace-nowrap px-2 py-2 align-middle', j ? 'text-end tabular-nums' : 'text-start')}>{c}</td>)}</tr>)}
        </tbody>
      </table>
    </div>
  );
}

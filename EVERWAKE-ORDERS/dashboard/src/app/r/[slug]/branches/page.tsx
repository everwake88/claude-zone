'use client';
import { LayoutGrid, Map as MapIcon, MapPin, Plus } from 'lucide-react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { BranchCard, DayStrip, STATE, useHoursLine, type BoardRow } from '@/components/branches/BranchCard';
import { BranchEditor, PAYMENTS } from '@/components/branches/BranchEditor';
import { RankList } from '@/components/charts';
import { Button, Card, Empty, Modal, PageHeader, Spinner, Switch, Tabs, useAction } from '@/components/ui';
import { PageGuide } from '@/components/guide';
import { useTenant } from '@/components/tenant';
import { cx, money } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { sb } from '@/lib/supabase/client';
import type { Branch } from '@/lib/types';
import { useCached } from '@/lib/use-cached';

const BranchMap = dynamic(() => import('@/components/branches/BranchMap'), { ssr: false,
  loading: () => <div className="ew-skeleton h-full min-h-[420px] rounded-[var(--ui-radius)]" /> });

type View = 'cards' | 'map';
const VIEW_KEY = 'ew-branches-view';

// The branches, live: open or not and until when, today's orders, the kitchen's queue, the last two
// weeks, and the switches the team uses during service. As cards, or on the map with a list beside it.
export default function BranchesPage() {
  const { tenant, base, can } = useTenant();
  const { t, lang } = useLang();
  const tz = tenant.timezone || 'Africa/Cairo', sym = tenant.currency_symbol;
  const [edit, setEdit] = useState<Partial<Branch> | null>(null);
  const [busyFor, setBusyFor] = useState<Branch | null>(null);
  const [view, setView] = useState<View>('cards');
  const [selected, setSelected] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const { busy, run } = useAction();
  const payName = (m: string) => t(PAYMENTS.find(p => p[0] === m)?.[1] || m);
  const hoursLine = useHoursLine();

  // the view chosen last time on this browser
  useEffect(() => { try { const v = localStorage.getItem(VIEW_KEY); if (v === 'map' || v === 'cards') setView(v); } catch { /* private mode */ } }, []);
  const choose = (v: View) => { setView(v); try { localStorage.setItem(VIEW_KEY, v); } catch { /* private mode */ } };

  const branches = useCached(`br:${tenant.id}`, async () => {
    const [b, tr] = await Promise.all([
      sb().from('branches').select('*').eq('tenant_id', tenant.id).order('sort'),
      sb().from('tenants').select('settings').eq('id', tenant.id).single()
    ]);
    return { list: (b.data || []) as Branch[],
             restPay: ((tr.data as { settings?: { payment_methods?: string[] } } | null)?.settings?.payment_methods) || ['cash'] };
  });
  const board = useCached(`brb:${tenant.id}`, async (): Promise<BoardRow[]> => {
    const { data, error } = await sb().rpc('branch_board', { p_tenant: tenant.id });
    if (!error) return data as BoardRow[];
    // before the database update: each branch's state on its own
    const { data: ids } = await sb().from('branches').select('id').eq('tenant_id', tenant.id);
    return Promise.all(((ids || []) as { id: string }[]).map(async b => ({ id: b.id, state: (await sb().rpc('branch_state', { p_branch: b.id })).data as string })));
  });
  const { refresh: refreshBoard } = board, { refresh: refreshBranches } = branches;
  const reload = useCallback(() => Promise.all([refreshBranches(), refreshBoard()]), [refreshBranches, refreshBoard]);

  // live: orders and switches as they change (a moment after, gathered), the clock every minute
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const soon = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => { refreshBoard(); }, 2500); };
    const ch = sb().channel('branches-' + tenant.id)
      .on('postgres_changes', { event: '*', schema: 'everwake', table: 'orders', filter: `tenant_id=eq.${tenant.id}` }, soon)
      .on('postgres_changes', { event: '*', schema: 'everwake', table: 'branches', filter: `tenant_id=eq.${tenant.id}` }, () => { refreshBranches(); soon(); })
      .subscribe();
    const tick = setInterval(() => setNow(Date.now()), 60000);
    return () => { if (timer) clearTimeout(timer); clearInterval(tick); sb().removeChannel(ch); };
  }, [tenant.id, refreshBoard, refreshBranches]);

  const rows = useMemo(() => new Map((board.data || []).map(r => [r.id, r])), [board.data]);
  const list = branches.data?.list, restPay = branches.data?.restPay || ['cash'];

  const accepting = (b: Branch, v: boolean) => run(async () => {
    const { error } = await sb().rpc('set_branch_accepting', { p_branch: b.id, p_accepting: v });
    if (error) throw new Error(error.message);
    await reload();
  }, v ? t('{branch} is taking orders again', { branch: b.name_en || b.name_ar }) : t('{branch} stopped taking orders — the agent offers another branch', { branch: b.name_en || b.name_ar }));
  const pause = (b: Branch, minutes: number) => run(async () => {
    const { error } = await sb().rpc('set_branch_busy', { p_branch: b.id, p_minutes: minutes, p_reason: null });
    if (error) throw new Error(error.message);
    setBusyFor(null); await reload();
  }, minutes ? t('Paused for {n} minutes', { n: minutes }) : t('Taking orders again'));

  if (!list) return <Spinner />;
  const active = list.filter(b => b.is_active);
  const openNow = active.filter(b => rows.get(b.id)?.state === 'open').length;
  const todayOrders = active.reduce((s, b) => s + Number(rows.get(b.id)?.today?.orders || 0), 0);
  const todayRevenue = active.reduce((s, b) => s + Number(rows.get(b.id)?.today?.revenue || 0), 0);
  const money0 = can.edit && active.some(b => rows.get(b.id)?.today?.revenue != null);
  const nameOf = (b: Branch) => (lang === 'ar' ? b.name_ar : b.name_en || b.name_ar);
  const waiting = active.reduce((s, b) => s + Number(rows.get(b.id)?.live?.waiting || 0), 0);
  // the finding under the title: what is open, what today has brought, what is waiting
  const sentence = !list.length ? t('Where orders are made. Opening hours, fees and the switches here decide what the agent promises.')
    : [t('{a} of {b} open now', { a: openNow, b: active.length }),
       rows.size && board.data?.[0]?.today ? t('{n} orders today', { n: todayOrders }) + (money0 ? ` (${money(todayRevenue, sym)})` : '') : '',
       waiting ? t('{n} waiting to be accepted', { n: waiting }) : ''].filter(Boolean).join(' · ') + '.';
  const pins = active.filter(b => b.lat != null && b.lng != null)
    .map(b => ({ id: b.id, lat: Number(b.lat), lng: Number(b.lng), name: nameOf(b), state: rows.get(b.id)?.state || 'unknown', orders: rows.get(b.id)?.today ? Number(rows.get(b.id)!.today!.orders) : null }));
  const card = (b: Branch) => (
    <BranchCard key={b.id} b={b} row={rows.get(b.id)} tz={tz} sym={sym} now={now} base={base} canEdit={can.edit} canMoney={can.edit} busy={busy}
      onAccepting={v => accepting(b, v)} onPause={() => setBusyFor(b)} onResume={() => pause(b, 0)} onEdit={() => setEdit({ ...b })}
      payName={payName} restPay={restPay} />
  );

  return (
    <div className="space-y-5 pb-4">
      <PageHeader title={t('Branches')} subtitle={<span className="text-[15px] text-ink/75">{sentence}</span>}
        actions={<>
          {list.length > 0 && <Tabs value={view} onChange={choose} tabs={[
            { value: 'cards', label: <span className="flex items-center gap-1.5"><LayoutGrid className="size-4" aria-hidden />{t('Cards')}</span> },
            { value: 'map', label: <span className="flex items-center gap-1.5"><MapIcon className="size-4" aria-hidden />{t('Map')}</span> }]} />}
          {can.edit && <Button variant="gold" onClick={() => setEdit({ hours: { default: [{ open: '12:00', close: '00:00' }] }, accepting_orders: true, delivery_enabled: true, pickup_enabled: true, is_active: true })}>
            <Plus className="size-4" /> {t('Add a branch')}</Button>}
        </>} />
      <PageGuide id="branches" steps={[
          t('Add every branch with its Google Maps link and opening hours — every order goes to a branch.'),
          t('Its delivery fee, minimum order and VAT are what the agent quotes (a delivery zone can set its own fee).'),
          t('“Taking orders” and “Too busy” are for right now: while a branch is off, the agent offers another one.'),
          t('Open a branch (the pencil) for what is different there: seating, payment methods and table bookings. Its own dishes and prices are in Menu.')
        ]} />

      {list.length === 0 ? <Empty title={t('No branches yet')}>{t('Add at least one branch with its address and hours — every order goes to a branch.')}</Empty>
        : view === 'cards' ? (
        <>
          <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">{list.map(card)}</div>
          {active.length > 1 && board.data?.[0]?.today && (
            <Card title={t('Today by branch')}>
              <RankList format={v => String(v)} rows={active.map(b => ({ label: nameOf(b), value: Number(rows.get(b.id)?.today?.orders || 0),
                sub: money0 && rows.get(b.id)?.today?.revenue != null ? money(Number(rows.get(b.id)!.today!.revenue), sym) : undefined }))
                .sort((a, b) => b.value - a.value)} />
            </Card>
          )}
        </>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px] lg:items-stretch">
          <div className="ew-card min-h-[460px] p-1.5 lg:min-h-[620px]">
            {pins.length ? <BranchMap pins={pins} selected={selected} onSelect={setSelected} />
              : <div className="flex h-full min-h-[420px] items-center justify-center p-6 text-center text-sm text-muted">{t('No branch has a map pin yet. Open a branch and paste its Google Maps link.')}</div>}
          </div>
          <ul className="space-y-2.5 lg:max-h-[620px] lg:overflow-y-auto lg:pe-1">
            {list.map(b => {
              const r = rows.get(b.id), st = STATE[r?.state || 'unknown'] || STATE.unknown, on = selected === b.id;
              return (
                <li key={b.id} className={cx('ew-card overflow-hidden transition-shadow duration-150', on && 'ring-2 ring-ink/70', !b.is_active && 'opacity-60')}>
                  <button type="button" onClick={() => setSelected(on ? null : b.id)} aria-expanded={on}
                    className="flex w-full items-center gap-3 px-4 py-3 text-start">
                    <span className={cx('size-2.5 shrink-0 rounded-full', st.dot, r?.state === 'open' && 'ew-live')} aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-semibold text-ink"><bdi>{nameOf(b)}</bdi></span>
                      <span className="block truncate text-xs text-muted">{t(st.label)} · {hoursLine(b, r, tz, now)}</span>
                    </span>
                    {r?.today && <span className="shrink-0 text-end"><b className="block text-lg leading-none tabular-nums text-ink">{r.today.orders}</b><span className="text-[11px] text-muted">{t('today')}</span></span>}
                    {Number(r?.live?.waiting || 0) > 0 && <span className="shrink-0 rounded-full bg-critical px-2 py-0.5 text-xs font-semibold text-white">{r!.live!.waiting}</span>}
                    {b.lat == null && <MapPin className="size-4 shrink-0 text-muted/60" aria-label={t('No map pin')} />}
                  </button>
                  {on && (
                    <div className="ew-fade space-y-3 border-t border-hairline/70 px-4 pb-4 pt-3">
                      <DayStrip b={b} tz={tz} now={now} />
                      {r?.live && <p className="text-sm text-ink/80">{t('{a} waiting · {b} in the kitchen · {c} ready', { a: r.live.waiting, b: r.live.cooking, c: r.live.ready })}</p>}
                      {b.lat == null && <p className="text-xs text-muted">{t('Add its Google Maps link to put it on the map.')}</p>}
                      <div className="flex flex-wrap items-center gap-2">
                        <label className="flex items-center gap-2 text-sm">{t('Taking orders')} <Switch checked={b.accepting_orders} onChange={v => accepting(b, v)} disabled={busy} /></label>
                        <span className="flex-1" />
                        {r?.state === 'busy' ? <Button size="sm" variant="outline" onClick={() => pause(b, 0)}>{t('Resume now')}</Button>
                          : <Button size="sm" variant="outline" disabled={!b.accepting_orders} onClick={() => setBusyFor(b)}>{t('Too busy')}</Button>}
                        {can.edit && <Button size="sm" variant="ghost" onClick={() => setEdit({ ...b })}>{t('Edit')}</Button>}
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <p className="text-sm text-muted">{t('Delivery areas and their fees are drawn on the map in')} <Link href={`${base}/zones`} className="text-gold-ink underline">{t('Delivery zones')}</Link>.</p>

      <Modal open={!!busyFor} onClose={() => setBusyFor(null)} title={t('Pause {branch}', { branch: busyFor ? nameOf(busyFor) : '' })}>
        <p className="mb-3 text-sm text-muted">{t('The agent tells customers this branch is too busy right now and offers another open branch. It starts taking orders again by itself.')}</p>
        <div className="grid grid-cols-3 gap-2">
          {[15, 30, 45, 60, 90, 120].map(m => <Button key={m} variant="outline" busy={busy} onClick={() => busyFor && pause(busyFor, m)}>{m < 60 ? t('{n} min', { n: m }) : t('{n} h', { n: m / 60 })}</Button>)}
        </div>
      </Modal>

      <BranchEditor edit={edit} setEdit={setEdit} list={list} restPay={restPay} onSaved={reload} />
    </div>
  );
}

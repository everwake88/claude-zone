'use client';
import { ArrowDownRight, ArrowUpRight, Camera, CircleDollarSign, Copy, FileImage, ImageOff, LayoutGrid, List, MapPin, Moon, Pencil, Plus, Search, Sparkles, Star, Utensils } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { ItemEditor } from '@/components/menu/ItemEditor';
import { BranchPriceModal, CopyBranchModal } from '@/components/menu/BranchMenuTools';
import { StockButton } from '@/components/menu/StockButton';
import { DishCard, type Sales } from '@/components/menu/DishCard';
import { Badge, Button, Checkbox, Empty, Field, Input, Modal, PageHeader, Select, Spinner, Switch, Tabs, Textarea, useAction } from '@/components/ui';
import { PageGuide } from '@/components/guide';
import { useTenant } from '@/components/tenant';
import { cx, money } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { sb } from '@/lib/supabase/client';
import type { Branch, Category, Item, ItemBranch, OptionBranch } from '@/lib/types';
import { useCached } from '@/lib/use-cached';

type Show = 'all' | 'here' | 'not_here' | 'own_price';
type Health = 'all' | 'nophoto' | 'out' | 'stale' | 'noprice';
const VIEW_KEY = 'ew-menu-view';

export default function MenuPage() {
  const { tenant, base, can } = useTenant();
  const params = useSearchParams();
  const [cat, setCat] = useState<string>('all');
  const [scope, setScope] = useState<string>(params.get('branch') || 'all');
  const [show, setShow] = useState<Show>('all');
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<Item | 'new' | null>(null);
  const [catEdit, setCatEdit] = useState<Partial<Category> | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [priceFor, setPriceFor] = useState<Item[] | null>(null);
  const [copyOpen, setCopyOpen] = useState(false);
  const [view, setView] = useState<'cards' | 'list'>('cards');
  const [health, setHealth] = useState<Health>('all');
  const { busy, run } = useAction();
  const { t, lang } = useLang();
  useEffect(() => { try { const v = localStorage.getItem(VIEW_KEY); if (v === 'cards' || v === 'list') setView(v); } catch { /* private mode */ } }, []);
  const choose = (v: 'cards' | 'list') => { setView(v); try { localStorage.setItem(VIEW_KEY, v); } catch { /* private mode */ } };

  // the menu, kept between visits: coming back shows it at once, then the fresh copy
  const menu = useCached(`menu:${tenant.id}`, async () => {
    const db = sb();
    const [c, i, b, o, m, g, ob] = await Promise.all([
      db.from('menu_categories').select('*').eq('tenant_id', tenant.id).order('sort'),
      db.from('menu_items').select('*').eq('tenant_id', tenant.id).order('sort').order('name_ar'),
      db.from('branches').select('*').eq('tenant_id', tenant.id).eq('is_active', true).order('sort'),
      db.from('menu_item_branches').select('*').eq('tenant_id', tenant.id),
      db.from('item_media').select('item_id, url, is_primary').eq('tenant_id', tenant.id).order('is_primary', { ascending: false }),
      db.from('menu_option_groups').select('item_id').eq('tenant_id', tenant.id),
      db.from('menu_option_branches').select('*').eq('tenant_id', tenant.id)
    ]);
    const ph: Record<string, string> = {};
    for (const x of (m.data || []) as { item_id: string; url: string }[]) if (!ph[x.item_id]) ph[x.item_id] = x.url;
    const cc: Record<string, number> = {};
    for (const x of (g.data || []) as { item_id: string }[]) cc[x.item_id] = (cc[x.item_id] || 0) + 1;
    return { cats: (c.data || []) as Category[], items: (i.data || []) as Item[], branches: (b.data || []) as Branch[],
             overrides: (o.data || []) as ItemBranch[], optOverrides: (ob.data || []) as OptionBranch[], photos: ph, choiceCount: cc };
  });
  // each dish's sales, last 30 days against the 30 before (owners and managers; nothing before the database update)
  const insights = useCached(can.edit ? `menuins:${tenant.id}` : null, async () => {
    const { data, error } = await sb().rpc('menu_insights', { p_tenant: tenant.id, p_days: 30 });
    return error ? null : ((data as { items: Record<string, Sales> }).items || {});
  });
  const load = menu.refresh;
  const cats = menu.data?.cats ?? null, items = menu.data?.items ?? [], branches = menu.data?.branches ?? [];
  const overrides = menu.data?.overrides ?? [], optOverrides = menu.data?.optOverrides ?? [];
  const photos = menu.data?.photos ?? {}, choiceCount = menu.data?.choiceCount ?? {};
  const sales = insights.data ?? null;


  // one branch's view of the menu (a branch from the link that no longer exists → all branches)
  const branch = scope === 'all' ? null : branches.find(b => b.id === scope) || null;
  useEffect(() => { if (cats && scope !== 'all' && !branches.some(b => b.id === scope)) setScope('all'); }, [cats, branches, scope]);
  useEffect(() => { setPicked(new Set()); setShow('all'); }, [scope]);

  const ov = useMemo(() => new Map(overrides.map(o => [`${o.item_id}:${o.branch_id}`, o])), [overrides]);
  const catById = useMemo(() => new Map((cats || []).map(c => [c.id, c])), [cats]);
  const servedAt = (c: Category | undefined, branchId: string) => !c || !c.branch_ids || c.branch_ids.includes(branchId);
  // on a branch's menu: listed there, its category served there, and (dine-in only dishes) the branch has seating
  const onMenuAt = (i: Item, b: Branch) => (ov.get(`${i.id}:${b.id}`)?.is_listed ?? true) && servedAt(catById.get(i.category_id || ''), b.id)
    && (i.orderable || b.dine_in !== false);
  const ownPrice = (i: Item, branchId: string) => ov.get(`${i.id}:${branchId}`)?.price ?? null;
  const ownChoices = (i: Item, branchId: string) => optOverrides.filter(x => x.item_id === i.id && x.branch_id === branchId).length;
  // out of stock now: everywhere, or at the branch whose menu is shown (on the whole menu: at any branch)
  const gone = (a: boolean, until: string | null | undefined) => !a || (!!until && new Date(until) > new Date());
  const isOut = (i: Item) => gone(i.is_available, i.sold_out_until)
    || (branch ? (() => { const o = ov.get(`${i.id}:${branch.id}`); return !!o && gone(o.is_available, o.sold_out_until); })()
               : overrides.some(o => o.item_id === i.id && gone(o.is_available, o.sold_out_until)));

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return items.filter(i => (showArchived ? !i.is_active : i.is_active))
      .filter(i => cat === 'all' || (cat === 'none' ? !i.category_id : i.category_id === cat))
      .filter(i => !s || [i.code, i.name_ar, i.name_en, ...(i.aliases || [])].some(v => (v || '').toLowerCase().includes(s)))
      .filter(i => !branch || show === 'all' || (show === 'here' ? onMenuAt(i, branch) : show === 'not_here' ? !onMenuAt(i, branch)
        : ownPrice(i, branch.id) != null || ownChoices(i, branch.id) > 0))
      .filter(i => health === 'all' || (health === 'nophoto' ? !photos[i.id] : health === 'out' ? isOut(i) : health === 'noprice' ? i.price == null
        : !(Number(sales?.[i.id]?.sold || 0) > 0)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, cat, q, showArchived, branch, show, ov, optOverrides, catById, health, photos, sales]);

  const saveCategory = () => run(async () => {
    if (!catEdit?.name_ar?.trim()) throw new Error(t('The category needs an Arabic name'));
    if (catEdit.branch_ids && !catEdit.branch_ids.length) throw new Error(t('Tick the branches that serve this category (or hide it).'));
    const every = catEdit.branch_ids && branches.every(b => catEdit.branch_ids!.includes(b.id));
    const row = { tenant_id: tenant.id, name_ar: catEdit.name_ar.trim(), name_en: catEdit.name_en || null, description_ar: catEdit.description_ar || null,
                  available_from: catEdit.available_from || null, available_to: catEdit.available_to || null,
                  is_active: catEdit.is_active !== false, sort: catEdit.sort ?? ((cats?.length || 0) + 1) * 10,
                  branch_ids: every ? null : catEdit.branch_ids ?? null };
    const { error } = catEdit.id ? await sb().from('menu_categories').update(row).eq('id', catEdit.id)
                                 : await sb().from('menu_categories').insert(row);
    if (error) throw new Error(error.message);
    setCatEdit(null); await load();
  }, t('Category saved'));

  // one branch, one or many dishes
  const update = (ids: string[], patch: Record<string, unknown>, done?: string) => run(async () => {
    if (!branch) return;
    const { error } = await sb().rpc('branch_menu_update', { p_tenant: tenant.id, p_branch: branch.id, p: { items: ids, ...patch } });
    if (error) throw new Error(error.message);
    setPicked(new Set()); await load();
  }, done);
  const setPrice = (i: Item, raw: string) => {
    const v = raw.trim() === '' ? null : Number(raw);
    if (v === ownPrice(i, branch!.id) || (v !== null && (isNaN(v) || v < 0))) return;
    update([i.id], { price: v === null || v === i.price ? { mode: 'reset', choices: false } : { mode: 'set', value: v } },
           t('Price at {branch} saved', { branch: branch!.name_en || branch!.name_ar }));
  };

  const branchOut = (itemId: string) => overrides.filter(o => o.item_id === itemId && (!o.is_available || (o.sold_out_until && new Date(o.sold_out_until) > new Date())));
  if (!cats) return <Spinner />;
  const bName = (b: Branch) => b.name_en || b.name_ar;
  const pickedItems = items.filter(i => picked.has(i.id));
  const allPicked = shown.length > 0 && shown.every(i => picked.has(i.id));

  return (
    <div>
      <PageHeader title={t('Menu')} subtitle={t('Everything the agent offers. Any change here — a price, a dish out of stock — reaches the agent on the very next message.')}
        actions={can.edit && <>
          <Link href={`${base}/menu/pages`}><Button variant="outline"><FileImage className="size-4" /> {t('Menu pictures / PDF')}</Button></Link>
          <Link href={`${base}/menu/photos`}><Button variant="outline"><Camera className="size-4" /> {t('Dish photos with AI')}</Button></Link>
          <Link href={`${base}/menu/import${branch ? `?branch=${branch.id}` : ''}`}><Button variant="outline"><Sparkles className="size-4" /> {branch ? t('Import this branch’s menu') : t('Import a menu with AI')}</Button></Link>
          <Button variant="gold" onClick={() => setEditing('new')}><Plus className="size-4" /> {t('Add a dish')}</Button>
        </>} />
      <PageGuide id="menu" steps={[
          t('The agent offers only what is here, at these prices. The quickest start: Import a menu with AI (a PDF, photos, a link or a spreadsheet), then check it.'),
          t('Open a dish (the pencil) for its choices — sizes and add-ons — its photos and what is different at each branch.'),
          t('Sold out? Press its stock button: for today, for a while, or until you switch it back on.'),
          t('Branches that sell differently: choose the branch under “Menu of”, then switch its dishes on or off and change its prices — many at once if you tick them.')
        ]} />

      {branches.length > 1 && items.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-hairline bg-white px-4 py-3">
          <MapPin className="size-4 text-gold" />
          <span className="text-sm font-medium">{t('Menu of')}</span>
          <div className="w-80 max-w-full">
            <Select value={scope} onChange={e => setScope(e.target.value)} aria-label={t('Menu of')}>
              <option value="all">{t('All branches (the restaurant’s menu)')}</option>
              {branches.map(b => <option key={b.id} value={b.id}>{bName(b)}</option>)}
            </Select>
          </div>
          {branch ? <>
            <span className="text-sm text-muted">{t('{n} of {total} dishes here', { n: items.filter(i => i.is_active && onMenuAt(i, branch)).length, total: items.filter(i => i.is_active).length })}
              {branch.dine_in === false ? ' · ' + t('no seating: dine-in only dishes are left out') : ''}</span>
            <span className="flex-1" />
            {can.edit && <Button size="sm" variant="outline" onClick={() => setCopyOpen(true)}><Copy className="size-4" /> {t('Set up like…')}</Button>}
          </> : <span className="text-sm text-muted">{t('Choose a branch to give it its own dishes, prices and choices.')}</span>}
        </div>
      )}

      {items.length === 0 ? (
        <Empty title={t('No dishes yet')} action={can.edit && <Link href={`${base}/menu/import`}><Button variant="gold"><Sparkles className="size-4" /> {t('Import your menu from a PDF, photos or a link')}</Button></Link>}>
          {t('Upload the menu you already have — the AI reads it into dishes, prices and choices, and you review everything before it goes live.')}
        </Empty>
      ) : (() => {
        const live = items.filter(i => i.is_active && (!branch || onMenuAt(i, branch)));
        const counts = {
          nophoto: live.filter(i => !photos[i.id]).length, out: live.filter(isOut).length, noprice: live.filter(i => i.price == null).length,
          stale: sales ? live.filter(i => !(Number(sales[i.id]?.sold || 0) > 0)).length : 0
        };
        const best = new Set(Object.entries(sales || {}).filter(([, v]) => Number(v.sold) > 0).sort((a, b) => Number(b[1].sold) - Number(a[1].sold)).slice(0, 5).map(([k]) => k));
        const chips: { key: Health; label: string; n: number; icon: typeof Camera; tone?: string }[] = [
          { key: 'nophoto', label: t('without a photo'), n: counts.nophoto, icon: ImageOff },
          { key: 'out', label: t('sold out now'), n: counts.out, icon: Moon, tone: 'critical' },
          { key: 'stale', label: t('not ordered in 30 days'), n: counts.stale, icon: Utensils },
          { key: 'noprice', label: t('without a price'), n: counts.noprice, icon: CircleDollarSign }
        ];
        const catName = (c: Category) => (lang === 'en' && c.name_en ? c.name_en : c.name_ar);
        return (
          <div className="space-y-4">
            {/* the menu's health: each a filter, pressed again to show everything */}
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => setHealth('all')} aria-pressed={health === 'all'}
                className={cx('rounded-full px-3.5 py-1.5 text-sm font-semibold transition-colors duration-150', health === 'all' ? 'bg-navy text-white' : 'ew-card !rounded-full text-ink hover:text-gold-ink')}>
                {t('{n} dishes', { n: live.length })}
              </button>
              {chips.filter(c => c.n > 0).map(c => (
                <button key={c.key} type="button" onClick={() => setHealth(health === c.key ? 'all' : c.key)} aria-pressed={health === c.key}
                  className={cx('inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm transition-colors duration-150 active:scale-[.98]',
                    health === c.key ? 'bg-navy text-white' : c.tone === 'critical' ? 'bg-critical-wash text-critical hover:brightness-95' : 'bg-paper-sunk text-ink/80 hover:text-ink')}>
                  <c.icon className="size-3.5" aria-hidden /><b className="tabular-nums">{c.n}</b> {c.label}
                </button>
              ))}
            </div>

            {/* the categories, as a row of chips; the chosen one can be edited */}
            <div className="rail -mx-1 flex gap-2 overflow-x-auto px-1 py-0.5">
              {[{ id: 'all', name_ar: t('All dishes') } as Category, ...cats, ...(items.some(i => !i.category_id) ? [{ id: 'none', name_ar: t('No category') } as Category] : [])].map(c => {
                const n = items.filter(i => i.is_active && (c.id === 'all' || (c.id === 'none' ? !i.category_id : i.category_id === c.id)) && (!branch || onMenuAt(i, branch))).length;
                const notHere = branch && c.id !== 'all' && c.id !== 'none' && !servedAt(c, branch.id);
                const real = c.id !== 'all' && c.id !== 'none', on = cat === c.id;
                return (
                  <span key={c.id} className={cx('flex shrink-0 items-center rounded-full transition-colors duration-150', on ? 'bg-navy text-white' : 'ew-card !rounded-full text-ink')}>
                    <button type="button" onClick={() => setCat(c.id)} aria-pressed={on} className="flex items-center gap-2 py-1.5 ps-3.5 pe-3.5 text-sm font-medium">
                      <span dir="auto" className={cx((c.is_active === false || notHere) && 'line-through opacity-60')}>{real ? catName(c) : c.name_ar}</span>
                      {!branch && c.branch_ids && <MapPin className="size-3 opacity-70" aria-label={t('Some branches only')} />}
                      <span className={cx('text-xs tabular-nums', on ? 'text-white/70' : 'text-muted')}>{notHere ? t('not here') : n}</span>
                    </button>
                    {on && real && can.edit && (
                      <button type="button" onClick={() => setCatEdit(c)} aria-label={t('Edit category')} className="-ms-1.5 me-1 rounded-full p-1.5 hover:bg-white/15"><Pencil className="size-3.5" /></button>
                    )}
                  </span>
                );
              })}
              {can.edit && <button type="button" onClick={() => setCatEdit({})} className="flex shrink-0 items-center gap-1 rounded-full border border-dashed border-hairline px-3 py-1.5 text-sm text-muted hover:border-gold-line hover:text-gold-ink"><Plus className="size-3.5" /> {t('Category')}</button>}
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <div className="relative min-w-48 max-w-xs flex-1">
                <Search className="absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
                <Input className="ps-9" placeholder={t('Search dishes')} value={q} onChange={e => setQ(e.target.value)} />
              </div>
              {branch && (
                <div className="w-48">
                  <Select value={show} onChange={e => setShow(e.target.value as Show)} aria-label={t('Show')}>
                    <option value="all">{t('Every dish')}</option>
                    <option value="here">{t('On this branch’s menu')}</option>
                    <option value="not_here">{t('Not at this branch')}</option>
                    <option value="own_price">{t('Its own prices')}</option>
                  </Select>
                </div>
              )}
              <Checkbox checked={showArchived} onChange={setShowArchived} label={t('Show archived')} />
              <span className="flex-1" />
              <Tabs value={view} onChange={choose} tabs={[
                { value: 'cards', label: <span className="flex items-center gap-1.5"><LayoutGrid className="size-4" aria-hidden />{t('Cards')}</span> },
                { value: 'list', label: <span className="flex items-center gap-1.5"><List className="size-4" aria-hidden />{t('List')}</span> }]} />
            </div>

            {branch && can.edit && view === 'cards' && <p className="text-xs text-muted">{t('To change many dishes at this branch at once, switch to List and tick them.')}</p>}
            {branch && can.edit && view === 'list' && picked.size > 0 && (
              <div className="ew-pop sticky top-[80px] z-10 flex flex-wrap items-center gap-2 rounded-[var(--ui-radius-inner)] border border-gold/40 bg-gold-wash px-3 py-2 text-sm">
                <span className="font-medium">{t('{n} selected', { n: picked.size })}</span>
                <Button size="sm" variant="outline" busy={busy} onClick={() => update([...picked], { listed: true }, t('On {branch}’s menu', { branch: bName(branch) }))}>{t('Serve here')}</Button>
                <Button size="sm" variant="outline" busy={busy} onClick={() => update([...picked], { listed: false }, t('Off {branch}’s menu', { branch: bName(branch) }))}>{t('Not served here')}</Button>
                <Button size="sm" variant="outline" onClick={() => setPriceFor(pickedItems)}>{t('Change prices…')}</Button>
                <Button size="sm" variant="outline" busy={busy} onClick={() => update([...picked], { available: false }, t('Out of stock at {branch}', { branch: bName(branch) }))}>{t('Out of stock here')}</Button>
                <Button size="sm" variant="outline" busy={busy} onClick={() => update([...picked], { available: true }, t('Back in stock at {branch}', { branch: bName(branch) }))}>{t('Back in stock')}</Button>
                <span className="flex-1" />
                <Button size="sm" variant="ghost" onClick={() => setPicked(new Set())}>{t('Clear')}</Button>
              </div>
            )}

            {shown.length === 0 ? <Empty title={t('No dishes here.')}>{health !== 'all' ? t('Nothing left to fix here — well done.') : t('Try another category or search.')}</Empty>
              : view === 'cards' ? (
              <div className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-3 xl:grid-cols-4">
                {shown.map((i, k) => {
                  const o = branch ? ov.get(`${i.id}:${branch.id}`) : undefined;
                  const outAt = branchOut(i.id);
                  const stock = branch ? { available: (o?.is_available ?? true) && i.is_available, soldOutUntil: o?.sold_out_until || i.sold_out_until }
                    : { available: i.is_available, soldOutUntil: i.sold_out_until };
                  return (
                    <DishCard key={i.id} i={i} photo={photos[i.id]} sales={sales ? sales[i.id] || { sold: 0, prev_sold: 0, revenue: 0, orders: 0, last_at: null, weeks: [] } : null}
                      best={best.has(i.id)} stock={stock} choices={choiceCount[i.id] || 0} sym={tenant.currency_symbol} delay={k}
                      outLabel={!branch && i.is_available && outAt.length ? t('out at {branch}', { branch: outAt.map(x => bName(branches.find(b => b.id === x.branch_id)!)).filter(Boolean).join('، ') || t('a branch') }) : undefined}
                      branch={branch} branchPrice={branch ? ownPrice(i, branch.id) : null} served={o?.is_listed ?? true} here={!branch || onMenuAt(i, branch)}
                      canEdit={can.edit} busy={busy} onOpen={() => setEditing(i)} onStock={load}
                      onServed={v => branch && update([i.id], { listed: v }, v ? t('On {branch}’s menu', { branch: bName(branch) }) : t('Off {branch}’s menu', { branch: bName(branch) }))} />
                  );
                })}
              </div>
            ) : (
            <div className="ew-card overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-start text-xs text-muted">
                  <tr>
                    {branch && can.edit && <th className="w-8 px-3 py-2"><input type="checkbox" aria-label={t('Select all')} checked={allPicked}
                      onChange={e => setPicked(e.target.checked ? new Set(shown.map(i => i.id)) : new Set())} /></th>}
                    <th className="w-14 px-3 py-2" /><th className="px-3 py-2">{t('Dish')}</th>
                    <th className="px-3 py-2">{branch ? t('Price at {branch}', { branch: bName(branch) }) : t('Price')}</th>
                    {branch && <th className="px-3 py-2">{t('Served here')}</th>}
                    {!branch && sales && <th className="px-3 py-2 text-end">{t('Sold, 30 days')}</th>}
                    <th className="px-3 py-2">{t('Stock')}</th><th className="w-12" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-hairline">
                  {shown.map(i => {
                    const outAt = branchOut(i.id);
                    const c = catById.get(i.category_id || '');
                    if (branch) {
                      const o = ov.get(`${i.id}:${branch.id}`);
                      const listed = o?.is_listed ?? true;
                      const here = onMenuAt(i, branch);
                      const nChoices = ownChoices(i, branch.id);
                      return (
                        <tr key={i.id} className={cx('hover:bg-paper/60', !here && 'bg-paper/40')}>
                          {can.edit && <td className="px-3 py-2"><input type="checkbox" aria-label={t('Select {dish}', { dish: i.name_ar })} checked={picked.has(i.id)}
                            onChange={e => setPicked(p => { const n = new Set(p); if (e.target.checked) n.add(i.id); else n.delete(i.id); return n; })} /></td>}
                          <td className="px-3 py-2">
                            {photos[i.id] ? <img src={photos[i.id]} alt="" className={cx('size-12 rounded-xl object-cover', !here && 'opacity-50')} />
                              : <span className="flex size-12 items-center justify-center rounded-xl bg-paper-sunk text-muted"><Camera className="size-4" /></span>}
                          </td>
                          <td className="px-3 py-2">
                            <p className={cx('font-medium', !here && 'text-muted')}><span dir="auto">{i.name_ar}</span> {i.is_signature && <Star className="inline size-3.5 fill-gold text-gold" />}</p>
                            <p className="text-xs text-muted"><bdi><span className="font-mono">{i.code}</span>{i.name_en ? ` · ${i.name_en}` : ''}</bdi></p>
                            <div className="mt-0.5 flex flex-wrap gap-1">
                              {!servedAt(c, branch.id) && <Badge>{t('its category is not served here')}</Badge>}
                              {!i.orderable && branch.dine_in === false && <Badge>{t('dine-in only — no seating here')}</Badge>}
                              {!i.orderable && branch.dine_in !== false && <Badge>{t('dine-in only')}</Badge>}
                              {nChoices > 0 && <Badge tone="gold">{nChoices > 1 ? t('{n} choices with this branch’s price', { n: nChoices }) : t('1 choice with this branch’s price')}</Badge>}
                            </div>
                          </td>
                          <td className="whitespace-nowrap px-3 py-2">
                            {can.edit ? (
                              <div className="flex items-center gap-2">
                                <div className="w-24 shrink-0">
                                  <Input key={`${i.id}:${branch.id}:${o?.price ?? ''}`} className={cx(o?.price != null && 'border-gold')} type="number" min="0" step="0.5"
                                    aria-label={t('Price at {branch}', { branch: bName(branch) })} defaultValue={o?.price ?? ''} placeholder={i.price != null ? String(i.price) : '—'}
                                    onBlur={e => setPrice(i, e.target.value)} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
                                </div>
                                <span className="text-xs text-muted">{o?.price != null ? t('restaurant: {p}', { p: money(i.price, tenant.currency_symbol) }) : t('the restaurant’s')}</span>
                              </div>
                            ) : money(o?.price ?? i.price, tenant.currency_symbol)}
                          </td>
                          <td className="px-3 py-2">
                            <Switch checked={listed} disabled={!can.edit || busy} label={t('Served here')}
                              onChange={v => update([i.id], { listed: v }, v ? t('On {branch}’s menu', { branch: bName(branch) }) : t('Off {branch}’s menu', { branch: bName(branch) }))} />
                          </td>
                          <td className="px-3 py-2">{listed && <StockButton itemId={i.id} branchId={branch.id} available={o?.is_available ?? true}
                            soldOutUntil={o?.sold_out_until || null} onDone={load} />}</td>
                          <td className="px-3 py-2">{can.edit && <Button size="sm" variant="ghost" onClick={() => setEditing(i)} aria-label={t('Edit')}><Pencil className="size-4" /></Button>}</td>
                        </tr>
                      );
                    }
                    const notAt = branches.length > 1 ? branches.filter(b => !onMenuAt(i, b)) : [];
                    const priced = branches.filter(b => ownPrice(i, b.id) != null);
                    return (
                      <tr key={i.id} className="hover:bg-paper/60">
                        <td className="px-3 py-2">
                          {photos[i.id] ? <img src={photos[i.id]} alt="" className="size-12 rounded-xl object-cover" />
                            : <span className="flex size-12 items-center justify-center rounded-xl bg-paper-sunk text-muted"><Camera className="size-4" /></span>}
                        </td>
                        <td className="px-3 py-2">
                          <p className="font-medium"><span dir="auto">{i.name_ar}</span> {i.is_signature && <Star className="inline size-3.5 fill-gold text-gold" />}</p>
                          <p className="text-xs text-muted"><bdi><span className="font-mono">{i.code}</span>{i.name_en ? ` · ${i.name_en}` : ''}</bdi>
                            {choiceCount[i.id] ? ' · ' + (choiceCount[i.id] > 1 ? t('{n} choices', { n: choiceCount[i.id] }) : t('1 choice')) : ''}</p>
                          <div className="mt-0.5 flex flex-wrap gap-1">
                            {!i.orderable && <Badge>{t('dine-in only')}</Badge>}
                            {notAt.length > 0 && notAt.length < branches.length && <Badge>{t('not at {branches}', { branches: notAt.map(bName).join('، ') })}</Badge>}
                            {notAt.length === branches.length && branches.length > 1 && <Badge tone="caution">{t('on no branch’s menu')}</Badge>}
                            {outAt.map(o => <Badge key={o.branch_id} tone="caution">{t('out at {branch}', { branch: branches.find(b => b.id === o.branch_id)?.name_en || t('a branch') })}</Badge>)}
                          </div>
                        </td>
                        <td className="whitespace-nowrap px-3 py-2">{i.price == null ? <span className="text-muted">{t('branch confirms')}</span> : money(i.price, tenant.currency_symbol)}{i.unit === 'kg' ? ' / ' + t('kg') : ''}
                          {priced.length > 0 && <p className="text-xs text-muted">{priced.map(b => `${bName(b)} ${money(ownPrice(i, b.id), tenant.currency_symbol)}`).join(' · ')}</p>}</td>
                        {sales && (() => {
                          const v = sales[i.id], sold = Number(v?.sold || 0), pv = Number(v?.prev_sold || 0), tr = pv > 0 ? Math.round(((sold - pv) / pv) * 100) : null;
                          return (
                            <td className="whitespace-nowrap px-3 py-2 text-end tabular-nums">
                              {sold > 0 ? <b className="text-ink">{+sold.toFixed(2)}</b> : <span className="text-muted">0</span>}
                              {tr !== null && tr !== 0 && <span className={cx('ms-1.5 inline-flex items-center text-xs font-semibold', tr > 0 ? 'text-positive' : 'text-critical')}>
                                {tr > 0 ? <ArrowUpRight className="size-3.5" aria-hidden /> : <ArrowDownRight className="size-3.5" aria-hidden />}{Math.abs(tr)}%</span>}
                            </td>
                          );
                        })()}
                        <td className="px-3 py-2"><StockButton itemId={i.id} available={i.is_available} soldOutUntil={i.sold_out_until} onDone={load} /></td>
                        <td className="px-3 py-2">{can.edit && <Button size="sm" variant="ghost" onClick={() => setEditing(i)} aria-label={t('Edit')}><Pencil className="size-4" /></Button>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            )}
          </div>
        );
      })()}

      <ItemEditor item={editing} categories={cats} branches={branches} onClose={() => setEditing(null)} onSaved={load}
        defaultCategory={cat !== 'all' && cat !== 'none' ? cat : undefined} defaultBranch={branch?.id} />

      {branch && <BranchPriceModal open={!!priceFor} items={priceFor || []} branch={branch} overrides={ov} onClose={() => setPriceFor(null)}
        onApply={price => { const ids = (priceFor || []).map(i => i.id); setPriceFor(null); update(ids, { price }, t('Prices at {branch} saved', { branch: bName(branch) })); }} />}
      {branch && <CopyBranchModal open={copyOpen} branch={branch} branches={branches} onClose={() => setCopyOpen(false)} onDone={() => { setCopyOpen(false); load(); }} />}

      <Modal open={!!catEdit} onClose={() => setCatEdit(null)} title={catEdit?.id ? t('Edit category') : t('New category')}
        footer={<><Button variant="outline" onClick={() => setCatEdit(null)}>{t('Cancel')}</Button><Button variant="gold" busy={busy} onClick={saveCategory}>{t('Save')}</Button></>}>
        {catEdit && (
          <div className="space-y-3">
            <Field label={t('Name (Arabic)')}><Input dir="rtl" value={catEdit.name_ar || ''} onChange={e => setCatEdit({ ...catEdit, name_ar: e.target.value })} /></Field>
            <Field label={t('Name (English)')}><Input value={catEdit.name_en || ''} onChange={e => setCatEdit({ ...catEdit, name_en: e.target.value })} /></Field>
            <Field label={t('Description')}><Textarea dir="rtl" value={catEdit.description_ar || ''} onChange={e => setCatEdit({ ...catEdit, description_ar: e.target.value })} /></Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label={t('Served from')} hint={t('e.g. breakfast only')}><Input type="time" value={catEdit.available_from || ''} onChange={e => setCatEdit({ ...catEdit, available_from: e.target.value })} /></Field>
              <Field label={t('Until')}><Input type="time" value={catEdit.available_to || ''} onChange={e => setCatEdit({ ...catEdit, available_to: e.target.value })} /></Field>
            </div>
            {branches.length > 1 && (
              <div className="space-y-2 rounded-lg border border-hairline p-3">
                <Checkbox checked={!catEdit.branch_ids} onChange={v => setCatEdit({ ...catEdit, branch_ids: v ? null : branches.map(b => b.id) })}
                  label={t('Served at every branch')} />
                {catEdit.branch_ids && (
                  <div className="flex flex-wrap gap-4 ps-6">
                    {branches.map(b => <Checkbox key={b.id} checked={catEdit.branch_ids!.includes(b.id)} label={bName(b)}
                      onChange={v => setCatEdit({ ...catEdit, branch_ids: v ? [...catEdit.branch_ids!, b.id] : catEdit.branch_ids!.filter(x => x !== b.id) })} />)}
                  </div>
                )}
              </div>
            )}
            <Field label={t('Order on the menu')}><Input type="number" value={catEdit.sort ?? ''} onChange={e => setCatEdit({ ...catEdit, sort: Number(e.target.value) })} /></Field>
            <Checkbox checked={catEdit.is_active === false} onChange={v => setCatEdit({ ...catEdit, is_active: !v })} label={t('Hidden (the agent ignores the whole category)')} />
          </div>
        )}
      </Modal>
    </div>
  );
}

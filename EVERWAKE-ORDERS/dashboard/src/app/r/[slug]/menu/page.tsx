'use client';
import { Camera, Copy, FileImage, MapPin, Pencil, Plus, Search, Sparkles, Star } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ItemEditor } from '@/components/menu/ItemEditor';
import { BranchPriceModal, CopyBranchModal } from '@/components/menu/BranchMenuTools';
import { StockButton } from '@/components/menu/StockButton';
import { Badge, Button, Checkbox, Empty, Field, Input, Modal, PageHeader, Select, Spinner, Switch, Textarea, useAction } from '@/components/ui';
import { PageGuide } from '@/components/guide';
import { useTenant } from '@/components/tenant';
import { cx, money } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { sb } from '@/lib/supabase/client';
import type { Branch, Category, Item, ItemBranch, OptionBranch } from '@/lib/types';

type Show = 'all' | 'here' | 'not_here' | 'own_price';

export default function MenuPage() {
  const { tenant, base, can } = useTenant();
  const params = useSearchParams();
  const [cats, setCats] = useState<Category[] | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [overrides, setOverrides] = useState<ItemBranch[]>([]);
  const [optOverrides, setOptOverrides] = useState<OptionBranch[]>([]);
  const [photos, setPhotos] = useState<Record<string, string>>({});
  const [choiceCount, setChoiceCount] = useState<Record<string, number>>({});
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
  const { busy, run } = useAction();
  const t = useT();

  const load = useCallback(async () => {
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
    setCats((c.data || []) as Category[]);
    setItems((i.data || []) as Item[]);
    setBranches((b.data || []) as Branch[]);
    setOverrides((o.data || []) as ItemBranch[]);
    setOptOverrides((ob.data || []) as OptionBranch[]);
    const ph: Record<string, string> = {};
    for (const x of (m.data || []) as { item_id: string; url: string }[]) if (!ph[x.item_id]) ph[x.item_id] = x.url;
    setPhotos(ph);
    const cc: Record<string, number> = {};
    for (const x of (g.data || []) as { item_id: string }[]) cc[x.item_id] = (cc[x.item_id] || 0) + 1;
    setChoiceCount(cc);
  }, [tenant.id]);
  useEffect(() => { load(); }, [load]);

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

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return items.filter(i => (showArchived ? !i.is_active : i.is_active))
      .filter(i => cat === 'all' || (cat === 'none' ? !i.category_id : i.category_id === cat))
      .filter(i => !s || [i.code, i.name_ar, i.name_en, ...(i.aliases || [])].some(v => (v || '').toLowerCase().includes(s)))
      .filter(i => !branch || show === 'all' || (show === 'here' ? onMenuAt(i, branch) : show === 'not_here' ? !onMenuAt(i, branch)
        : ownPrice(i, branch.id) != null || ownChoices(i, branch.id) > 0));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, cat, q, showArchived, branch, show, ov, optOverrides, catById]);

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
      ) : (
        <div className="grid gap-4 lg:grid-cols-[220px_1fr]">
          <aside className="space-y-1">
            {[{ id: 'all', name_ar: t('All dishes') } as Category, ...cats, ...(items.some(i => !i.category_id) ? [{ id: 'none', name_ar: t('No category') } as Category] : [])].map(c => {
              const n = items.filter(i => i.is_active && (c.id === 'all' || (c.id === 'none' ? !i.category_id : i.category_id === c.id))
                                       && (!branch || onMenuAt(i, branch))).length;
              const notHere = branch && c.id !== 'all' && c.id !== 'none' && !servedAt(c, branch.id);
              const some = !branch && c.branch_ids;
              return (
                <div key={c.id} className={cx('group flex items-center rounded-lg', cat === c.id ? 'bg-navy text-white' : 'hover:bg-paper-sunk')}>
                  <button onClick={() => setCat(c.id)} className="flex flex-1 items-center justify-between px-3 py-2 text-start text-sm">
                    <span dir="auto" className={cx((c.is_active === false || notHere) && 'line-through opacity-60')}>{c.name_ar}
                      {some && <MapPin className="ms-1 inline size-3 opacity-70" aria-label={t('Some branches only')} />}</span>
                    <span className="text-xs opacity-70">{notHere ? t('not here') : n}</span>
                  </button>
                  {can.edit && c.id !== 'all' && c.id !== 'none' && (
                    <button onClick={() => setCatEdit(c)} className="px-2 opacity-0 group-hover:opacity-100" aria-label={t('Edit category')}><Pencil className="size-3.5" /></button>
                  )}
                </div>
              );
            })}
            {can.edit && <Button size="sm" variant="ghost" className="w-full justify-start" onClick={() => setCatEdit({})}><Plus className="size-4" /> {t('Category')}</Button>}
          </aside>

          <section>
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <div className="relative max-w-xs flex-1">
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
            </div>

            {branch && can.edit && picked.size > 0 && (
              <div className="sticky top-2 z-10 mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-gold/40 bg-gold-wash px-3 py-2 text-sm">
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

            <div className="overflow-x-auto rounded-xl border border-hairline bg-white">
              <table className="w-full text-sm">
                <thead className="bg-paper text-start text-xs text-muted">
                  <tr>
                    {branch && can.edit && <th className="w-8 px-3 py-2"><input type="checkbox" aria-label={t('Select all')} checked={allPicked}
                      onChange={e => setPicked(e.target.checked ? new Set(shown.map(i => i.id)) : new Set())} /></th>}
                    <th className="w-14 px-3 py-2" /><th className="px-3 py-2">{t('Dish')}</th>
                    <th className="px-3 py-2">{branch ? t('Price at {branch}', { branch: bName(branch) }) : t('Price')}</th>
                    {branch && <th className="px-3 py-2">{t('Served here')}</th>}
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
                            {photos[i.id] ? <img src={photos[i.id]} alt="" className={cx('size-10 rounded-lg object-cover', !here && 'opacity-50')} />
                              : <span className="flex size-10 items-center justify-center rounded-lg bg-paper-sunk text-muted"><Camera className="size-4" /></span>}
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
                          {photos[i.id] ? <img src={photos[i.id]} alt="" className="size-10 rounded-lg object-cover" />
                            : <span className="flex size-10 items-center justify-center rounded-lg bg-paper-sunk text-muted"><Camera className="size-4" /></span>}
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
                        <td className="px-3 py-2"><StockButton itemId={i.id} available={i.is_available} soldOutUntil={i.sold_out_until} onDone={load} /></td>
                        <td className="px-3 py-2">{can.edit && <Button size="sm" variant="ghost" onClick={() => setEditing(i)} aria-label={t('Edit')}><Pencil className="size-4" /></Button>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {shown.length === 0 && <p className="p-6 text-center text-sm text-muted">{t('No dishes here.')}</p>}
            </div>
          </section>
        </div>
      )}

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

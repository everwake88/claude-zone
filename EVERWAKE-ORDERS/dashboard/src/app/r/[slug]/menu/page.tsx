'use client';
import { Camera, FileImage, Pencil, Plus, Search, Sparkles, Star } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ItemEditor } from '@/components/menu/ItemEditor';
import { StockButton } from '@/components/menu/StockButton';
import { Badge, Button, Checkbox, Empty, Field, Input, Modal, PageHeader, Spinner, Textarea, useAction } from '@/components/ui';
import { useTenant } from '@/components/tenant';
import { cx, money } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { sb } from '@/lib/supabase/client';
import type { Branch, Category, Item, ItemBranch } from '@/lib/types';

export default function MenuPage() {
  const { tenant, base, can } = useTenant();
  const [cats, setCats] = useState<Category[] | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [overrides, setOverrides] = useState<ItemBranch[]>([]);
  const [photos, setPhotos] = useState<Record<string, string>>({});
  const [choiceCount, setChoiceCount] = useState<Record<string, number>>({});
  const [cat, setCat] = useState<string>('all');
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<Item | 'new' | null>(null);
  const [catEdit, setCatEdit] = useState<Partial<Category> | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const { busy, run } = useAction();
  const t = useT();

  const load = useCallback(async () => {
    const db = sb();
    const [c, i, b, o, m, g] = await Promise.all([
      db.from('menu_categories').select('*').eq('tenant_id', tenant.id).order('sort'),
      db.from('menu_items').select('*').eq('tenant_id', tenant.id).order('sort').order('name_ar'),
      db.from('branches').select('*').eq('tenant_id', tenant.id).eq('is_active', true).order('sort'),
      db.from('menu_item_branches').select('*').eq('tenant_id', tenant.id),
      db.from('item_media').select('item_id, url, is_primary').eq('tenant_id', tenant.id).order('is_primary', { ascending: false }),
      db.from('menu_option_groups').select('item_id').eq('tenant_id', tenant.id)
    ]);
    setCats((c.data || []) as Category[]);
    setItems((i.data || []) as Item[]);
    setBranches((b.data || []) as Branch[]);
    setOverrides((o.data || []) as ItemBranch[]);
    const ph: Record<string, string> = {};
    for (const x of (m.data || []) as { item_id: string; url: string }[]) if (!ph[x.item_id]) ph[x.item_id] = x.url;
    setPhotos(ph);
    const cc: Record<string, number> = {};
    for (const x of (g.data || []) as { item_id: string }[]) cc[x.item_id] = (cc[x.item_id] || 0) + 1;
    setChoiceCount(cc);
  }, [tenant.id]);
  useEffect(() => { load(); }, [load]);

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return items.filter(i => (showArchived ? !i.is_active : i.is_active))
      .filter(i => cat === 'all' || (cat === 'none' ? !i.category_id : i.category_id === cat))
      .filter(i => !s || [i.code, i.name_ar, i.name_en, ...(i.aliases || [])].some(v => (v || '').toLowerCase().includes(s)));
  }, [items, cat, q, showArchived]);

  const saveCategory = () => run(async () => {
    if (!catEdit?.name_ar?.trim()) throw new Error(t('The category needs an Arabic name'));
    const row = { tenant_id: tenant.id, name_ar: catEdit.name_ar.trim(), name_en: catEdit.name_en || null, description_ar: catEdit.description_ar || null,
                  available_from: catEdit.available_from || null, available_to: catEdit.available_to || null,
                  is_active: catEdit.is_active !== false, sort: catEdit.sort ?? ((cats?.length || 0) + 1) * 10 };
    const { error } = catEdit.id ? await sb().from('menu_categories').update(row).eq('id', catEdit.id)
                                 : await sb().from('menu_categories').insert(row);
    if (error) throw new Error(error.message);
    setCatEdit(null); await load();
  }, 'Category saved');

  const branchOut = (itemId: string) => overrides.filter(o => o.item_id === itemId && (!o.is_available || (o.sold_out_until && new Date(o.sold_out_until) > new Date())));
  if (!cats) return <Spinner />;

  return (
    <div>
      <PageHeader title={t('Menu')} subtitle={t('Everything the agent offers. Any change here — a price, a dish out of stock — reaches the agent on the very next message.')}
        actions={can.edit && <>
          <Link href={`${base}/menu/pages`}><Button variant="outline"><FileImage className="size-4" /> {t('Menu pictures / PDF')}</Button></Link>
          <Link href={`${base}/menu/import`}><Button variant="outline"><Sparkles className="size-4" /> {t('Import a menu with AI')}</Button></Link>
          <Button variant="gold" onClick={() => setEditing('new')}><Plus className="size-4" /> {t('Add a dish')}</Button>
        </>} />

      {items.length === 0 ? (
        <Empty title={t('No dishes yet')} action={can.edit && <Link href={`${base}/menu/import`}><Button variant="gold"><Sparkles className="size-4" /> {t('Import your menu from a PDF, photos or a link')}</Button></Link>}>
          {t('Upload the menu you already have — the AI reads it into dishes, prices and choices, and you review everything before it goes live.')}
        </Empty>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[220px_1fr]">
          <aside className="space-y-1">
            {[{ id: 'all', name_ar: t('All dishes') } as Category, ...cats, ...(items.some(i => !i.category_id) ? [{ id: 'none', name_ar: t('No category') } as Category] : [])].map(c => {
              const n = items.filter(i => i.is_active && (c.id === 'all' || (c.id === 'none' ? !i.category_id : i.category_id === c.id))).length;
              return (
                <div key={c.id} className={cx('group flex items-center rounded-lg', cat === c.id ? 'bg-navy text-white' : 'hover:bg-paper-sunk')}>
                  <button onClick={() => setCat(c.id)} className="flex flex-1 items-center justify-between px-3 py-2 text-start text-sm">
                    <span dir="auto" className={cx(c.is_active === false && 'line-through opacity-60')}>{c.name_ar}</span>
                    <span className="text-xs opacity-70">{n}</span>
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
              <Checkbox checked={showArchived} onChange={setShowArchived} label={t('Show archived')} />
            </div>
            <div className="overflow-hidden rounded-xl border border-hairline bg-white">
              <table className="w-full text-sm">
                <thead className="bg-paper text-start text-xs text-muted">
                  <tr><th className="w-14 px-3 py-2" /><th className="px-3 py-2">{t('Dish')}</th><th className="px-3 py-2">{t('Price')}</th><th className="px-3 py-2">{t('Stock')}</th><th className="w-12" /></tr>
                </thead>
                <tbody className="divide-y divide-hairline">
                  {shown.map(i => {
                    const outAt = branchOut(i.id);
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
                            {outAt.map(o => <Badge key={o.branch_id} tone="caution">{t('out at {branch}', { branch: branches.find(b => b.id === o.branch_id)?.name_en || t('a branch') })}</Badge>)}
                          </div>
                        </td>
                        <td className="whitespace-nowrap px-3 py-2">{i.price == null ? <span className="text-muted">{t('branch confirms')}</span> : money(i.price, tenant.currency_symbol)}{i.unit === 'kg' ? ' / ' + t('kg') : ''}</td>
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
        defaultCategory={cat !== 'all' && cat !== 'none' ? cat : undefined} />

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
            <Field label={t('Order on the menu')}><Input type="number" value={catEdit.sort ?? ''} onChange={e => setCatEdit({ ...catEdit, sort: Number(e.target.value) })} /></Field>
            <Checkbox checked={catEdit.is_active === false} onChange={v => setCatEdit({ ...catEdit, is_active: !v })} label={t('Hidden (the agent ignores the whole category)')} />
          </div>
        )}
      </Modal>
    </div>
  );
}

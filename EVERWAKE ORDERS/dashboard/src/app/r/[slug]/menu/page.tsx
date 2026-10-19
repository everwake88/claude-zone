'use client';
import { Camera, FileImage, Pencil, Plus, Search, Sparkles, Star } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ItemEditor } from '@/components/menu/ItemEditor';
import { StockButton } from '@/components/menu/StockButton';
import { Badge, Button, Checkbox, Empty, Field, Input, Modal, PageHeader, Spinner, Textarea, useAction } from '@/components/ui';
import { useTenant } from '@/components/tenant';
import { cx, money } from '@/lib/format';
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
    if (!catEdit?.name_ar?.trim()) throw new Error('The category needs an Arabic name');
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
      <PageHeader title="Menu" subtitle="Everything the agent offers. Any change here — a price, a dish out of stock — reaches the agent on the very next message."
        actions={can.edit && <>
          <Link href={`${base}/menu/pages`}><Button variant="outline"><FileImage className="size-4" /> Menu pictures / PDF</Button></Link>
          <Link href={`${base}/menu/import`}><Button variant="outline"><Sparkles className="size-4" /> Import a menu with AI</Button></Link>
          <Button variant="gold" onClick={() => setEditing('new')}><Plus className="size-4" /> Add a dish</Button>
        </>} />

      {items.length === 0 ? (
        <Empty title="No dishes yet" action={can.edit && <Link href={`${base}/menu/import`}><Button variant="gold"><Sparkles className="size-4" /> Import your menu from a PDF, photos or a link</Button></Link>}>
          Upload the menu you already have — the AI reads it into dishes, prices and choices, and you review everything before it goes live.
        </Empty>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[220px_1fr]">
          <aside className="space-y-1">
            {[{ id: 'all', name_ar: 'All dishes' } as Category, ...cats, ...(items.some(i => !i.category_id) ? [{ id: 'none', name_ar: 'No category' } as Category] : [])].map(c => {
              const n = items.filter(i => i.is_active && (c.id === 'all' || (c.id === 'none' ? !i.category_id : i.category_id === c.id))).length;
              return (
                <div key={c.id} className={cx('group flex items-center rounded-lg', cat === c.id ? 'bg-navy text-white' : 'hover:bg-paper-sunk')}>
                  <button onClick={() => setCat(c.id)} className="flex flex-1 items-center justify-between px-3 py-2 text-left text-sm">
                    <span dir="auto" className={cx(c.is_active === false && 'line-through opacity-60')}>{c.name_ar}</span>
                    <span className="text-xs opacity-70">{n}</span>
                  </button>
                  {can.edit && c.id !== 'all' && c.id !== 'none' && (
                    <button onClick={() => setCatEdit(c)} className="px-2 opacity-0 group-hover:opacity-100" aria-label="Edit category"><Pencil className="size-3.5" /></button>
                  )}
                </div>
              );
            })}
            {can.edit && <Button size="sm" variant="ghost" className="w-full justify-start" onClick={() => setCatEdit({})}><Plus className="size-4" /> Category</Button>}
          </aside>

          <section>
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <div className="relative max-w-xs flex-1">
                <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
                <Input className="pl-9" placeholder="Search dishes" value={q} onChange={e => setQ(e.target.value)} />
              </div>
              <Checkbox checked={showArchived} onChange={setShowArchived} label="Show archived" />
            </div>
            <div className="overflow-hidden rounded-xl border border-hairline bg-white">
              <table className="w-full text-sm">
                <thead className="bg-paper text-left text-xs text-muted">
                  <tr><th className="w-14 px-3 py-2" /><th className="px-3 py-2">Dish</th><th className="px-3 py-2">Price</th><th className="px-3 py-2">Stock</th><th className="w-12" /></tr>
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
                          <p className="text-xs text-muted"><span className="font-mono">{i.code}</span>{i.name_en ? ` · ${i.name_en}` : ''}
                            {choiceCount[i.id] ? ` · ${choiceCount[i.id]} choice${choiceCount[i.id] > 1 ? 's' : ''}` : ''}</p>
                          <div className="mt-0.5 flex flex-wrap gap-1">
                            {!i.orderable && <Badge>dine-in only</Badge>}
                            {outAt.map(o => <Badge key={o.branch_id} tone="caution">out at {branches.find(b => b.id === o.branch_id)?.name_en || 'a branch'}</Badge>)}
                          </div>
                        </td>
                        <td className="whitespace-nowrap px-3 py-2">{i.price == null ? <span className="text-muted">branch confirms</span> : money(i.price, tenant.currency_symbol)}{i.unit === 'kg' ? ' / kg' : ''}</td>
                        <td className="px-3 py-2"><StockButton itemId={i.id} available={i.is_available} soldOutUntil={i.sold_out_until} onDone={load} /></td>
                        <td className="px-3 py-2">{can.edit && <Button size="sm" variant="ghost" onClick={() => setEditing(i)} aria-label="Edit"><Pencil className="size-4" /></Button>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {shown.length === 0 && <p className="p-6 text-center text-sm text-muted">No dishes here.</p>}
            </div>
          </section>
        </div>
      )}

      <ItemEditor item={editing} categories={cats} branches={branches} onClose={() => setEditing(null)} onSaved={load}
        defaultCategory={cat !== 'all' && cat !== 'none' ? cat : undefined} />

      <Modal open={!!catEdit} onClose={() => setCatEdit(null)} title={catEdit?.id ? 'Edit category' : 'New category'}
        footer={<><Button variant="outline" onClick={() => setCatEdit(null)}>Cancel</Button><Button variant="gold" busy={busy} onClick={saveCategory}>Save</Button></>}>
        {catEdit && (
          <div className="space-y-3">
            <Field label="Name (Arabic)"><Input dir="rtl" value={catEdit.name_ar || ''} onChange={e => setCatEdit({ ...catEdit, name_ar: e.target.value })} /></Field>
            <Field label="Name (English)"><Input value={catEdit.name_en || ''} onChange={e => setCatEdit({ ...catEdit, name_en: e.target.value })} /></Field>
            <Field label="Description"><Textarea dir="rtl" value={catEdit.description_ar || ''} onChange={e => setCatEdit({ ...catEdit, description_ar: e.target.value })} /></Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Served from" hint="e.g. breakfast only"><Input type="time" value={catEdit.available_from || ''} onChange={e => setCatEdit({ ...catEdit, available_from: e.target.value })} /></Field>
              <Field label="Until"><Input type="time" value={catEdit.available_to || ''} onChange={e => setCatEdit({ ...catEdit, available_to: e.target.value })} /></Field>
            </div>
            <Field label="Order on the menu"><Input type="number" value={catEdit.sort ?? ''} onChange={e => setCatEdit({ ...catEdit, sort: Number(e.target.value) })} /></Field>
            <Checkbox checked={catEdit.is_active === false} onChange={v => setCatEdit({ ...catEdit, is_active: !v })} label="Hidden (the agent ignores the whole category)" />
          </div>
        )}
      </Modal>
    </div>
  );
}

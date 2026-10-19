'use client';
import { ArrowDown, ArrowUp, Plus, Star, Trash2, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { money } from '@/lib/format';
import { sb } from '@/lib/supabase/client';
import type { Branch, Category, Item, ItemBranch, ItemMedia, OptionGroup } from '@/lib/types';
import { Badge, Button, Checkbox, Drawer, Field, Input, Select, Switch, Tabs, Textarea, useAction } from '../ui';
import { useTenant } from '../tenant';
import { StockButton } from './StockButton';

const csv = (a?: string[] | null) => (a || []).join('، ');
const list = (s: string) => s.split(/[,،]/).map(x => x.trim()).filter(Boolean);
type Tab = 'details' | 'choices' | 'branches' | 'photos';

interface GroupDraft { label_ar: string; label_en: string; required: boolean; min: string; max: string;
  options: { name_ar: string; name_en: string; aliases: string; price_delta: string; extra_charge: boolean; is_available: boolean }[] }

export function ItemEditor({ item, categories, branches, onClose, onSaved, defaultCategory }:
  { item: Item | null | 'new'; categories: Category[]; branches: Branch[]; onClose: () => void; onSaved: () => void; defaultCategory?: string }) {
  const { tenant } = useTenant();
  const [tab, setTab] = useState<Tab>('details');
  const [it, setIt] = useState<Partial<Item>>({});
  const [aliases, setAliases] = useState('');
  const [tags, setTags] = useState('');
  const [groups, setGroups] = useState<GroupDraft[]>([]);
  const [overrides, setOverrides] = useState<Record<string, ItemBranch>>({});
  const [media, setMedia] = useState<ItemMedia[]>([]);
  const file = useRef<HTMLInputElement>(null);
  const { busy, run } = useAction();
  const isNew = item === 'new';
  const id = item && item !== 'new' ? item.id : (it.id as string | undefined);

  useEffect(() => {
    setTab('details');
    if (!item) return;
    if (item === 'new') {
      setIt({ unit: 'portion', orderable: true, is_active: true, is_available: true, category_id: defaultCategory || categories[0]?.id || null });
      setAliases(''); setTags(''); setGroups([]); setOverrides({}); setMedia([]);
      return;
    }
    setIt(item); setAliases(csv(item.aliases)); setTags(csv(item.tags));
    const db = sb();
    db.from('menu_option_groups').select('*, options:menu_options(*)').eq('item_id', item.id).order('level').then(({ data }) => {
      setGroups(((data || []) as OptionGroup[]).map(g => ({
        label_ar: g.label_ar, label_en: g.label_en || '', required: g.required, min: String(g.min_select ?? ''), max: g.max_select == null ? '' : String(g.max_select),
        options: (g.options || []).sort((a, b) => a.sort - b.sort).map(o => ({ name_ar: o.name_ar, name_en: o.name_en || '', aliases: csv(o.aliases),
          price_delta: String(o.price_delta ?? 0), extra_charge: o.extra_charge, is_available: o.is_available }))
      })));
    });
    db.from('menu_item_branches').select('*').eq('item_id', item.id).then(({ data }) =>
      setOverrides(Object.fromEntries(((data || []) as ItemBranch[]).map(o => [o.branch_id, o]))));
    db.from('item_media').select('*').eq('item_id', item.id).order('sort').then(({ data }) => setMedia((data || []) as ItemMedia[]));
  }, [item, categories, defaultCategory]);

  const set = <K extends keyof Item>(k: K, v: Item[K]) => setIt(x => ({ ...x, [k]: v }));

  const saveDetails = () => run(async () => {
    const row = {
      tenant_id: tenant.id, category_id: it.category_id || null, name_ar: (it.name_ar || '').trim(), name_en: (it.name_en || '').trim() || null,
      aliases: list(aliases), description_ar: it.description_ar || null, description_en: it.description_en || null,
      unit: it.unit || 'portion', price: it.price === null || it.price === undefined || String(it.price) === '' ? null : Number(it.price),
      qty_step: it.unit === 'kg' ? Number(it.qty_step || 0.25) : null, min_qty: it.unit === 'kg' ? Number(it.min_qty || 0.25) : null,
      tags: list(tags), is_signature: !!it.is_signature, is_featured: !!it.is_featured, orderable: it.orderable !== false,
      is_active: it.is_active !== false
    };
    if (!row.name_ar) throw new Error('The dish needs an Arabic name');
    if (id) {
      const { error } = await sb().from('menu_items').update(row).eq('id', id);
      if (error) throw new Error(error.message);
    } else {
      const { data, error } = await sb().from('menu_items').insert(row).select('*').single();
      if (error) throw new Error(error.message);
      setIt(data as Item);
      setTab('choices');
    }
    onSaved();
  }, 'Saved — the agent knows on the next message');

  const saveChoices = () => run(async () => {
    if (!id) throw new Error('Save the details first');
    const payload = groups.map(g => ({ label_ar: g.label_ar, label_en: g.label_en, required: g.required, min: g.min, max: g.max,
      options: g.options.map(o => ({ ...o, aliases: list(o.aliases) })) }));
    const { error } = await sb().rpc('save_item_choices', { p_item: id, p_groups: payload });
    if (error) throw new Error(error.message);
    onSaved();
  }, 'Choices saved');

  const saveBranch = (branchId: string, patch: Partial<ItemBranch>) => run(async () => {
    if (!id) throw new Error('Save the details first');
    const cur = overrides[branchId] || { is_listed: true, price: null, is_available: true, sold_out_until: null };
    const row = { tenant_id: tenant.id, item_id: id, branch_id: branchId, is_listed: cur.is_listed, price: cur.price,
                  is_available: cur.is_available, sold_out_until: cur.sold_out_until, ...patch };
    const { data, error } = await sb().from('menu_item_branches').upsert(row, { onConflict: 'item_id,branch_id' }).select('*').single();
    if (error) throw new Error(error.message);
    setOverrides(o => ({ ...o, [branchId]: data as ItemBranch }));
    onSaved();
  });

  const upload = (files: FileList) => run(async () => {
    if (!id) throw new Error('Save the details first');
    for (const f of Array.from(files)) {
      const path = `${tenant.id}/items/${id}/${crypto.randomUUID()}.${f.name.split('.').pop() || 'jpg'}`;
      const up = await sb().storage.from('media').upload(path, f, { contentType: f.type });
      if (up.error) throw new Error(up.error.message);
      const url = sb().storage.from('media').getPublicUrl(path).data.publicUrl;
      const { data, error } = await sb().from('item_media').insert({ tenant_id: tenant.id, item_id: id, url, storage_path: path, mime: f.type || 'image/jpeg',
                                                                  is_primary: media.length === 0, sort: media.length * 10 }).select('*').single();
      if (error) throw new Error(error.message);
      setMedia(m => [...m, data as ItemMedia]);
    }
    onSaved();
  }, 'Photo added — the agent can send it now');

  const removePhoto = (m: ItemMedia) => run(async () => {
    if (m.storage_path) await sb().storage.from('media').remove([m.storage_path]);
    const { error } = await sb().from('item_media').delete().eq('id', m.id);
    if (error) throw new Error(error.message);
    setMedia(x => x.filter(y => y.id !== m.id));
    onSaved();
  });
  const makePrimary = (m: ItemMedia) => run(async () => {
    await sb().from('item_media').update({ is_primary: false }).eq('item_id', m.item_id);
    await sb().from('item_media').update({ is_primary: true }).eq('id', m.id);
    setMedia(x => x.map(y => ({ ...y, is_primary: y.id === m.id })));
  });

  const moveGroup = (i: number, d: -1 | 1) => setGroups(g => { const n = [...g]; const j = i + d; if (j < 0 || j >= n.length) return n; [n[i], n[j]] = [n[j], n[i]]; return n; });
  const sym = tenant.currency_symbol;

  return (
    <Drawer open={!!item} onClose={onClose} wide
      title={isNew && !id ? 'New dish' : <span dir="auto">{it.code ? <span className="mr-2 font-mono text-sm text-muted">{it.code}</span> : null}{it.name_ar}</span>}
      footer={tab === 'details' ? <Button variant="gold" busy={busy} onClick={saveDetails}>{id ? 'Save' : 'Create the dish'}</Button>
        : tab === 'choices' ? <Button variant="gold" busy={busy} onClick={saveChoices}>Save choices</Button> : undefined}>
      <div className="mb-4">
        <Tabs value={tab} onChange={(t) => id || t === 'details' ? setTab(t) : undefined} tabs={[
          { value: 'details', label: 'Details' }, { value: 'choices', label: `Choices${groups.length ? ` (${groups.length})` : ''}` },
          { value: 'branches', label: 'Branches' }, { value: 'photos', label: `Photos${media.length ? ` (${media.length})` : ''}` }]} />
      </div>

      {tab === 'details' && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name (Arabic)"><Input dir="rtl" value={it.name_ar || ''} onChange={e => set('name_ar', e.target.value)} /></Field>
          <Field label="Name (English)"><Input dir="ltr" value={it.name_en || ''} onChange={e => set('name_en', e.target.value)} /></Field>
          <Field label="Other names customers use" hint="Comma separated — e.g. كفته، kofta. The agent matches these." className="sm:col-span-2">
            <Input value={aliases} onChange={e => setAliases(e.target.value)} />
          </Field>
          <Field label="Description (Arabic)" className="sm:col-span-2"><Textarea dir="rtl" value={it.description_ar || ''} onChange={e => set('description_ar', e.target.value)} /></Field>
          <Field label="Category">
            <Select value={it.category_id || ''} onChange={e => set('category_id', e.target.value || null)}>
              <option value="">—</option>
              {categories.map(c => <option key={c.id} value={c.id}>{c.name_ar}{c.name_en ? ` · ${c.name_en}` : ''}</option>)}
            </Select>
          </Field>
          <Field label="Sold by">
            <Select value={it.unit || 'portion'} onChange={e => set('unit', e.target.value as Item['unit'])}>
              <option value="portion">Portion</option><option value="piece">Piece</option><option value="kg">Kilo (weight)</option><option value="person">Per person</option>
            </Select>
          </Field>
          <Field label={`Price (${tenant.currency})${it.unit === 'kg' ? ' per kilo' : ''}`} hint="Empty = the branch confirms the price.">
            <Input type="number" min="0" step="0.5" value={it.price ?? ''} onChange={e => set('price', e.target.value === '' ? null : Number(e.target.value))} />
          </Field>
          {it.unit === 'kg' && (
            <div className="grid grid-cols-2 gap-2">
              <Field label="Step (kg)"><Input type="number" step="0.05" value={it.qty_step ?? 0.25} onChange={e => set('qty_step', Number(e.target.value))} /></Field>
              <Field label="Minimum (kg)"><Input type="number" step="0.05" value={it.min_qty ?? 0.25} onChange={e => set('min_qty', Number(e.target.value))} /></Field>
            </div>
          )}
          <Field label="Tags" hint="Comma separated — help the agent suggest alternatives (chicken, spicy, vegetarian…)." className="sm:col-span-2">
            <Input value={tags} onChange={e => setTags(e.target.value)} />
          </Field>
          <div className="space-y-3 sm:col-span-2">
            <Checkbox checked={!!it.is_signature} onChange={v => set('is_signature', v)} label={<>Signature dish ★ <span className="text-muted">— the agent recommends it to people who can&apos;t decide</span></>} />
            <Checkbox checked={!!it.is_featured} onChange={v => set('is_featured', v)} label="Featured" />
            <Checkbox checked={it.orderable === false} onChange={v => set('orderable', !v)} label={<>Dine-in only <span className="text-muted">— shown, never delivered or picked up (shisha, drinks…)</span></>} />
            <Checkbox checked={it.is_active === false} onChange={v => set('is_active', !v)} label={<>Archived <span className="text-muted">— hidden from the agent completely</span></>} />
          </div>
        </div>
      )}

      {tab === 'choices' && (
        <div className="space-y-4">
          <p className="text-sm text-muted">Choices are asked one level at a time, in this order. A required choice must be answered before the dish goes in the cart.</p>
          {groups.map((g, gi) => (
            <div key={gi} className="rounded-xl border border-hairline p-3">
              <div className="flex flex-wrap items-end gap-2">
                <span className="mb-2 flex size-6 items-center justify-center rounded-full bg-navy text-xs font-semibold text-white">{gi + 1}</span>
                <Field label="Question (Arabic)" className="min-w-40 flex-1"><Input dir="rtl" value={g.label_ar} placeholder="الحجم"
                  onChange={e => setGroups(x => x.map((y, i) => i === gi ? { ...y, label_ar: e.target.value } : y))} /></Field>
                <Field label="English" className="w-32"><Input value={g.label_en} placeholder="Size"
                  onChange={e => setGroups(x => x.map((y, i) => i === gi ? { ...y, label_en: e.target.value } : y))} /></Field>
                <Field label="Pick at least" className="w-24"><Input type="number" min="0" value={g.min}
                  onChange={e => setGroups(x => x.map((y, i) => i === gi ? { ...y, min: e.target.value } : y))} /></Field>
                <Field label="At most" className="w-24"><Input type="number" min="1" value={g.max} placeholder="any"
                  onChange={e => setGroups(x => x.map((y, i) => i === gi ? { ...y, max: e.target.value } : y))} /></Field>
                <div className="mb-2 flex items-center gap-1">
                  <Checkbox checked={g.required} onChange={v => setGroups(x => x.map((y, i) => i === gi ? { ...y, required: v, min: v && !y.min ? '1' : y.min } : y))} label="Required" />
                  <Button size="sm" variant="ghost" onClick={() => moveGroup(gi, -1)} aria-label="Up"><ArrowUp className="size-4" /></Button>
                  <Button size="sm" variant="ghost" onClick={() => moveGroup(gi, 1)} aria-label="Down"><ArrowDown className="size-4" /></Button>
                  <Button size="sm" variant="ghost" className="text-critical" onClick={() => setGroups(x => x.filter((_, i) => i !== gi))} aria-label="Delete"><Trash2 className="size-4" /></Button>
                </div>
              </div>
              <table className="mt-3 w-full text-sm">
                <thead><tr className="text-left text-xs text-muted"><th className="pb-1">Option (Arabic)</th><th>English</th><th>Other names</th><th className="w-24">+ Price</th><th className="w-20">Extra fee*</th><th className="w-16">On</th><th className="w-8" /></tr></thead>
                <tbody>
                  {g.options.map((o, oi) => {
                    const upd = (p: Partial<typeof o>) => setGroups(x => x.map((y, i) => i === gi ? { ...y, options: y.options.map((z, j) => j === oi ? { ...z, ...p } : z) } : y));
                    return (
                      <tr key={oi}>
                        <td className="pr-1 py-0.5"><Input dir="rtl" value={o.name_ar} onChange={e => upd({ name_ar: e.target.value })} /></td>
                        <td className="pr-1"><Input value={o.name_en} onChange={e => upd({ name_en: e.target.value })} /></td>
                        <td className="pr-1"><Input value={o.aliases} onChange={e => upd({ aliases: e.target.value })} /></td>
                        <td className="pr-1"><Input type="number" step="0.5" value={o.price_delta} onChange={e => upd({ price_delta: e.target.value })} /></td>
                        <td className="text-center"><input type="checkbox" checked={o.extra_charge} onChange={e => upd({ extra_charge: e.target.checked })} /></td>
                        <td><Switch checked={o.is_available} onChange={v => upd({ is_available: v })} label="Available" /></td>
                        <td><button className="text-critical" onClick={() => setGroups(x => x.map((y, i) => i === gi ? { ...y, options: y.options.filter((_, j) => j !== oi) } : y))}><Trash2 className="size-4" /></button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <Button size="sm" variant="ghost" className="mt-2" onClick={() => setGroups(x => x.map((y, i) => i === gi ? { ...y, options: [...y.options, { name_ar: '', name_en: '', aliases: '', price_delta: '0', extra_charge: false, is_available: true }] } : y))}>
                <Plus className="size-4" /> Add an option
              </Button>
            </div>
          ))}
          <Button variant="outline" onClick={() => setGroups(g => [...g, { label_ar: '', label_en: '', required: true, min: '1', max: '1', options: [{ name_ar: '', name_en: '', aliases: '', price_delta: '0', extra_charge: false, is_available: true }] }])}>
            <Plus className="size-4" /> Add a choice
          </Button>
          <p className="text-xs text-muted">* Extra fee: the branch adds a charge it has not published (e.g. a special preparation). The agent tells the customer it will be added.</p>
        </div>
      )}

      {tab === 'branches' && (
        <div className="space-y-2">
          <p className="mb-2 text-sm text-muted">Every dish is on every branch at its own price unless you change it here.</p>
          {branches.map(b => {
            const o = overrides[b.id];
            const listed = o ? o.is_listed : true;
            return (
              <div key={b.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-hairline p-3">
                <span className="min-w-32 flex-1 font-medium">{b.name_en || b.name_ar}</span>
                <label className="flex items-center gap-2 text-sm">On this branch&apos;s menu <Switch checked={listed} onChange={v => saveBranch(b.id, { is_listed: v })} /></label>
                <label className="flex items-center gap-2 text-sm">Price
                  <Input className="w-28" type="number" step="0.5" placeholder={it.price != null ? String(it.price) : '—'} defaultValue={o?.price ?? ''}
                    onBlur={e => { const v = e.target.value === '' ? null : Number(e.target.value); if (v !== (o?.price ?? null)) saveBranch(b.id, { price: v }); }} />
                </label>
                {id && listed && <StockButton itemId={id} branchId={b.id} available={o ? o.is_available : true} soldOutUntil={o?.sold_out_until || null}
                  onDone={() => sb().from('menu_item_branches').select('*').eq('item_id', id).then(({ data }) =>
                    setOverrides(Object.fromEntries(((data || []) as ItemBranch[]).map(x => [x.branch_id, x]))))} />}
              </div>
            );
          })}
        </div>
      )}

      {tab === 'photos' && (
        <div>
          <p className="mb-3 text-sm text-muted">When a customer asks what this dish looks like, the agent sends the main photo with its name and price ({money(it.price, sym)}).</p>
          <input ref={file} type="file" accept="image/*" multiple className="hidden" onChange={e => { if (e.target.files?.length) upload(e.target.files); e.target.value = ''; }} />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {media.map(m => (
              <figure key={m.id} className="group relative overflow-hidden rounded-xl border border-hairline">
                <img src={m.url} alt="" className="aspect-[4/3] w-full object-cover" />
                <figcaption className="flex items-center justify-between p-2">
                  {m.is_primary ? <Badge tone="gold"><Star className="size-3" /> Main</Badge> : <Button size="sm" variant="ghost" onClick={() => makePrimary(m)}>Make main</Button>}
                  <button className="text-critical" onClick={() => removePhoto(m)} aria-label="Delete"><Trash2 className="size-4" /></button>
                </figcaption>
              </figure>
            ))}
            <button onClick={() => file.current?.click()} className="flex aspect-[4/3] flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-hairline text-sm text-muted hover:border-gold">
              <Upload className="size-5" /> Add photos
            </button>
          </div>
        </div>
      )}
    </Drawer>
  );
}

'use client';
import { ArrowLeft, Download, FileText, Link2, Loader2, Plus, Sheet, Sparkles, Trash2, Upload } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Badge, Button, Card, Checkbox, Field, Input, PageHeader, Select, Tabs, Textarea, useAction, useToast } from '@/components/ui';
import { useTenant } from '@/components/tenant';
import { CSV_TEMPLATE, csvToMenu } from '@/lib/csv-menu';
import { dateTime } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { sb } from '@/lib/supabase/client';
import type { ExtractedItem, ExtractedMenu, MenuImport } from '@/lib/types';

type Source = 'files' | 'url' | 'text' | 'csv';

export default function ImportMenu() {
  const { tenant, base, can } = useTenant();
  const toast = useToast();
  const [source, setSource] = useState<Source>('files');
  const [files, setFiles] = useState<File[]>([]);
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const [reading, setReading] = useState(false);
  const [importId, setImportId] = useState<string | null>(null);
  const [menu, setMenu] = useState<ExtractedMenu | null>(null);
  const [mode, setMode] = useState<'merge' | 'replace'>('merge');
  const [history, setHistory] = useState<MenuImport[]>([]);
  const pick = useRef<HTMLInputElement>(null);
  const { busy, run } = useAction();
  const t = useT();

  const loadHistory = () => sb().from('menu_imports').select('*').eq('tenant_id', tenant.id).order('created_at', { ascending: false }).limit(10)
    .then(({ data }) => setHistory((data || []) as MenuImport[]));
  useEffect(() => { loadHistory(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [tenant.id]);

  const read = async () => {
    setReading(true);
    try {
      if (source === 'csv') {
        const f = files[0];
        if (!f) throw new Error(t('Choose the CSV file'));
        const m = csvToMenu(await f.text());
        const { data, error } = await sb().from('menu_imports').insert({ tenant_id: tenant.id, source_kind: 'csv', status: 'review', extracted: m }).select('id').single();
        if (error) throw new Error(error.message);
        setImportId((data as { id: string }).id); setMenu(m);
        return;
      }
      const id = crypto.randomUUID();
      const uploaded: { path: string; mime: string; name: string }[] = [];
      if (source === 'files') {
        if (!files.length) throw new Error(t('Add the menu PDF or photos first'));
        for (const f of files) {
          const path = `${tenant.id}/${id}/${f.name.replace(/[^\w.\-]+/g, '_')}`;
          const up = await sb().storage.from('imports').upload(path, f, { contentType: f.type || 'application/octet-stream' });
          if (up.error) throw new Error(up.error.message);
          uploaded.push({ path, mime: f.type, name: f.name });
        }
      }
      if (source === 'url' && !/^https?:\/\//.test(url.trim())) throw new Error(t('Paste the full link, starting with https://'));
      if (source === 'text' && text.trim().length < 20) throw new Error(t('Paste the menu text'));
      const kind = source === 'files' ? (files.every(f => f.type.startsWith('image/')) ? 'image' : 'pdf') : source;
      const { error } = await sb().from('menu_imports').insert({
        id, tenant_id: tenant.id, source_kind: kind, files: uploaded, source_url: source === 'url' ? url.trim() : null,
        raw_text: source === 'text' ? text : null });
      if (error) throw new Error(error.message);
      setImportId(id);
      const res = await fetch(`/api/menu-import/${id}/extract`, { method: 'POST' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || t('The AI could not read the menu'));
      setMenu(body.menu as ExtractedMenu);
      toast(t('Found {n} dishes — check them below, then publish', { n: body.count }));
    } catch (e) {
      toast(t(e instanceof Error ? e.message : String(e)), 'critical');
    } finally {
      setReading(false); loadHistory();
    }
  };

  const publish = () => run(async () => {
    if (!menu) return;
    const { data, error } = await sb().rpc('publish_menu', { p_tenant: tenant.id, p_menu: menu, p_mode: mode, p_import: importId });
    if (error) throw new Error(error.message);
    const r = data as { items_created: number; items_updated: number; items_archived: number };
    toast(t('Published: {created} new, {updated} updated, {archived} archived. The agent uses it from the next message.', { created: r.items_created, updated: r.items_updated, archived: r.items_archived || 0 }));
    setMenu(null); setImportId(null); setFiles([]); setUrl(''); setText('');
    loadHistory();
  });

  const updItem = (ci: number, ii: number, patch: Partial<ExtractedItem>) =>
    setMenu(m => m && ({ ...m, categories: m.categories.map((c, i) => i !== ci ? c : { ...c, items: c.items.map((it, j) => j !== ii ? it : { ...it, ...patch }) }) }));
  const total = menu?.categories.reduce((n, c) => n + c.items.length, 0) || 0;

  if (!can.edit) return <p className="text-sm text-muted">{t('Only owners and managers can import a menu.')}</p>;

  return (
    <div className="space-y-5">
      <Link href={`${base}/menu`} className="inline-flex items-center gap-1 text-sm text-muted hover:text-ink"><ArrowLeft className="size-4 rtl:rotate-180" /> {t('Menu')}</Link>
      <PageHeader title={t('Import a menu')} subtitle={t('Give us the menu you already have. The AI reads every dish, price, size and add-on; you check it, then publish.')} />

      {!menu && (
        <Card>
          <Tabs value={source} onChange={(s) => { setSource(s); setFiles([]); }} tabs={[
            { value: 'files', label: <span className="flex items-center gap-1.5"><Upload className="size-4" /> {t('PDF or photos')}</span> },
            { value: 'url', label: <span className="flex items-center gap-1.5"><Link2 className="size-4" /> {t('Website link')}</span> },
            { value: 'text', label: <span className="flex items-center gap-1.5"><FileText className="size-4" /> {t('Paste text')}</span> },
            { value: 'csv', label: <span className="flex items-center gap-1.5"><Sheet className="size-4" /> {t('Spreadsheet')}</span> }]} />
          <div className="mt-5">
            {source === 'files' && (
              <div>
                <input ref={pick} type="file" multiple accept="application/pdf,image/*" className="hidden"
                  onChange={e => setFiles(f => [...f, ...Array.from(e.target.files || [])])} />
                <button onClick={() => pick.current?.click()}
                  className="flex w-full flex-col items-center gap-2 rounded-xl border-2 border-dashed border-hairline p-8 text-sm text-muted hover:border-gold">
                  <Upload className="size-6" /> {t('The menu PDF, or a photo of every page (several at once is fine)')}
                </button>
                {files.length > 0 && <ul className="mt-3 space-y-1 text-sm">{files.map((f, i) => (
                  <li key={i} className="flex items-center justify-between rounded-lg bg-paper px-3 py-1.5">{f.name}
                    <button onClick={() => setFiles(x => x.filter((_, j) => j !== i))} className="text-critical"><Trash2 className="size-4" /></button></li>))}</ul>}
              </div>
            )}
            {source === 'url' && <Field label={t('The page with your menu')} hint={t('Your menu page. The AI reads the page, the menu data ordering sites keep behind it (sizes, add-ons), its menu pictures and a linked menu PDF. If a site shows nothing without a browser, use screenshots instead.')}><Input dir="ltr" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://…" /></Field>}
            {source === 'text' && <Field label={t('The menu as text')}><Textarea rows={12} value={text} onChange={e => setText(e.target.value)} placeholder={t('Paste the menu — any layout works')} /></Field>}
            {source === 'csv' && (
              <div className="space-y-3 text-sm">
                <p className="text-muted">{t('One row per dish. Choices go in one column:')} <code dir="rtl">الحجم*: صغير=0 | كبير=20 ; صوص: حار | عادي</code> (<code>*</code> = {t('required')}, <code>=20</code> = {t('extra price')}).</p>
                <a href={`data:text/csv;charset=utf-8,${encodeURIComponent('﻿' + CSV_TEMPLATE)}`} download="everwake-menu-template.csv"
                  className="inline-flex items-center gap-1.5 text-gold-ink underline"><Download className="size-4" /> {t('Download the template')}</a>
                <input type="file" accept=".csv,text/csv" onChange={e => setFiles(Array.from(e.target.files || []))} className="block text-sm" />
              </div>
            )}
          </div>
          <div className="mt-5 flex items-center gap-3">
            <Button variant="gold" onClick={read} disabled={reading}>
              {reading ? <><Loader2 className="size-4 animate-spin" /> {t('Reading the menu — usually under a minute…')}</> : <><Sparkles className="size-4" /> {source === 'csv' ? t('Load the spreadsheet') : t('Read the menu')}</>}
            </Button>
          </div>
        </Card>
      )}

      {menu && (
        <>
          <Card title={t('Check what the AI found — {cats} categories, {dishes} dishes', { cats: menu.categories.length, dishes: total })}
            action={<Button size="sm" variant="ghost" onClick={() => { setMenu(null); setImportId(null); }}>{t('Start over')}</Button>}>
            {menu.notes && <p className="mb-4 rounded-lg bg-caution-wash px-3 py-2 text-sm text-caution" dir="auto">{t('To check: {notes}', { notes: menu.notes })}</p>}
            <div className="space-y-6">
              {menu.categories.map((c, ci) => (
                <section key={ci}>
                  <div className="mb-2 flex items-center gap-2">
                    <Input dir="rtl" className="max-w-xs font-semibold" value={c.name_ar}
                      onChange={e => setMenu(m => m && ({ ...m, categories: m.categories.map((x, i) => i === ci ? { ...x, name_ar: e.target.value } : x) }))} />
                    <Input className="max-w-xs" value={c.name_en || ''} placeholder={t('English')}
                      onChange={e => setMenu(m => m && ({ ...m, categories: m.categories.map((x, i) => i === ci ? { ...x, name_en: e.target.value } : x) }))} />
                    <Button size="sm" variant="ghost" className="text-critical" onClick={() => setMenu(m => m && ({ ...m, categories: m.categories.filter((_, i) => i !== ci) }))}><Trash2 className="size-4" /></Button>
                  </div>
                  <div className="overflow-x-auto rounded-xl border border-hairline">
                    <table className="w-full min-w-[720px] text-sm">
                      <thead className="bg-paper text-start text-xs text-muted"><tr>
                        <th className="px-2 py-1.5">{t('Arabic name')}</th><th className="px-2">{t('English')}</th><th className="w-24 px-2">{t('Price')}</th><th className="w-28 px-2">{t('Sold by')}</th>
                        <th className="px-2">{t('Choices')}</th><th className="w-10 px-2">★</th><th className="w-8" /></tr></thead>
                      <tbody className="divide-y divide-hairline">
                        {c.items.map((it, ii) => (
                          <tr key={ii} className="align-top">
                            <td className="px-2 py-1.5"><Input dir="rtl" value={it.name_ar} onChange={e => updItem(ci, ii, { name_ar: e.target.value })} />
                              {it.description_ar && <p className="mt-1 text-xs text-muted" dir="rtl">{it.description_ar}</p>}</td>
                            <td className="px-2 py-1.5"><Input value={it.name_en || ''} onChange={e => updItem(ci, ii, { name_en: e.target.value })} /></td>
                            <td className="px-2 py-1.5"><Input type="number" value={it.price ?? ''} className={it.price == null ? 'border-caution' : ''}
                              onChange={e => updItem(ci, ii, { price: e.target.value === '' ? null : Number(e.target.value) })} /></td>
                            <td className="px-2 py-1.5"><Select value={it.unit} onChange={e => updItem(ci, ii, { unit: e.target.value as ExtractedItem['unit'] })}>
                              <option value="portion">{t('Portion')}</option><option value="piece">{t('Piece')}</option><option value="kg">{t('Kilo')}</option><option value="person">{t('Person')}</option></Select></td>
                            <td className="px-2 py-1.5 text-xs" dir="rtl">
                              {it.options.map((g, gi) => (
                                <p key={gi}><strong>{g.label_ar}{g.required ? '*' : ''}:</strong> {g.choices.map(x => x.name_ar + (x.price_delta ? ` +${x.price_delta}` : '')).join(' / ')}</p>
                              ))}
                            </td>
                            <td className="px-2 py-1.5"><input type="checkbox" checked={it.is_signature} onChange={e => updItem(ci, ii, { is_signature: e.target.checked })} /></td>
                            <td className="px-2 py-1.5"><button className="text-critical" onClick={() => setMenu(m => m && ({ ...m, categories: m.categories.map((x, i) => i !== ci ? x : { ...x, items: x.items.filter((_, j) => j !== ii) }) }))}><Trash2 className="size-4" /></button></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <Button size="sm" variant="ghost" className="mt-1" onClick={() => setMenu(m => m && ({ ...m, categories: m.categories.map((x, i) => i !== ci ? x : { ...x, items: [...x.items, { name_ar: '', name_en: null, description_ar: null, price: null, unit: 'portion', is_signature: false, aliases: [], tags: [], options: [] }] }) }))}>
                    <Plus className="size-4" /> {t('Add a dish')}
                  </Button>
                </section>
              ))}
            </div>
            <p className="mt-4 text-xs text-muted">{t('Choices (sizes, add-ons) can be fine-tuned per dish after publishing, in the dish editor.')}</p>
          </Card>

          <Card>
            <div className="flex flex-wrap items-center gap-4">
              <Checkbox checked={mode === 'replace'} onChange={v => setMode(v ? 'replace' : 'merge')}
                label={<>{t('This is the whole menu —')} <span className="text-muted">{t('archive dishes that are not in it')}</span></>} />
              <span className="flex-1" />
              <Button variant="gold" busy={busy} onClick={publish}>{t('Publish {n} dishes', { n: total })}</Button>
            </div>
            <p className="mt-2 text-xs text-muted">{t('Dishes that already exist (same name) are updated, not duplicated. Their photos and stock switches are kept.')}</p>
          </Card>
        </>
      )}

      {history.length > 0 && (
        <Card title={t('Earlier imports')}>
          <ul className="divide-y divide-hairline text-sm">
            {history.map(h => (
              <li key={h.id} className="flex items-center justify-between gap-3 py-2">
                <span>{dateTime(h.created_at, tenant.timezone)} · {t(h.source_kind)}{h.source_url ? ` · ${h.source_url}` : ''}</span>
                <span className="flex items-center gap-2">
                  {h.error && <span className="max-w-xs truncate text-xs text-critical" title={h.error}>{h.error}</span>}
                  <Badge tone={h.status === 'published' ? 'positive' : h.status === 'failed' ? 'critical' : h.status === 'review' ? 'gold' : 'neutral'}>{t(h.status)}</Badge>
                  {h.status === 'review' && h.extracted && <Button size="sm" variant="outline" onClick={() => { setImportId(h.id); setMenu(h.extracted); }}>{t('Review')}</Button>}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

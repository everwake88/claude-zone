'use client';
import { ArrowLeft, Check, ImagePlus, Loader2, Maximize2, Sparkles, X } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge, Button, Card, Checkbox, Empty, PageHeader, Select, useAction } from '@/components/ui';
import { useTenant } from '@/components/tenant';
import { cx } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { sb } from '@/lib/supabase/client';
import type { Item } from '@/lib/types';

// Dish photos in bulk: drop in pictures of the dishes — cards screenshotted
// from an ordering app (photo, name, price) or plain photos. The AI finds
// each one's dish on the menu and where the food photo is inside it; the
// browser crops it. The team checks every match, then saves them all.
type Box = { top: number; left: number; bottom: number; right: number };
interface Row {
  key: string; file: File; source: string; state: 'reading' | 'done' | 'failed';
  item_id: string; seen: string; confidence: number; box: Box | null; whole: boolean;
  crop: Blob | null; preview: string; error?: string;
}

const loadImage = (url: string) => new Promise<HTMLImageElement>((ok, bad) => {
  const img = new Image(); img.onload = () => ok(img); img.onerror = () => bad(new Error('The picture could not be opened')); img.src = url;
});
// a JPEG of (part of) the picture, at most `max` pixels on its long side
async function render(img: HTMLImageElement, box: Box, max: number, quality = 0.9) {
  const sx = img.naturalWidth * box.left, sy = img.naturalHeight * box.top;
  const sw = img.naturalWidth * (box.right - box.left), sh = img.naturalHeight * (box.bottom - box.top);
  const scale = Math.min(1, max / Math.max(sw, sh));
  const c = document.createElement('canvas');
  c.width = Math.round(sw * scale); c.height = Math.round(sh * scale);
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  g.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
  const blob = await new Promise<Blob>((ok) => c.toBlob(b => ok(b!), 'image/jpeg', quality));
  return { blob, dataUrl: c.toDataURL('image/jpeg', quality) };
}
const WHOLE: Box = { top: 0, left: 0, bottom: 1, right: 1 };

export default function DishPhotos() {
  const { tenant, base, can } = useTenant();
  const [items, setItems] = useState<Item[]>([]);
  const [hasPhoto, setHasPhoto] = useState<Set<string>>(new Set());
  const [rows, setRows] = useState<Row[]>([]);
  const [replace, setReplace] = useState(true);
  const pick = useRef<HTMLInputElement>(null);
  const { busy, run } = useAction();
  const t = useT();

  const load = useCallback(async () => {
    const [i, m] = await Promise.all([
      sb().from('menu_items').select('*').eq('tenant_id', tenant.id).eq('is_active', true).order('name_ar'),
      sb().from('item_media').select('item_id').eq('tenant_id', tenant.id)
    ]);
    setItems((i.data || []) as Item[]);
    setHasPhoto(new Set(((m.data || []) as { item_id: string }[]).map(x => x.item_id)));
  }, [tenant.id]);
  useEffect(() => { load(); }, [load]);

  const patch = (key: string, p: Partial<Row>) => setRows(rs => rs.map(r => (r.key === key ? { ...r, ...p } : r)));

  const read = async (row: Row) => {
    try {
      const img = await loadImage(row.source);
      const small = await render(img, WHOLE, 1400, 0.85);
      const res = await fetch('/api/menu-photos', { method: 'POST', headers: { 'content-type': 'application/json' },
                                                     body: JSON.stringify({ tenant_id: tenant.id, image: small.dataUrl }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || t('The AI could not read this picture'));
      const crop = await render(img, j.box, 1200);
      patch(row.key, { state: 'done', item_id: j.item_id || '', seen: j.seen_name || '', confidence: j.confidence || 0,
                       box: j.box, crop: crop.blob, preview: crop.dataUrl });
    } catch (e) {
      patch(row.key, { state: 'failed', error: e instanceof Error ? e.message : String(e) });
    }
  };

  const add = async (files: FileList) => {
    const fresh: Row[] = Array.from(files).filter(f => f.type.startsWith('image/')).map(f => {
      const source = URL.createObjectURL(f);
      return { key: crypto.randomUUID(), file: f, source, state: 'reading', item_id: '', seen: '', confidence: 0,
               box: null, whole: false, crop: null, preview: source };
    });
    setRows(rs => [...rs, ...fresh]);
    // three at a time
    const queue = [...fresh];
    await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => { while (queue.length) await read(queue.shift()!); }));
  };

  const toggleWhole = async (r: Row) => {
    const img = await loadImage(r.source);
    const whole = !r.whole;
    const out = await render(img, whole || !r.box ? WHOLE : r.box, 1200);
    patch(r.key, { whole, crop: out.blob, preview: out.dataUrl });
  };

  const ready = rows.filter(r => r.state === 'done' && r.item_id && r.crop);
  const save = () => run(async () => {
    for (const r of ready) {
      const path = `${tenant.id}/items/${r.item_id}/${crypto.randomUUID()}.jpg`;
      const up = await sb().storage.from('media').upload(path, r.crop!, { contentType: 'image/jpeg' });
      if (up.error) throw new Error(up.error.message);
      const url = sb().storage.from('media').getPublicUrl(path).data.publicUrl;
      if (replace) await sb().from('item_media').update({ is_primary: false }).eq('item_id', r.item_id);
      const { error } = await sb().from('item_media').insert({ tenant_id: tenant.id, item_id: r.item_id, url, storage_path: path, mime: 'image/jpeg',
                                                              is_primary: replace || !hasPhoto.has(r.item_id), sort: replace ? -1 : 100 });
      if (error) throw new Error(error.message);
    }
    setRows(rs => rs.filter(r => !ready.includes(r)));
    await load();
  }, t('{n} photos saved — the agent can send them now', { n: ready.length }));

  const used = new Map<string, number>();
  for (const r of rows) if (r.item_id) used.set(r.item_id, (used.get(r.item_id) || 0) + 1);
  const label = (i: Item) => `${i.name_ar}${i.name_en ? ' — ' + i.name_en : ''}${hasPhoto.has(i.id) ? ' 📷' : ''}`;

  return (
    <div>
      <Link href={`${base}/menu`} className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
        <ArrowLeft className="size-4 rtl:rotate-180" /> {t('Menu')}
      </Link>
      <PageHeader title={t('Dish photos with AI')}
        subtitle={t('Drop in pictures of your dishes — screenshots of dish cards from an ordering app, or plain photos. The AI finds each dish on your menu and cuts out its photo; you check, then save.')}
        actions={can.edit && <>
          <input ref={pick} type="file" accept="image/*" multiple className="hidden" onChange={e => { if (e.target.files?.length) add(e.target.files); e.target.value = ''; }} />
          <Button variant="outline" onClick={() => pick.current?.click()}><ImagePlus className="size-4" /> {t('Add pictures')}</Button>
          <Button variant="gold" busy={busy} disabled={!ready.length} onClick={save}><Check className="size-4" /> {t('Save {n} photos', { n: ready.length })}</Button>
        </>} />

      {rows.length === 0 ? (
        <Card>
          <button onClick={() => pick.current?.click()} disabled={!can.edit}
            className="flex w-full flex-col items-center gap-2 rounded-xl border-2 border-dashed border-hairline px-6 py-12 text-center hover:border-gold">
            <Sparkles className="size-8 text-gold-ink" />
            <span className="font-medium">{t('Choose all your dish pictures at once')}</span>
            <span className="max-w-lg text-sm text-muted">{t('Each picture should show one dish. A card with the dish name works best — the AI matches the name to your menu.')}</span>
          </button>
        </Card>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-4 text-sm text-muted">
            <span>{t('{done} of {all} read', { done: rows.filter(r => r.state !== 'reading').length, all: rows.length })}</span>
            <Checkbox checked={replace} onChange={setReplace} label={t('Make each new photo the dish’s main photo')} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {rows.map(r => {
              const unsure = r.state === 'done' && r.item_id && r.confidence < 0.7;
              const twice = r.item_id && (used.get(r.item_id) || 0) > 1;
              return (
                <Card key={r.key}>
                  <div className="relative mb-2 aspect-[4/3] overflow-hidden rounded-lg bg-paper">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={r.preview} alt="" className="size-full object-contain" />
                    {r.state === 'reading' && <div className="absolute inset-0 flex items-center justify-center bg-white/60"><Loader2 className="size-6 animate-spin" /></div>}
                    <button onClick={() => setRows(rs => rs.filter(x => x.key !== r.key))} title={t('Remove')}
                      className="absolute end-1.5 top-1.5 rounded-full bg-white/90 p-1 shadow"><X className="size-4" /></button>
                  </div>
                  {r.state === 'failed' ? <p className="text-sm text-critical">{r.error}</p> : (
                    <div className="space-y-2">
                      <Select value={r.item_id} disabled={r.state !== 'done'} onChange={e => patch(r.key, { item_id: e.target.value })}>
                        <option value="">{r.state === 'reading' ? t('Reading…') : t('Not on the menu — pick the dish')}</option>
                        {items.map(i => <option key={i.id} value={i.id}>{label(i)}</option>)}
                      </Select>
                      <div className="flex flex-wrap items-center gap-1.5 text-xs">
                        {r.seen && <span className="text-muted" dir="auto">{t('Written on it: {name}', { name: r.seen })}</span>}
                        {unsure && <Badge tone="caution">{t('Not sure — check it')}</Badge>}
                        {twice && <Badge tone="caution">{t('Two pictures for this dish')}</Badge>}
                        {r.state === 'done' && !r.item_id && <Badge tone="critical">{t('No match')}</Badge>}
                        {r.state === 'done' && r.box && (
                          <button onClick={() => toggleWhole(r)} className={cx('ms-auto inline-flex items-center gap-1 underline', r.whole && 'text-gold-ink')}>
                            <Maximize2 className="size-3" /> {r.whole ? t('Use the cut-out') : t('Use the whole picture')}
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        </>
      )}
      {!items.length && <Empty title={t('No dishes yet')}><p>{t('Add or import the menu first, then its photos.')}</p></Empty>}
    </div>
  );
}

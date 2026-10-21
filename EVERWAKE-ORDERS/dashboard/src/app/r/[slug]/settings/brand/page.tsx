'use client';
import { ImagePlus, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTenantRow } from '@/components/settings/useTenantRow';
import { Button, Card, Spinner, useAction } from '@/components/ui';
import { useTenant } from '@/components/tenant';
import { useT } from '@/lib/i18n';
import { loadImage, logoColors, onColor } from '@/lib/menu-art';
import { sb } from '@/lib/supabase/client';
import type { Brand } from '@/lib/types';

const PRESETS = ['#0B222E', '#C8102E', '#E4572E', '#F2A900', '#2E7D32', '#1565C0', '#6A1B9A', '#3E2723'];

// The restaurant's logo — its picture on the dashboard and on the menu
// pictures — and the colour those pictures are drawn in.
export default function BrandSettings() {
  const { tenant, can, setBrand } = useTenant();
  const { row, save, busy } = useTenantRow();
  const t = useT();
  const pick = useRef<HTMLInputElement>(null);
  const [brand, setLocal] = useState<Brand>({});
  const [found, setFound] = useState<string[]>([]);
  const { busy: uploading, run } = useAction();

  useEffect(() => { if (row) setLocal(row.profile?.brand || {}); }, [row]);
  useEffect(() => {
    if (!brand.logo_url) { setFound([]); return; }
    loadImage(brand.logo_url).then(img => setFound(logoColors(img))).catch(() => setFound([]));
  }, [brand.logo_url]);
  if (!row) return <Spinner />;
  const ro = !can.edit;

  const store = async (b: Brand, done?: string) => { if (await save({ profile: { ...row.profile, brand: b } }, done)) setBrand(b); };

  const upload = (f: File) => run(async () => {
    const path = `${tenant.id}/brand/logo-${crypto.randomUUID()}.${(f.name.split('.').pop() || 'png').toLowerCase()}`;
    const up = await sb().storage.from('media').upload(path, f, { contentType: f.type });
    if (up.error) throw new Error(up.error.message);
    const url = sb().storage.from('media').getPublicUrl(path).data.publicUrl;
    if (brand.logo_path) await sb().storage.from('media').remove([brand.logo_path]);
    // no colour yet: take the logo's own
    const color = brand.color || await loadImage(url).then(img => logoColors(img)[0]).catch(() => undefined);
    const next = { ...brand, logo_url: url, logo_path: path, ...(color ? { color } : {}) };
    setLocal(next);
    await store(next, t('Logo saved'));
  });
  const removeLogo = async () => {
    if (brand.logo_path) await sb().storage.from('media').remove([brand.logo_path]);
    const next = { ...brand, logo_url: undefined, logo_path: undefined };
    setLocal(next);
    await store(next, t('Logo removed'));
  };
  const color = brand.color || '#0B222E';

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card title={t('Logo')}>
        <input ref={pick} type="file" accept="image/png,image/jpeg,image/webp" className="hidden"
          onChange={e => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ''; }} />
        <div className="flex items-center gap-5">
          <div className="flex size-32 shrink-0 items-center justify-center overflow-hidden rounded-full border border-hairline bg-white">
            {brand.logo_url
              ? <img src={brand.logo_url} alt="" className="size-full object-contain p-2" />
              : <span className="text-4xl font-bold text-muted">{(tenant.name_en || tenant.name_ar).slice(0, 1).toUpperCase()}</span>}
          </div>
          <div className="space-y-2">
            <p className="text-sm text-muted">{t('Shown next to your name on the dashboard and on top of your menu pictures. A square PNG with a clear background looks best.')}</p>
            {!ro && <div className="flex gap-2">
              <Button busy={uploading} onClick={() => pick.current?.click()}><ImagePlus className="size-4" /> {brand.logo_url ? t('Change logo') : t('Upload logo')}</Button>
              {brand.logo_url && <Button variant="ghost" className="text-critical" onClick={removeLogo}><Trash2 className="size-4" /> {t('Remove')}</Button>}
            </div>}
          </div>
        </div>
      </Card>

      <Card title={t('Brand colour')}>
        <p className="mb-3 text-sm text-muted">{t('The colour of the menu pictures: the top band, the category labels and the prices.')}</p>
        {found.length > 0 && <>
          <p className="label-caps mb-2">{t('From your logo')}</p>
          <div className="mb-4 flex flex-wrap gap-2">
            {found.map(c => <Swatch key={c} c={c} on={c === color} disabled={ro} pick={() => setLocal({ ...brand, color: c })} />)}
          </div>
        </>}
        <p className="label-caps mb-2">{t('Or pick one')}</p>
        <div className="flex flex-wrap items-center gap-2">
          {PRESETS.map(c => <Swatch key={c} c={c} on={c === color} disabled={ro} pick={() => setLocal({ ...brand, color: c })} />)}
          <label className="ms-2 flex items-center gap-2 text-sm text-muted">
            <input type="color" disabled={ro} value={color} onChange={e => setLocal({ ...brand, color: e.target.value })} className="size-9 cursor-pointer rounded border border-hairline" />
            <span dir="ltr">{color}</span>
          </label>
        </div>
        <div className="mt-4 rounded-xl px-4 py-3 text-lg font-bold" style={{ background: color, color: onColor(color) }}>
          {tenant.name_ar || tenant.name_en}
        </div>
        {!ro && <Button variant="gold" className="mt-4" busy={busy} onClick={() => store(brand)}>{t('Save')}</Button>}
      </Card>
    </div>
  );
}

function Swatch({ c, on, pick, disabled }: { c: string; on: boolean; pick: () => void; disabled?: boolean }) {
  return (
    <button type="button" disabled={disabled} onClick={pick} aria-label={c}
      className={`size-9 rounded-full border-2 ${on ? 'border-ink ring-2 ring-gold' : 'border-white shadow'}`} style={{ background: c }} />
  );
}

'use client';
import { Download, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Button, Card, Checkbox, useAction } from '@/components/ui';
import { useTenant } from '@/components/tenant';
import { cairo } from '@/lib/fonts';
import { useT } from '@/lib/i18n';
import { drawMenu, loadImage, toJpeg, type ArtCategory } from '@/lib/menu-art';
import { sb } from '@/lib/supabase/client';

interface Cat { id: string; name_ar: string; sort: number }
interface Item { id: string; category_id: string | null; name_ar: string; name_en: string | null; description_ar: string | null; price: number | null; sort: number }
interface Group { id: string; item_id: string; level: number; label_ar: string; required: boolean; max_select: number | null }
interface Opt { group_id: string; price_delta: number; is_available: boolean }

type Section = ArtCategory & { id: string };
const num = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

// "Design menu pictures": the live menu as two or three designed pictures
// with the logo, ready to be the pictures the agent sends.
export function MenuArt({ scope, existing, onSaved }: { scope: string; existing: number; onSaved: () => void }) {
  const { tenant, brand, base, can } = useTenant();
  const t = useT();
  const { busy, run } = useAction();
  const [cats, setCats] = useState<Cat[]>([]);
  const [menu, setMenu] = useState<Section[] | null>(null);
  const [footer, setFooter] = useState('');
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const [pics, setPics] = useState<{ blob: Blob; url: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);

  // the menu as customers see it: active dishes, branch prices for one branch
  useEffect(() => {
    (async () => {
      const id = tenant.id;
      const [c, i, g, o, b, p] = await Promise.all([
        sb().from('menu_categories').select('id,name_ar,sort').eq('tenant_id', id).eq('is_active', true).order('sort'),
        sb().from('menu_items').select('id,category_id,name_ar,name_en,description_ar,price,sort').eq('tenant_id', id).eq('is_active', true).order('sort'),
        sb().from('menu_option_groups').select('id,item_id,level,label_ar,required,max_select').eq('tenant_id', id),
        sb().from('menu_options').select('group_id,price_delta,is_available').eq('tenant_id', id),
        scope === 'all' ? Promise.resolve({ data: [] }) : sb().from('menu_item_branches').select('item_id,is_listed,price').eq('branch_id', scope),
        sb().from('tenants').select('profile').eq('id', id).single()
      ]);
      const groups = (g.data || []) as Group[], opts = (o.data || []) as Opt[];
      const branch = new Map(((b.data || []) as { item_id: string; is_listed: boolean; price: number | null }[]).map(r => [r.item_id, r]));
      const hotline = (p.data?.profile as { contacts?: { hotline?: string } } | null)?.contacts?.hotline;
      setFooter(hotline ? `اكتب طلبك هنا في الشات  •  الخط الساخن ${hotline}` : 'اكتب طلبك هنا في الشات');
      // a dish with sizes shows each size's price: 155 / 215 / 240
      const priceOf = (it: Item, base: number | null) => {
        if (base == null) return '';
        const size = groups.filter(x => x.item_id === it.id && x.required && x.max_select === 1).sort((a, b) => a.level - b.level)
          .map(x => [...new Set(opts.filter(y => y.group_id === x.id && y.is_available).map(y => Number(y.price_delta)))].sort((a, b) => a - b))
          .find(d => d.length > 1 && d.length <= 4);
        return size ? size.map(d => num(base + d)).join(' / ') : `${num(base)} ${tenant.currency_symbol}`;
      };
      const items = ((i.data || []) as Item[]).filter(it => branch.get(it.id)?.is_listed !== false);
      const list = (c.data || []) as Cat[];
      setCats(list);
      setMenu(list.map(cat => ({
        id: cat.id, name: cat.name_ar,
        items: items.filter(it => it.category_id === cat.id).map(it => {
          const price = branch.get(it.id)?.price ?? it.price;
          return { name: it.name_ar, sub: it.description_ar || it.name_en, price: priceOf(it, price == null ? null : Number(price)) };
        })
      })));
    })();
  }, [tenant.id, tenant.currency_symbol, scope]);
  const design = () => run(async () => {
    setError(null); setConfirm(false);
    if (!menu) return;
    await Promise.all(['400', '700', '800'].map(w => document.fonts.load(`${w} 30px ${cairo.style.fontFamily}`, 'منيو Menu 123')));
    const logo = brand.logo_url ? await loadImage(brand.logo_url).catch(() => null) : null;
    const chosen = menu.filter(c => !skip.has(c.id) && c.items.length);
    if (!chosen.length) throw new Error(t('Pick at least one category with dishes.'));
    const pages = drawMenu({
      title: tenant.name_ar || tenant.name_en, subtitle: tenant.name_en && tenant.name_en !== tenant.name_ar ? tenant.name_en : null,
      logo, color: brand.color || '#0B222E', categories: chosen, footer, font: cairo.style.fontFamily, maxPages: 3
    });
    pics.forEach(p => URL.revokeObjectURL(p.url));
    if (!pages) { setPics([]); setError(t('The menu does not fit in three pictures. Leave out a category or two (drinks, extras) and try again.')); return; }
    const blobs = await Promise.all(pages.map(toJpeg));
    setPics(blobs.map(blob => ({ blob, url: URL.createObjectURL(blob) })));
  });

  // replaces this branch's (or every branch's) menu pictures with the new ones
  const save = () => run(async () => {
    let q = sb().from('menu_media').select('id,storage_path').eq('tenant_id', tenant.id);
    q = scope === 'all' ? q.is('branch_id', null) : q.eq('branch_id', scope);
    const { data: old } = await q;
    const stamp = Date.now();
    const rows = [];
    for (const [i, p] of pics.entries()) {
      const path = `${tenant.id}/menus/designed-${stamp}-${i + 1}.jpg`;
      const up = await sb().storage.from('media').upload(path, p.blob, { contentType: 'image/jpeg' });
      if (up.error) throw new Error(up.error.message);
      rows.push({ tenant_id: tenant.id, branch_id: scope === 'all' ? null : scope, kind: 'image', url: sb().storage.from('media').getPublicUrl(path).data.publicUrl,
                  storage_path: path, mime: 'image/jpeg', file_name: `menu-${i + 1}.jpg`, position: i + 1 });
    }
    const { error } = await sb().from('menu_media').insert(rows);
    if (error) throw new Error(error.message);
    const gone = (old || []) as { id: string; storage_path: string | null }[];
    if (gone.length) {
      await sb().from('menu_media').delete().in('id', gone.map(r => r.id));
      const paths = gone.map(r => r.storage_path).filter(Boolean) as string[];
      if (paths.length) await sb().storage.from('media').remove(paths);
    }
    setConfirm(false);
    onSaved();
  }, t('Saved — the agent sends these when someone asks for the menu'));

  return (
    <Card className={cairo.className} title={<span className="flex items-center gap-2"><Sparkles className="size-4 text-gold-ink" /> {t('Design menu pictures')}</span>}>
      <p className="mb-3 text-sm text-muted">
        {t('Two or three pictures of your live menu, with your logo and colour — ready to send when a customer asks for the menu.')}{' '}
        {!brand.logo_url && <Link href={`${base}/settings/brand`} className="text-gold-ink underline">{t('Add your logo first')}</Link>}
      </p>
      {cats.length > 0 && (
        <div className="mb-4">
          <p className="label-caps mb-2">{t('Categories to include')}</p>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {cats.map(c => (
              <Checkbox key={c.id} checked={!skip.has(c.id)} label={c.name_ar}
                onChange={v => setSkip(s => { const n = new Set(s); if (v) n.delete(c.id); else n.add(c.id); return n; })} />
            ))}
          </div>
        </div>
      )}
      <Button variant="gold" busy={busy && !pics.length} disabled={!menu} onClick={design}><Sparkles className="size-4" /> {pics.length ? t('Design again') : t('Design the pictures')}</Button>
      {error && <p className="mt-3 text-sm text-critical">{error}</p>}

      {pics.length > 0 && (
        <div className="mt-5 space-y-4">
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
            {pics.map((p, i) => (
              <figure key={p.url} className="overflow-hidden rounded-xl border border-hairline">
                <a href={p.url} target="_blank" rel="noreferrer"><img src={p.url} alt="" className="w-full" /></a>
                <figcaption className="flex items-center justify-between p-2 text-xs text-muted">
                  {t('Picture {n}', { n: i + 1 })}
                  <a href={p.url} download={`menu-${i + 1}.jpg`} className="inline-flex items-center gap-1 hover:text-ink"><Download className="size-3.5" /> {t('Download')}</a>
                </figcaption>
              </figure>
            ))}
          </div>
          {can.edit && (confirm
            ? <div className="flex flex-wrap items-center gap-3 rounded-lg bg-paper p-3 text-sm">
                <span>{t('This replaces the {n} pictures above with these {m}. Go ahead?', { n: existing, m: pics.length })}</span>
                <Button variant="gold" busy={busy} onClick={save}>{t('Replace them')}</Button>
                <Button variant="ghost" onClick={() => setConfirm(false)}>{t('Cancel')}</Button>
              </div>
            : <Button variant="primary" busy={busy} onClick={() => (existing ? setConfirm(true) : save())}>{t('Use these as the menu pictures')}</Button>)}
        </div>
      )}
    </Card>
  );
}

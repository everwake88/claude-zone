'use client';
import { ArrowDown, ArrowLeft, ArrowUp, FileText, Trash2, Upload } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Card, Input, PageHeader, Select, useAction } from '@/components/ui';
import { useTenant } from '@/components/tenant';
import { useT } from '@/lib/i18n';
import { sb } from '@/lib/supabase/client';
import type { Branch, MenuMedia } from '@/lib/types';

// The full menu the agent sends when a customer asks "send me the menu":
// pictures of the pages, or a PDF. One set for every branch, or a set per
// branch when their menus differ.
export default function MenuPages() {
  const { tenant, base, can } = useTenant();
  const [branches, setBranches] = useState<Branch[]>([]);
  const [scope, setScope] = useState<string>('all');
  const [pages, setPages] = useState<MenuMedia[]>([]);
  const pick = useRef<HTMLInputElement>(null);
  const { busy, run } = useAction();
  const t = useT();

  const load = useCallback(async () => {
    let q = sb().from('menu_media').select('*').eq('tenant_id', tenant.id).order('position');
    q = scope === 'all' ? q.is('branch_id', null) : q.eq('branch_id', scope);
    const { data } = await q;
    setPages((data || []) as MenuMedia[]);
  }, [tenant.id, scope]);
  useEffect(() => { sb().from('branches').select('*').eq('tenant_id', tenant.id).order('sort').then(({ data }) => setBranches((data || []) as Branch[])); }, [tenant.id]);
  useEffect(() => { load(); }, [load]);

  const upload = (files: FileList) => run(async () => {
    let pos = pages.length;
    for (const f of Array.from(files)) {
      const pdf = f.type.includes('pdf');
      const path = `${tenant.id}/menus/${crypto.randomUUID()}.${f.name.split('.').pop() || (pdf ? 'pdf' : 'jpg')}`;
      const up = await sb().storage.from('media').upload(path, f, { contentType: f.type });
      if (up.error) throw new Error(up.error.message);
      const url = sb().storage.from('media').getPublicUrl(path).data.publicUrl;
      const { error } = await sb().from('menu_media').insert({ tenant_id: tenant.id, branch_id: scope === 'all' ? null : scope, kind: pdf ? 'pdf' : 'image',
        url, storage_path: path, mime: f.type || (pdf ? 'application/pdf' : 'image/jpeg'), file_name: f.name, position: ++pos });
      if (error) throw new Error(error.message);
    }
    await load();
  }, t('Uploaded — the agent sends these when someone asks for the menu'));

  const move = (i: number, d: -1 | 1) => run(async () => {
    const j = i + d; if (j < 0 || j >= pages.length) return;
    const a = pages[i], b = pages[j];
    await sb().from('menu_media').update({ position: b.position }).eq('id', a.id);
    await sb().from('menu_media').update({ position: a.position }).eq('id', b.id);
    await load();
  });
  const remove = (p: MenuMedia) => run(async () => {
    if (p.storage_path) await sb().storage.from('media').remove([p.storage_path]);
    await sb().from('menu_media').delete().eq('id', p.id);
    await load();
  });
  const caption = (p: MenuMedia, c: string) => sb().from('menu_media').update({ caption: c || null }).eq('id', p.id);

  return (
    <div className="space-y-5">
      <Link href={`${base}/menu`} className="inline-flex items-center gap-1 text-sm text-muted hover:text-ink"><ArrowLeft className="size-4 rtl:rotate-180" /> {t('Menu')}</Link>
      <PageHeader title={t('Menu pictures and PDF')} subtitle={t('What the agent sends when a customer asks to see the menu — at most 6 pages, in this order.')}
        actions={branches.length > 1 && (
          <Select value={scope} onChange={e => setScope(e.target.value)} className="w-56">
            <option value="all">{t('Every branch')}</option>
            {branches.map(b => <option key={b.id} value={b.id}>{t('{branch} only', { branch: b.name_en || b.name_ar })}</option>)}
          </Select>
        )} />
      {scope !== 'all' && <p className="text-sm text-muted">{t('A branch with its own pages sends those; every other branch sends the "every branch" set.')}</p>}
      <Card>
        <input ref={pick} type="file" multiple accept="image/*,application/pdf" className="hidden" onChange={e => { if (e.target.files?.length) upload(e.target.files); e.target.value = ''; }} />
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          {pages.map((p, i) => (
            <figure key={p.id} className="overflow-hidden rounded-xl border border-hairline">
              {p.kind === 'pdf'
                ? <a href={p.url} target="_blank" rel="noreferrer" className="flex aspect-[3/4] flex-col items-center justify-center gap-2 bg-paper text-sm text-muted"><FileText className="size-8" />{p.file_name || 'PDF'}</a>
                : <img src={p.url} alt="" className="aspect-[3/4] w-full object-cover" />}
              <figcaption className="space-y-1 p-2">
                <Input defaultValue={p.caption || ''} placeholder={t('Caption (optional)')} onBlur={e => caption(p, e.target.value)} disabled={!can.edit} />
                {can.edit && <div className="flex justify-between">
                  <span><Button size="sm" variant="ghost" onClick={() => move(i, -1)} aria-label={t('Earlier')}><ArrowUp className="size-4" /></Button>
                    <Button size="sm" variant="ghost" onClick={() => move(i, 1)} aria-label={t('Later')}><ArrowDown className="size-4" /></Button></span>
                  <Button size="sm" variant="ghost" className="text-critical" onClick={() => remove(p)} aria-label={t('Delete')}><Trash2 className="size-4" /></Button>
                </div>}
              </figcaption>
            </figure>
          ))}
          {can.edit && (
            <button onClick={() => pick.current?.click()} disabled={busy}
              className="flex aspect-[3/4] flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-hairline text-sm text-muted hover:border-gold">
              <Upload className="size-6" /> {t('Add pages or a PDF')}
            </button>
          )}
        </div>
      </Card>
    </div>
  );
}

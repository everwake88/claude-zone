import { NextResponse, type NextRequest } from 'next/server';
import { extractMenu, nameMenu, pageParts, siteMenu } from '@/lib/menu-extract';
import { serverClient } from '@/lib/supabase/server';
import type { MenuImport } from '@/lib/types';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

// Reads an uploaded menu with the AI and stores the result for review.
// Everything runs as the signed-in user: row level security and the
// storage policies decide what they may read and write.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = await serverClient();
  const { data: imp, error } = await db.from('menu_imports').select('*').eq('id', id).single();
  if (error || !imp) return NextResponse.json({ error: 'Import not found' }, { status: 404 });
  const row = imp as MenuImport;
  const { data: role } = await db.rpc('member_role', { p_tenant: row.tenant_id });
  if (role !== 'owner' && role !== 'manager') return NextResponse.json({ error: 'Only owners and managers can import a menu' }, { status: 403 });

  await db.from('menu_imports').update({ status: 'extracting', error: null }).eq('id', id);
  try {
    // a link to an ordering site we read exactly: every dish with its levels, no guessing
    if (row.source_kind === 'url' && row.source_url && !(row.files || []).length && !row.raw_text) {
      const site = await siteMenu(row.source_url).catch(() => null);
      if (site) {
        const { menu, usage, model } = await nameMenu(site);
        const count = menu.categories.reduce((n, c) => n + c.items.length, 0);
        await db.from('menu_imports').update({ status: 'review', extracted: menu, usage, model }).eq('id', id);
        return NextResponse.json({ ok: true, menu, count });
      }
    }
    const parts: Record<string, unknown>[] = [{ type: 'input_text', text: 'Here is the menu. Return every dish.' }];
    for (const f of row.files || []) {
      const dl = await db.storage.from('imports').download(f.path);
      if (dl.error || !dl.data) throw new Error(`Could not read ${f.name}: ${dl.error?.message || 'missing'}`);
      const b64 = Buffer.from(await dl.data.arrayBuffer()).toString('base64');
      if ((f.mime || '').includes('pdf')) parts.push({ type: 'input_file', filename: f.name || 'menu.pdf', file_data: `data:application/pdf;base64,${b64}` });
      else parts.push({ type: 'input_image', image_url: `data:${f.mime || 'image/jpeg'};base64,${b64}`, detail: 'high' });
    }
    if (row.source_kind === 'url' && row.source_url) parts.push(...await pageParts(row.source_url));
    if (row.raw_text) parts.push({ type: 'input_text', text: row.raw_text.slice(0, 120000) });
    if (parts.length === 1) throw new Error('Nothing to read — add a file, a link or the menu text.');

    const { menu, usage, model } = await extractMenu(parts);
    const count = menu.categories.reduce((n, c) => n + c.items.length, 0);
    if (!count) throw new Error('No dishes were found. Is this the menu? Try clearer photos or the PDF.');
    await db.from('menu_imports').update({ status: 'review', extracted: menu, usage, model }).eq('id', id);
    return NextResponse.json({ ok: true, menu, count });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await db.from('menu_imports').update({ status: 'failed', error: message }).eq('id', id);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

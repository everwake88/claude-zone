'use client';
import { MessageCircle, Search } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Drawer, Field, Input, PageHeader, Select, Spinner, Textarea, useAction } from '@/components/ui';
import { useTenant } from '@/components/tenant';
import { dateTime, day, displayName, money, phoneLabel, statusLabel, timeAgo } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { sb } from '@/lib/supabase/client';
import type { Address, Customer, Order } from '@/lib/types';

type Sort = 'last_seen_at' | 'orders_count' | 'total_spent' | 'first_seen_at';

export default function CustomersPage() {
  const { tenant, base } = useTenant();
  const [list, setList] = useState<Customer[] | null>(null);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<Sort>('last_seen_at');
  const [open, setOpen] = useState<Customer | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [convId, setConvId] = useState<number | null>(null);
  const [notes, setNotes] = useState('');
  const [tags, setTags] = useState('');
  const { busy, run } = useAction();
  const t = useT();

  const load = useCallback(async () => {
    let query = sb().from('customers').select('*').eq('tenant_id', tenant.id).order(sort, { ascending: false }).limit(300);
    const s = q.trim().replace(/[,()*%\\]/g, ' ').trim();   // keep the search out of the filter syntax
    if (s) query = query.or(`full_name.ilike.%${s}%,display_name.ilike.%${s}%,phone.ilike.%${s.replace(/\D/g, '') || s}%,wa_id.ilike.%${s.replace(/\D/g, '') || s}%`);
    const { data } = await query;
    setList((data || []) as Customer[]);
  }, [tenant.id, q, sort]);
  useEffect(() => { const h = setTimeout(load, 250); return () => clearTimeout(h); }, [load]);

  const show = async (c: Customer) => {
    setOpen(c); setNotes(c.staff_notes || ''); setTags((c.tags || []).join('، '));
    const [o, a, cv] = await Promise.all([
      sb().from('orders').select('*').eq('customer_id', c.id).neq('status', 'draft').order('placed_at', { ascending: false }).limit(20),
      sb().from('customer_addresses').select('*').eq('customer_id', c.id).order('last_used_at', { ascending: false }),
      sb().from('conversations').select('id').eq('tenant_id', tenant.id).eq('wa_id', c.wa_id).maybeSingle()
    ]);
    setOrders((o.data || []) as Order[]); setAddresses((a.data || []) as Address[]); setConvId((cv.data as { id: number } | null)?.id || null);
  };

  const save = () => run(async () => {
    if (!open) return;
    const { error } = await sb().from('customers').update({ staff_notes: notes || null, tags: tags.split(/[,،]/).map(s => s.trim()).filter(Boolean) }).eq('id', open.id);
    if (error) throw new Error(error.message);
    await load();
  }, t('Saved'));
  const forget = (a: Address) => run(async () => {
    const { error } = await sb().from('customer_addresses').delete().eq('id', a.id);
    if (error) throw new Error(error.message);
    setAddresses(x => x.filter(y => y.id !== a.id));
  }, t('Address removed'));

  return (
    <div>
      <PageHeader title={t('Customers')} subtitle={t("Everyone who wrote to you on WhatsApp. The agent remembers each one's last order and addresses — by their number, or by the private id WhatsApp sometimes shows instead.")} />
      <div className="mb-3 flex flex-wrap gap-3">
        <div className="relative max-w-sm flex-1">
          <Search className="absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
          <Input className="ps-9" placeholder={t('Name or number')} value={q} onChange={e => setQ(e.target.value)} />
        </div>
        <Select value={sort} onChange={e => setSort(e.target.value as Sort)} className="w-52">
          <option value="last_seen_at">{t('Most recent')}</option><option value="orders_count">{t('Most orders')}</option>
          <option value="total_spent">{t('Most spent')}</option><option value="first_seen_at">{t('Newest customers')}</option>
        </Select>
      </div>
      {!list ? <Spinner /> : (
        <div className="overflow-x-auto rounded-xl border border-hairline bg-white">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="bg-paper text-start text-xs text-muted"><tr>
              <th className="px-3 py-2">{t('Customer')}</th><th className="px-3 py-2">{t('Orders')}</th><th className="px-3 py-2">{t('Spent')}</th><th className="px-3 py-2">{t('Last order')}</th><th className="px-3 py-2">{t('Last message')}</th></tr></thead>
            <tbody className="divide-y divide-hairline">
              {list.map(c => (
                <tr key={c.id} className="cursor-pointer hover:bg-paper/60" onClick={() => show(c)}>
                  <td className="px-3 py-2"><p className="font-medium" dir="auto">{displayName(c)} {c.is_blocked && <Badge tone="critical">{t('blocked')}</Badge>}</p>
                    <p className="text-xs text-muted">{phoneLabel(c.wa_id, c.phone, c.phone_hidden)}</p></td>
                  <td className="px-3 py-2">{c.orders_count}</td>
                  <td className="px-3 py-2">{money(c.total_spent, tenant.currency_symbol)}</td>
                  <td className="px-3 py-2 text-muted">{c.last_order_at ? timeAgo(c.last_order_at) : '—'}</td>
                  <td className="px-3 py-2 text-muted">{timeAgo(c.last_seen_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {list.length === 0 && <p className="p-6 text-center text-sm text-muted">{t('No customers found.')}</p>}
        </div>
      )}

      <Drawer open={!!open} onClose={() => setOpen(null)} title={<span dir="auto">{displayName(open)}</span>}
        footer={<>{convId && <Link href={`${base}/inbox?c=${convId}`}><Button variant="outline"><MessageCircle className="size-4" /> {t('Open the chat')}</Button></Link>}
          <Button variant="gold" busy={busy} onClick={save}>{t('Save')}</Button></>}>
        {open && (
          <div className="space-y-5 text-sm">
            <div className="grid grid-cols-3 gap-2">
              {[['Orders', String(open.orders_count)], ['Spent', money(open.total_spent, tenant.currency_symbol)], ['Since', day(open.first_seen_at, tenant.timezone)]].map(([k, v]) => (
                <div key={k} className="rounded-lg bg-paper p-3"><p className="label-caps">{t(k)}</p><p className="mt-0.5 font-semibold">{v}</p></div>))}
            </div>
            <p className="text-muted">{phoneLabel(open.wa_id, open.phone, open.phone_hidden)}{open.alt_phone ? ` · ${open.alt_phone}` : ''}{open.language ? ' · ' + (open.language === 'en' ? t('writes in English') : t('writes in Arabic')) : ''}</p>
            {open.food_prefs && <p dir="auto">{t('Avoids: {prefs}', { prefs: open.food_prefs })}</p>}
            <Field label={t('Notes for your team')}><Textarea value={notes} onChange={e => setNotes(e.target.value)} /></Field>
            <Field label={t('Tags')} hint={t('Comma separated, e.g. VIP, corporate.')}><Input value={tags} onChange={e => setTags(e.target.value)} /></Field>
            <section>
              <p className="label-caps mb-2">{t('Saved addresses')}</p>
              {addresses.length === 0 ? <p className="text-muted">{t('None yet — saved with each delivery order.')}</p> : addresses.map(a => (
                <div key={a.id} className="mb-1.5 flex items-start justify-between gap-2 rounded-lg bg-paper p-2">
                  <span dir="auto">{a.address_text} <span className="text-xs text-muted">· {t('used {n}×', { n: a.use_count })}</span></span>
                  <button className="text-xs text-critical" onClick={() => forget(a)}>{t('Remove')}</button>
                </div>
              ))}
            </section>
            <section>
              <p className="label-caps mb-2">{t('Orders')}</p>
              {orders.length === 0 ? <p className="text-muted">{t('No orders yet.')}</p> : (
                <ul className="divide-y divide-hairline">{orders.map(o => (
                  <li key={o.id} className="flex justify-between py-1.5"><span><strong>{o.order_no}</strong> · {dateTime(o.placed_at, tenant.timezone)} · {statusLabel(o.status)}</span><span>{money(o.total, tenant.currency_symbol)}</span></li>))}</ul>
              )}
            </section>
          </div>
        )}
      </Drawer>
    </div>
  );
}

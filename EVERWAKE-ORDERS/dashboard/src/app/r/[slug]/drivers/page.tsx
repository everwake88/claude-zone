'use client';
import { Copy, MapPin, Plus, Send } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, Checkbox, Empty, Field, Input, Modal, PageHeader, Spinner, Switch, useAction, useToast } from '@/components/ui';
import { useTenant } from '@/components/tenant';
import { money, timeAgo } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { sb } from '@/lib/supabase/client';
import type { Branch, Driver } from '@/lib/types';

interface Report { driver_id: string; delivered: number; cash: number; total: number; avg_minutes: number | null }
const COLS = 'id,tenant_id,name,phone,branch_ids,is_active,login_code_sent_at,last_lat,last_lng,last_loc_at,last_seen_at,created_at';
const local = (p: string) => (p.startsWith('20') && p.length === 12 ? '0' + p.slice(2) : '+' + p);

// The restaurant's own drivers: added with a name and a WhatsApp number,
// signed in from a link sent to that number. Any team member can add one.
export default function Drivers() {
  const { tenant } = useTenant();
  const t = useT();
  const toast = useToast();
  const { busy, run } = useAction();
  const [drivers, setDrivers] = useState<Driver[] | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [report, setReport] = useState<Record<string, Report>>({});
  const [edit, setEdit] = useState<{ id?: string; name: string; phone: string; branch_ids: string[] } | null>(null);
  const [link, setLink] = useState<{ name: string; url: string } | null>(null);
  const [origin, setOrigin] = useState('');
  useEffect(() => setOrigin(window.location.origin), []);

  const load = useCallback(async () => {
    const { data } = await sb().from('drivers').select(COLS).eq('tenant_id', tenant.id).order('is_active', { ascending: false }).order('name');
    setDrivers((data || []) as Driver[]);
    const from = new Date(); from.setHours(0, 0, 0, 0);
    const { data: r } = await sb().rpc('driver_report', { p_tenant: tenant.id, p_from: from.toISOString(), p_to: new Date(Date.now() + 60000).toISOString() });
    setReport(Object.fromEntries(((r || []) as Report[]).map(x => [x.driver_id, x])));
  }, [tenant.id]);
  useEffect(() => {
    load();
    sb().from('branches').select('*').eq('tenant_id', tenant.id).order('sort').then(({ data }) => setBranches((data || []) as Branch[]));
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, [tenant.id, load]);

  // a sign-in link to the driver's WhatsApp (and here, to copy)
  const invite = (d: { id: string; name: string }) => run(async () => {
    const { data, error } = await sb().rpc('invite_driver', { p_driver: d.id, p_base: window.location.origin });
    if (error) throw new Error(error.message);
    await fetch('/api/outbox/ping', { method: 'POST' }).catch(() => null);
    setLink({ name: d.name, url: (data as { link: string }).link });
    await load();
  }, t('Sign-in link sent to {name} on WhatsApp', { name: d.name }));

  const save = () => run(async () => {
    if (!edit) return;
    const { data, error } = await sb().rpc('save_driver', { p_tenant: tenant.id, p: edit });
    if (error) throw new Error(error.message);
    const isNew = !edit.id;
    setEdit(null);
    await load();
    if (isNew) await invite({ id: (data as { id: string }).id, name: edit.name });
  }, edit?.id ? t('Saved') : undefined);

  const setActive = (d: Driver, v: boolean) => run(async () => {
    const { error } = await sb().rpc('save_driver', { p_tenant: tenant.id, p: { id: d.id, is_active: v } });
    if (error) throw new Error(error.message);
    await load();
  }, v ? t('{name} can drive again — send a new sign-in link', { name: d.name }) : t('{name} is switched off and signed out', { name: d.name }));

  if (!drivers) return <Spinner />;
  const branchName = (id: string) => branches.find(b => b.id === id)?.name_ar || '';

  return (
    <div className="space-y-5">
      <PageHeader title={t('Drivers')}
        subtitle={t('Your own drivers. They sign in with a link on WhatsApp — no password — see the orders you give them with the map, and the customer is told when they leave and when they are close.')}
        actions={<Button variant="gold" onClick={() => setEdit({ name: '', phone: '', branch_ids: [] })}><Plus className="size-4" /> {t('Add a driver')}</Button>} />

      {drivers.length === 0
        ? <Empty title={t('No drivers yet')}>{t('Add one with a name and a WhatsApp number. They get a sign-in link on WhatsApp right away.')}</Empty>
        : (
          <Card>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-muted">
                  <tr className="border-b border-hairline">
                    <th className="p-2">{t('Driver')}</th><th className="p-2">{t('Branches')}</th><th className="p-2">{t('Today')}</th>
                    <th className="p-2">{t('Cash to hand in')}</th><th className="p-2">{t('Last position')}</th><th className="p-2">{t('Active')}</th><th className="p-2" />
                  </tr>
                </thead>
                <tbody>
                  {drivers.map(d => {
                    const r = report[d.id];
                    const live = d.last_loc_at && Date.now() - new Date(d.last_loc_at).getTime() < 10 * 60000;
                    return (
                      <tr key={d.id} className="border-b border-hairline last:border-0">
                        <td className="p-2">
                          <button className="text-start font-medium hover:underline" onClick={() => setEdit({ id: d.id, name: d.name, phone: local(d.phone), branch_ids: d.branch_ids })}>{d.name}</button>
                          <p className="text-xs text-muted" dir="ltr">{local(d.phone)}</p>
                        </td>
                        <td className="p-2 text-xs">{d.branch_ids.length ? d.branch_ids.map(branchName).join('، ') : t('All branches')}</td>
                        <td className="p-2">{r?.delivered ? t('{n} delivered', { n: r.delivered }) : '—'}{r?.avg_minutes ? <p className="text-xs text-muted">{t('~{n} min each', { n: r.avg_minutes })}</p> : null}</td>
                        <td className="p-2 font-semibold">{r?.cash ? money(r.cash, tenant.currency_symbol) : '—'}</td>
                        <td className="p-2 text-xs">
                          {d.last_loc_at
                            ? <a className="inline-flex items-center gap-1 hover:underline" target="_blank" rel="noreferrer" href={`https://www.google.com/maps?q=${d.last_lat},${d.last_lng}`}>
                                <MapPin className="size-3.5" /> {timeAgo(d.last_loc_at)} {live && <Badge tone="positive">{t('Live')}</Badge>}</a>
                            : d.last_seen_at ? t('Signed in, no position yet') : t('Not signed in yet')}
                        </td>
                        <td className="p-2"><Switch checked={d.is_active} onChange={v => setActive(d, v)} label="" /></td>
                        <td className="p-2 text-end">
                          {d.is_active && <Button size="sm" variant="outline" disabled={busy} onClick={() => invite(d)}><Send className="size-3.5 rtl:rotate-180" /> {t('Send sign-in link')}</Button>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        )}

      <Card title={t('How it works')}>
        <ol className="list-decimal space-y-1.5 ps-5 text-sm text-muted">
          <li>{t('Add the driver. A sign-in link goes to their WhatsApp from your restaurant’s number. They open it once on their phone and stay signed in.')}</li>
          <li>{t('On the order board, pick the driver on a delivery order. They get a WhatsApp message and see it in their app with the map, the customer’s number and what to collect.')}</li>
          <li>{t('When they press “start delivery”, the customer gets their name, number and an arrival estimate. When they are about 5 minutes away, the customer is told again.')}</li>
          <li>{t('The customer and the driver can chat through your WhatsApp number, or call each other. The agent knows where the driver is if the customer asks.')}</li>
          <li>{t('Lost the link? The driver opens this page and types their number to get a new one:')}{' '}
            <bdi dir="ltr" className="font-mono text-xs text-ink">{origin}/driver/login</bdi></li>
        </ol>
      </Card>

      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? t('Edit driver') : t('Add a driver')}
        footer={<><Button variant="outline" onClick={() => setEdit(null)}>{t('Cancel')}</Button>
          <Button variant="gold" busy={busy} onClick={save}>{edit?.id ? t('Save') : t('Add and send the link')}</Button></>}>
        {edit && <div className="space-y-3">
          <Field label={t('Name')}><Input value={edit.name} onChange={e => setEdit({ ...edit, name: e.target.value })} placeholder="أحمد" /></Field>
          <Field label={t('WhatsApp number')} hint={t('The sign-in link and new orders go to this number.')}>
            <Input dir="ltr" inputMode="tel" value={edit.phone} onChange={e => setEdit({ ...edit, phone: e.target.value })} placeholder="01xxxxxxxxx" />
          </Field>
          {branches.length > 1 && (
            <Field label={t('Delivers for')} hint={t('None ticked = every branch.')}>
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                {branches.map(b => <Checkbox key={b.id} label={b.name_ar} checked={edit.branch_ids.includes(b.id)}
                  onChange={v => setEdit({ ...edit, branch_ids: v ? [...edit.branch_ids, b.id] : edit.branch_ids.filter(x => x !== b.id) })} />)}
              </div>
            </Field>
          )}
        </div>}
      </Modal>

      <Modal open={!!link} onClose={() => setLink(null)} title={t('Sign-in link for {name}', { name: link?.name })}
        footer={<Button onClick={() => setLink(null)}>{t('Done')}</Button>}>
        <p className="text-sm text-muted">{t('It was sent to their WhatsApp. If it does not arrive, copy it and send it yourself. It works once, for 7 days.')}</p>
        <div className="mt-3 flex gap-2">
          <Input readOnly dir="ltr" value={link?.url || ''} className="text-xs" />
          <Button variant="outline" onClick={() => { navigator.clipboard.writeText(link?.url || ''); toast(t('Copied')); }}><Copy className="size-4" /></Button>
        </div>
      </Modal>
    </div>
  );
}

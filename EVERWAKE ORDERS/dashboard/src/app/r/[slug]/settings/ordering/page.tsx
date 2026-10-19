'use client';
import { Fragment, useEffect, useState } from 'react';
import { useTenantRow } from '@/components/settings/useTenantRow';
import { Button, Card, Checkbox, Field, Input, Spinner } from '@/components/ui';
import { useTenant } from '@/components/tenant';
import { sb } from '@/lib/supabase/client';
import type { Settings } from '@/lib/types';

const PAYMENTS = [['cash', 'Cash'], ['card', 'Card on delivery'], ['wallet', 'Mobile wallet'], ['instapay', 'InstaPay']];
const FIELDS: [string, string][] = [
  ['phone_confirmed', 'Confirm the WhatsApp number'], ['full_name', 'Name'], ['delivery_method', 'Delivery or pickup'],
  ['address_area', 'Area'], ['address_street', 'Street'], ['address_building', 'Building'], ['address_floor', 'Floor'],
  ['address_apartment', 'Apartment'], ['address_landmark', 'Landmark'], ['payment_method', 'Payment method']
];

export default function OrderingSettings() {
  const { can } = useTenant();
  const { row, save, busy } = useTenantRow();
  const [s, setS] = useState<Settings | null>(null);
  const [prefix, setPrefix] = useState('');
  const [tests, setTests] = useState('');

  useEffect(() => {
    if (!row) return;
    sb().rpc('merged_settings', { p_settings: row.settings }).then(({ data }) => {
      const m = data as Settings;
      setS(m); setTests((m.test_numbers || []).join(', ')); setPrefix(row.order_no_prefix);
    });
  }, [row]);
  if (!row || !s) return <Spinner />;
  const ro = !can.edit;
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS({ ...s, [k]: v });
  const req = (mode: 'delivery' | 'pickup', f: string, on: boolean) => {
    const cur = s.required_fields?.[mode] || [];
    set('required_fields', { ...s.required_fields, [mode]: on ? [...cur.filter(x => x !== f), f] : cur.filter(x => x !== f) });
  };

  const submit = () => {
    const { templates: _t, ...rest } = s;
    void _t;
    save({
      order_no_prefix: prefix.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'EW',
      settings: { ...row.settings, ...rest, test_numbers: tests.split(/[\s,،]+/).map(x => x.replace(/\D/g, '')).filter(Boolean),
                  ops_whatsapp: (s.ops_whatsapp || '').replace(/\D/g, '') }
    });
  };

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card title="Payment">
        <p className="mb-3 text-sm text-muted">The agent only offers these, and never promises anything else.</p>
        <div className="grid grid-cols-2 gap-2">
          {PAYMENTS.map(([k, label]) => (
            <Checkbox key={k} checked={(s.payment_methods || []).includes(k)} label={label}
              onChange={v => !ro && set('payment_methods', v ? [...(s.payment_methods || []), k] : (s.payment_methods || []).filter(x => x !== k))} />
          ))}
        </div>
      </Card>

      <Card title="What the agent collects before placing an order">
        <div className="grid grid-cols-[1fr_auto_auto] items-center gap-x-6 gap-y-2 text-sm">
          <span /><span className="label-caps">Delivery</span><span className="label-caps">Pickup</span>
          {FIELDS.map(([f, label]) => (
            <Fragment key={f}>
              <span>{label}</span>
              <input type="checkbox" disabled={ro} checked={(s.required_fields?.delivery || []).includes(f)} onChange={e => req('delivery', f, e.target.checked)} />
              <input type="checkbox" disabled={ro || f.startsWith('address_')} checked={(s.required_fields?.pickup || []).includes(f)} onChange={e => req('pickup', f, e.target.checked)} />
            </Fragment>
          ))}
        </div>
        <p className="mt-3 text-xs text-muted">A shared location pin counts as the street. The agent asks one or two things at a time, never the whole form.</p>
      </Card>

      <Card title="Delivery and opening hours">
        <div className="space-y-3">
          <Checkbox checked={s.require_zone_for_delivery !== false} onChange={v => set('require_zone_for_delivery', v)}
            label="Deliver only inside the drawn delivery zones" />
          <Checkbox checked={!!s.accept_orders_when_closed} onChange={v => set('accept_orders_when_closed', v)}
            label="Take orders while a branch is closed (prepared when it opens)" />
          <Field label="Before zones are drawn, deliver up to (km)"><Input type="number" disabled={ro} value={s.max_delivery_km ?? ''} onChange={e => set('max_delivery_km', Number(e.target.value))} /></Field>
        </div>
      </Card>

      <Card title="When a person takes over">
        <div className="space-y-3">
          <Field label="Hand back to the agent after (minutes of no reply from your team)" hint="0 = never by itself.">
            <Input type="number" min="0" disabled={ro} value={s.human_auto_release_minutes ?? 30} onChange={e => set('human_auto_release_minutes', Number(e.target.value))} />
          </Field>
          <Checkbox checked={s.phone_reply_takes_over !== false} onChange={v => set('phone_reply_takes_over', v)}
            label="A reply typed on the restaurant's phone takes the chat over" />
          <Checkbox checked={!!s.auto_takeover_on_handoff} onChange={v => set('auto_takeover_on_handoff', v)}
            label="When the agent asks for a person, it stops replying until someone hands the chat back" />
        </div>
      </Card>

      <Card title="New-order tickets on WhatsApp">
        <div className="space-y-3">
          <Checkbox checked={s.send_order_ticket !== false} onChange={v => set('send_order_ticket', v)} label="Send each new order as a WhatsApp message too" />
          <Field label="Restaurant's operations number" hint="Used when the branch has none. International format, digits only (2010…).">
            <Input dir="ltr" disabled={ro} value={s.ops_whatsapp || ''} onChange={e => set('ops_whatsapp', e.target.value)} />
          </Field>
          <Field label="Order number prefix" hint={`Orders are numbered ${prefix || 'EW'}-1001, ${prefix || 'EW'}-1002…`}>
            <Input dir="ltr" disabled={ro} value={prefix} onChange={e => setPrefix(e.target.value.toUpperCase())} />
          </Field>
        </div>
      </Card>

      <Card title="Testing and reports">
        <div className="space-y-3">
          <Field label="Test numbers" hint="While the restaurant is onboarding, only these numbers reach the agent. Digits, comma separated.">
            <Input dir="ltr" disabled={ro} value={tests} onChange={e => setTests(e.target.value)} placeholder="201012345678, 201098765432" />
          </Field>
          <Field label="Delivery-app commission to compare with (%)" hint="For the “commission saved” number in Analytics.">
            <Input type="number" disabled={ro} value={s.aggregator_commission_percent ?? 25} onChange={e => set('aggregator_commission_percent', Number(e.target.value))} />
          </Field>
        </div>
      </Card>

      {!ro && <div className="xl:col-span-2"><Button variant="gold" busy={busy} onClick={submit}>Save</Button></div>}
    </div>
  );
}

'use client';
import { useState } from 'react';
import { clock } from '@/lib/format';
import { sb } from '@/lib/supabase/client';
import { Badge, Button, Modal, useAction } from '../ui';
import { useTenant } from '../tenant';

// tomorrow at 06:00 on the restaurant's clock — when "out for today" ends
export function tomorrowMorning(tz: string): Date {
  const now = new Date();
  const local = new Date(now.toLocaleString('en-US', { timeZone: tz }));
  const offset = now.getTime() - local.getTime();
  const t = new Date(local);
  t.setDate(t.getDate() + (local.getHours() < 6 ? 0 : 1));
  t.setHours(6, 0, 0, 0);
  return new Date(t.getTime() + offset);
}

// The out-of-stock switch. Anyone on the team may use it; the agent knows on
// its very next message.
export function StockButton({ itemId, available, soldOutUntil, branchId, label, onDone }:
  { itemId: string; available: boolean; soldOutUntil: string | null; branchId?: string | null; label?: string; onDone: () => void }) {
  const { tenant } = useTenant();
  const [open, setOpen] = useState(false);
  const { busy, run } = useAction();
  const out = !available || (!!soldOutUntil && new Date(soldOutUntil) > new Date());

  const set = (avail: boolean, until: Date | null) => run(async () => {
    const { error } = await sb().rpc('set_item_availability', { p_item: itemId, p_available: avail, p_branch: branchId || null,
                                                                p_until: until ? until.toISOString() : null });
    if (error) throw new Error(error.message);
    setOpen(false);
    onDone();
  }, avail ? 'Back on the menu — the agent offers it again' : 'Marked out of stock — the agent stops offering it now');

  return (
    <>
      {out ? (
        <button onClick={() => set(true, null)} disabled={busy} title="Click when it is back">
          <Badge tone="critical">{soldOutUntil && available ? `Out until ${clock(soldOutUntil, tenant.timezone)}` : 'Out of stock'}</Badge>
        </button>
      ) : (
        <button onClick={() => setOpen(true)} title="Mark out of stock"><Badge tone="positive">{label || 'Available'}</Badge></button>
      )}
      <Modal open={open} onClose={() => setOpen(false)} title="Out of stock">
        <p className="mb-4 text-sm text-muted">The agent stops offering it on the next message, and takes it out of any open cart.</p>
        <div className="grid gap-2">
          <Button variant="outline" busy={busy} onClick={() => set(false, new Date(Date.now() + 3600e3))}>For 1 hour</Button>
          <Button variant="outline" busy={busy} onClick={() => set(false, new Date(Date.now() + 3 * 3600e3))}>For 3 hours</Button>
          <Button variant="outline" busy={busy} onClick={() => set(false, tomorrowMorning(tenant.timezone))}>For today (back tomorrow morning)</Button>
          <Button variant="danger" busy={busy} onClick={() => set(false, null)}>Until I switch it back on</Button>
        </div>
      </Modal>
    </>
  );
}

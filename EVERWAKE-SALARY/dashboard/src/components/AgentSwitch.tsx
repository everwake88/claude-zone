'use client';
import { useState, useTransition } from 'react';
import { setAgent } from '@/app/actions';

// The agent on or off, right on its card. It flips at once; the server confirms.
export function AgentSwitch({ on, label }: { on: boolean; label: string }) {
  const [value, setValue] = useState(on);
  const [, start] = useTransition();
  return (
    <span className="switch">
      <input type="checkbox" role="switch" aria-label={label} checked={value}
             onChange={(e) => { const next = e.target.checked; setValue(next); start(async () => { const r = await setAgent(next); if (!r.ok) setValue(!next); }); }} />
      <span />
    </span>
  );
}

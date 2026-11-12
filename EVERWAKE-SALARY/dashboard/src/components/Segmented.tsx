'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';

// Choices as a pill track; the white pill slides to what you picked at once, the page follows.
export function Segmented({ options, current, label }: {
  options: { key: string; href: string; label: React.ReactNode }[]; current: string; label: string;
}) {
  const [picked, setPicked] = useState(current);
  useEffect(() => setPicked(current), [current]);
  const at = Math.max(0, options.findIndex((o) => o.key === picked));
  return (
    <nav className="seg" aria-label={label} style={{ ['--n' as string]: options.length }}>
      <span className="seg-pill" aria-hidden="true" style={{ ['--at' as string]: at }} />
      {options.map((o) => (
        <Link key={o.key} href={o.href} scroll={false} aria-current={o.key === picked ? 'page' : undefined} onClick={() => setPicked(o.key)}>
          {o.label}
        </Link>
      ))}
    </nav>
  );
}

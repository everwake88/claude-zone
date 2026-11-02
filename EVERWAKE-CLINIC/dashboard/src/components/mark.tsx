'use client';
import { useReducedMotion } from 'motion/react';
import { cx } from '@/lib/format';

// Everwake's mark (brand/logo/everwake-mark.svg): a person over two arches, inside a gold ring.
// On navy the person is white; on light it is navy. `framed` puts it on its navy tile.
const ARCH = 'M -8.1601 4.9335 C -2.7227 -3.2890 2.7287 -3.2890 8.1601 4.9335';
const BASE = 'M -5.6953 7.5936 C -1.8984 1.3944 1.8945 1.3944 5.6914 7.5936';

export function Mark({ size = 36, tone = 'onNavy', framed = false, draw = false, className }:
  { size?: number; tone?: 'onNavy' | 'onLight'; framed?: boolean; draw?: boolean; className?: string }) {
  const reduce = useReducedMotion();
  const ink = tone === 'onNavy' || framed ? '#FFFFFF' : '#0B222E';
  const anim = draw && !reduce;
  return (
    <svg width={size} height={size} viewBox={framed ? '-20.95 -20.95 41.9 41.9' : '-15.64 -15.64 31.27 31.27'} aria-hidden className={cx('shrink-0', className)}>
      {framed && <rect x="-20.95" y="-20.95" width="41.9" height="41.9" rx="9" fill="#0B222E" />}
      <circle cx="0" cy="0" r="15.18" fill="none" stroke="#B8913F" strokeWidth="0.91" className={anim ? 'c-fade' : undefined} />
      <path d={ARCH} fill="none" stroke={ink} strokeWidth="1.67" strokeLinecap="round" pathLength={1}
        strokeDasharray={anim ? 1 : undefined} className={anim ? 'c-draw' : undefined} style={anim ? { ['--len' as string]: 1, animationDelay: '.25s' } : undefined} />
      <path d={BASE} fill="none" stroke="#B8913F" strokeWidth="1.29" strokeLinecap="round" pathLength={1}
        strokeDasharray={anim ? 1 : undefined} className={anim ? 'c-draw' : undefined} style={anim ? { ['--len' as string]: 1, animationDelay: '.45s' } : undefined} />
      <circle cx="0" cy="-5.12" r="1.67" fill={ink} className={anim ? 'c-fade' : undefined} />
    </svg>
  );
}

// the product's name beside the mark
export function Wordmark({ dark = true }: { dark?: boolean }) {
  return (
    <span className="flex items-center gap-2.5">
      <Mark size={34} tone={dark ? 'onNavy' : 'onLight'} />
      <span className="leading-none">
        <span className={cx('block text-[15px] font-semibold tracking-[-0.01em]', dark ? 'text-white' : 'text-ink')} dir="ltr">Everwake</span>
        <span className={cx('mt-1 block text-[11.5px] font-medium tracking-[0.12em]', dark ? 'text-gold-bright' : 'text-gold-ink')} dir="ltr">CLINIC</span>
      </span>
    </span>
  );
}

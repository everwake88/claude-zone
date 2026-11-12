// The product's mark: a payslip with its fold, and the sage tick of a checked identity.
export function Mark({ size = 44 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 44 44" aria-hidden="true" style={{ flex: 'none' }}>
      <rect width="44" height="44" rx="14" fill="#1c2320" />
      <path d="M14 11.5h11l5 5V31a1 1 0 0 1-1 1H14a1 1 0 0 1-1-1V12.5a1 1 0 0 1 1-1Z" fill="none" stroke="#fff" strokeWidth="1.8" />
      <path d="M17 18h6.5M17 22h4.5" stroke="#9db3a3" strokeWidth="1.8" strokeLinecap="round" />
      <path d="m22.5 27 2.6 2.6 5.4-6" fill="none" stroke="#b9d0bf" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// The product's mark: a payslip with its fold, and the gold tick of a checked identity.
export function Mark({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 30 30" aria-hidden="true" style={{ flex: 'none' }}>
      <rect x="0.75" y="0.75" width="28.5" height="28.5" rx="7" fill="#0b222e" />
      <path d="M9 7.5h8.5l4 4V22a.5.5 0 0 1-.5.5H9a.5.5 0 0 1-.5-.5V8a.5.5 0 0 1 .5-.5Z" fill="none" stroke="#fff" strokeWidth="1.4" />
      <path d="M11.5 12.5h5M11.5 15.5h3.5" stroke="#9fb3bc" strokeWidth="1.4" strokeLinecap="round" />
      <path d="m15.5 19 2 2 4-4.5" fill="none" stroke="#d4a94b" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

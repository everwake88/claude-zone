// the kitchen screen opening: its dark columns, quietly, so nothing light flashes on the dark screen
export default function Loading() {
  return (
    <div aria-busy="true" className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3">
      {[0, 1, 2].map(i => <div key={i} className="h-[60dvh] animate-pulse rounded-3xl bg-white/[.05]" style={{ animationDelay: `${i * 120}ms` }} />)}
    </div>
  );
}

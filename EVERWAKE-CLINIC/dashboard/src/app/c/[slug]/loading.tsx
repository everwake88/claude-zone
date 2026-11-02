// shown the moment a page is chosen, inside the frame that stays put: the page's shape, still
export default function Loading() {
  return (
    <div aria-busy="true">
      <div className="mb-5 space-y-2">
        <div className="skeleton h-7 w-48" />
        <div className="skeleton h-4 w-72 max-w-full" />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="skeleton h-40 lg:col-span-2" />
        <div className="skeleton h-40" />
      </div>
    </div>
  );
}

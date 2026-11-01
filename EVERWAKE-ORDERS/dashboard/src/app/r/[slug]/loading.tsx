import { Spinner } from '@/components/ui';

// shown the moment a page is chosen, inside the sidebar and the header that stay put,
// until the page arrives: the shape of a page, shimmering
export default function Loading() {
  return (
    <div aria-busy="true" className="pt-1">
      <div className="mb-6 space-y-2.5">
        <div className="ew-skeleton h-8 w-52 rounded-xl" />
        <div className="ew-skeleton h-4 w-80 max-w-full rounded-lg [animation-delay:.1s]" />
      </div>
      <Spinner />
    </div>
  );
}

'use client';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useTenant } from '@/components/tenant';
import { chime } from '@/lib/alerts';
import { lalezar } from '@/lib/fonts';
import { useT } from '@/lib/i18n';
import { sb } from '@/lib/supabase/client';
import type { Branch, Order } from '@/lib/types';

// A TV or an old tablet in the branch: the numbers being prepared and the
// numbers ready to collect, like at the big chains. It chimes when one is
// ready — customers who closed their page still see their number.
function Board() {
  const { tenant, brand } = useTenant();
  const params = useSearchParams();
  const branchId = params.get('branch') || '';
  const [branch, setBranch] = useState<Branch | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const readySeen = useRef<Set<number> | null>(null);
  const t = useT();

  const load = useCallback(async () => {
    const since = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
    const { data } = await sb().from('orders').select('*').eq('tenant_id', tenant.id).eq('branch_id', branchId)
      .in('status', ['placed', 'accepted', 'preparing', 'ready']).neq('delivery_method', 'delivery').gte('placed_at', since).order('placed_at');
    const list = (data || []) as Order[];
    const ready = list.filter(o => o.status === 'ready').map(o => o.id);
    if (readySeen.current && ready.some(id => !readySeen.current!.has(id))) chime();
    readySeen.current = new Set(ready);
    setOrders(list);
  }, [tenant.id, branchId]);
  useEffect(() => {
    if (!branchId) return;
    sb().from('branches').select('*').eq('id', branchId).single().then(({ data }) => setBranch(data as Branch));
    load();
    const ch = sb().channel('tv-' + branchId)
      .on('postgres_changes', { event: '*', schema: 'everwake', table: 'orders', filter: `tenant_id=eq.${tenant.id}` }, () => load())
      .subscribe();
    const tick = setInterval(load, 20000);
    return () => { sb().removeChannel(ch); clearInterval(tick); };
  }, [branchId, tenant.id, load]);

  const preparing = orders.filter(o => o.status !== 'ready');
  const ready = orders.filter(o => o.status === 'ready');
  const color = brand.color || '#0B222E';
  return (
    <div className={`fixed inset-0 z-50 flex flex-col bg-[#0E1418] text-white ${lalezar.variable}`} dir="rtl">
      <header className="flex items-center gap-4 px-8 py-5" style={{ background: color }}>
        {brand.logo_url && <img src={brand.logo_url} alt="" className="size-16 rounded-full bg-white object-cover" />}
        <div>
          <p className="board text-[44px]">{tenant.name_ar}</p>
          <p className="text-lg opacity-90">{branch?.name_ar}</p>
        </div>
      </header>
      <div className="grid flex-1 grid-cols-2 gap-6 p-8">
        <section>
          <h2 className="board mb-5 text-[44px] text-white/60">قيد التحضير <span className="text-xl font-semibold opacity-70">· Preparing</span></h2>
          <div className="flex flex-wrap gap-4">
            {preparing.map(o => <span key={o.id} className="board rounded-2xl bg-white/[.07] px-6 py-4 text-[56px] text-white/85"><bdi>{o.order_no}</bdi></span>)}
          </div>
        </section>
        <section>
          <h2 className="board mb-5 text-[44px] text-[#45C486]">جاهز <span className="text-xl font-semibold opacity-80">· Ready</span></h2>
          <div className="flex flex-wrap gap-4">
            {ready.map(o => (
              <span key={o.id} className="qr-flash kds-in rounded-2xl bg-[#1F7A52] px-7 py-5 text-[72px] [--brand:#45C486]">
                <bdi className="board block">{o.order_no}</bdi>{o.table_label && <span className="block text-2xl font-semibold">ترابيزة {o.table_label}</span>}
              </span>
            ))}
          </div>
        </section>
      </div>
      <p className="pb-3 text-center text-sm text-on-navy-muted">{t('Tap once anywhere so the screen can chime')}</p>
    </div>
  );
}

export default function ReadyScreen() {
  return <Suspense><Board /></Suspense>;
}

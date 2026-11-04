// The month's bill as an Excel sheet: every order that came through Everwake with the customer, the
// address, the items, the order total, Everwake's fee and the restaurant's share, then a summary.
// Read with the signed-in user's own access (bill_statement checks they are an owner or manager).
import ExcelJS from 'exceljs';
import type { NextRequest } from 'next/server';
import { serverClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Row { order_no: string; placed_at: string; channel: string; name: string | null; phone: string | null; address: string | null;
  items: string | null; branch: string | null; total: number; base: number; fee: number; net: number }

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const tenant = q.get('tenant') || '', from = q.get('from') || '', to = q.get('to') || '';
  const month = (q.get('month') || '').replace(/[^0-9-]/g, '').slice(0, 7);
  const ar = q.get('lang') !== 'en';
  const db = await serverClient();
  const [{ data, error }, { data: tn }] = await Promise.all([
    db.rpc('bill_statement', { p_tenant: tenant, p_from: from, p_to: to }),
    db.from('tenants').select('slug, name_ar, name_en, timezone, currency_symbol_ar').eq('id', tenant).maybeSingle()
  ]);
  if (error || !data) return Response.json({ error: error?.message || 'not found' }, { status: error?.code === '42501' ? 403 : 400 });
  const st = data as { rule: { fee_percent: number; include_delivery_fee: boolean; include_vat: boolean };
                       totals: { orders: number; sales: number; base: number; fee: number; net: number; whatsapp_orders: number; qr_orders: number };
                       rows: Row[] };
  const t = tn as { slug: string; name_ar: string; name_en: string | null; timezone: string | null } | null;
  const tz = t?.timezone || 'Africa/Cairo';
  const name = (ar ? t?.name_ar : t?.name_en || t?.name_ar) || '';
  const L = ar ? {
    sheet: 'الطلبات', summary: 'الملخص', order: 'رقم الطلب', date: 'التاريخ', channel: 'القناة', customer: 'العميل', phone: 'الموبايل',
    address: 'العنوان', items: 'الأصناف', branch: 'الفرع', total: 'إجمالي الطلب', base: 'المبلغ المحسوبة عليه النسبة',
    fee: 'نسبة Everwake (ج)', net: 'صافي المطعم (ج)', whatsapp: 'واتساب', qr: 'QR في الفرع', totals: 'الإجمالي',
    restaurant: 'المطعم', month: 'الشهر', rule: 'القاعدة', orders: 'عدد الطلبات', sales: 'إجمالي الطلبات', feeSum: 'نسبة Everwake',
    netSum: 'صافي المطعم', ruleText: (r: typeof st.rule) => `${r.fee_percent}% من أكل طلبات الواتساب بعد الخصومات${r.include_delivery_fee ? ' + التوصيل' : ''}${r.include_vat ? ' + الضريبة' : ''}، و${r.fee_percent}% من إجمالي طلبات الـQR`
  } : {
    sheet: 'Orders', summary: 'Summary', order: 'Order', date: 'Date', channel: 'Channel', customer: 'Customer', phone: 'Phone',
    address: 'Address', items: 'Items', branch: 'Branch', total: 'Order total', base: 'Amount the percent is on',
    fee: 'Everwake fee (EGP)', net: 'Restaurant share (EGP)', whatsapp: 'WhatsApp', qr: 'QR in the branch', totals: 'Total',
    restaurant: 'Restaurant', month: 'Month', rule: 'Rule', orders: 'Orders', sales: 'Order totals', feeSum: 'Everwake fee',
    netSum: 'Restaurant share', ruleText: (r: typeof st.rule) => `${r.fee_percent}% of WhatsApp orders' food after discounts${r.include_delivery_fee ? ' + delivery fee' : ''}${r.include_vat ? ' + VAT' : ''}; ${r.fee_percent}% of QR orders' total`
  };

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Everwake Orders';
  const ws = wb.addWorksheet(L.sheet, { views: [{ rightToLeft: ar, state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: L.order, key: 'order_no', width: 12 }, { header: L.date, key: 'date', width: 18 }, { header: L.channel, key: 'channel', width: 14 },
    { header: L.customer, key: 'name', width: 22 }, { header: L.phone, key: 'phone', width: 15 }, { header: L.address, key: 'address', width: 38 },
    { header: L.items, key: 'items', width: 44 }, { header: L.branch, key: 'branch', width: 14 }, { header: L.total, key: 'total', width: 14 },
    { header: L.base, key: 'base', width: 16 }, { header: L.fee, key: 'fee', width: 16 }, { header: L.net, key: 'net', width: 16 }
  ];
  const dateOf = (iso: string) => new Intl.DateTimeFormat('en-GB', { dateStyle: 'short', timeStyle: 'short', timeZone: tz }).format(new Date(iso));
  for (const r of st.rows) {
    ws.addRow({ order_no: r.order_no, date: dateOf(r.placed_at), channel: r.channel === 'qr' ? L.qr : L.whatsapp, name: r.name || '', phone: r.phone || '',
                address: r.address || '', items: r.items || '', branch: r.branch || '', total: Number(r.total), base: Number(r.base),
                fee: Number(r.fee), net: Number(r.net) });
  }
  const total = ws.addRow({ order_no: L.totals, total: Number(st.totals.sales), base: Number(st.totals.base), fee: Number(st.totals.fee), net: Number(st.totals.net) });
  total.font = { bold: true };
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B222E' } };
  head.alignment = { vertical: 'middle', wrapText: true };
  head.height = 30;
  for (const k of ['total', 'base', 'fee', 'net']) ws.getColumn(k).numFmt = '#,##0.00';
  ws.getColumn('items').alignment = { wrapText: true, vertical: 'top' };
  ws.getColumn('address').alignment = { wrapText: true, vertical: 'top' };
  ws.autoFilter = { from: 'A1', to: 'L1' };

  const sum = wb.addWorksheet(L.summary, { views: [{ rightToLeft: ar }] });
  sum.columns = [{ width: 26 }, { width: 60 }];
  [[L.restaurant, name], [L.month, month], [L.rule, L.ruleText(st.rule)], [L.orders, Number(st.totals.orders)],
   [L.whatsapp, Number(st.totals.whatsapp_orders)], [L.qr, Number(st.totals.qr_orders)], [L.sales, Number(st.totals.sales)],
   [L.base, Number(st.totals.base)], [L.feeSum, Number(st.totals.fee)], [L.netSum, Number(st.totals.net)]]
    .forEach(([k, v], i) => { const row = sum.addRow([k, v]); row.getCell(1).font = { bold: true }; if (i >= 6) row.getCell(2).numFmt = '#,##0.00'; });

  const buf = await wb.xlsx.writeBuffer();
  const file = `everwake-bill-${t?.slug || 'restaurant'}-${month || 'period'}.xlsx`;
  return new Response(buf as ArrayBuffer, {
    headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
               'content-disposition': `attachment; filename="${file}"`, 'cache-control': 'no-store' }
  });
}

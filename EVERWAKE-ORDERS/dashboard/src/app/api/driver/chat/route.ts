import { driverCall } from '@/lib/driver-server';

export const dynamic = 'force-dynamic';

// the chat with the customer, through the restaurant's WhatsApp number
export async function GET(req: Request) {
  return driverCall('driver_chat', { p_order: Number(new URL(req.url).searchParams.get('order')) });
}
export async function POST(req: Request) {
  const { order, text } = await req.json();
  return driverCall('driver_send', { p_order: Number(order), p_text: String(text || '') }, { ping: () => true });
}

import { driverCall } from '@/lib/driver-server';

// pick_up (the customer hears who is coming) or delivered
export async function POST(req: Request) {
  const { order, action } = await req.json();
  return driverCall('driver_action', { p_order: Number(order), p_action: String(action) }, { ping: () => true });
}

import { driverCall } from '@/lib/driver-server';

// the phone's position while delivering
export async function POST(req: Request) {
  const { lat, lng, accuracy } = await req.json();
  return driverCall('driver_ping', { p_lat: Number(lat), p_lng: Number(lng), p_accuracy: accuracy == null ? null : Number(accuracy) },
                    { ping: d => Number((d as { notified?: number } | null)?.notified) > 0 });
}

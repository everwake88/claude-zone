import { driverCall } from '@/lib/driver-server';

export const dynamic = 'force-dynamic';
export async function GET() { return driverCall('driver_home'); }

import { NextResponse } from 'next/server';

// for the load balancer / Docker health check
export function GET() {
  return NextResponse.json({ ok: true, at: new Date().toISOString() });
}

'use client';
import { createContext, useContext, useState, type ReactNode } from 'react';
import type { Brand, Role, TenantSummary } from '@/lib/types';

interface Ctx {
  tenant: TenantSummary;
  tenants: TenantSummary[];
  setAgentEnabled: (v: boolean) => void;
  brand: Brand;
  setBrand: (b: Brand) => void;
  role: Role;
  // edit: the catalogue, schedules and settings · owner: the team, WhatsApp, going live ·
  // clinical: medical records · desk: bookings and the waiting room (everyone)
  can: { edit: boolean; owner: boolean; clinical: boolean };
  base: string;                                  // "/c/<slug>"
}
const TenantCtx = createContext<Ctx | null>(null);

// the brand comes from the server with the page, so nothing pops in after it opens;
// Settings → Brand updates it here when it is saved
export function TenantProvider({ tenant, tenants, initialBrand, children }: { tenant: TenantSummary; tenants: TenantSummary[]; initialBrand?: Brand; children: ReactNode }) {
  const [agentEnabled, setAgentEnabled] = useState(tenant.agent_enabled);
  const [brand, setBrand] = useState<Brand>(initialBrand || {});
  const role: Role = tenant.role;
  const value: Ctx = {
    tenant: { ...tenant, agent_enabled: agentEnabled },
    tenants, setAgentEnabled, brand, setBrand, role,
    can: { edit: ['owner', 'manager', 'doctor'].includes(role), owner: role === 'owner', clinical: tenant.clinical },
    base: `/c/${tenant.slug}`
  };
  return <TenantCtx.Provider value={value}>{children}</TenantCtx.Provider>;
}

export function useTenant(): Ctx {
  const v = useContext(TenantCtx);
  if (!v) throw new Error('useTenant outside a clinic');
  return v;
}

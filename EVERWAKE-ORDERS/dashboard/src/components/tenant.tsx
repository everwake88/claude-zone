'use client';
import { createContext, useContext, useState, type ReactNode } from 'react';
import type { Brand, Role, TenantSummary } from '@/lib/types';

interface Ctx {
  tenant: TenantSummary;
  tenants: TenantSummary[];
  setAgentEnabled: (v: boolean) => void;
  brand: Brand;
  setBrand: (b: Brand) => void;
  can: { edit: boolean; owner: boolean };
  base: string;                                  // "/r/<slug>"
}
const TenantCtx = createContext<Ctx | null>(null);

// the brand (logo, colour) comes from the server with the page, so nothing pops in after it opens;
// Settings → Brand updates it here when it is saved
export function TenantProvider({ tenant, tenants, initialBrand, children }: { tenant: TenantSummary; tenants: TenantSummary[]; initialBrand?: Brand; children: ReactNode }) {
  const [agentEnabled, setAgentEnabled] = useState(tenant.agent_enabled);
  const [brand, setBrand] = useState<Brand>(initialBrand || {});
  const role: Role = tenant.role;
  const value: Ctx = {
    tenant: { ...tenant, agent_enabled: agentEnabled },
    tenants,
    setAgentEnabled,
    brand,
    setBrand,
    can: { edit: role === 'owner' || role === 'manager', owner: role === 'owner' },
    base: `/r/${tenant.slug}`
  };
  return <TenantCtx.Provider value={value}>{children}</TenantCtx.Provider>;
}

export function useTenant(): Ctx {
  const v = useContext(TenantCtx);
  if (!v) throw new Error('useTenant outside a restaurant');
  return v;
}

'use client';
import { createContext, useContext, useState, type ReactNode } from 'react';
import type { Role, TenantSummary } from '@/lib/types';

interface Ctx {
  tenant: TenantSummary;
  tenants: TenantSummary[];
  setAgentEnabled: (v: boolean) => void;
  can: { edit: boolean; owner: boolean };
  base: string;                                  // "/r/<slug>"
}
const TenantCtx = createContext<Ctx | null>(null);

export function TenantProvider({ tenant, tenants, children }: { tenant: TenantSummary; tenants: TenantSummary[]; children: ReactNode }) {
  const [agentEnabled, setAgentEnabled] = useState(tenant.agent_enabled);
  const role: Role = tenant.role;
  const value: Ctx = {
    tenant: { ...tenant, agent_enabled: agentEnabled },
    tenants,
    setAgentEnabled,
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

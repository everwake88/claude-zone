'use client';
import { Mail, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, Field, Input, Select, Spinner, useAction } from '@/components/ui';
import { useTenant } from '@/components/tenant';
import { timeAgo } from '@/lib/format';
import { sb } from '@/lib/supabase/client';
import type { Branch, Invite, Member, Role } from '@/lib/types';

const ROLE_HELP: Record<Role, string> = {
  owner: 'Everything, including the team and the WhatsApp number',
  manager: 'Menu, offers, branches, zones, settings, reports',
  staff: 'Orders, the inbox, stock and busy switches, the agent switch'
};

export default function TeamSettings() {
  const { tenant, can } = useTenant();
  const [members, setMembers] = useState<Member[] | null>(null);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('staff');
  const [branch, setBranch] = useState('');
  const { busy, run } = useAction();

  const load = useCallback(async () => {
    const [m, i, b] = await Promise.all([
      sb().from('tenant_members').select('*').eq('tenant_id', tenant.id).order('created_at'),
      can.owner ? sb().from('tenant_invites').select('*').eq('tenant_id', tenant.id).is('accepted_at', null).order('created_at') : Promise.resolve({ data: [] }),
      sb().from('branches').select('*').eq('tenant_id', tenant.id).order('sort')
    ]);
    setMembers((m.data || []) as Member[]); setInvites((i.data || []) as Invite[]); setBranches((b.data || []) as Branch[]);
  }, [tenant.id, can.owner]);
  useEffect(() => { load(); }, [load]);

  const rpc = (fn: string, args: Record<string, unknown>, done: string) => run(async () => {
    const { error } = await sb().rpc(fn, args);
    if (error) throw new Error(error.message);
    await load();
  }, done);

  if (!members) return <Spinner />;
  const bName = (ids: string[] | null) => !ids?.length ? 'All branches' : ids.map(id => branches.find(b => b.id === id)?.name_en || '?').join(', ');

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
      <Card title="Team">
        <ul className="divide-y divide-hairline">
          {members.map(m => (
            <li key={m.user_id} className="flex flex-wrap items-center gap-3 py-3">
              <div className="min-w-48 flex-1">
                <p className="font-medium">{m.display_name || m.email}</p>
                <p className="text-xs text-muted">{m.email} · {bName(m.branch_ids)}</p>
              </div>
              {can.owner ? (
                <>
                  <Select className="w-32" value={m.role} onChange={e => rpc('update_member', { p_tenant: tenant.id, p_user: m.user_id, p_role: e.target.value, p_branch_ids: m.branch_ids, p_display_name: null }, 'Role updated')}>
                    <option value="owner">Owner</option><option value="manager">Manager</option><option value="staff">Staff</option>
                  </Select>
                  {branches.length > 1 && (
                    <Select className="w-40" value={m.branch_ids?.[0] || ''} onChange={e => rpc('update_member', { p_tenant: tenant.id, p_user: m.user_id, p_role: m.role, p_branch_ids: e.target.value ? [e.target.value] : null, p_display_name: null }, 'Branch access updated')}>
                      <option value="">All branches</option>
                      {branches.map(b => <option key={b.id} value={b.id}>{b.name_en || b.name_ar} only</option>)}
                    </Select>
                  )}
                  <Button size="sm" variant="ghost" className="text-critical" onClick={() => rpc('remove_member', { p_tenant: tenant.id, p_user: m.user_id }, 'Removed')}><Trash2 className="size-4" /></Button>
                </>
              ) : <Badge>{m.role}</Badge>}
            </li>
          ))}
        </ul>
      </Card>

      {can.owner && (
        <div className="space-y-4">
          <Card title="Invite someone">
            <div className="space-y-3">
              <Field label="E-mail"><Input type="email" dir="ltr" value={email} onChange={e => setEmail(e.target.value)} /></Field>
              <Field label="Role" hint={ROLE_HELP[role]}>
                <Select value={role} onChange={e => setRole(e.target.value as Role)}><option value="staff">Staff</option><option value="manager">Manager</option><option value="owner">Owner</option></Select>
              </Field>
              {branches.length > 1 && (
                <Field label="Branch" hint="Branch staff see only that branch's orders.">
                  <Select value={branch} onChange={e => setBranch(e.target.value)}><option value="">All branches</option>{branches.map(b => <option key={b.id} value={b.id}>{b.name_en || b.name_ar}</option>)}</Select>
                </Field>
              )}
              <Button variant="gold" busy={busy} onClick={() => rpc('invite_member', { p_tenant: tenant.id, p_email: email, p_role: role, p_branch_ids: branch ? [branch] : null }, 'Invited').then(() => setEmail(''))}>
                <Mail className="size-4" /> Invite
              </Button>
              <p className="text-xs text-muted">Tell them to sign up at this dashboard with this e-mail — they join automatically.</p>
            </div>
          </Card>
          {invites.length > 0 && (
            <Card title="Waiting to join">
              <ul className="space-y-1 text-sm">{invites.map(i => <li key={i.id} className="flex justify-between"><span>{i.email}</span><span className="text-muted">{i.role} · {timeAgo(i.created_at)}</span></li>)}</ul>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

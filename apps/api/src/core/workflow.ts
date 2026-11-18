// Generic multi-agency approval engine (FR-SWN). A document (e.g. a vessel call at stage ARRIVAL) gets one approval row
// per agency configured for the port; when all are APPROVED the owning module's completion hook advances the document.
import type { Agency } from '@pcs/shared';
import { many, type Db } from './db.js';
import type { Actor } from './context.js';
import { notify } from './context.js';

type CompletionHook = (c: Db, actor: Actor, entityId: string, stage: string, outcome: 'APPROVED' | 'REJECTED' | 'QUERY') => Promise<void>;
const hooks = new Map<string, CompletionHook>();

export function onApprovalOutcome(entityType: string, hook: CompletionHook) {
  hooks.set(entityType, hook);
}

export async function openApprovals(c: Db, tenantId: string, entityType: string, entityId: string, stage: string, agencies: Agency[], title: string, link: string) {
  for (const agency of agencies) {
    await c.query(
      `INSERT INTO approvals (tenant_id, entity_type, entity_id, stage, agency) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (entity_type, entity_id, stage, agency) DO UPDATE SET status='PENDING', remarks=NULL, decided_by=NULL, decided_at=NULL
       WHERE approvals.status <> 'APPROVED'`,
      [tenantId, entityType, entityId, stage, agency],
    );
    await notify(c, tenantId, { role: agency }, `Clearance request: ${title}`, `${stage.toLowerCase()} clearance awaiting your decision`, link, 'warning');
  }
}

/** Record a decision and fire the completion hook when the stage is fully decided or blocked. */
export async function decide(c: Db, actor: Actor, approval: any, status: 'APPROVED' | 'REJECTED' | 'QUERY', remarks?: string) {
  await c.query('UPDATE approvals SET status=$2, remarks=$3, decided_by=$4, decided_at=now() WHERE id=$1', [approval.id, status, remarks ?? null, actor.userId]);
  const all = await many(c, 'SELECT status FROM approvals WHERE entity_type=$1 AND entity_id=$2 AND stage=$3', [approval.entity_type, approval.entity_id, approval.stage]);
  const hook = hooks.get(approval.entity_type);
  if (!hook) return;
  if (status === 'REJECTED') return hook(c, actor, approval.entity_id, approval.stage, 'REJECTED');
  if (status === 'QUERY') return hook(c, actor, approval.entity_id, approval.stage, 'QUERY');
  if (all.every((a) => a.status === 'APPROVED')) return hook(c, actor, approval.entity_id, approval.stage, 'APPROVED');
}

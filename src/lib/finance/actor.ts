import { type DbExecutor } from "@/db";
import { auditLog } from "@/db/schema";
import { recordAudit, type AuditActor } from "@/lib/audit";

/**
 * WHO did a finance mutation.
 *
 * Wider than `AdminActor` from @/lib/admin-auth in exactly one way: `userId`
 * may be null, because the renewal cron and the reminder dispatcher act with
 * no signed-in user. `audit_log.actor_user_id` is nullable for that reason.
 * An `AdminActor` is structurally assignable to this, so a server action just
 * passes `await requireStaff()` straight through.
 */
export type FinanceActor = AuditActor;

/** The actor recorded for anything the cron or a background job does. */
export const SYSTEM_ACTOR: FinanceActor = {
  userId: null,
  contactId: null,
  label: "system (cron)",
};

type AuditAction = (typeof auditLog.$inferInsert)["action"];

export interface FinanceAuditInput {
  actor: FinanceActor;
  action: AuditAction;
  entity: string;
  entityId?: string | null;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  db?: DbExecutor;
}

/**
 * Appends one row to the shared audit trail, stamped `module: "finance"`.
 *
 * A thin wrapper over @/lib/audit#recordAudit — there is ONE function in this
 * codebase that writes `audit_log`, and this is not it. This exists only to
 * add the module stamp so a bookkeeper can filter the ledger's own trail out
 * of the general admin trail.
 */
export async function recordFinanceAudit(
  input: FinanceAuditInput,
): Promise<void> {
  await recordAudit({
    ...input,
    metadata: { module: "finance", ...(input.metadata ?? {}) },
  });
}

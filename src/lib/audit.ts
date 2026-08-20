import { db as defaultDb, type DbExecutor } from "@/db";
import { auditLog } from "@/db/schema";

/**
 * WHO did the thing.
 *
 * Wider than `AdminActor` from @/lib/admin-auth in exactly one way: `userId`
 * may be null, because the renewal cron and the reminder dispatcher act with
 * no signed-in user (`audit_log.actor_user_id` is nullable for that reason).
 * An `AdminActor` is structurally assignable to this, so a server action can
 * pass `await requireStaff()` straight through.
 */
export interface AuditActor {
  userId: string | null;
  contactId?: string | null;
  /** Denormalised so the trail survives the user row being deleted. */
  label: string;
}

type AuditAction = (typeof auditLog.$inferInsert)["action"];

export interface RecordAuditInput {
  actor: AuditActor;
  action: AuditAction;
  /** Table name, e.g. "contacts". */
  entity: string;
  entityId?: string | null;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  db?: DbExecutor;
}

/**
 * Append one row to the audit trail.
 *
 * THE single audit writer. Every mutation in the application — admin actions,
 * event actions, and the finance module via recordFinanceAudit() — lands
 * here, inside the same transaction as the write wherever a transaction
 * exists, so the trail can never disagree with the data.
 */
export async function recordAudit(input: RecordAuditInput): Promise<void> {
  const database = input.db ?? defaultDb;
  await database.insert(auditLog).values({
    actorUserId: input.actor.userId,
    actorContactId: input.actor.contactId ?? null,
    actorLabel: input.actor.label,
    action: input.action,
    entity: input.entity,
    entityId: input.entityId ?? null,
    diff: {
      ...(input.before ? { before: input.before } : {}),
      ...(input.after ? { after: input.after } : {}),
    },
    metadata: input.metadata ?? {},
  });
}

/**
 * Narrows a before/after pair to the fields that actually changed, so the
 * audit diff stays readable instead of echoing the whole row.
 */
export function diffFields<T extends Record<string, unknown>>(
  before: T,
  after: Partial<T>,
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const key of Object.keys(after)) {
    const prev = before[key];
    const next = after[key];
    const prevKey = prev instanceof Date ? prev.toISOString() : prev;
    const nextKey = next instanceof Date ? next.toISOString() : next;
    if (JSON.stringify(prevKey ?? null) === JSON.stringify(nextKey ?? null)) {
      continue;
    }
    b[key] = prevKey ?? null;
    a[key] = nextKey ?? null;
  }
  return { before: b, after: a };
}

export function hasChanges(diff: {
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}): boolean {
  return Object.keys(diff.after).length > 0;
}

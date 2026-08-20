import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { auditActionEnum } from "./enums";

/**
 * Append-only audit trail. Every mutating admin action writes one row.
 * `diff` holds { before, after } for the changed fields only.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid().primaryKey().defaultRandom(),

    /** users.id of the actor. Null for system/cron actions. */
    actorUserId: uuid(),
    actorContactId: uuid(),
    /** Denormalised so the trail survives a user deletion. */
    actorLabel: text(),

    action: auditActionEnum().notNull(),
    /** Table name, e.g. "memberships". */
    entity: text().notNull(),
    entityId: uuid(),

    diff: jsonb()
      .$type<{ before?: Record<string, unknown>; after?: Record<string, unknown> }>()
      .notNull()
      .default(sql`'{}'::jsonb`),

    /** Free-form context: request id, reason, bulk-job id. */
    metadata: jsonb()
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),

    ipAddress: text(),
    userAgent: text(),

    at: timestamp({ withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    index("audit_log_entity_entity_id_at_idx").on(t.entity, t.entityId, t.at),
    index("audit_log_actor_at_idx").on(t.actorUserId, t.at),
    index("audit_log_at_idx").on(t.at),
    index("audit_log_action_idx").on(t.action, t.at),
  ],
);

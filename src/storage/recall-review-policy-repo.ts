import type Database from 'better-sqlite3';
import type { GuidanceActionType, RecallReviewPolicy, RecallReviewPolicyType } from '../core/types.js';

interface RecallReviewPolicyRow {
  id: string;
  policy_type: string;
  scope: string | null;
  subject: string | null;
  proposal_type: string | null;
  auto_apply: number;
  created_at: string;
  updated_at: string;
}

export interface RecallReviewPolicyLookup {
  policyType: RecallReviewPolicyType;
  scope: string | null;
  subject: string | null;
  proposalType: GuidanceActionType | null;
}

function rowToRecallReviewPolicy(row: RecallReviewPolicyRow): RecallReviewPolicy {
  return {
    id: row.id,
    policyType: row.policy_type as RecallReviewPolicyType,
    scope: row.scope,
    subject: row.subject,
    proposalType: row.proposal_type as GuidanceActionType | null,
    autoApply: row.auto_apply === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class RecallReviewPolicyRepo {
  constructor(private db: Database.Database) {}

  upsert(policy: RecallReviewPolicy): void {
    this.db.prepare(`
      INSERT INTO recall_review_policies (
        id, policy_type, scope, subject, proposal_type, auto_apply, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        policy_type = excluded.policy_type,
        scope = excluded.scope,
        subject = excluded.subject,
        proposal_type = excluded.proposal_type,
        auto_apply = excluded.auto_apply,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `).run(
      policy.id,
      policy.policyType,
      policy.scope,
      policy.subject,
      policy.proposalType,
      policy.autoApply ? 1 : 0,
      policy.createdAt,
      policy.updatedAt,
    );
  }

  findMatching(lookup: RecallReviewPolicyLookup): RecallReviewPolicy | null {
    const row = this.db.prepare(`
      SELECT * FROM recall_review_policies
      WHERE policy_type = ?
        AND scope IS ?
        AND subject IS ?
        AND proposal_type IS ?
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(
      lookup.policyType,
      lookup.scope,
      lookup.subject,
      lookup.proposalType,
    ) as RecallReviewPolicyRow | undefined;

    return row ? rowToRecallReviewPolicy(row) : null;
  }

  findAll(): RecallReviewPolicy[] {
    const rows = this.db.prepare(
      'SELECT * FROM recall_review_policies ORDER BY updated_at DESC'
    ).all() as RecallReviewPolicyRow[];
    return rows.map(rowToRecallReviewPolicy);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM recall_review_policies WHERE id = ?').run(id);
  }
}

/** WarriorPlus purchase types shared by ingest, the state machine, entitlements and admin. */

import type { WarriorPlusPurchase } from "../config";

export type PurchaseKind = "one_time" | "recurring" | "comp";

export type PurchaseStatus =
  | "active"
  | "refunded"
  | "disputed"
  | "cancelled"
  | "suspended"
  | "ended"
  | "revoked"
  | "needs_review";

export type PurchaseSource = "ipn" | "reconcile" | "comp";

export interface PurchaseRow {
  id: string;
  app: string;
  sale: string;
  item_number: string;
  product_code: string;
  kind: PurchaseKind;
  buyer_email: string;
  tenant_id: string | null;
  workspace_id: string | null;
  status: PurchaseStatus;
  subscr_id: string | null;
  last_payment_num: number | null;
  last_granted_payment_num: number | null;
  current_period_end: string | null;
  expires_at: string | null;
  amount_cents: number | null;
  source: PurchaseSource;
  verified_at: string | null;
  review_reason: string | null;
  comp_reason: string | null;
  granted_by: string | null;
  granted_at: string;
  revoked_at: string | null;
  updated_at: string;
}

export interface IpnEventRow {
  ipn_id: string;
  app: string;
  action: string;
  sale: string | null;
  item_number: string | null;
  subscr_id: string | null;
  payment_num: string | null;
  payload: string;
  status: "pending" | "processed" | "ignored" | "failed" | "needs_review";
  error: string | null;
  attempts: number;
  received_at: string;
  processed_at: string | null;
}

export type IpnPayload = Record<string, string>;

export interface PurchaseState {
  status: PurchaseStatus;
  lastPaymentNum: number | null;
  lastGrantedPaymentNum: number | null;
  currentPeriodEnd: string | null;
  revokedAt: string | null;
  reviewReason: string | null;
}

export type StateEffect =
  | "grant_credits"
  | "revoke_credits"
  | "payment_failed_email"
  | "alert_dispute"
  | "fe_refund_cascade";

export interface StateEvent {
  action: string;
  kind: PurchaseKind;
  paymentNum?: number | null;
  nextPaymentDate?: string | null;
  paymentStatus?: string | null;
  now: string;
}

export interface StateChange {
  state: PurchaseState;
  effects: StateEffect[];
  changed: boolean;
  ignoredReason?: string;
}

/** One room of the admin test window; Send Test is accepted only while this is open. */
export interface TestWindow {
  app: string;
  openedBy: string;
  until: string;
  openedAt: string;
}

/** The public dummy key WarriorPlus's Send Test sends. It is not a secret. */
export const DUMMY_SECURITY_KEY = "abcdefabcdefabcdefabcdefabcdef";

/** The subset the app hooks receive; camelCase, no IPN payload or PII beyond the email. */
export function toWarriorPlusPurchase(row: PurchaseRow): WarriorPlusPurchase {
  return {
    id: row.id,
    app: row.app,
    sale: row.sale,
    itemNumber: row.item_number,
    productCode: row.product_code,
    kind: row.kind,
    buyerEmail: row.buyer_email,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    status: row.status,
    amountCents: row.amount_cents,
    source: row.source,
    verifiedAt: row.verified_at,
  };
}

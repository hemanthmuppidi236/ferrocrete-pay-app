/**
 * Type definitions matching the backend Pydantic schemas.
 * Keep in sync with backend/app/schemas/*.py
 */

// ─── Common ─────────────────────────────────────────────────────

export type UUID = string;
export type ISODate = string;       // "2026-04-30"
export type ISODateTime = string;   // "2026-04-30T15:30:00Z"
export type Money = string;         // Decimal as string, e.g., "1234.56"
export type Period = string;        // "YY-MM", e.g., "26-05"

// ─── User ───────────────────────────────────────────────────────

export type Role = "admin" | "accountant" | "pe" | "viewer";

export interface CurrentUser {
  id: UUID;
  email: string;
  full_name: string | null;
  role: Role;
}

// ─── Project ────────────────────────────────────────────────────

export type ProjectStatus = "active" | "closed" | "on_hold";

export interface Project {
  id: UUID;
  project_no: string;
  name: string;
  address: string | null;
  gc_company: string | null;
  gc_address: string | null;
  gc_contact_name: string | null;
  gc_contact_email: string | null;
  gc_contact_phone: string | null;
  contract_value: Money;
  retention_rate: Money;
  retention_drops_at_50_pct: boolean;
  retention_rate_after_50: Money | null;
  status: ProjectStatus;
  started_at: ISODate | null;
  substantial_completion_at: ISODate | null;
  notes: string | null;
  grace_days: number;
  billing_due_rule: string | null;
  billing_contact: string | null;
  created_by: UUID | null;
  created_at: ISODateTime;
  updated_at: ISODateTime;
}

export interface ProjectCreate {
  project_no: string;
  name: string;
  address?: string;
  gc_company?: string;
  gc_contact_name?: string;
  gc_contact_email?: string;
  gc_contact_phone?: string;
  contract_value?: Money;
  retention_rate?: Money;
  retention_drops_at_50_pct?: boolean;
  retention_rate_after_50?: Money;
  status?: ProjectStatus;
  started_at?: ISODate;
  substantial_completion_at?: ISODate;
  notes?: string;
}

// ─── SOV / CO ───────────────────────────────────────────────────

export interface SOVLine {
  id: UUID;
  project_id: UUID;
  item_no: string | null;
  description: string;
  scheduled_value: Money;
  sort_order: number;
  created_at: ISODateTime;
  updated_at: ISODateTime;
}

export type ChangeOrderStatus = "pending" | "approved" | "rejected" | "void";

export interface ChangeOrder {
  id: UUID;
  project_id: UUID;
  co_no: string;
  description: string;
  amount: Money;
  status: ChangeOrderStatus;
  has_retention: boolean;
  submitted_at: ISODate | null;
  approved_at: ISODate | null;
  notes: string | null;
  created_at: ISODateTime;
  updated_at: ISODateTime;
}

// ─── Pay App ────────────────────────────────────────────────────

export type PayAppStatus =
  | "draft"
  | "pending_approval"
  | "approved"
  | "submitted"
  | "paid"
  | "void";

export interface BillingLine {
  id?: UUID;
  sov_line_id: UUID | null;
  change_order_id: UUID | null;
  previous_work: Money;
  this_period_work: Money;
  materials_stored: Money;
}

export interface PayApp {
  id: UUID;
  project_id: UUID;
  period: Period;
  app_no: number;
  period_to: ISODate;
  due_date: ISODate | null;
  status: PayAppStatus;

  original_contract: Money;
  approved_co_total: Money;
  revised_contract: Money;
  total_completed_to_date: Money;
  retention_held: Money;
  earned_less_retention: Money;
  previous_certificates: Money;
  current_payment_due: Money;
  balance_to_finish: Money;

  // Retention billed this period (#6)
  retention_billed: boolean;
  retention_billed_amount: Money;

  // Workflow timestamps + actors
  submitted_for_approval_at: ISODateTime | null;
  submitted_for_approval_by: UUID | null;
  approved_at: ISODateTime | null;
  approved_by: UUID | null;
  rejected_at: ISODateTime | null;
  rejected_by: UUID | null;
  rejection_reason: string | null;
  sent_to_gc_at: ISODateTime | null;
  sent_to_gc_by: UUID | null;
  sent_to_gc_email: string | null;

  // Legacy single-submit (historical rows from before the approval flow)
  submitted_at: ISODateTime | null;
  submitted_by: UUID | null;

  paid_at: ISODateTime | null;
  paid_amount: Money | null;

  excel_file_path: string | null;
  pdf_file_path: string | null;
  excel_generated_at: ISODateTime | null;
  pdf_generated_at: ISODateTime | null;

  notes: string | null;
  created_at: ISODateTime;
  updated_at: ISODateTime;
}

export interface PayAppDetail extends PayApp {
  billings: BillingLine[];
}

// ─── Subs / Releases ────────────────────────────────────────────

export type ReleaseType = "CP" | "UP" | "CF" | "UF";

export interface Sub {
  id: UUID;
  project_id: UUID;
  name: string;
  parent_sub_id: UUID | null;
  default_release_type: ReleaseType | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  billing_email: string | null;
  billing_cc: string | null;
  is_non_prelimed: boolean;
  sort_order: number;
  active: boolean;
  created_at: ISODateTime;
  updated_at: ISODateTime;
}

export type BillStatus =
  | "not_requested" | "requested" | "received" | "not_applicable";
export type WaiverStatus =
  | "not_requested" | "requested" | "received" | "verified" | "sent_to_gc" | "not_applicable";
export type CheckType = "joint" | "individual" | "none";
export type Stage =
  | "n/a" | "awaiting_bill" | "awaiting_conditional" | "awaiting_gc_payment"
  | "awaiting_check_release" | "awaiting_unconditional" | "complete";

export interface ReleaseLine {
  id: UUID;
  release_tracker_id: UUID;
  sub_id: UUID;
  sub_name: string | null;
  parent_sub_id: UUID | null;
  is_non_prelimed: boolean;
  billed_amount: Money;
  check_amount: Money;
  release_type: ReleaseType | null;
  exception: string | null;
  prev_month_status: string | null;
  // Per-line lifecycle (WI-2)
  bill_status: BillStatus;
  bill_requested_at: ISODate | null;
  bill_received_at: ISODate | null;
  bill_due_at: ISODate | null;
  conditional_status: WaiverStatus;
  conditional_received_at: ISODate | null;
  conditional_sent_at: ISODate | null;
  check_type: CheckType | null;
  check_received_at: ISODate | null;
  check_sent_to_sub_at: ISODate | null;
  unconditional_status: WaiverStatus;
  unconditional_requested_at: ISODate | null;
  unconditional_received_at: ISODate | null;
  unconditional_sent_at: ISODate | null;
  difference_note: string | null;
  // Derived, from the server
  stage: Stage | null;
  is_overdue: boolean;
  has_email: boolean;
  last_reminder: { template_key: ReminderTemplateKey; sent_at: ISODateTime } | null;
  created_at: ISODateTime;
  updated_at: ISODateTime;
}

export type ReminderTemplateKey =
  | "request_bill_cpcf" | "cpcf_overdue" | "request_upuf" | "upuf_overdue";

export interface ReminderRecipient {
  release_line_id: UUID;
  sub_name: string | null;
  to: string | null;
  cc: string | null;
  has_email: boolean;
}

export interface ReminderPreview {
  template_key: ReminderTemplateKey;
  subject: string;
  body: string;
  recipients: ReminderRecipient[];
  skipped: ReminderRecipient[];
}

export interface ReminderSendResult {
  sent: number;
  skipped: number;
  failures: { release_line_id: UUID; error: string }[];
}

export interface ReleaseUnbilledEntry {
  id?: UUID;
  description: string | null;
  amount: Money;
  sort_order: number;
}

export interface ReleaseTracker {
  id: UUID;
  project_id: UUID;
  pay_app_id: UUID | null;
  period: Period;
  invoice_amount: Money | null;
  invoice_amount_overridden: boolean;
  conditional_through_date: ISODate | null;
  requested_releases: boolean;
  verified_releases: boolean;
  approved: boolean;
  sent_to_gc: boolean;
  buildertrend_total: Money | null;
  less_misc_field_expenses: Money | null;
  excel_file_path: string | null;
  excel_generated_at: ISODateTime | null;
  notes: string | null;
  created_at: ISODateTime;
  updated_at: ISODateTime;
  // Derived stage summary (WI-2)
  stage_counts?: Record<string, number> | null;
  applicable_count?: number | null;
  complete_count?: number | null;
  overdue_count?: number | null;
}

export interface ReleaseTrackerDetail extends ReleaseTracker {
  lines: ReleaseLine[];
  unbilled_entries: ReleaseUnbilledEntry[];
  // Ferrocrete's net income = invoice − Σ(sub checks) − Σ(prev-month unbilled).
  // Feeds the Billing Summary's "Potential Net" column.
  ferrocrete_net: Money | null;
  retention_billed_amount: Money | null;
}

export interface Waiver {
  id: UUID;
  release_line_id: UUID;
  waiver_type: ReleaseType;
  file_path: string;
  file_name: string;
  file_size_bytes: number | null;
  mime_type: string | null;
  received_at: ISODate | null;
  uploaded_by: UUID | null;
  uploaded_at: ISODateTime;
  notes: string | null;
}

// ─── BILLING SUMMARY ──────────────────────────────────────────────────

export interface BillingSummaryRow {
  project_id: UUID;
  project_no: string;
  project_name: string;
  job: string;

  // Auto financial columns (from pay app + release tracker)
  revised_contract: Money;
  total_completed: Money;
  retention: Money;
  balance_to_finish: Money;         // H = E − F
  balance_with_retention: Money;    // I = E − F + G
  gross_billing: Money;
  retention_rate: Money;
  billed_amount: Money;
  potential_net: Money | null;
  retention_billed: Money;

  // Manual (auto-defaulted, editable overrides)
  billing_due_date: string;
  bt_note: string;
  rebar: Money | null;
  cmu: Money | null;
  cpcf_sent: string;
  upuf_sent: string;
  billing_contact: string;
  payment_status: string;

  has_pay_app: boolean;
  pay_app_id: UUID | null;
}

export interface BillingSummaryTotals {
  revised_contract: Money;
  total_completed: Money;
  retention: Money;
  balance_to_finish: Money;
  gross_billing: Money;
  billed_amount: Money;
  potential_net: Money;
  rebar: Money;
  cmu: Money;
  retention_billed: Money;
}

export interface BillingSummaryAccrued {
  net: Money;
  billed: Money;
}

export interface BillingSummaryFooter {
  net_pct_of_billed: Money | null;
  quickbooks_total: Money | null;
  quickbooks_diff: Money | null;
  running_total_billed: Money;
  billed_incl_retention: Money;
  net_incl_retention: Money;
}

export interface BillingSummaryResponse {
  period: string | null;
  available_periods: string[];
  rows: BillingSummaryRow[];
  totals: BillingSummaryTotals;
  accrued: BillingSummaryAccrued;
  footer: BillingSummaryFooter;
}

// Editable manual columns for a (project, period) cell-set.
export interface BillingOverridePatch {
  project_id: UUID;
  period: string;
  billing_due_date?: string;
  bt_note?: string;
  rebar?: string | null;
  cmu?: string | null;
  cpcf_sent?: string;
  upuf_sent?: string;
  billing_contact?: string;
  payment_status?: string;
}

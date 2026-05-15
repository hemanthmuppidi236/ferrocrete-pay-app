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

export type PayAppStatus = "draft" | "submitted" | "paid" | "void";

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
  is_non_prelimed: boolean;
  sort_order: number;
  active: boolean;
  created_at: ISODateTime;
  updated_at: ISODateTime;
}

export interface ReleaseLine {
  id: UUID;
  release_tracker_id: UUID;
  sub_id: UUID;
  sub_name: string | null;
  parent_sub_id: UUID | null;
  billed_amount: Money;
  check_amount: Money;
  release_type: ReleaseType | null;
  exception: string | null;
  prev_month_status: string | null;
  created_at: ISODateTime;
  updated_at: ISODateTime;
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
}

export interface ReleaseTrackerDetail extends ReleaseTracker {
  lines: ReleaseLine[];
  unbilled_entries: ReleaseUnbilledEntry[];
}

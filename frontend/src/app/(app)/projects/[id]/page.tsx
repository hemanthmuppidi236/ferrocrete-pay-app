"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, formatApiError } from "@/lib/api";
import type {
  Project,
  SOVLine,
  ChangeOrder,
  ChangeOrderStatus,
  PayApp,
} from "@/lib/types";
import { fmtMoneyShort } from "@/lib/payAppMath";
import { useCurrentUser } from "@/lib/useCurrentUser";

export default function ProjectDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const { id } = params;
  const router = useRouter();
  const { user: currentUser } = useCurrentUser();
  const [project, setProject] = useState<Project | null>(null);
  const [sov, setSov] = useState<SOVLine[] | null>(null);
  const [cos, setCos] = useState<ChangeOrder[] | null>(null);
  const [payApps, setPayApps] = useState<PayApp[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const [editingProject, setEditingProject] = useState(false);
  const [addingCo, setAddingCo] = useState(false);
  const [editingCoId, setEditingCoId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [p, s, c, pa] = await Promise.all([
          api.get<Project>(`/projects/${id}`),
          api.get<SOVLine[]>(`/projects/${id}/sov-lines`),
          api.get<ChangeOrder[]>(`/projects/${id}/change-orders`),
          api.get<PayApp[]>(`/pay-apps?project_id=${id}`),
        ]);
        if (cancelled) return;
        setProject(p);
        setSov(s);
        setCos(c);
        setPayApps(pa);
      } catch (e) {
        if (cancelled) return;
        setError(formatApiError(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  async function reloadCos() {
    try {
      const c = await api.get<ChangeOrder[]>(`/projects/${id}/change-orders`);
      setCos(c);
    } catch (e) {
      setError(formatApiError(e));
    }
  }

  async function reloadPayApps() {
    try {
      const pa = await api.get<PayApp[]>(`/pay-apps?project_id=${id}`);
      setPayApps(pa);
    } catch {
      /* non-fatal */
    }
  }

  async function reloadProject() {
    try {
      const p = await api.get<Project>(`/projects/${id}`);
      setProject(p);
    } catch (e) {
      setError(formatApiError(e));
    }
  }

  if (error && !project) {
    return (
      <div className="page-content">
        <div
          className="glass"
          style={{
            padding: 20,
            borderColor: "rgba(213,59,52,0.30)",
            background: "rgba(213,59,52,0.06)",
          }}
        >
          <div className="form-label" style={{ color: "var(--ferrocrete-red)" }}>
            Error loading project
          </div>
          <div style={{ fontSize: 14 }}>{error}</div>
        </div>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="page-content">
        <div
          className="glass"
          style={{ padding: 32, textAlign: "center", color: "var(--text-muted)" }}
        >
          Loading…
        </div>
      </div>
    );
  }

  const sovTotal = (sov ?? []).reduce(
    (sum, l) => sum + parseFloat(l.scheduled_value || "0"),
    0
  );
  const coTotal = (cos ?? [])
    .filter((c) => c.status === "approved")
    .reduce((sum, c) => sum + parseFloat(c.amount || "0"), 0);
  const revisedContract = parseFloat(project.contract_value) + coTotal;

  const sortedPayApps = [...(payApps ?? [])].sort((a, b) =>
    b.period.localeCompare(a.period)
  );

  async function handleDelete() {
    if (!project) return;
    setDeleting(true);
    try {
      await api.delete(`/projects/${project.id}`);
      router.push("/projects");
    } catch (e) {
      setError(formatApiError(e));
      setDeleting(false);
      setConfirmingDelete(false);
    }
  }

  const canEdit =
    currentUser?.role === "admin" ||
    currentUser?.role === "accountant" ||
    currentUser?.role === "pe";
  const canDeleteCo =
    currentUser?.role === "admin" || currentUser?.role === "accountant";
  const isAdmin = currentUser?.role === "admin";

  return (
    <>
      <div className="page-header">
        <div className="page-title-block">
          <div className="page-eyebrow">PROJECT {project.project_no}</div>
          <h1 className="page-title">{project.name}</h1>
          <div className="page-meta">
            {project.address && <>{project.address} · </>}
            {project.gc_company && (
              <>
                GC <strong>{project.gc_company}</strong> ·{" "}
              </>
            )}
            Contract <strong>{fmtMoneyShort(project.contract_value)}</strong>
            {" · "}Retention{" "}
            <strong>{Math.round(parseFloat(project.retention_rate) * 100)}%</strong>
          </div>
        </div>
        <div className="page-actions">
          {canEdit && !editingProject && (
            <button
              onClick={() => setEditingProject(true)}
              className="btn btn-ghost"
            >
              Edit details
            </button>
          )}
          {isAdmin && (
            confirmingDelete ? (
              <>
                <span
                  style={{
                    fontFamily: "IBM Plex Mono, 'Cascadia Mono', Consolas, 'Courier New', ui-monospace, monospace",
                    fontSize: 11,
                    letterSpacing: 1,
                    color: "var(--ferrocrete-red)",
                    textTransform: "uppercase",
                    marginRight: 10,
                  }}
                >
                  Delete this project?
                </span>
                <button
                  onClick={handleDelete}
                  disabled={deleting}
                  className="btn"
                  style={{
                    color: "#fff",
                    background: "var(--ferrocrete-red)",
                    borderColor: "var(--ferrocrete-red)",
                  }}
                >
                  {deleting ? "Deleting…" : "Yes, delete"}
                </button>
                <button
                  onClick={() => setConfirmingDelete(false)}
                  disabled={deleting}
                  className="btn btn-ghost"
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                onClick={() => setConfirmingDelete(true)}
                className="btn btn-ghost"
                style={{ color: "var(--ferrocrete-red)" }}
                title="Permanently archive this project (admin only)"
              >
                Delete project
              </button>
            )
          )}
        </div>
      </div>

      <div className="page-content">
        {error && project && (
          <div
            className="glass"
            style={{
              padding: 14,
              marginBottom: 16,
              borderColor: "rgba(213,59,52,0.30)",
              background: "rgba(213,59,52,0.06)",
              fontSize: 14,
              color: "var(--ferrocrete-red)",
            }}
          >
            {error}
            <button
              onClick={() => setError(null)}
              style={{
                float: "right",
                background: "none",
                border: "none",
                color: "var(--ferrocrete-red)",
                cursor: "pointer",
              }}
            >
              ✕
            </button>
          </div>
        )}

        {editingProject && (
          <ProjectEditPanel
            project={project}
            onCancel={() => setEditingProject(false)}
            onSaved={async () => {
              await reloadProject();
              setEditingProject(false);
            }}
            onError={(msg) => setError(msg)}
          />
        )}

        <div className="stat-grid">
          <Stat
            label="Original Contract"
            value={fmtMoneyShort(project.contract_value)}
          />
          <Stat label="Approved COs" value={fmtMoneyShort(coTotal)} />
          <Stat label="Revised Contract" value={fmtMoneyShort(revisedContract)} />
        </div>

        {/* Pay Apps section */}
        <div className="section-card glass">
          <div className="section-header">
            <h2 className="section-title">Pay Applications</h2>
            <Link
              href={`/projects/${id}/pay-apps/new`}
              className="btn btn-accent"
            >
              + New Period
            </Link>
          </div>

          {payApps === null ? (
            <div style={{ color: "var(--text-muted)" }}>Loading…</div>
          ) : sortedPayApps.length === 0 ? (
            <div
              style={{
                color: "var(--text-muted)",
                fontSize: 14,
                padding: "16px 0",
              }}
            >
              No pay applications yet. Create one to start billing.
            </div>
          ) : (
            <div className="pay-app-list">
              {sortedPayApps.map((pa) => (
                <Link
                  key={pa.id}
                  href={`/projects/${id}/pay-apps/${pa.period}`}
                  className="pay-app-row"
                >
                  <div className="pay-app-row-left">
                    <div className="pay-app-row-period">{pa.period}</div>
                    <div className="pay-app-row-app-no">App #{pa.app_no}</div>
                  </div>
                  <div className="pay-app-row-right">
                    <div className="pay-app-row-amount">
                      {fmtMoneyShort(pa.current_payment_due)}
                    </div>
                    <PayAppStatusPill status={pa.status} />
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>

        {/* Change Orders section */}
        <div className="section-card glass" style={{ marginTop: 20 }}>
          <div className="section-header">
            <h2 className="section-title">Change Orders</h2>
            {canEdit && !addingCo && (
              <button
                onClick={() => setAddingCo(true)}
                className="btn btn-accent"
              >
                + Add CO
              </button>
            )}
          </div>

          {addingCo && (
            <ChangeOrderForm
              projectId={id}
              initial={null}
              onCancel={() => setAddingCo(false)}
              onSaved={async () => {
                await reloadCos();
                await reloadPayApps();
                setAddingCo(false);
              }}
              onError={(msg) => setError(msg)}
            />
          )}

          {cos === null ? (
            <div style={{ color: "var(--text-muted)" }}>Loading…</div>
          ) : cos.length === 0 ? (
            <div
              style={{
                color: "var(--text-muted)",
                fontSize: 14,
                padding: "16px 0",
              }}
            >
              No change orders yet.
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 560 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border-strong)" }}>
                  <th style={{ ...thStyle, textAlign: "left" }}>CO #</th>
                  <th style={{ ...thStyle, textAlign: "left" }}>Description</th>
                  <th style={thStyle}>Status</th>
                  <th style={thStyle}>Retention</th>
                  <th style={{ ...thStyle, textAlign: "right" }}>Amount</th>
                  {canEdit && <th style={thStyle}></th>}
                </tr>
              </thead>
              <tbody>
                {cos.map((co) =>
                  editingCoId === co.id ? (
                    <tr key={co.id}>
                      <td colSpan={canEdit ? 6 : 5} style={{ padding: 0 }}>
                        <ChangeOrderForm
                          projectId={id}
                          initial={co}
                          onCancel={() => setEditingCoId(null)}
                          onSaved={async () => {
                            await reloadCos();
                            await reloadPayApps();
                            setEditingCoId(null);
                          }}
                          onDelete={
                            canDeleteCo
                              ? async () => {
                                  await reloadCos();
                                  await reloadPayApps();
                                  setEditingCoId(null);
                                }
                              : undefined
                          }
                          onError={(msg) => setError(msg)}
                        />
                      </td>
                    </tr>
                  ) : (
                    <tr
                      key={co.id}
                      style={{ borderBottom: "1px solid var(--border)" }}
                    >
                      <td style={tdMono}>{co.co_no}</td>
                      <td style={tdProse}>{co.description}</td>
                      <td style={{ ...tdMono, textAlign: "right" }}>
                        <CoStatusPill status={co.status} />
                      </td>
                      <td
                        style={{
                          ...tdMono,
                          textAlign: "right",
                          color: co.has_retention
                            ? "var(--text-body)"
                            : "var(--text-muted)",
                        }}
                      >
                        {co.has_retention ? "Yes" : "No"}
                      </td>
                      <td style={{ ...tdMono, textAlign: "right" }}>
                        {fmtMoneyShort(co.amount)}
                      </td>
                      {canEdit && (
                        <td style={{ ...tdMono, textAlign: "right" }}>
                          <button
                            onClick={() => setEditingCoId(co.id)}
                            className="btn btn-ghost"
                            style={{ fontSize: 13, padding: "4px 10px" }}
                          >
                            Edit
                          </button>
                        </td>
                      )}
                    </tr>
                  )
                )}
                <tr>
                  <td colSpan={3} style={{ paddingTop: 14 }}></td>
                  <td style={totalLabelStyle}>Approved total</td>
                  <td style={totalValueStyle}>{fmtMoneyShort(coTotal)}</td>
                  {canEdit && <td></td>}
                </tr>
              </tbody>
            </table>
            </div>
          )}
        </div>

        {/* Sub management + Release trackers section */}
        <div className="section-card glass" style={{ marginTop: 20 }}>
          <div className="section-header">
            <h2 className="section-title">Sub releases & waivers</h2>
          </div>
          <div className="two-col-collapse">
            <Link
              href={`/projects/${id}/subs`}
              style={{
                display: "block",
                padding: 16,
                background: "var(--accent-dim)",
                border: "1px solid var(--accent-border)",
                borderRadius: "var(--radius)",
                textDecoration: "none",
                color: "inherit",
              }}
            >
              <div
                style={{
                  fontFamily: "IBM Plex Mono, 'Cascadia Mono', Consolas, 'Courier New', ui-monospace, monospace",
                  fontSize: 11,
                  letterSpacing: 1.5,
                  textTransform: "uppercase",
                  color: "var(--text-muted)",
                  marginBottom: 6,
                }}
              >
                Subs / Vendors
              </div>
              <div style={{ fontSize: 18, fontWeight: 500 }}>
                Manage sub list →
              </div>
              <div
                style={{
                  fontSize: 13,
                  color: "var(--text-muted)",
                  marginTop: 4,
                }}
              >
                Add, edit, or deactivate subs and vendors for this project.
              </div>
            </Link>

            <Link
              href={`/projects/${id}/releases`}
              style={{
                display: "block",
                padding: 16,
                background: "var(--accent-dim)",
                border: "1px solid var(--accent-border)",
                borderRadius: "var(--radius)",
                textDecoration: "none",
                color: "inherit",
              }}
            >
              <div
                style={{
                  fontFamily: "IBM Plex Mono, 'Cascadia Mono', Consolas, 'Courier New', ui-monospace, monospace",
                  fontSize: 11,
                  letterSpacing: 1.5,
                  textTransform: "uppercase",
                  color: "var(--text-muted)",
                  marginBottom: 6,
                }}
              >
                Release trackers
              </div>
              <div style={{ fontSize: 18, fontWeight: 500 }}>
                View all trackers →
              </div>
              <div
                style={{
                  fontSize: 13,
                  color: "var(--text-muted)",
                  marginTop: 4,
                }}
              >
                Sub billing, checks, release types, and waiver uploads per
                period.
              </div>
            </Link>
          </div>
        </div>

        {/* SOV section */}
        <div className="section-card glass" style={{ marginTop: 20 }}>
          <h2 className="section-title">Schedule of Values</h2>

          {sov === null ? (
            <div style={{ color: "var(--text-muted)" }}>Loading…</div>
          ) : sov.length === 0 ? (
            <div style={{ color: "var(--text-muted)", fontSize: 14 }}>
              No SOV lines yet.
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 520 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border-strong)" }}>
                  <th style={thStyle}>#</th>
                  <th style={{ ...thStyle, textAlign: "left" }}>Description</th>
                  <th style={{ ...thStyle, textAlign: "right" }}>
                    Scheduled Value
                  </th>
                </tr>
              </thead>
              <tbody>
                {sov.map((line) => (
                  <tr
                    key={line.id}
                    style={{ borderBottom: "1px solid var(--border)" }}
                  >
                    <td style={tdMono}>{line.item_no}</td>
                    <td style={tdProse}>{line.description}</td>
                    <td style={{ ...tdMono, textAlign: "right" }}>
                      {fmtMoneyShort(line.scheduled_value)}
                    </td>
                  </tr>
                ))}
                <tr>
                  <td style={{ paddingTop: 14 }}></td>
                  <td style={totalLabelStyle}>Total</td>
                  <td style={totalValueStyle}>{fmtMoneyShort(sovTotal)}</td>
                </tr>
              </tbody>
            </table>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// ─── Project edit panel ──────────────────────────────────────────────

function ProjectEditPanel({
  project,
  onCancel,
  onSaved,
  onError,
}: {
  project: Project;
  onCancel: () => void;
  onSaved: () => Promise<void> | void;
  onError: (msg: string) => void;
}) {
  const [name, setName] = useState(project.name);
  const [address, setAddress] = useState(project.address ?? "");
  const [gcCompany, setGcCompany] = useState(project.gc_company ?? "");
  const [gcContactName, setGcContactName] = useState(
    project.gc_contact_name ?? ""
  );
  const [gcContactEmail, setGcContactEmail] = useState(
    project.gc_contact_email ?? ""
  );
  const [gcContactPhone, setGcContactPhone] = useState(
    project.gc_contact_phone ?? ""
  );
  const [status, setStatus] = useState<Project["status"]>(project.status);
  const [startedAt, setStartedAt] = useState(project.started_at ?? "");
  const [subCompletionAt, setSubCompletionAt] = useState(
    project.substantial_completion_at ?? ""
  );
  const [notes, setNotes] = useState(project.notes ?? "");
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {};
      const setIfChanged = (
        key: string,
        oldVal: unknown,
        newVal: unknown
      ) => {
        if (newVal !== oldVal) payload[key] = newVal;
      };
      setIfChanged("name", project.name, name.trim());
      setIfChanged("address", project.address ?? "", address.trim() || null);
      setIfChanged(
        "gc_company",
        project.gc_company ?? "",
        gcCompany.trim() || null
      );
      setIfChanged(
        "gc_contact_name",
        project.gc_contact_name ?? "",
        gcContactName.trim() || null
      );
      setIfChanged(
        "gc_contact_email",
        project.gc_contact_email ?? "",
        gcContactEmail.trim() || null
      );
      setIfChanged(
        "gc_contact_phone",
        project.gc_contact_phone ?? "",
        gcContactPhone.trim() || null
      );
      setIfChanged("status", project.status, status);
      setIfChanged("started_at", project.started_at ?? "", startedAt || null);
      setIfChanged(
        "substantial_completion_at",
        project.substantial_completion_at ?? "",
        subCompletionAt || null
      );
      setIfChanged("notes", project.notes ?? "", notes.trim() || null);

      if (Object.keys(payload).length === 0) {
        onCancel();
        return;
      }

      await api.patch(`/projects/${project.id}`, payload);
      await onSaved();
    } catch (e) {
      onError(formatApiError(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="section-card glass" style={{ marginBottom: 20 }}>
      <div className="section-header">
        <h2 className="section-title">Edit project details</h2>
      </div>

      <div className="two-col-collapse">
        <Field label="Project name" required>
          <input
            type="text"
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Status">
          <select
            className="input"
            value={status}
            onChange={(e) => setStatus(e.target.value as Project["status"])}
          >
            <option value="active">Active</option>
            <option value="on_hold">On hold</option>
            <option value="closed">Closed</option>
          </select>
        </Field>

        <Field label="Project address" span={2}>
          <input
            type="text"
            className="input"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="Street, City, State Zip"
          />
        </Field>

        <Field label="GC company">
          <input
            type="text"
            className="input"
            value={gcCompany}
            onChange={(e) => setGcCompany(e.target.value)}
          />
        </Field>
        <Field label="GC contact name">
          <input
            type="text"
            className="input"
            value={gcContactName}
            onChange={(e) => setGcContactName(e.target.value)}
          />
        </Field>
        <Field label="GC contact email">
          <input
            type="email"
            className="input"
            value={gcContactEmail}
            onChange={(e) => setGcContactEmail(e.target.value)}
            placeholder="name@company.com"
          />
        </Field>
        <Field label="GC contact phone">
          <input
            type="tel"
            className="input"
            value={gcContactPhone}
            onChange={(e) => setGcContactPhone(e.target.value)}
            placeholder="(555) 123-4567"
          />
        </Field>

        <Field label="Started">
          <input
            type="date"
            className="input"
            value={startedAt}
            onChange={(e) => setStartedAt(e.target.value)}
          />
        </Field>
        <Field label="Substantial completion">
          <input
            type="date"
            className="input"
            value={subCompletionAt}
            onChange={(e) => setSubCompletionAt(e.target.value)}
          />
        </Field>

        <Field label="Notes" span={2}>
          <textarea
            className="input"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            style={{ fontFamily: "inherit", resize: "vertical" }}
          />
        </Field>
      </div>

      <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
        <button onClick={save} disabled={saving} className="btn btn-accent">
          {saving ? "Saving…" : "Save changes"}
        </button>
        <button onClick={onCancel} disabled={saving} className="btn btn-ghost">
          Cancel
        </button>
        <div
          style={{
            marginLeft: "auto",
            fontFamily: "IBM Plex Mono, 'Cascadia Mono', Consolas, 'Courier New', ui-monospace, monospace",
            fontSize: 11,
            color: "var(--text-muted)",
            maxWidth: 320,
            textAlign: "right",
            lineHeight: 1.4,
          }}
        >
          Contract amount &amp; retention rate are locked. Use change orders
          for contract changes.
        </div>
      </div>
    </div>
  );
}

// ─── Change order add/edit form ──────────────────────────────────────

function ChangeOrderForm({
  projectId,
  initial,
  onCancel,
  onSaved,
  onDelete,
  onError,
}: {
  projectId: string;
  initial: ChangeOrder | null;
  onCancel: () => void;
  onSaved: () => Promise<void> | void;
  onDelete?: () => Promise<void> | void;
  onError: (msg: string) => void;
}) {
  const [coNo, setCoNo] = useState(initial?.co_no ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [amount, setAmount] = useState(initial?.amount ?? "");
  const [coStatus, setCoStatus] = useState<ChangeOrderStatus>(
    initial?.status ?? "pending"
  );
  const [hasRetention, setHasRetention] = useState(
    initial?.has_retention ?? true
  );
  const [submittedAt, setSubmittedAt] = useState(initial?.submitted_at ?? "");
  const [approvedAt, setApprovedAt] = useState(initial?.approved_at ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const isEdit = Boolean(initial);

  async function save() {
    setSaving(true);
    try {
      if (isEdit) {
        const payload: Record<string, unknown> = {};
        const setIf = (key: string, oldVal: unknown, newVal: unknown) => {
          if (newVal !== oldVal) payload[key] = newVal;
        };
        setIf("description", initial!.description, description.trim());
        setIf("amount", initial!.amount, amount);
        setIf("status", initial!.status, coStatus);
        setIf("has_retention", initial!.has_retention, hasRetention);
        setIf(
          "submitted_at",
          initial!.submitted_at ?? "",
          submittedAt || null
        );
        setIf("approved_at", initial!.approved_at ?? "", approvedAt || null);
        setIf("notes", initial!.notes ?? "", notes.trim() || null);

        if (Object.keys(payload).length === 0) {
          onCancel();
          return;
        }

        await api.patch(
          `/projects/${projectId}/change-orders/${initial!.id}`,
          payload
        );
      } else {
        if (!coNo.trim()) {
          onError("CO # is required");
          setSaving(false);
          return;
        }
        if (!description.trim()) {
          onError("Description is required");
          setSaving(false);
          return;
        }
        const amountNum = parseFloat(amount);
        if (isNaN(amountNum)) {
          onError("Amount must be a number");
          setSaving(false);
          return;
        }

        const payload: Record<string, unknown> = {
          co_no: coNo.trim(),
          description: description.trim(),
          amount: String(amountNum),
          status: coStatus,
          has_retention: hasRetention,
        };
        if (submittedAt) payload.submitted_at = submittedAt;
        if (approvedAt) payload.approved_at = approvedAt;
        if (notes.trim()) payload.notes = notes.trim();

        await api.post(`/projects/${projectId}/change-orders`, payload);
      }
      await onSaved();
    } catch (e) {
      onError(formatApiError(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!initial || !onDelete) return;
    setSaving(true);
    try {
      await api.delete(`/projects/${projectId}/change-orders/${initial.id}`);
      await onDelete();
    } catch (e) {
      onError(formatApiError(e));
      setConfirmingDelete(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      style={{
        background: "var(--accent-dim)",
        padding: 18,
        margin: isEdit ? "0" : "8px 0 16px",
        borderRadius: "var(--radius)",
        border: "1px solid var(--accent-border)",
      }}
    >
      <div className="two-col-collapse">
        <Field label="CO #" required>
          <input
            type="text"
            className="input"
            value={coNo}
            onChange={(e) => setCoNo(e.target.value)}
            placeholder="001"
            disabled={isEdit}
            title={isEdit ? "CO number can't be changed after creation" : ""}
          />
        </Field>
        <Field label="Amount ($)" required>
          <input
            type="number"
            step="0.01"
            className="input"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
          />
        </Field>

        <Field label="Description" span={2} required>
          <input
            type="text"
            className="input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Brief scope of the change"
          />
        </Field>

        <Field label="Status">
          <select
            className="input"
            value={coStatus}
            onChange={(e) =>
              setCoStatus(e.target.value as ChangeOrderStatus)
            }
          >
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
            <option value="void">Void</option>
          </select>
        </Field>
        <Field label="Retention applies">
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              paddingTop: 10,
            }}
          >
            <input
              type="checkbox"
              checked={hasRetention}
              onChange={(e) => setHasRetention(e.target.checked)}
            />
            <span style={{ fontSize: 14 }}>
              {hasRetention ? "Yes (standard)" : "No (full payment)"}
            </span>
          </label>
        </Field>

        <Field label="Submitted">
          <input
            type="date"
            className="input"
            value={submittedAt}
            onChange={(e) => setSubmittedAt(e.target.value)}
          />
        </Field>
        <Field label="Approved">
          <input
            type="date"
            className="input"
            value={approvedAt}
            onChange={(e) => setApprovedAt(e.target.value)}
          />
        </Field>

        <Field label="Notes" span={2}>
          <textarea
            className="input"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            style={{ fontFamily: "inherit", resize: "vertical" }}
          />
        </Field>
      </div>

      <div
        style={{
          display: "flex",
          gap: 10,
          marginTop: 14,
          alignItems: "center",
        }}
      >
        <button onClick={save} disabled={saving} className="btn btn-accent">
          {saving ? "Saving…" : isEdit ? "Save changes" : "Add change order"}
        </button>
        <button onClick={onCancel} disabled={saving} className="btn btn-ghost">
          Cancel
        </button>

        {isEdit && onDelete && (
          <div style={{ marginLeft: "auto" }}>
            {confirmingDelete ? (
              <>
                <span
                  style={{
                    fontFamily: "IBM Plex Mono, 'Cascadia Mono', Consolas, 'Courier New', ui-monospace, monospace",
                    fontSize: 11,
                    letterSpacing: 1,
                    color: "var(--ferrocrete-red)",
                    textTransform: "uppercase",
                    marginRight: 10,
                  }}
                >
                  Delete CO {initial!.co_no}?
                </span>
                <button
                  onClick={handleDelete}
                  disabled={saving}
                  className="btn"
                  style={{
                    color: "#fff",
                    background: "var(--ferrocrete-red)",
                    borderColor: "var(--ferrocrete-red)",
                  }}
                >
                  Yes, delete
                </button>
                <button
                  onClick={() => setConfirmingDelete(false)}
                  disabled={saving}
                  className="btn btn-ghost"
                  style={{ marginLeft: 6 }}
                >
                  Keep
                </button>
              </>
            ) : (
              <button
                onClick={() => setConfirmingDelete(true)}
                disabled={saving}
                className="btn btn-ghost"
                style={{ color: "var(--ferrocrete-red)" }}
              >
                Delete CO
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Small helpers ───────────────────────────────────────────────────

function Field({
  label,
  required,
  span,
  children,
}: {
  label: string;
  required?: boolean;
  span?: number;
  children: React.ReactNode;
}) {
  return (
    <div style={{ gridColumn: span ? `span ${span}` : undefined }}>
      <label className="form-label">
        {label}
        {required && (
          <span
            style={{
              color: "var(--ferrocrete-red)",
              marginLeft: 4,
              fontWeight: 700,
            }}
          >
            *
          </span>
        )}
      </label>
      {children}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="glass" style={{ padding: 18 }}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
    </div>
  );
}

function PayAppStatusPill({ status }: { status: PayApp["status"] }) {
  const cls: Record<PayApp["status"], string> = {
    draft: "pill-muted",
    pending_approval: "pill-amber",
    approved: "pill-blue",
    submitted: "pill-blue",
    paid: "pill-green",
    void: "pill-red",
  };
  const label: Record<PayApp["status"], string> = {
    draft: "draft",
    pending_approval: "pending approval",
    approved: "approved",
    submitted: "sent to client",
    paid: "paid",
    void: "void",
  };
  return <span className={`pill ${cls[status]}`}>{label[status]}</span>;
}

function CoStatusPill({ status }: { status: ChangeOrderStatus }) {
  const map: Record<ChangeOrderStatus, string> = {
    pending: "pill-amber",
    approved: "pill-green",
    rejected: "pill-muted",
    void: "pill-muted",
  };
  return <span className={`pill ${map[status]}`}>{status}</span>;
}

const thStyle: React.CSSProperties = {
  textAlign: "right",
  padding: "10px 8px",
  fontFamily: "IBM Plex Mono, 'Cascadia Mono', Consolas, 'Courier New', ui-monospace, monospace",
  fontSize: 10,
  letterSpacing: "1.5px",
  textTransform: "uppercase",
  color: "var(--text-muted)",
  fontWeight: 500,
};
const tdMono: React.CSSProperties = {
  padding: "10px 8px",
  fontFamily: "IBM Plex Mono, 'Cascadia Mono', Consolas, 'Courier New', ui-monospace, monospace",
  fontSize: 13,
  color: "var(--text-body)",
};
const tdProse: React.CSSProperties = {
  padding: "10px 8px",
  fontSize: 15,
  color: "var(--text-body)",
};
const totalLabelStyle: React.CSSProperties = {
  paddingTop: 14,
  fontFamily: "IBM Plex Mono, 'Cascadia Mono', Consolas, 'Courier New', ui-monospace, monospace",
  fontSize: 10,
  letterSpacing: "1.5px",
  textTransform: "uppercase",
  color: "var(--text-muted)",
};
const totalValueStyle: React.CSSProperties = {
  paddingTop: 14,
  textAlign: "right",
  fontFamily: "IBM Plex Mono, 'Cascadia Mono', Consolas, 'Courier New', ui-monospace, monospace",
  fontSize: 16,
  fontWeight: 600,
  color: "var(--text-primary)",
};

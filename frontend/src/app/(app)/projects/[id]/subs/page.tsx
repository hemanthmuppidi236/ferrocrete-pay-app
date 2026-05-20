"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api, formatApiError } from "@/lib/api";
import type { Project, Sub, ReleaseType } from "@/lib/types";
import { useCurrentUser } from "@/lib/useCurrentUser";

export default function ProjectSubsPage({
  params,
}: {
  params: { id: string };
}) {
  const { id } = params;
  const { user: currentUser } = useCurrentUser();
  const [project, setProject] = useState<Project | null>(null);
  const [subs, setSubs] = useState<Sub[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);

  const [addingUnder, setAddingUnder] = useState<string | "ROOT" | null>(null);
  const [editingSubId, setEditingSubId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [p, s] = await Promise.all([
          api.get<Project>(`/projects/${id}`),
          api.get<Sub[]>(`/projects/${id}/subs?include_inactive=${showInactive}`),
        ]);
        if (cancelled) return;
        setProject(p);
        setSubs(s);
      } catch (e) {
        if (cancelled) return;
        setError(formatApiError(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, showInactive]);

  async function reloadSubs() {
    try {
      const s = await api.get<Sub[]>(
        `/projects/${id}/subs?include_inactive=${showInactive}`
      );
      setSubs(s);
    } catch (e) {
      setError(formatApiError(e));
    }
  }

  const canEdit =
    currentUser?.role === "admin" ||
    currentUser?.role === "accountant" ||
    currentUser?.role === "pe";
  const canDelete =
    currentUser?.role === "admin" || currentUser?.role === "accountant";

  if (error && !project) {
    return (
      <div className="page-content">
        <ErrorBanner message={error} onDismiss={() => setError(null)} />
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

  // Build tree from flat list. `parent_sub_id` of null = top-level root.
  const subList = subs ?? [];
  const childrenByParent = new Map<string | null, Sub[]>();
  for (const s of subList) {
    const key = s.parent_sub_id ?? null;
    if (!childrenByParent.has(key)) childrenByParent.set(key, []);
    childrenByParent.get(key)!.push(s);
  }
  // Sort each level by sort_order then name
  for (const arr of childrenByParent.values()) {
    arr.sort(
      (a, b) =>
        a.sort_order - b.sort_order || a.name.localeCompare(b.name)
    );
  }
  const roots = childrenByParent.get(null) ?? [];

  return (
    <>
      <div className="page-header">
        <div className="page-title-block">
          <div className="page-eyebrow">PROJECT {project.project_no}</div>
          <h1 className="page-title">Subs / Vendors</h1>
          <div className="page-meta">
            {project.name} ·{" "}
            <Link
              href={`/projects/${id}`}
              style={{ color: "var(--accent-text)" }}
            >
              ← back to project
            </Link>
          </div>
        </div>
        <div className="page-actions">
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 13,
              color: "var(--text-muted)",
            }}
          >
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
            />
            Show inactive
          </label>
          {canEdit && addingUnder !== "ROOT" && (
            <button
              onClick={() => {
                setAddingUnder("ROOT");
                setEditingSubId(null);
              }}
              className="btn btn-accent"
            >
              + Add top-level
            </button>
          )}
        </div>
      </div>

      <div className="page-content">
        {error && (
          <ErrorBanner message={error} onDismiss={() => setError(null)} />
        )}

        {addingUnder === "ROOT" && (
          <SubForm
            projectId={id}
            parentSubId={null}
            initial={null}
            onCancel={() => setAddingUnder(null)}
            onSaved={async () => {
              await reloadSubs();
              setAddingUnder(null);
            }}
            onError={(msg) => setError(msg)}
          />
        )}

        <div className="section-card glass">
          {subs === null ? (
            <div style={{ color: "var(--text-muted)" }}>Loading…</div>
          ) : roots.length === 0 ? (
            <div
              style={{
                color: "var(--text-muted)",
                fontSize: 14,
                padding: "16px 0",
              }}
            >
              No subs yet. Click <strong>+ Add top-level</strong> to start.
            </div>
          ) : (
            <div>
              {roots.map((root) => (
                <SubTreeNode
                  key={root.id}
                  sub={root}
                  childrenByParent={childrenByParent}
                  depth={0}
                  canEdit={canEdit}
                  canDelete={canDelete}
                  editingSubId={editingSubId}
                  addingUnder={addingUnder}
                  onStartEdit={(id) => {
                    setEditingSubId(id);
                    setAddingUnder(null);
                  }}
                  onStartAddUnder={(parentId) => {
                    setAddingUnder(parentId);
                    setEditingSubId(null);
                  }}
                  projectId={id}
                  onChange={reloadSubs}
                  onCancelEdit={() => setEditingSubId(null)}
                  onCancelAdd={() => setAddingUnder(null)}
                  onError={(msg) => setError(msg)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// ─── Recursive tree node ─────────────────────────────────────────────

function SubTreeNode({
  sub,
  childrenByParent,
  depth,
  canEdit,
  canDelete,
  editingSubId,
  addingUnder,
  onStartEdit,
  onStartAddUnder,
  projectId,
  onChange,
  onCancelEdit,
  onCancelAdd,
  onError,
}: {
  sub: Sub;
  childrenByParent: Map<string | null, Sub[]>;
  depth: number;
  canEdit: boolean;
  canDelete: boolean;
  editingSubId: string | null;
  addingUnder: string | "ROOT" | null;
  onStartEdit: (id: string) => void;
  onStartAddUnder: (parentId: string) => void;
  projectId: string;
  onChange: () => Promise<void> | void;
  onCancelEdit: () => void;
  onCancelAdd: () => void;
  onError: (msg: string) => void;
}) {
  const kids = childrenByParent.get(sub.id) ?? [];
  const isEditing = editingSubId === sub.id;
  const isAddingChild = addingUnder === sub.id;

  return (
    <>
      {isEditing ? (
        <div
          style={{
            paddingLeft: depth * 20,
            paddingBottom: 8,
            marginBottom: 8,
            borderBottom: "1px solid var(--border)",
          }}
        >
          <SubForm
            projectId={projectId}
            parentSubId={sub.parent_sub_id}
            initial={sub}
            onCancel={onCancelEdit}
            onSaved={async () => {
              await onChange();
              onCancelEdit();
            }}
            onDelete={
              canDelete
                ? async () => {
                    await onChange();
                    onCancelEdit();
                  }
                : undefined
            }
            onError={onError}
          />
        </div>
      ) : (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "8px 0",
            paddingLeft: depth * 20,
            borderBottom: "1px solid var(--border)",
            opacity: sub.active ? 1 : 0.5,
          }}
        >
          <div style={{ flex: "1 1 auto", minWidth: 0 }}>
            <div
              style={{
                fontFamily: "EB Garamond, Garamond, Cambria, Georgia, 'Times New Roman', serif",
                fontSize: 15,
                fontWeight: 500,
                color: "var(--text-primary)",
                display: "flex",
                alignItems: "baseline",
                gap: 8,
              }}
            >
              {sub.name}
              {!sub.active && (
                <span className="pill pill-muted" style={{ fontSize: 10 }}>
                  inactive
                </span>
              )}
              {sub.is_non_prelimed && (
                <span className="pill pill-amber" style={{ fontSize: 10 }}>
                  non-prelimed
                </span>
              )}
            </div>
            {(sub.contact_name || sub.contact_email || sub.contact_phone) && (
              <div
                style={{
                  fontFamily: "IBM Plex Mono, 'Cascadia Mono', Consolas, 'Courier New', ui-monospace, monospace",
                  fontSize: 11,
                  color: "var(--text-muted)",
                  marginTop: 2,
                }}
              >
                {[sub.contact_name, sub.contact_email, sub.contact_phone]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
            )}
          </div>
          {sub.default_release_type && (
            <span
              style={{
                fontFamily: "IBM Plex Mono, 'Cascadia Mono', Consolas, 'Courier New', ui-monospace, monospace",
                fontSize: 11,
                color: "var(--text-muted)",
                marginRight: 4,
              }}
              title={`Default release type: ${sub.default_release_type}`}
            >
              {sub.default_release_type}
            </span>
          )}
          {canEdit && (
            <>
              <button
                onClick={() => onStartAddUnder(sub.id)}
                className="btn btn-ghost"
                style={{ fontSize: 12, padding: "4px 10px" }}
                title="Add a child under this sub"
              >
                + child
              </button>
              <button
                onClick={() => onStartEdit(sub.id)}
                className="btn btn-ghost"
                style={{ fontSize: 12, padding: "4px 10px" }}
              >
                Edit
              </button>
            </>
          )}
        </div>
      )}

      {isAddingChild && (
        <div
          style={{
            paddingLeft: (depth + 1) * 20,
            paddingBottom: 8,
            marginBottom: 8,
            borderBottom: "1px solid var(--border)",
          }}
        >
          <SubForm
            projectId={projectId}
            parentSubId={sub.id}
            initial={null}
            onCancel={onCancelAdd}
            onSaved={async () => {
              await onChange();
              onCancelAdd();
            }}
            onError={onError}
          />
        </div>
      )}

      {kids.map((child) => (
        <SubTreeNode
          key={child.id}
          sub={child}
          childrenByParent={childrenByParent}
          depth={depth + 1}
          canEdit={canEdit}
          canDelete={canDelete}
          editingSubId={editingSubId}
          addingUnder={addingUnder}
          onStartEdit={onStartEdit}
          onStartAddUnder={onStartAddUnder}
          projectId={projectId}
          onChange={onChange}
          onCancelEdit={onCancelEdit}
          onCancelAdd={onCancelAdd}
          onError={onError}
        />
      ))}
    </>
  );
}

// ─── Sub form (add / edit) ───────────────────────────────────────────

function SubForm({
  projectId,
  parentSubId,
  initial,
  onCancel,
  onSaved,
  onDelete,
  onError,
}: {
  projectId: string;
  parentSubId: string | null;
  initial: Sub | null;
  onCancel: () => void;
  onSaved: () => Promise<void> | void;
  onDelete?: () => Promise<void> | void;
  onError: (msg: string) => void;
}) {
  const isEdit = Boolean(initial);
  const [name, setName] = useState(initial?.name ?? "");
  const [defaultReleaseType, setDefaultReleaseType] = useState<
    ReleaseType | ""
  >((initial?.default_release_type ?? "") as ReleaseType | "");
  const [contactName, setContactName] = useState(initial?.contact_name ?? "");
  const [contactEmail, setContactEmail] = useState(initial?.contact_email ?? "");
  const [contactPhone, setContactPhone] = useState(initial?.contact_phone ?? "");
  const [isNonPrelimed, setIsNonPrelimed] = useState(
    initial?.is_non_prelimed ?? false
  );
  const [active, setActive] = useState(initial?.active ?? true);
  const [saving, setSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  async function save() {
    setSaving(true);
    try {
      if (isEdit) {
        const payload: Record<string, unknown> = {};
        const setIf = (key: string, oldVal: unknown, newVal: unknown) => {
          if (newVal !== oldVal) payload[key] = newVal;
        };
        setIf("name", initial!.name, name.trim());
        setIf(
          "default_release_type",
          initial!.default_release_type ?? "",
          defaultReleaseType || null
        );
        setIf(
          "contact_name",
          initial!.contact_name ?? "",
          contactName.trim() || null
        );
        setIf(
          "contact_email",
          initial!.contact_email ?? "",
          contactEmail.trim() || null
        );
        setIf(
          "contact_phone",
          initial!.contact_phone ?? "",
          contactPhone.trim() || null
        );
        setIf("is_non_prelimed", initial!.is_non_prelimed, isNonPrelimed);
        setIf("active", initial!.active, active);

        if (Object.keys(payload).length === 0) {
          onCancel();
          return;
        }
        await api.patch(`/projects/${projectId}/subs/${initial!.id}`, payload);
      } else {
        if (!name.trim()) {
          onError("Name is required");
          setSaving(false);
          return;
        }
        const payload: Record<string, unknown> = {
          name: name.trim(),
          parent_sub_id: parentSubId,
          is_non_prelimed: isNonPrelimed,
          active: true,
        };
        if (defaultReleaseType) payload.default_release_type = defaultReleaseType;
        if (contactName.trim()) payload.contact_name = contactName.trim();
        if (contactEmail.trim()) payload.contact_email = contactEmail.trim();
        if (contactPhone.trim()) payload.contact_phone = contactPhone.trim();

        await api.post(`/projects/${projectId}/subs`, payload);
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
      await api.delete(`/projects/${projectId}/subs/${initial.id}`);
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
        padding: 14,
        borderRadius: "var(--radius)",
        border: "1px solid var(--accent-border)",
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: "10px 14px",
        }}
      >
        <div style={{ gridColumn: "span 2" }}>
          <label className="form-label">Name *</label>
          <input
            type="text"
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={
              parentSubId ? "Child sub / vendor name" : "Sub or vendor name"
            }
          />
        </div>

        <div>
          <label className="form-label">Default release type</label>
          <select
            className="input"
            value={defaultReleaseType}
            onChange={(e) =>
              setDefaultReleaseType(e.target.value as ReleaseType | "")
            }
          >
            <option value="">— none —</option>
            <option value="CP">CP (Conditional Partial)</option>
            <option value="UP">UP (Unconditional Partial)</option>
            <option value="CF">CF (Conditional Final)</option>
            <option value="UF">UF (Unconditional Final)</option>
          </select>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <label
            className="form-label"
            style={{ visibility: "hidden" }}
          >
            flags
          </label>
          <div style={{ display: "flex", gap: 14, paddingTop: 8 }}>
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontSize: 13,
              }}
            >
              <input
                type="checkbox"
                checked={isNonPrelimed}
                onChange={(e) => setIsNonPrelimed(e.target.checked)}
              />
              Non-prelimed
            </label>
            {isEdit && (
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 13,
                }}
              >
                <input
                  type="checkbox"
                  checked={active}
                  onChange={(e) => setActive(e.target.checked)}
                />
                Active
              </label>
            )}
          </div>
        </div>

        <div>
          <label className="form-label">Contact name</label>
          <input
            type="text"
            className="input"
            value={contactName}
            onChange={(e) => setContactName(e.target.value)}
          />
        </div>
        <div>
          <label className="form-label">Contact email</label>
          <input
            type="email"
            className="input"
            value={contactEmail}
            onChange={(e) => setContactEmail(e.target.value)}
          />
        </div>

        <div style={{ gridColumn: "span 2" }}>
          <label className="form-label">Contact phone</label>
          <input
            type="tel"
            className="input"
            value={contactPhone}
            onChange={(e) => setContactPhone(e.target.value)}
          />
        </div>
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
          {saving ? "Saving…" : isEdit ? "Save" : "Add"}
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
                    marginRight: 8,
                  }}
                >
                  Deactivate?
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
                  Yes
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
                title="Deactivates the sub (preserves release history)"
              >
                Deactivate
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ErrorBanner({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}) {
  return (
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
      {message}
      <button
        onClick={onDismiss}
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
  );
}

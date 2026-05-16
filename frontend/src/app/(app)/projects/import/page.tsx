"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, ApiError } from "@/lib/api";

interface ImportResult {
  project: { id: string; name: string; project_no: string };
  action: string;
  sov_count: number;
  co_count: number;
  pay_app_id?: string;
  pay_app_action?: string;
  warning?: string;
  migration_override?: {
    previous_certificates: string;
    reason: string;
  };
}

export default function ImportProjectPage() {
  const [file, setFile] = useState<File | null>(null);
  const [createPayApp, setCreatePayApp] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(null);
    setResult(null);

    const fd = new FormData();
    fd.append("file", file);

    try {
      const res = await api.post<ImportResult>(
        `/import/pay-app-excel?create_pay_app=${createPayApp}`,
        undefined,
        { formData: fd }
      );
      setResult(res);
    } catch (e) {
      if (e instanceof ApiError) {
        setError(`${e.status}: ${e.detail}`);
      } else {
        setError(String(e));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="page-header">
        <div className="page-title-block">
          <div className="page-eyebrow">FERROCRETE BUILDERS, INC.</div>
          <h1 className="page-title">Import Project</h1>
          <div className="page-meta">
            Upload a pay application <strong>.xlsx</strong> file (AIA G702/G703
            format) to create the project, SOV lines, and change orders.
          </div>
        </div>
      </div>

      <div className="page-content">
        <form onSubmit={submit} className="glass form-card">
          <div className="form-row">
            <label className="form-label">Pay App File</label>
            <input
              type="file"
              accept=".xlsx"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="input"
              required
            />
            {file && (
              <div className="form-help">
                {file.name} ({(file.size / 1024).toFixed(1)} KB)
              </div>
            )}
          </div>

          <div className="form-row">
            <label className="form-checkbox">
              <input
                type="checkbox"
                checked={createPayApp}
                onChange={(e) => setCreatePayApp(e.target.checked)}
              />
              <span>
                Also create the pay app row (with billings populated from the
                file&apos;s D/E/F columns)
              </span>
            </label>
          </div>

          <div className="form-actions">
            <button
              type="submit"
              disabled={!file || busy}
              className="btn btn-accent"
            >
              {busy ? "Importing…" : "Import"}
            </button>
            <Link href="/projects" className="btn btn-ghost">
              Cancel
            </Link>
          </div>
        </form>

        {error && (
          <div
            className="glass form-card"
            style={{
              marginTop: 20,
              borderColor: "rgba(213,59,52,0.30)",
              background: "rgba(213,59,52,0.06)",
            }}
          >
            <div
              className="form-label"
              style={{ color: "var(--ferrocrete-red)" }}
            >
              Import failed
            </div>
            <div style={{ fontSize: 14, color: "var(--text-body)" }}>
              {error}
            </div>
          </div>
        )}

        {result && (
          <div
            className="glass form-card"
            style={{
              marginTop: 20,
              borderColor: "rgba(58,122,86,0.40)",
              background: "rgba(58,122,86,0.06)",
            }}
          >
            <div
              className="form-label"
              style={{ color: "var(--status-green)" }}
            >
              ✓ Imported successfully
            </div>
            <div
              style={{
                fontFamily: "EB Garamond, serif",
                fontSize: 24,
                fontWeight: 500,
                color: "var(--text-primary)",
                marginBottom: 12,
                marginTop: 4,
                letterSpacing: "-0.01em",
              }}
            >
              {result.project.name}
              <span
                style={{
                  marginLeft: 12,
                  fontFamily: "IBM Plex Mono, monospace",
                  fontSize: 14,
                  color: "var(--text-faint)",
                  letterSpacing: "1.5px",
                  textTransform: "uppercase",
                }}
              >
                {result.project.project_no}
              </span>
            </div>
            <ul
              style={{
                fontSize: 14,
                color: "var(--text-body)",
                listStyle: "none",
                lineHeight: 1.8,
                padding: 0,
              }}
            >
              <li>
                Project:{" "}
                <span
                  className="font-mono"
                  style={{ fontSize: 13, color: "var(--text-muted)" }}
                >
                  {result.action}
                </span>
              </li>
              <li>
                {result.sov_count} SOV line
                {result.sov_count === 1 ? "" : "s"}
              </li>
              <li>
                {result.co_count} change order
                {result.co_count === 1 ? "" : "s"}
              </li>
              {result.pay_app_id && (
                <li>
                  Pay app:{" "}
                  <span
                    className="font-mono"
                    style={{ fontSize: 13, color: "var(--text-muted)" }}
                  >
                    {result.pay_app_action}
                  </span>
                </li>
              )}
              {result.warning && (
                <li style={{ color: "var(--status-amber)" }}>
                  ⚠ {result.warning}
                </li>
              )}
              {result.migration_override && (
                <li style={{ color: "var(--accent-text)" }}>
                  ℹ Backfilled <strong>previous certificates</strong> from the
                  file&apos;s 702 sheet:{" "}
                  <span className="font-mono" style={{ fontSize: 13 }}>
                    $
                    {parseFloat(
                      result.migration_override.previous_certificates
                    ).toLocaleString("en-US", { minimumFractionDigits: 2 })}
                  </span>
                  <div
                    style={{
                      fontSize: 12,
                      color: "var(--text-muted)",
                      marginTop: 4,
                    }}
                  >
                    {result.migration_override.reason}
                  </div>
                </li>
              )}
            </ul>
            <div className="form-actions">
              <button
                onClick={() => router.push(`/projects/${result.project.id}`)}
                className="btn btn-accent"
              >
                View Project →
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

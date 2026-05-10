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
    <div className="max-w-2xl">
      <Link
        href="/projects"
        className="text-sm font-mono uppercase tracking-wider mb-6 inline-block"
        style={{ color: "var(--text-muted)", letterSpacing: "0.1em" }}
      >
        ← Back to projects
      </Link>

      <h1
        className="font-display text-4xl mb-2"
        style={{ color: "var(--text-primary)" }}
      >
        Import Project from Excel
      </h1>
      <p className="text-sm mb-8" style={{ color: "var(--text-muted)" }}>
        Upload a pay application <span className="font-mono">.xlsx</span> file
        (G702/G703 format) to create the project, SOV lines, and change orders.
      </p>

      <form onSubmit={submit} className="glass p-8 space-y-6">
        <div>
          <label
            className="block font-mono text-xs uppercase mb-2"
            style={{ color: "var(--text-muted)", letterSpacing: "0.15em" }}
          >
            Pay App File
          </label>
          <input
            type="file"
            accept=".xlsx"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="input"
            required
          />
          {file && (
            <div
              className="mt-2 text-xs font-mono"
              style={{ color: "var(--text-faint)" }}
            >
              {file.name} ({(file.size / 1024).toFixed(1)} KB)
            </div>
          )}
        </div>

        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={createPayApp}
            onChange={(e) => setCreatePayApp(e.target.checked)}
          />
          <span className="text-sm" style={{ color: "var(--text-body)" }}>
            Also create the pay app row (with billings populated from the file's
            D/E/F columns)
          </span>
        </label>

        <div className="flex gap-3">
          <button
            type="submit"
            disabled={!file || busy}
            className="btn btn-accent"
          >
            {busy ? "Importing…" : "Import"}
          </button>
          <Link href="/projects" className="btn">
            Cancel
          </Link>
        </div>
      </form>

      {error && (
        <div
          className="glass p-6 mt-6"
          style={{
            borderColor: "rgba(213,59,52,0.30)",
            background: "rgba(213,59,52,0.06)",
          }}
        >
          <div
            className="font-mono text-xs uppercase mb-2"
            style={{ color: "var(--ferrocrete-red)" }}
          >
            Import failed
          </div>
          <div className="text-sm" style={{ color: "var(--text-body)" }}>
            {error}
          </div>
        </div>
      )}

      {result && (
        <div
          className="glass p-6 mt-6"
          style={{
            borderColor: "rgba(58,122,86,0.40)",
            background: "rgba(58,122,86,0.06)",
          }}
        >
          <div
            className="font-mono text-xs uppercase mb-3"
            style={{ color: "var(--status-green)", letterSpacing: "0.15em" }}
          >
            ✓ Imported successfully
          </div>
          <div
            className="font-display text-2xl mb-3"
            style={{ color: "var(--text-primary)" }}
          >
            {result.project.name}
            <span
              className="ml-3 font-mono text-sm"
              style={{ color: "var(--text-faint)" }}
            >
              {result.project.project_no}
            </span>
          </div>
          <ul className="text-sm space-y-1" style={{ color: "var(--text-body)" }}>
            <li>
              Project: <span className="font-mono">{result.action}</span>
            </li>
            <li>{result.sov_count} SOV line{result.sov_count === 1 ? "" : "s"}</li>
            <li>{result.co_count} change order{result.co_count === 1 ? "" : "s"}</li>
            {result.pay_app_id && (
              <li>
                Pay app: <span className="font-mono">{result.pay_app_action}</span>
              </li>
            )}
            {result.warning && (
              <li style={{ color: "var(--status-amber)" }}>⚠ {result.warning}</li>
            )}
          </ul>
          <button
            onClick={() => router.push(`/projects/${result.project.id}`)}
            className="btn btn-accent mt-5"
          >
            View Project →
          </button>
        </div>
      )}
    </div>
  );
}

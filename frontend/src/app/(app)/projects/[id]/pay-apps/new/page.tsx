"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import type { Project, PayApp } from "@/lib/types";

export default function NewPayAppPage({
  params,
}: {
  params: { id: string };
}) {
  const { id: projectId } = params;
  const router = useRouter();
  const [project, setProject] = useState<Project | null>(null);
  const [existingPayApps, setExistingPayApps] = useState<PayApp[]>([]);
  const [period, setPeriod] = useState<string>(suggestPeriod());
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [p, pas] = await Promise.all([
          api.get<Project>(`/projects/${projectId}`),
          api.get<PayApp[]>(`/pay-apps?project_id=${projectId}`),
        ]);
        setProject(p);
        setExistingPayApps(pas);
        // Suggest next period after the latest existing one
        if (pas.length > 0) {
          const latest = pas
            .map((p) => p.period)
            .sort()
            .reverse()[0];
          setPeriod(nextPeriod(latest));
        }
      } catch (e) {
        setError(e instanceof ApiError ? `${e.status}: ${e.detail}` : String(e));
      }
    })();
  }, [projectId]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!/^\d{2}-\d{2}$/.test(period)) {
      setError("Period must be in format YY-MM, e.g. 26-05");
      return;
    }
    if (existingPayApps.some((p) => p.period === period)) {
      setError(`A pay app for ${period} already exists in this project.`);
      return;
    }

    setError(null);
    setCreating(true);
    try {
      // Compute period_to = last day of the month
      const [yy, mm] = period.split("-").map(Number);
      const year = 2000 + yy;
      const lastDay = new Date(year, mm, 0).getDate();
      const periodTo = `${year}-${String(mm).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

      const nextAppNo =
        existingPayApps.length === 0
          ? 1
          : Math.max(...existingPayApps.map((p) => p.app_no)) + 1;

      const created = await api.post<PayApp>("/pay-apps", {
        project_id: projectId,
        period,
        app_no: nextAppNo,
        period_to: periodTo,
      });
      router.push(`/projects/${projectId}/pay-apps/${created.period}`);
    } catch (e) {
      setError(e instanceof ApiError ? `${e.status}: ${e.detail}` : String(e));
      setCreating(false);
    }
  }

  return (
    <>
      <div className="page-header">
        <div className="page-title-block">
          <div className="page-eyebrow">
            {project ? `PROJECT ${project.project_no}` : "PROJECT"}
          </div>
          <h1 className="page-title">New Pay Application</h1>
          <div className="page-meta">
            {project?.name ?? ""}
          </div>
        </div>
      </div>

      <div className="page-content">
        <form onSubmit={create} className="glass form-card">
          <div className="form-row">
            <label className="form-label">Billing period</label>
            <input
              type="text"
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
              className="input"
              placeholder="YY-MM"
              required
              pattern="\d{2}-\d{2}"
            />
            <div className="form-help">
              Format: YY-MM (e.g. <strong>26-05</strong> for May 2026)
            </div>
          </div>

          <div className="form-actions">
            <button
              type="submit"
              disabled={creating}
              className="btn btn-accent"
            >
              {creating ? "Creating…" : "Create & Open Draft"}
            </button>
            <Link href={`/projects/${projectId}`} className="btn btn-ghost">
              Cancel
            </Link>
          </div>

          {error && (
            <div
              className="login-error"
              style={{ marginTop: 16 }}
            >
              {error}
            </div>
          )}
        </form>
      </div>
    </>
  );
}

function suggestPeriod(): string {
  const now = new Date();
  const yy = String(now.getFullYear() % 100).padStart(2, "0");
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  return `${yy}-${mm}`;
}

function nextPeriod(period: string): string {
  const [yy, mm] = period.split("-").map(Number);
  let nextMm = mm + 1;
  let nextYy = yy;
  if (nextMm > 12) {
    nextMm = 1;
    nextYy += 1;
  }
  return `${String(nextYy).padStart(2, "0")}-${String(nextMm).padStart(2, "0")}`;
}

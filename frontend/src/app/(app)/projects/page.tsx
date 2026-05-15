"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api, ApiError } from "@/lib/api";
import type { Project } from "@/lib/types";

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api.get<Project[]>("/projects");
        if (!cancelled) setProjects(data);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof ApiError ? `${e.status}: ${e.detail}` : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const projectCount = projects?.length ?? 0;

  return (
    <>
      <div className="page-header">
        <div className="page-title-block">
          <div className="page-eyebrow">FERROCRETE BUILDERS, INC.</div>
          <h1 className="page-title">Projects</h1>
          <div className="page-meta">
            {projects === null
              ? "Loading…"
              : (
                <>
                  <strong>{projectCount}</strong>{" "}
                  active {projectCount === 1 ? "project" : "projects"}
                </>
              )}
          </div>
        </div>
        <div className="page-actions">
          <Link href="/projects/import" className="btn btn-ghost">
            Import
          </Link>
          <Link href="/projects/new" className="btn btn-accent">
            + New Project
          </Link>
        </div>
      </div>

      <div className="page-content">
        {error && (
          <div
            className="glass"
            style={{
              padding: 20,
              borderColor: "rgba(213,59,52,0.30)",
              background: "rgba(213,59,52,0.06)",
            }}
          >
            <div
              className="font-mono"
              style={{
                fontSize: 11,
                color: "var(--ferrocrete-red)",
                letterSpacing: "1.5px",
                textTransform: "uppercase",
                marginBottom: 6,
              }}
            >
              Error loading projects
            </div>
            <div style={{ fontSize: 14, color: "var(--text-body)" }}>
              {error}
            </div>
          </div>
        )}

        {projects?.length === 0 && (
          <div className="glass empty-state">
            <h2 className="empty-state-title">No projects yet</h2>
            <p className="empty-state-desc">
              Get started by creating one or importing an existing pay app.
            </p>
            <div className="empty-state-actions">
              <Link href="/projects/new" className="btn btn-accent">
                + Create Project
              </Link>
              <Link href="/projects/import" className="btn">
                Import from Excel
              </Link>
            </div>
          </div>
        )}

        {projects && projects.length > 0 && (
          <div className="project-grid">
            {projects.map((p) => (
              <ProjectCard key={p.id} project={p} />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function ProjectCard({ project }: { project: Project }) {
  return (
    <Link href={`/projects/${project.id}`} className="project-card glass">
      <div className="project-card-header">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="project-card-num">{project.project_no}</div>
          <div className="project-card-name">{project.name}</div>
          {(project.address || project.gc_company) && (
            <div className="project-card-meta">
              {project.address}
              {project.address && project.gc_company && " · "}
              {project.gc_company && <>GC {project.gc_company}</>}
            </div>
          )}
        </div>
        <StatusPill status={project.status} />
      </div>
      <div className="project-card-divider" />
      <div className="project-card-stats">
        <div className="project-card-stat">
          <div className="project-card-stat-label">Contract</div>
          <div className="project-card-stat-value">
            {fmtMoney(project.contract_value)}
          </div>
        </div>
        <div className="project-card-stat">
          <div className="project-card-stat-label">Retention</div>
          <div className="project-card-stat-value">
            {fmtPct(project.retention_rate)}
          </div>
        </div>
      </div>
    </Link>
  );
}

function StatusPill({ status }: { status: Project["status"] }) {
  const map = {
    active: "pill-green",
    closed: "pill-muted",
    on_hold: "pill-amber",
  };
  const label = {
    active: "Active",
    closed: "Closed",
    on_hold: "On Hold",
  };
  return <span className={`pill ${map[status]}`}>{label[status]}</span>;
}

function fmtMoney(v: string | number): string {
  const n = typeof v === "string" ? parseFloat(v) : v;
  if (isNaN(n)) return String(v);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);
}

function fmtPct(v: string | number): string {
  const n = typeof v === "string" ? parseFloat(v) : v;
  if (isNaN(n)) return String(v);
  return `${Math.round(n * 100)}%`;
}

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
        if (e instanceof ApiError) {
          setError(`${e.status}: ${e.detail}`);
        } else {
          setError(String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div>
      <div className="flex items-end justify-between mb-8">
        <div>
          <h1
            className="font-display text-5xl mb-2"
            style={{ color: "var(--text-primary)", letterSpacing: "-0.02em" }}
          >
            Projects
          </h1>
          <p className="text-sm" style={{ color: "var(--text-muted)" }}>
            Active projects across Ferrocrete Builders.
          </p>
        </div>
        <Link href="/projects/new" className="btn btn-accent">
          + New Project
        </Link>
      </div>

      {error && (
        <div
          className="glass p-6 mb-6"
          style={{
            borderColor: "rgba(213,59,52,0.30)",
            background: "rgba(213,59,52,0.06)",
          }}
        >
          <div
            className="font-mono text-xs uppercase mb-1"
            style={{ color: "var(--ferrocrete-red)" }}
          >
            Error loading projects
          </div>
          <div className="text-sm" style={{ color: "var(--text-body)" }}>
            {error}
          </div>
        </div>
      )}

      {projects === null && !error && (
        <div className="glass p-8 text-center" style={{ color: "var(--text-muted)" }}>
          Loading…
        </div>
      )}

      {projects?.length === 0 && (
        <div className="glass p-12 text-center">
          <h2 className="font-display text-2xl mb-3" style={{ color: "var(--text-primary)" }}>
            No projects yet
          </h2>
          <p className="text-sm mb-6" style={{ color: "var(--text-muted)" }}>
            Get started by creating one or importing an existing pay app.
          </p>
          <div className="flex gap-3 justify-center">
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
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {projects.map((p) => (
            <ProjectCard key={p.id} project={p} />
          ))}
        </div>
      )}
    </div>
  );
}

function ProjectCard({ project }: { project: Project }) {
  return (
    <Link href={`/projects/${project.id}`} className="block">
      <div
        className="glass p-6 transition-transform hover:scale-[1.01]"
        style={{ transition: "all 200ms var(--glide)" }}
      >
        <div
          className="font-mono text-xs uppercase mb-2"
          style={{ color: "var(--text-faint)", letterSpacing: "0.15em" }}
        >
          {project.project_no}
        </div>
        <h3
          className="font-display text-2xl mb-3"
          style={{ color: "var(--text-primary)", letterSpacing: "-0.01em" }}
        >
          {project.name}
        </h3>
        <div className="flex items-center justify-between">
          <StatusPill status={project.status} />
          <div
            className="font-mono text-sm"
            style={{ color: "var(--text-body)" }}
          >
            {formatMoney(project.contract_value)}
          </div>
        </div>
        {project.gc_company && (
          <div
            className="text-xs mt-3 pt-3"
            style={{
              color: "var(--text-muted)",
              borderTop: "1px solid var(--border)",
            }}
          >
            {project.gc_company}
          </div>
        )}
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

function formatMoney(value: string): string {
  const n = parseFloat(value);
  if (isNaN(n)) return value;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);
}

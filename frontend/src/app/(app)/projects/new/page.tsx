import Link from "next/link";

export default function NewProjectPage() {
  return (
    <div className="max-w-xl">
      <Link
        href="/projects"
        className="text-sm font-mono uppercase tracking-wider mb-6 inline-block"
        style={{ color: "var(--text-muted)", letterSpacing: "0.1em" }}
      >
        ← Back to projects
      </Link>
      <div className="glass p-10">
        <h1
          className="font-display text-4xl mb-3"
          style={{ color: "var(--text-primary)" }}
        >
          New Project
        </h1>
        <p className="text-sm mb-6" style={{ color: "var(--text-muted)" }}>
          Coming in Phase 1B-β. For now, use the Excel import flow to bring in
          existing projects, or POST directly to the API at <span className="font-mono">/projects</span>.
        </p>
        <Link href="/projects/import" className="btn btn-accent">
          Import from Excel instead
        </Link>
      </div>
    </div>
  );
}

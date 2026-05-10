import Link from "next/link";

export default function NewProjectPage() {
  return (
    <>
      <div className="page-header">
        <div className="page-title-block">
          <div className="page-eyebrow">FERROCRETE BUILDERS, INC.</div>
          <h1 className="page-title">New Project</h1>
          <div className="page-meta">
            Create a project from scratch
          </div>
        </div>
      </div>

      <div className="page-content">
        <div className="glass form-card">
          <p style={{ fontSize: 15, color: "var(--text-body)", marginBottom: 12 }}>
            Manual project creation is coming in Phase 1B-β.
          </p>
          <p
            style={{
              fontSize: 14,
              color: "var(--text-muted)",
              marginBottom: 24,
              lineHeight: 1.55,
            }}
          >
            For now, use the Excel import flow to bring in existing projects
            from your current pay app files.
          </p>
          <div className="form-actions">
            <Link href="/projects/import" className="btn btn-accent">
              Import from Excel
            </Link>
            <Link href="/projects" className="btn btn-ghost">
              Back to projects
            </Link>
          </div>
        </div>
      </div>
    </>
  );
}

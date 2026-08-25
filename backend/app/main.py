"""
FastAPI app entry point.

Run locally:
    uvicorn app.main:app --reload --port 8000

In production (Render):
    uvicorn app.main:app --host 0.0.0.0 --port $PORT
"""

import logging
import uuid
from fastapi import FastAPI, Request, status, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.exceptions import RequestValidationError

from .core.config import settings
from .api import (
    me, projects, sov_lines, change_orders,
    pay_apps, subs, release_trackers, waivers,
    artifacts, email_outbox, import_excel, admin,
    billing_summary,
)


logging.basicConfig(level=settings.log_level)
log = logging.getLogger("ferrocrete")


app = FastAPI(
    title=settings.app_name,
    description="Production API for Ferrocrete pay applications and release trackers.",
    version="0.1.0",
)


# ─── CORS ─────────────────────────────────────────────────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    # CRITICAL: expose these so the browser can read responses; without
    # this Chrome treats some error responses as opaque and surfaces
    # "TypeError: Failed to fetch" to the JS client instead of letting it
    # see the 500 body.
    expose_headers=["X-Error-Id"],
)


# ─── Health check ─────────────────────────────────────────────────────
@app.get("/health", tags=["meta"])
def health():
    return {"status": "ok", "env": settings.app_env, "name": settings.app_name}


# ─── Error handlers ───────────────────────────────────────────────────
@app.exception_handler(RequestValidationError)
async def validation_handler(request: Request, exc: RequestValidationError):
    """Cleaner 422 responses than FastAPI's default."""
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        content={"detail": "Validation error", "errors": exc.errors()},
    )


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    """Pass HTTPException through but log 5xx for visibility."""
    if exc.status_code >= 500:
        log.error(
            "HTTPException %d in %s %s: %s",
            exc.status_code, request.method, request.url.path, exc.detail,
        )
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": exc.detail},
        headers=exc.headers or None,
    )


@app.exception_handler(Exception)
async def fallback_handler(request: Request, exc: Exception):
    """
    Catch-all so we never leak stack traces in prod responses, but log them.

    Includes:
    - An error_id correlation ID logged alongside the traceback so we can
      grep logs for the matching request when a user reports an error.
    - The exception class name (always safe) so debugging is possible
      without seeing the message.
    - In non-production environments, the full str(exc) is included so
      developers can debug locally.
    """
    error_id = uuid.uuid4().hex[:12]
    log.exception(
        "Unhandled %s in %s %s [error_id=%s]",
        type(exc).__name__, request.method, request.url.path, error_id,
    )
    is_dev = settings.app_env in ("development", "dev", "local")
    body = {
        "detail": (
            f"{type(exc).__name__}: {exc}"
            if is_dev
            else f"Server error (id: {error_id}). Check Render logs for [error_id={error_id}]."
        ),
        "error_id": error_id,
        "type": type(exc).__name__,
    }
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content=body,
        headers={"X-Error-Id": error_id},
    )


# ─── Mount routes ─────────────────────────────────────────────────────
app.include_router(me.router)
app.include_router(projects.router)
app.include_router(sov_lines.router)
app.include_router(change_orders.router)
app.include_router(subs.router)
app.include_router(pay_apps.router)
app.include_router(release_trackers.router)
app.include_router(waivers.router)
app.include_router(billing_summary.router)
app.include_router(artifacts.router)
app.include_router(email_outbox.router)
app.include_router(import_excel.router)
app.include_router(admin.router)

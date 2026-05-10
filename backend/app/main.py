"""
FastAPI app entry point.

Run locally:
    uvicorn app.main:app --reload --port 8000

In production (Render):
    uvicorn app.main:app --host 0.0.0.0 --port $PORT
"""

import logging
from fastapi import FastAPI, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.exceptions import RequestValidationError

from .core.config import settings
from .api import (
    me, projects, sov_lines, change_orders,
    pay_apps, subs, release_trackers, waivers,
    artifacts, email_outbox, import_excel,
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


@app.exception_handler(Exception)
async def fallback_handler(request: Request, exc: Exception):
    """Catch-all so we never leak stack traces in prod responses, but log them."""
    log.exception("Unhandled exception in %s %s", request.method, request.url.path)
    if settings.app_env == "development":
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={"detail": str(exc), "type": type(exc).__name__},
        )
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={"detail": "Internal server error"},
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
app.include_router(artifacts.router)
app.include_router(email_outbox.router)
app.include_router(import_excel.router)

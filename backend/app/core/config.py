"""
Application settings, loaded from environment variables (.env in dev, platform vars in prod).
"""

from pydantic_settings import BaseSettings, SettingsConfigDict
from typing import Optional


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # App
    app_env: str = "development"           # development | production
    app_name: str = "Ferrocrete Pay App API"
    log_level: str = "INFO"

    # Supabase
    supabase_url: str
    supabase_anon_key: str                  # for verifying user JWTs
    supabase_service_role_key: str          # for backend writes (bypasses RLS)
    supabase_jwt_secret: str                # for verifying access tokens server-side

    # Storage buckets (created in Supabase Storage)
    bucket_pay_apps: str = "pay-apps"
    bucket_release_trackers: str = "release-trackers"
    bucket_waivers: str = "waivers"

    # CORS
    cors_origins: str = "http://localhost:3000"   # comma-separated

    # Email (Phase 1: just queue to outbox; Phase 2: wire SMTP/Resend)
    email_from: str = "noreply@ferrocretebuilders.com"
    email_provider: str = "outbox_only"     # outbox_only | resend | sendgrid
    resend_api_key: Optional[str] = None

    # Auth domain restriction (signups limited to this domain)
    allowed_email_domain: Optional[str] = None    # e.g., "ferrocretebuilders.com"

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


settings = Settings()

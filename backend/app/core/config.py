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

    # Email
    # email_provider:
    #   - "gmail_api"    — send via Gmail HTTP API as the gmail_sender_email user
    #   - "outbox_only"  — queue to email_outbox table but DON'T send
    # When OAuth credentials are missing the provider is forced to outbox_only
    # regardless of this setting (fail-safe so we never silently drop emails).
    email_from: str = "noreply@ferrocretebuilders.com"
    email_provider: str = "gmail_api"

    # Gmail API (OAuth single-user). Refresh token is obtained once via
    # scripts/get_gmail_refresh_token.py and stored in Render env vars.
    gmail_oauth_client_id: Optional[str] = None
    gmail_oauth_client_secret: Optional[str] = None
    gmail_oauth_refresh_token: Optional[str] = None
    # The Workspace inbox the app sends as (must match the account that
    # granted OAuth consent). Gmail rewrites the From header to this address.
    gmail_sender_email: Optional[str] = None

    # Public URL of the frontend app; used to build deep links inside emails
    # (e.g. "Review pay app: {app_url}/projects/.../pay-apps/...").
    app_url: str = "http://localhost:3000"

    # Auth domain restriction (signups limited to this domain)
    allowed_email_domain: Optional[str] = None    # e.g., "ferrocretebuilders.com"

    @property
    def email_enabled(self) -> bool:
        """True when emails should actually be sent (vs. queued only)."""
        if self.email_provider == "gmail_api":
            return bool(
                self.gmail_oauth_client_id
                and self.gmail_oauth_client_secret
                and self.gmail_oauth_refresh_token
                and self.gmail_sender_email
            )
        return False

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


settings = Settings()

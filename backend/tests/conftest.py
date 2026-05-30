"""
Pytest setup. Two things:

1. Adds the backend root to sys.path so `from app.core...` imports resolve
   when running `pytest` from the backend/ directory.

2. Stubs Supabase env vars so `app.core.config.Settings()` instantiates
   cleanly during import. The pure functions under test don't actually use
   them — but the module-level import chain does.
"""

import os
import sys
from pathlib import Path

os.environ.setdefault("SUPABASE_URL", "http://stub.local")
os.environ.setdefault("SUPABASE_ANON_KEY", "stub")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "stub")
os.environ.setdefault("SUPABASE_JWT_SECRET", "stub")

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

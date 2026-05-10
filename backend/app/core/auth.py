"""
Auth: verify Supabase JWT tokens on protected routes.

Frontend sends `Authorization: Bearer <access_token>` on every API call.
This dependency validates the token and loads the user profile.
"""

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from jose import jwt, JWTError
from typing import Optional
from pydantic import BaseModel

from .config import settings
from .supabase_client import get_service_client


bearer_scheme = HTTPBearer(auto_error=False)


class CurrentUser(BaseModel):
    id: str
    email: str
    full_name: Optional[str] = None
    role: str = "pe"


def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme),
) -> CurrentUser:
    """Validate the access token and return the current user.

    Raises 401 if the token is missing, invalid, expired, or the user isn't
    in app_users (which would mean signup didn't sync correctly).
    """
    if credentials is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing authorization header",
            headers={"WWW-Authenticate": "Bearer"},
        )

    token = credentials.credentials
    try:
        payload = jwt.decode(
            token,
            settings.supabase_jwt_secret,
            algorithms=["HS256"],
            audience="authenticated",
        )
    except JWTError as e:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Invalid token: {e}",
            headers={"WWW-Authenticate": "Bearer"},
        )

    user_id = payload.get("sub")
    email = payload.get("email")
    if not user_id or not email:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token missing required claims",
        )

    # Look up app_users row for role (created automatically by trigger on signup)
    sb = get_service_client()
    res = sb.table("app_users").select("*").eq("id", user_id).limit(1).execute()
    if not res.data:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found in app_users",
        )

    row = res.data[0]
    if row.get("deactivated_at"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Account deactivated",
        )

    return CurrentUser(
        id=row["id"],
        email=row["email"],
        full_name=row.get("full_name"),
        role=row.get("role", "pe"),
    )


def require_role(*allowed_roles: str):
    """Dependency factory for role-gating routes.

    Usage:
        @router.post("/", dependencies=[Depends(require_role("admin", "accountant"))])
        def create_thing(...): ...
    """
    def _check(user: CurrentUser = Depends(get_current_user)):
        if user.role not in allowed_roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Requires one of roles: {', '.join(allowed_roles)}",
            )
        return user
    return _check

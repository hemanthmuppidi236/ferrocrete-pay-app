"""
Current user API. Mostly for the frontend to fetch its own profile after login.
"""

from fastapi import APIRouter, Depends
from ..core.auth import CurrentUser, get_current_user

router = APIRouter(prefix="/me", tags=["me"])


@router.get("", response_model=CurrentUser)
def get_me(user: CurrentUser = Depends(get_current_user)):
    return user

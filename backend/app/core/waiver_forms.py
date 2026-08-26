"""
WI-5: California statutory conditional/unconditional waiver and release forms
(Civil Code 8132 / 8134 / 8136 / 8138), matching the tabs in the reference
pay-app workbook verbatim.

Pure content + field mapping so it is unit-testable without ReportLab. The
PDF renderer in core/pdf_waivers.py consumes build_waiver().

The Claimant is always Ferrocrete Builders (its own release), so that identity
is a constant here. The Customer is the project's GC, the Owner is a project
field, and the Job Location is the project address.
"""

import re
from decimal import Decimal, InvalidOperation

# Ferrocrete's own identity (the Claimant on every one of its releases).
CLAIMANT_NAME = "Ferrocrete Builders, Inc."
CLAIMANT_ADDRESS = "1756 Flower St, Glendale, CA 91201"
CLAIMANT_TITLE = "Project Executive"

WAIVER_TYPES = ("CP", "UP", "CF", "UF")

TITLES = {
    "CP": "CONDITIONAL WAIVER AND RELEASE ON PROGRESS PAYMENT",
    "UP": "UNCONDITIONAL WAIVER AND RELEASE ON PROGRESS PAYMENT",
    "CF": "CONDITIONAL WAIVER AND RELEASE ON FINAL PAYMENT",
    "UF": "UNCONDITIONAL WAIVER AND RELEASE ON FINAL PAYMENT",
}

NOTICE_CONDITIONAL = (
    "NOTICE: THIS DOCUMENT WAIVES THE CLAIMANT'S LIEN, STOP PAYMENT NOTICE, AND "
    "PAYMENT BOND RIGHTS EFFECTIVE ON RECEIPT OF PAYMENT. A PERSON SHOULD NOT "
    "RELY ON THIS DOCUMENT UNLESS SATISFIED THAT THE CLAIMANT HAS RECEIVED PAYMENT."
)
NOTICE_UNCONDITIONAL = (
    "NOTICE TO CLAIMANT: THIS DOCUMENT WAIVES AND RELEASES LIEN, STOP PAYMENT "
    "NOTICE, AND PAYMENT BOND RIGHTS UNCONDITIONALLY AND STATES THAT YOU HAVE "
    "BEEN PAID FOR GIVING UP THOSE RIGHTS. THIS DOCUMENT IS ENFORCEABLE AGAINST "
    "YOU IF YOU SIGN IT, EVEN IF YOU HAVE NOT BEEN PAID. IF YOU HAVE NOT BEEN "
    "PAID, USE A CONDITIONAL WAIVER AND RELEASE FORM."
)
NOTICES = {"CP": NOTICE_CONDITIONAL, "UP": NOTICE_UNCONDITIONAL,
           "CF": NOTICE_CONDITIONAL, "UF": NOTICE_UNCONDITIONAL}

BODY = {
    "CP": (
        "This document waives and releases lien, stop payment notice, and "
        "payment bond rights the claimant has for labor and service provided, "
        "and equipment and material delivered, to the customer on this job "
        "through the Through Date of this document. Rights based upon labor or "
        "service provided, or equipment or material delivered, pursuant to a "
        "written change order that has been fully executed by the parties prior "
        "to the date that this document is signed by the claimant, are waived "
        "and released by this document, unless listed as an Exception below. "
        "This document is effective only on the claimant's receipt of payment "
        "from the financial institution on which the following check is drawn:"
    ),
    "UP": (
        "This document waives and releases lien, stop payment notice, and "
        "payment bond rights the claimant has for labor and service provided, "
        "and equipment and material delivered, to the customer on this job "
        "through the Through Date of this document. Rights based upon labor or "
        "service provided, or equipment or material delivered, pursuant to a "
        "written change order that has been fully executed by the parties prior "
        "to the date that this document is signed by the claimant, are waived "
        "and released by this document, unless listed as an Exception below. "
        "The claimant has received the following progress payment:"
    ),
    "CF": (
        "This document waives and releases lien, stop payment notice, and "
        "payment bond rights the claimant has for labor and service provided, "
        "and equipment and material delivered, to the customer on this job. "
        "Rights based upon labor or service provided, or equipment or material "
        "delivered, pursuant to a written change order that has been fully "
        "executed by the parties prior to the date that this document is signed "
        "by the claimant, are waived and released by this document, unless "
        "listed as an Exception below. This document is effective only on the "
        "claimant's receipt of payment from the financial institution on which "
        "the following check is drawn:"
    ),
    "UF": (
        "This document waives and releases lien, stop payment notice, and "
        "payment bond rights the claimant has for all labor and service "
        "provided, and equipment and material delivered, to the customer on "
        "this job. Rights based upon labor or service provided, or equipment or "
        "material delivered, pursuant to a written change order that has been "
        "fully executed by the parties prior to the date that this document is "
        "signed by the claimant, are waived and released by this document, "
        "unless listed as an Exception below. The claimant has been paid in full."
    ),
}

EXCEPTIONS = {
    "CP": [
        "This document does not affect any of the following:",
        "(1) Retentions.",
        "(2) Extras for which the claimant has not received payment.",
        "(3) The following progress payments for which the claimant has "
        "previously given a conditional waiver and release but has not received "
        "payment:",
        "Date(s) of waiver and release: ____________________",
        "Amount(s) of unpaid progress payment(s): $____________________",
        "(4) Contract rights, including (A) a right based on rescission, "
        "abandonment, or breach of contract, and (B) the right to recover "
        "compensation for work not compensated by the payment.",
    ],
    "UP": [
        "This document does not affect any of the following:",
        "(1) Retentions.",
        "(2) Extras for which the claimant has not received payment.",
        "(3) Contract rights, including (A) a right based on rescission, "
        "abandonment, or breach of contract, and (B) the right to recover "
        "compensation for work not compensated by the payment.",
    ],
    "CF": [
        "This document does not affect any of the following:",
        "Disputed claims for extras in the amount of: $____________________",
    ],
    "UF": [
        "This document does not affect any of the following:",
        "Disputed claims for extras in the amount of: $____________________",
    ],
}

# Which fields each form shows.
HAS_THROUGH_DATE = {"CP": True, "UP": True, "CF": False, "UF": False}
HAS_CHECK_BLOCK = {"CP": True, "UP": False, "CF": True, "UF": False}   # Maker/Payable
SHOWS_AMOUNT = {"CP": True, "UP": True, "CF": True, "UF": False}


def _money(x) -> str:
    try:
        d = Decimal(str(x if x not in (None, "") else "0"))
    except (InvalidOperation, ValueError, TypeError):
        d = Decimal("0")
    return f"${d:,.2f}"


def _safe(s) -> str:
    return re.sub(r'[\\/:*?"<>|]+', "", str(s or "")).strip()


def build_waiver(waiver_type: str, *, project: dict, pay_app: dict) -> dict:
    """Return the fully-mapped field set for one waiver form.

    Matches the native form: the name fields show names only (no address);
    Job Location carries the full job address.

    project: needs name, project_no, gc_company, address, owner_name.
    pay_app: needs app_no, period, period_to, current_payment_due.
    """
    wt = waiver_type.upper()
    if wt not in WAIVER_TYPES:
        raise ValueError(f"Unknown waiver type: {waiver_type}")

    customer = project.get("gc_company") or ""      # Name of Customer (GC), name only
    owner = project.get("owner_name") or ""         # Owner, name only
    amount = _money(pay_app.get("current_payment_due"))

    # Filename includes project name + application number, per request.
    app_no = pay_app.get("app_no")
    app_part = f"App{app_no}" if app_no not in (None, "") else (pay_app.get("period") or "")
    filename = "_".join(p for p in [
        _safe(project.get("project_no")), _safe(project.get("name")),
        app_part, "Ferrocrete", wt,
    ] if p) + ".pdf"

    return {
        "waiver_type": wt,
        "title": TITLES[wt],
        "notice": NOTICES[wt],
        "body": BODY[wt],
        "exceptions": list(EXCEPTIONS[wt]),

        "claimant_name": CLAIMANT_NAME,       # name only, matches native
        "customer": customer,                 # Name of Customer (GC), name only
        "job_location": project.get("address") or "",
        "owner": owner,
        "through_date": pay_app.get("period_to") if HAS_THROUGH_DATE[wt] else None,

        "has_check_block": HAS_CHECK_BLOCK[wt],
        "maker_of_check": customer if HAS_CHECK_BLOCK[wt] else None,
        "check_payable_to": CLAIMANT_NAME if HAS_CHECK_BLOCK[wt] else None,
        "shows_amount": SHOWS_AMOUNT[wt],
        "amount_of_check": amount if SHOWS_AMOUNT[wt] else None,

        "claimant_title": CLAIMANT_TITLE,
        "date_of_signature": None,            # dated by hand (no signature added)

        "filename": filename,
    }

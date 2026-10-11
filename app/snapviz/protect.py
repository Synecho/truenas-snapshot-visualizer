"""Snapshots that TrueNAS manages itself and that the app must never delete.

* boot environments (boot-pool / freenas-boot): manage them under System > Boot
* the system dataset (.system)
* the apps datasets (.ix-apps, legacy ix-applications): TrueNAS creates and removes these snapshots

Patterns are globs matched against the full dataset name (`*` also matches `/`).
The same patterns are sent to the frontend, which greys out the delete button.
"""

from __future__ import annotations

from fnmatch import fnmatchcase

MANAGED_PATTERNS: dict[str, list[str]] = {
    "boot": ["boot-pool", "boot-pool/*", "freenas-boot", "freenas-boot/*"],
    "system": ["*/.system", "*/.system/*"],
    "apps": ["*/.ix-apps", "*/.ix-apps/*", "*/ix-applications", "*/ix-applications/*"],
}


def managed_reason(dataset: str) -> str | None:
    """Return 'boot', 'system' or 'apps' if TrueNAS manages snapshots of this dataset."""
    for reason, patterns in MANAGED_PATTERNS.items():
        if any(fnmatchcase(dataset, p) for p in patterns):
            return reason
    return None

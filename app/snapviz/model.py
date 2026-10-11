"""Normalised data model shared by all sources and the frontend."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field


@dataclass
class Dataset:
    name: str
    type: str = "FILESYSTEM"  # FILESYSTEM | VOLUME
    used: int | None = None
    usedbysnapshots: int | None = None
    usedbydataset: int | None = None
    usedbychildren: int | None = None
    available: int | None = None
    referenced: int | None = None


@dataclass
class Snapshot:
    dataset: str
    name: str  # part after "@"
    creation: int | None = None  # unix seconds
    used: int | None = None  # space unique to this snapshot
    referenced: int | None = None
    written: int | None = None  # written since previous snapshot
    holds: int = 0

    @property
    def full_name(self) -> str:
        return f"{self.dataset}@{self.name}"


@dataclass
class SnapshotReport:
    source: str
    datasets: list[Dataset] = field(default_factory=list)
    snapshots: list[Snapshot] = field(default_factory=list)
    fetched_at: float = 0.0
    duration: float = 0.0
    host: str | None = None
    connection: str | None = None  # e.g. "socket (root)" or "API key"
    warnings: list[str] = field(default_factory=list)

    def to_json(self) -> dict:
        # Snapshots are sent column-wise-ish as compact lists to keep the payload
        # small on systems with tens of thousands of snapshots.
        return {
            "source": self.source,
            "host": self.host,
            "connection": self.connection,
            "fetched_at": self.fetched_at,
            "duration": round(self.duration, 3),
            "warnings": self.warnings,
            "datasets": [asdict(d) for d in self.datasets],
            "snapshot_fields": ["dataset", "name", "creation", "used", "referenced", "written", "holds"],
            "snapshots": [
                [s.dataset, s.name, s.creation, s.used, s.referenced, s.written, s.holds]
                for s in self.snapshots
            ],
        }


def ensure_datasets(report: SnapshotReport) -> None:
    """Make sure every dataset referenced by a snapshot (and all its parents) exists."""
    known = {d.name for d in report.datasets}
    needed: set[str] = set()
    for s in report.snapshots:
        parts = s.dataset.split("/")
        for i in range(1, len(parts) + 1):
            needed.add("/".join(parts[:i]))
    for name in sorted(needed - known):
        report.datasets.append(Dataset(name=name))
    report.datasets.sort(key=lambda d: d.name)

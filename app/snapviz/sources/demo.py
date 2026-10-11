"""Synthetic but realistic snapshot data for trying the UI without a TrueNAS box."""

from __future__ import annotations

import random
import time

from ..model import Dataset, Snapshot, SnapshotReport, ensure_datasets

GiB = 1024**3
MiB = 1024**2

# dataset -> (size of live data, daily churn ratio, snapshot schedules)
LAYOUT = {
    "tank": (2 * GiB, 0.001, ["daily"]),
    "tank/media": (0, 0.0, []),
    "tank/media/movies": (3800 * GiB, 0.002, ["daily", "monthly"]),
    "tank/media/music": (420 * GiB, 0.001, ["daily", "monthly"]),
    "tank/media/photos": (910 * GiB, 0.004, ["hourly", "daily", "weekly", "monthly"]),
    "tank/home": (0, 0.0, []),
    "tank/home/anna": (180 * GiB, 0.02, ["hourly", "daily", "weekly"]),
    "tank/home/ben": (95 * GiB, 0.03, ["hourly", "daily", "weekly"]),
    "tank/vm": (0, 0.0, []),
    "tank/vm/win11": (120 * GiB, 0.08, ["hourly", "daily"]),
    "tank/vm/homeassistant": (32 * GiB, 0.05, ["hourly", "daily", "weekly"]),
    "tank/apps": (0, 0.0, []),
    "tank/apps/nextcloud": (640 * GiB, 0.015, ["hourly", "daily", "weekly", "monthly"]),
    "tank/apps/immich": (1250 * GiB, 0.01, ["daily", "weekly", "monthly"]),
    "tank/apps/postgres": (18 * GiB, 0.25, ["hourly", "daily"]),
    "tank/backup": (0, 0.0, []),
    "tank/backup/laptops": (1500 * GiB, 0.03, ["daily", "weekly", "monthly"]),
    "backup": (1 * GiB, 0.0, []),
    "backup/replica": (0, 0.0, []),
    "backup/replica/photos": (905 * GiB, 0.004, ["daily", "weekly", "monthly", "yearly"]),
    "backup/replica/nextcloud": (630 * GiB, 0.015, ["daily", "weekly", "monthly", "yearly"]),
}

VOLUMES = {"tank/vm/win11", "tank/vm/homeassistant"}

# schedule -> (interval seconds, keep count, name pattern)
SCHEDULES = {
    "hourly": (3600, 48, "auto-hourly-%Y-%m-%d_%H-%M"),
    "daily": (86400, 30, "auto-daily-%Y-%m-%d_00-00"),
    "weekly": (7 * 86400, 12, "auto-weekly-%Y-%m-%d_00-00"),
    "monthly": (30 * 86400, 12, "auto-monthly-%Y-%m-01_00-00"),
    "yearly": (365 * 86400, 4, "auto-yearly-%Y-01-01_00-00"),
}


def generate(seed: int = 42) -> SnapshotReport:
    rng = random.Random(seed)
    now = int(time.time())
    report = SnapshotReport(source="demo", host="demo")

    for ds_name, (size, churn, schedules) in LAYOUT.items():
        snaps: list[Snapshot] = []
        for sched in schedules:
            interval, keep, pattern = SCHEDULES[sched]
            # align to interval
            last = now - (now % interval)
            for i in range(keep):
                ts = last - i * interval
                age_days = (now - ts) / 86400
                # newer snapshots hold little unique data, very old ones accumulate
                # deleted/overwritten blocks -> lognormal noise times churn
                base = size * churn * min(interval / 86400, 7) ** 0.7 * 0.35 * rng.lognormvariate(0, 0.8)
                used = int(min(base * (0.3 + min(age_days, 400) / 300), size * 0.06))
                snaps.append(
                    Snapshot(
                        dataset=ds_name,
                        name=time.strftime(pattern, time.gmtime(ts)),
                        creation=ts + rng.randint(0, 90),
                        used=max(used, 0 if rng.random() < 0.15 else 64 * 1024),
                        referenced=int(size * rng.uniform(0.85, 1.0)),
                        written=int(size * churn * rng.lognormvariate(-0.5, 1.0)),
                        holds=1 if sched == "yearly" and i == 0 else 0,
                    )
                )
        # a few forgotten manual snapshots (the classic disk-space eaters)
        if size > 100 * GiB and rng.random() < 0.45:
            for _ in range(rng.randint(1, 3)):
                ts = now - rng.randint(120, 900) * 86400
                snaps.append(
                    Snapshot(
                        dataset=ds_name,
                        name=rng.choice(["manual", "before-upgrade", "pre-migration", "test"])
                        + time.strftime("-%Y%m%d", time.gmtime(ts)),
                        creation=ts,
                        used=int(size * rng.uniform(0.02, 0.12)),
                        referenced=int(size * rng.uniform(0.6, 0.95)),
                        written=int(size * rng.uniform(0.01, 0.1)),
                    )
                )

        # de-duplicate names produced by overlapping schedules
        seen: set[str] = set()
        unique = []
        for s in sorted(snaps, key=lambda s: s.creation or 0):
            if s.name not in seen:
                seen.add(s.name)
                unique.append(s)
        report.snapshots.extend(unique)

        snap_used = sum(s.used or 0 for s in unique)
        # blocks shared by >1 snapshot are only visible in usedbysnapshots
        usedbysnapshots = int(snap_used * rng.uniform(1.15, 1.6)) if unique else 0
        report.datasets.append(
            Dataset(
                name=ds_name,
                type="VOLUME" if ds_name in VOLUMES else "FILESYSTEM",
                usedbydataset=size,
                usedbysnapshots=usedbysnapshots,
                referenced=size,
            )
        )

    ensure_datasets(report)
    _roll_up(report, rng)
    return report


def _roll_up(report: SnapshotReport, rng: random.Random) -> None:
    by_name = {d.name: d for d in report.datasets}
    for d in sorted(report.datasets, key=lambda d: -d.name.count("/")):
        children = [c for n, c in by_name.items() if n.startswith(d.name + "/") and n.count("/") == d.name.count("/") + 1]
        d.usedbydataset = d.usedbydataset or 0
        d.usedbysnapshots = d.usedbysnapshots or 0
        d.usedbychildren = sum(c.used or 0 for c in children)
        d.used = d.usedbydataset + d.usedbysnapshots + d.usedbychildren
    pool_size = {"tank": 16 * 1024 * GiB, "backup": 8 * 1024 * GiB}
    for d in report.datasets:
        pool = d.name.split("/")[0]
        d.available = max(pool_size.get(pool, 0) - (by_name[pool].used or 0), 0)


class DemoSource:
    """Demo data that remembers deletions, so the delete workflow can be tried safely."""

    name = "demo"

    def __init__(self) -> None:
        self._deleted: set[str] = set()

    async def fetch(self) -> SnapshotReport:
        report = generate()
        if self._deleted:
            freed: dict[str, int] = {}
            kept = []
            for s in report.snapshots:
                if s.full_name in self._deleted:
                    freed[s.dataset] = freed.get(s.dataset, 0) + (s.used or 0)
                else:
                    kept.append(s)
            report.snapshots = kept
            for d in report.datasets:
                if d.name in freed and d.usedbysnapshots is not None:
                    d.usedbysnapshots = max(0, d.usedbysnapshots - freed[d.name])
        return report

    async def delete(self, snapshot_ids: list[str]) -> list[dict]:
        held = {s.full_name for s in generate().snapshots if s.holds}
        results = []
        for snap_id in snapshot_ids:
            if snap_id in held:
                results.append({"id": snap_id, "ok": False, "error": "snapshot has holds (dataset is busy)"})
            else:
                self._deleted.add(snap_id)
                results.append({"id": snap_id, "ok": True, "error": None})
        return results

    async def close(self) -> None:
        pass

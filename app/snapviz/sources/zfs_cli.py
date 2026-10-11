"""Read snapshots via the local `zfs` binary, or parse pasted `zfs list` output.

Expected command output (tab separated, -H -p):

    zfs list -Hp -t snapshot -o name,used,referenced,written,creation,userrefs
    zfs list -Hp -t filesystem,volume -o name,type,used,usedbysnapshots,usedbydataset,usedbychildren,available,referenced
"""

from __future__ import annotations

import asyncio
import re
import shutil
import time

from ..model import Dataset, Snapshot, SnapshotReport, ensure_datasets

SNAPSHOT_CMD = ["zfs", "list", "-Hp", "-t", "snapshot", "-o", "name,used,referenced,written,creation,userrefs"]
DATASET_CMD = [
    "zfs", "list", "-Hp", "-t", "filesystem,volume",
    "-o", "name,type,used,usedbysnapshots,usedbydataset,usedbychildren,available,referenced",
]

_SIZE_RE = re.compile(r"^([\d.]+)([KMGTPE]?)i?B?$", re.I)
_UNITS = {"": 1, "K": 1024, "M": 1024**2, "G": 1024**3, "T": 1024**4, "P": 1024**5, "E": 1024**6}


def _num(value: str) -> int | None:
    """Parse '12345', '1.5G' or '-' into bytes."""
    value = value.strip()
    if value in ("", "-", "none"):
        return None
    if value.isdigit():
        return int(value)
    m = _SIZE_RE.match(value)
    if m:
        return int(float(m.group(1)) * _UNITS[m.group(2).upper()])
    return None


def _time(value: str) -> int | None:
    value = value.strip()
    if value.isdigit():
        return int(value)
    for fmt in ("%a %b %d %H:%M %Y", "%a %b %d %H:%M:%S %Y"):
        try:
            return int(time.mktime(time.strptime(" ".join(value.split()), fmt)))
        except ValueError:
            pass
    return None


def parse_listing(text: str, source: str = "import") -> SnapshotReport:
    """Parse mixed snapshot / dataset listings.

    Lines whose first column contains '@' are snapshots
    (name, used, referenced, written, creation[, userrefs]); other lines are
    datasets (name, type, used, usedbysnapshots, usedbydataset, usedbychildren,
    available, referenced). A header line (NAME ...) is ignored. Columns may be
    separated by tabs or runs of spaces (non -H output); in that case the
    human readable creation date is also understood.
    """
    report = SnapshotReport(source=source)
    for raw in text.splitlines():
        line = raw.rstrip("\r\n")
        if not line.strip() or line.lstrip().upper().startswith("NAME"):
            continue
        cols = line.split("\t") if "\t" in line else line.split()
        name = cols[0].strip()
        if "@" in name:
            dataset, snap = name.split("@", 1)
            creation = None
            holds = 0
            if len(cols) > 4:
                # creation may be split into several columns in space separated output
                if "\t" not in line and len(cols) > 5 and not cols[4].isdigit():
                    creation = _time(" ".join(cols[4:9]))
                    rest = cols[9:]
                else:
                    creation = _time(cols[4])
                    rest = cols[5:]
                if rest and rest[0].strip().isdigit():
                    holds = int(rest[0])
            report.snapshots.append(
                Snapshot(
                    dataset=dataset,
                    name=snap,
                    used=_num(cols[1]) if len(cols) > 1 else None,
                    referenced=_num(cols[2]) if len(cols) > 2 else None,
                    written=_num(cols[3]) if len(cols) > 3 else None,
                    creation=creation,
                    holds=holds,
                )
            )
        else:
            c = cols + [""] * 8
            report.datasets.append(
                Dataset(
                    name=name,
                    type=c[1].strip().upper() or "FILESYSTEM",
                    used=_num(c[2]),
                    usedbysnapshots=_num(c[3]),
                    usedbydataset=_num(c[4]),
                    usedbychildren=_num(c[5]),
                    available=_num(c[6]),
                    referenced=_num(c[7]),
                )
            )
    ensure_datasets(report)
    return report


async def _run(cmd: list[str]) -> str:
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
    )
    out, err = await proc.communicate()
    if proc.returncode != 0:
        raise RuntimeError(f"{' '.join(cmd)} failed: {err.decode(errors='replace').strip()}")
    return out.decode(errors="replace")


class ZfsCliSource:
    name = "zfs"

    def __init__(self) -> None:
        if not shutil.which("zfs"):
            raise RuntimeError("SNAPVIZ_SOURCE=zfs but no `zfs` binary found in PATH")

    async def fetch(self) -> SnapshotReport:
        snaps, datasets = await asyncio.gather(_run(SNAPSHOT_CMD), _run(DATASET_CMD))
        report = parse_listing(datasets + "\n" + snaps, source="zfs")
        report.host = "localhost"
        return report

    async def close(self) -> None:
        pass

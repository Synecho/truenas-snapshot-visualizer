from snapviz.sources.demo import generate
from snapviz.sources.zfs_cli import parse_listing

TAB_LISTING = """\
tank\tfilesystem\t1000\t300\t200\t500\t9000\t200
tank/data\tfilesystem\t500\t100\t400\t0\t9000\t400
tank/data@auto-2026-10-01_00-00\t40\t380\t50\t1790000000\t0
tank/data@manual\t60\t390\t70\t1780000000\t1
"""

SPACE_LISTING = """\
NAME                         USED  REFER  WRITTEN  CREATION                USERREFS
tank/data@auto-2026-10-01    1.5G   10G    2.0G    Wed Oct  1  0:00 2025   0
"""


def test_parse_tab_separated():
    r = parse_listing(TAB_LISTING)
    assert [d.name for d in r.datasets] == ["tank", "tank/data"]
    assert r.datasets[1].usedbysnapshots == 100
    assert len(r.snapshots) == 2
    s = r.snapshots[1]
    assert (s.dataset, s.name, s.used, s.referenced, s.written, s.creation, s.holds) == (
        "tank/data", "manual", 60, 390, 70, 1780000000, 1,
    )


def test_parse_human_readable():
    r = parse_listing(SPACE_LISTING)
    s = r.snapshots[0]
    assert s.used == int(1.5 * 1024**3)
    assert s.written == 2 * 1024**3
    assert s.creation is not None
    # parents are created automatically
    assert [d.name for d in r.datasets] == ["tank", "tank/data"]


def test_parse_snapshots_only_minimal_columns():
    r = parse_listing("pool/a@s1\t10\npool/a@s2\t20\n")
    assert [s.used for s in r.snapshots] == [10, 20]
    assert r.snapshots[0].creation is None


def test_demo_is_consistent():
    r = generate()
    assert len(r.snapshots) > 100
    by_name = {d.name: d for d in r.datasets}
    for s in r.snapshots:
        assert s.dataset in by_name
    for d in r.datasets:
        own = sum(s.used for s in r.snapshots if s.dataset == d.name)
        assert d.usedbysnapshots >= own
    payload = r.to_json()
    assert len(payload["snapshots"][0]) == len(payload["snapshot_fields"])

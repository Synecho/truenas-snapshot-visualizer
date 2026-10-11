from snapviz.protect import managed_reason


def test_managed_reason():
    assert managed_reason("boot-pool/ROOT/24.10.2") == "boot"
    assert managed_reason("freenas-boot") == "boot"
    assert managed_reason("tank/.system") == "system"
    assert managed_reason("tank/.system/samba4") == "system"
    assert managed_reason("tank/.ix-apps/app_mounts/nextcloud") == "apps"
    assert managed_reason("tank/ix-applications/k3s") == "apps"
    assert managed_reason("tank/media") is None
    assert managed_reason("tank/systemd-backup") is None
    assert managed_reason("my-boot-pool-backup/data") is None

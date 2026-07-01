from server.app.keyring import key_environment, mask_key


def test_mask_key_keeps_only_edges():
    assert mask_key("sk-1234567890abcdef") == "sk-1...cdef"


def test_mask_key_handles_short_keys():
    assert mask_key("abc123") == "******"


def test_key_environment_sets_syapi_key_without_mutating_process_env(monkeypatch):
    monkeypatch.delenv("SYAPI_API_KEY", raising=False)

    env = key_environment("user-key", base_url="https://api.0000238.xyz")

    assert env["SYAPI_API_KEY"] == "user-key"
    assert env["SYAPI_BASE_URL"] == "https://api.0000238.xyz"


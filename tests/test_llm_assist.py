from authorledger import llm_assist


def test_not_configured_without_env_var(monkeypatch):
    monkeypatch.delenv(llm_assist.ENV_VAR, raising=False)
    assert llm_assist.is_configured() is False
    assert llm_assist.get_api_key() is None


def test_configured_with_env_var(monkeypatch):
    monkeypatch.setenv(llm_assist.ENV_VAR, "sk-test-fake-key")
    assert llm_assist.is_configured() is True
    assert llm_assist.get_api_key() == "sk-test-fake-key"


def test_summarize_report_narrative_returns_none_when_unconfigured(monkeypatch):
    monkeypatch.delenv(llm_assist.ENV_VAR, raising=False)
    result = llm_assist.summarize_report_narrative({"book_title": "X"})
    assert result is None


def test_craft_feedback_returns_none_when_unconfigured(monkeypatch):
    monkeypatch.delenv(llm_assist.ENV_VAR, raising=False)
    result = llm_assist.craft_feedback("Some chapter text.")
    assert result is None


def test_craft_feedback_returns_none_for_empty_text(monkeypatch):
    monkeypatch.setenv(llm_assist.ENV_VAR, "sk-test-fake-key")
    result = llm_assist.craft_feedback("   ")
    assert result is None


def test_call_claude_raises_without_key(monkeypatch):
    monkeypatch.delenv(llm_assist.ENV_VAR, raising=False)
    try:
        llm_assist._call_claude("hello")
        assert False, "expected LLMError"
    except llm_assist.LLMError as exc:
        assert llm_assist.ENV_VAR in str(exc)

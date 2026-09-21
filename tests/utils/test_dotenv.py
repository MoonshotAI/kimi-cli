from __future__ import annotations

import os

from kimi_cli.utils.dotenv import load_dotenv_values, load_llm_env


def test_load_dotenv_values_does_not_mutate_process(tmp_path, monkeypatch):
    env_file = tmp_path / ".env"
    env_file.write_text("KIMI_CONFIG_FILE=dev/deepseek.toml\n")
    monkeypatch.delenv("KIMI_CONFIG_FILE", raising=False)

    assert load_dotenv_values(env_file) == {"KIMI_CONFIG_FILE": "dev/deepseek.toml"}
    assert "KIMI_CONFIG_FILE" not in os.environ


def test_load_llm_env_overlays_dotenv_without_mutating_process(tmp_path, monkeypatch):
    env_file = tmp_path / ".env"
    env_file.write_text("KIMI_API_KEY=local-key\nKIMI_MODEL_NAME=local-model\n")
    monkeypatch.setenv("KIMI_API_KEY", "process-key")

    env = load_llm_env(env_file)

    assert env["KIMI_API_KEY"] == "local-key"
    assert env["KIMI_MODEL_NAME"] == "local-model"
    assert os.environ["KIMI_API_KEY"] == "process-key"

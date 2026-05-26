from __future__ import annotations

from pathlib import Path
import sys

import pytest

BRIDGE_DIR = Path(__file__).resolve().parents[1]
if str(BRIDGE_DIR) not in sys.path:
    sys.path.insert(0, str(BRIDGE_DIR))

from lib.registry import RegistryError, load_character_registry


def write_config(tmp_path: Path, content: str) -> Path:
    config = tmp_path / "characters.yaml"
    config.write_text(content, encoding="utf-8")
    return config


def test_load_character_registry_success(tmp_path: Path) -> None:
    config = write_config(
        tmp_path,
        """
characters:
  Gerard:
    oc_agent_id: "gerard"
    discord_channel_id: "123"
    discord_bot_token: "token"
    whatsapp_number: null
    active: true
""",
    )

    registry = load_character_registry(config)

    assert list(registry.keys()) == ["Gerard"]
    assert registry["Gerard"].oc_agent_id == "gerard"
    assert registry["Gerard"].active is True


def test_load_character_registry_missing_required_field(tmp_path: Path) -> None:
    config = write_config(
        tmp_path,
        """
characters:
  Gerard:
    discord_channel_id: "123"
    active: true
""",
    )

    with pytest.raises(RegistryError, match="missing required field 'oc_agent_id'"):
        load_character_registry(config)

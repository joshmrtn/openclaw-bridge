from __future__ import annotations

import asyncio
from pathlib import Path
import sys

BRIDGE_DIR = Path(__file__).resolve().parents[1]
if str(BRIDGE_DIR) not in sys.path:
    sys.path.insert(0, str(BRIDGE_DIR))

import bridge as bridge_main
from lib.registry import CharacterConfig


def _write_config(tmp_path: Path, body: str) -> Path:
    path = tmp_path / "characters.yaml"
    path.write_text(body, encoding="utf-8")
    return path


def test_dry_run_loads_config_and_exits(tmp_path: Path) -> None:
    config = _write_config(
        tmp_path,
        """
characters:
  Gerard:
    oc_agent_id: "gerard"
    discord_channel_id: "123"
    discord_bot_token: "token"
    active: true
""",
    )

    exit_code = asyncio.run(bridge_main.run(["--config", str(config), "--dry-run"]))
    assert exit_code == 0


def test_validate_warns_on_unknown_character_without_failing(
    tmp_path: Path, monkeypatch
) -> None:
    config = _write_config(
        tmp_path,
        """
characters:
  Gerard:
    oc_agent_id: "gerard"
    discord_channel_id: "123"
    discord_bot_token: "token"
    active: true
""",
    )

    async def fake_list_characters(self):
        return ["SomeoneElse"]

    monkeypatch.setattr(bridge_main.STClient, "list_characters", fake_list_characters)
    exit_code = asyncio.run(bridge_main.run(["--config", str(config), "--validate"]))
    assert exit_code == 0


def test_resolve_active_characters_uses_plugin_state_with_credential_checks() -> None:
    registry = {
        "Gerard": CharacterConfig(
            name="Gerard",
            oc_agent_id="gerard",
            discord_channel_id="123",
            discord_bot_token="token",
            whatsapp_number=None,
            active=False,
        ),
        "Edward": CharacterConfig(
            name="Edward",
            oc_agent_id="edward",
            discord_channel_id="456",
            discord_bot_token=None,
            whatsapp_number=None,
            active=True,
        ),
    }

    links = {
        "Gerard": {"active": True, "oc_agent_id": "gerard"},
        "Edward": {"active": True, "oc_agent_id": "edward"},
        "Missing": {"active": True, "oc_agent_id": "missing"},
    }

    active = bridge_main.resolve_active_characters(registry, links)
    assert active == {"Gerard"}


def test_resolve_active_characters_falls_back_to_local_flags() -> None:
    registry = {
        "Gerard": CharacterConfig(
            name="Gerard",
            oc_agent_id="gerard",
            discord_channel_id="123",
            discord_bot_token="token",
            whatsapp_number=None,
            active=True,
        ),
        "Edward": CharacterConfig(
            name="Edward",
            oc_agent_id="edward",
            discord_channel_id="456",
            discord_bot_token="token",
            whatsapp_number=None,
            active=False,
        ),
    }

    active = bridge_main.resolve_active_characters(registry, {})
    assert active == {"Gerard"}

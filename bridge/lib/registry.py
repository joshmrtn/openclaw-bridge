from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml


class RegistryError(ValueError):
    """Raised when characters.yaml is malformed."""


@dataclass(frozen=True)
class CharacterConfig:
    name: str
    oc_agent_id: str
    discord_channel_id: str | None
    discord_bot_token: str | None
    whatsapp_number: str | None
    active: bool


def _required_string(
    raw: dict[str, Any], field_name: str, character_name: str
) -> str:
    value = raw.get(field_name)
    if not isinstance(value, str) or not value.strip():
        raise RegistryError(
            f"Character '{character_name}' missing required field '{field_name}'"
        )
    return value.strip()


def _optional_string(raw: dict[str, Any], field_name: str) -> str | None:
    value = raw.get(field_name)
    if value is None:
        return None
    if not isinstance(value, str):
        raise RegistryError(f"Field '{field_name}' must be a string or null")
    stripped = value.strip()
    return stripped if stripped else None


def load_character_registry(config_path: str | Path) -> dict[str, CharacterConfig]:
    path = Path(config_path)
    if not path.exists():
        raise RegistryError(f"Config file not found: {path}")

    with path.open("r", encoding="utf-8") as handle:
        raw_data = yaml.safe_load(handle) or {}

    if not isinstance(raw_data, dict):
        raise RegistryError("characters.yaml must contain a top-level mapping")

    raw_characters = raw_data.get("characters")
    if raw_characters is None:
        return {}
    if not isinstance(raw_characters, dict):
        raise RegistryError("'characters' must be a mapping")

    parsed: dict[str, CharacterConfig] = {}
    for character_name, entry in raw_characters.items():
        if not isinstance(character_name, str) or not character_name.strip():
            raise RegistryError("Character names must be non-empty strings")
        if not isinstance(entry, dict):
            raise RegistryError(
                f"Character '{character_name}' config must be a mapping"
            )

        parsed[character_name] = CharacterConfig(
            name=character_name,
            oc_agent_id=_required_string(entry, "oc_agent_id", character_name),
            discord_channel_id=_optional_string(entry, "discord_channel_id"),
            discord_bot_token=_optional_string(entry, "discord_bot_token"),
            whatsapp_number=_optional_string(entry, "whatsapp_number"),
            active=bool(entry.get("active", False)),
        )

    return parsed
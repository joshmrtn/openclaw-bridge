from __future__ import annotations

import asyncio
from pathlib import Path
import sys

import aiohttp
import pytest

BRIDGE_DIR = Path(__file__).resolve().parents[1]
if str(BRIDGE_DIR) not in sys.path:
    sys.path.insert(0, str(BRIDGE_DIR))

from lib.st_client import AuthError, STClient, STClientError


def test_generate_success_returns_text(monkeypatch: pytest.MonkeyPatch) -> None:
    client = STClient(base_url="http://localhost", auth_token="token")

    async def fake_generate_once(self, payload, character):
        return "hello"

    monkeypatch.setattr(STClient, "_generate_once", fake_generate_once)
    response = asyncio.run(client.generate(character="Gerard", message="Hi"))
    assert response == "hello"


def test_generate_401_bubbles_auth_error(monkeypatch: pytest.MonkeyPatch) -> None:
    client = STClient(base_url="http://localhost", auth_token="token")

    async def fake_generate_once(self, payload, character):
        raise AuthError("unauthorized")

    monkeypatch.setattr(STClient, "_generate_once", fake_generate_once)
    with pytest.raises(AuthError):
        asyncio.run(client.generate(character="Gerard", message="Hi"))


def test_generate_timeout_includes_character_name(monkeypatch: pytest.MonkeyPatch) -> None:
    client = STClient(
        base_url="http://localhost",
        auth_token="token",
        max_retries=3,
        retry_backoff_seconds=0,
    )
    attempts = {"count": 0}

    async def fake_generate_once(self, payload, character):
        attempts["count"] += 1
        raise asyncio.TimeoutError("slow")

    monkeypatch.setattr(STClient, "_generate_once", fake_generate_once)
    with pytest.raises(TimeoutError, match="Gerard"):
        asyncio.run(client.generate(character="Gerard", message="Hi"))
    assert attempts["count"] == 3


def test_generate_connection_retries_then_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    client = STClient(
        base_url="http://localhost",
        auth_token="token",
        max_retries=3,
        retry_backoff_seconds=0,
    )
    attempts = {"count": 0}

    async def fake_generate_once(self, payload, character):
        attempts["count"] += 1
        raise aiohttp.ClientConnectionError("down")

    monkeypatch.setattr(STClient, "_generate_once", fake_generate_once)
    with pytest.raises(STClientError, match="3 attempts"):
        asyncio.run(client.generate(character="Gerard", message="Hi"))
    assert attempts["count"] == 3


def test_extract_character_entries_supports_list_and_mapping() -> None:
    list_payload = ["Gerard", {"name": "Edward"}]
    dict_payload = {"characters": [{"name": "Gerard"}]}

    assert STClient._extract_character_entries(list_payload) == list_payload
    assert STClient._extract_character_entries(dict_payload) == [{"name": "Gerard"}]


def test_extract_character_entries_rejects_invalid_payload() -> None:
    with pytest.raises(STClientError, match="Unexpected /characters response format"):
        STClient._extract_character_entries("invalid")


def test_parse_links_from_entries_prefers_nested_link_fields() -> None:
    entries = [
        {
            "name": "Gerard",
            "active": False,
            "link": {
                "active": True,
                "oc_agent_id": "gerard",
            },
        },
        {
            "name": "Edward",
            "active": True,
        },
        "ignored",
    ]

    parsed = STClient._parse_links_from_entries(entries)
    assert parsed["Gerard"] == {"active": True, "oc_agent_id": "gerard"}
    assert parsed["Edward"] == {"active": True, "oc_agent_id": None}

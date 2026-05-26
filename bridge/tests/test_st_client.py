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

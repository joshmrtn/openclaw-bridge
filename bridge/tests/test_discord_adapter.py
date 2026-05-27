from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace
import sys

BRIDGE_DIR = Path(__file__).resolve().parents[1]
if str(BRIDGE_DIR) not in sys.path:
    sys.path.insert(0, str(BRIDGE_DIR))

from adapters.discord import DiscordAdapter
from lib.registry import CharacterConfig


class FakeQueueManager:
    def __init__(self) -> None:
        self.messages = []

    async def enqueue_normalized(self, message) -> None:
        self.messages.append(message)


class FakeDiscordClient:
    def __init__(self, intents) -> None:
        self._handlers = {}
        self._channels = {}

    def event(self, fn):
        self._handlers[fn.__name__] = fn
        return fn

    async def start(self, token: str) -> None:
        self.token = token

    async def close(self) -> None:
        return None

    def get_channel(self, channel_id: int):
        return self._channels.get(channel_id)

    async def fetch_channel(self, channel_id: int):
        return self._channels.get(channel_id)


class FakeChannel:
    def __init__(self) -> None:
        self.sent = []

    async def send(self, text: str) -> None:
        self.sent.append(text)


def test_discord_adapter_normalizes_message_and_attachments() -> None:
    async def run() -> None:
        queue_manager = FakeQueueManager()
        adapter = DiscordAdapter(queue_manager=queue_manager, client_factory=FakeDiscordClient)

        registry = {
            "Gerard": CharacterConfig(
                name="Gerard",
                oc_agent_id="gerard",
                discord_channel_id="123",
                discord_bot_token="token",
                whatsapp_number=None,
                active=True,
            )
        }

        await adapter.start(registry)
        adapter.set_active_characters({"Gerard"})

        binding = adapter._bindings_by_character["Gerard"]
        message = SimpleNamespace(
            author=SimpleNamespace(bot=False, id="42"),
            channel=SimpleNamespace(id=123),
            content="hello",
            attachments=[
                SimpleNamespace(
                    url="https://cdn.example/image.png",
                    content_type="image/png",
                    size=101,
                    filename="image.png",
                )
            ],
        )

        await binding.client._handlers["on_message"](message)

        assert len(queue_manager.messages) == 1
        normalized_message = queue_manager.messages[0]
        assert normalized_message.character == "Gerard"
        assert normalized_message.channel_type == "discord"
        assert normalized_message.sender_id == "discord:42"
        assert len(normalized_message.attachments) == 1
        attachment = normalized_message.attachments[0]
        assert attachment.url == "https://cdn.example/image.png"
        assert attachment.content_type == "image/png"
        assert attachment.size_bytes == 101

        await adapter.stop()

    asyncio.run(run())


def test_discord_adapter_ignores_inactive_character_messages() -> None:
    async def run() -> None:
        queue_manager = FakeQueueManager()
        adapter = DiscordAdapter(queue_manager=queue_manager, client_factory=FakeDiscordClient)

        registry = {
            "Gerard": CharacterConfig(
                name="Gerard",
                oc_agent_id="gerard",
                discord_channel_id="123",
                discord_bot_token="token",
                whatsapp_number=None,
                active=True,
            )
        }

        await adapter.start(registry)
        adapter.set_active_characters(set())

        binding = adapter._bindings_by_character["Gerard"]
        message = SimpleNamespace(
            author=SimpleNamespace(bot=False, id="42"),
            channel=SimpleNamespace(id=123),
            content="hello",
            attachments=[],
        )

        await binding.client._handlers["on_message"](message)
        assert queue_manager.messages == []

        await adapter.stop()

    asyncio.run(run())

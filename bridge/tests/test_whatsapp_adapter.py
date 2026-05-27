from __future__ import annotations

import asyncio
from pathlib import Path
import sys

BRIDGE_DIR = Path(__file__).resolve().parents[1]
if str(BRIDGE_DIR) not in sys.path:
    sys.path.insert(0, str(BRIDGE_DIR))

from adapters.whatsapp import (
    WhatsAppAdapter,
    WhatsAppInboundAttachment,
    WhatsAppInboundMessage,
)
from lib.registry import CharacterConfig


class FakeQueueManager:
    def __init__(self) -> None:
        self.messages = []

    async def enqueue_normalized(self, message) -> None:
        self.messages.append(message)


class FakeTransport:
    def __init__(self) -> None:
        self.sent = []
        self.fetched_media = []

    async def send_text(self, whatsapp_number: str, text: str) -> None:
        self.sent.append((whatsapp_number, text))

    async def fetch_media_bytes(self, media_id: str) -> bytes:
        self.fetched_media.append(media_id)
        return f"bytes:{media_id}".encode("utf-8")


def test_whatsapp_adapter_normalizes_message_and_attachments() -> None:
    async def run() -> None:
        queue_manager = FakeQueueManager()
        transport = FakeTransport()
        adapter = WhatsAppAdapter(queue_manager=queue_manager, transport=transport)

        registry = {
            "Gerard": CharacterConfig(
                name="Gerard",
                oc_agent_id="gerard",
                discord_channel_id=None,
                discord_bot_token=None,
                whatsapp_number="+15551230001",
                active=True,
            )
        }

        await adapter.start(registry)
        adapter.set_active_characters({"Gerard"})

        inbound_message = WhatsAppInboundMessage(
            sender_id="15550001111",
            text="hello from whatsapp",
            attachments=[
                WhatsAppInboundAttachment(
                    content_type="image/jpeg",
                    size_bytes=44,
                    filename="photo.jpg",
                    media_id="mid-123",
                )
            ],
        )

        await adapter.on_incoming_message("+15551230001", inbound_message)

        assert len(queue_manager.messages) == 1
        normalized_message = queue_manager.messages[0]
        assert normalized_message.character == "Gerard"
        assert normalized_message.channel_type == "whatsapp"
        assert normalized_message.sender_id == "whatsapp:15550001111"
        assert len(normalized_message.attachments) == 1

        attachment = normalized_message.attachments[0]
        assert attachment.content_type == "image/jpeg"
        assert attachment.size_bytes == 44
        assert attachment.filename == "photo.jpg"
        assert attachment.fetch_fn is not None

        payload = await attachment.fetch_fn()
        assert payload == b"bytes:mid-123"
        assert transport.fetched_media == ["mid-123"]

        await normalized_message.reply_callback("reply text")
        assert transport.sent == [("+15551230001", "reply text")]

        await adapter.stop()

    asyncio.run(run())


def test_whatsapp_adapter_ignores_unknown_or_inactive_bindings() -> None:
    async def run() -> None:
        queue_manager = FakeQueueManager()
        transport = FakeTransport()
        adapter = WhatsAppAdapter(queue_manager=queue_manager, transport=transport)

        registry = {
            "Gerard": CharacterConfig(
                name="Gerard",
                oc_agent_id="gerard",
                discord_channel_id=None,
                discord_bot_token=None,
                whatsapp_number="+15551230001",
                active=True,
            )
        }

        await adapter.start(registry)
        adapter.set_active_characters(set())

        inbound_message = WhatsAppInboundMessage(
            sender_id="15550001111",
            text="hello",
            attachments=[],
        )

        await adapter.on_incoming_message("+15551230001", inbound_message)
        await adapter.on_incoming_message("+19999999999", inbound_message)

        assert queue_manager.messages == []
        await adapter.stop()

    asyncio.run(run())


def test_whatsapp_adapter_send_message_warns_without_binding() -> None:
    async def run() -> None:
        queue_manager = FakeQueueManager()
        transport = FakeTransport()
        adapter = WhatsAppAdapter(queue_manager=queue_manager, transport=transport)

        await adapter.start({})
        await adapter.send_message("Unknown", "text")
        assert transport.sent == []
        await adapter.stop()

    asyncio.run(run())
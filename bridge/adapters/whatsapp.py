from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Awaitable, Callable, Protocol

from lib.normalized import NormalizedAttachment, NormalizedMessage
from lib.queue_manager import QueueManager
from lib.registry import CharacterConfig

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class WhatsAppInboundAttachment:
    content_type: str
    size_bytes: int
    filename: str
    media_id: str | None = None
    url: str | None = None


@dataclass(slots=True)
class WhatsAppInboundMessage:
    sender_id: str
    text: str
    attachments: list[WhatsAppInboundAttachment]


class WhatsAppTransport(Protocol):
    async def send_text(self, whatsapp_number: str, text: str) -> None: ...

    async def fetch_media_bytes(self, media_id: str) -> bytes: ...


@dataclass(slots=True)
class WhatsAppBinding:
    character: str
    whatsapp_number: str


class WhatsAppAdapter:
    def __init__(
        self,
        queue_manager: QueueManager,
        transport: WhatsAppTransport,
    ) -> None:
        self._queue_manager = queue_manager
        self._transport = transport
        self._bindings_by_character: dict[str, WhatsAppBinding] = {}
        self._bindings_by_number: dict[str, WhatsAppBinding] = {}
        self._active_characters: set[str] = set()

    async def start(self, registry: dict[str, CharacterConfig]) -> None:
        for character, config in registry.items():
            if not config.whatsapp_number:
                continue

            number = config.whatsapp_number.strip()
            if not number:
                continue

            binding = WhatsAppBinding(character=character, whatsapp_number=number)
            self._bindings_by_character[character] = binding
            self._bindings_by_number[number] = binding

    async def stop(self) -> None:
        self._bindings_by_character.clear()
        self._bindings_by_number.clear()

    def set_active_characters(self, active_characters: set[str]) -> None:
        self._active_characters = set(active_characters)

    def get_active_characters(self) -> set[str]:
        return set(self._active_characters)

    async def send_message(self, character: str, text: str) -> None:
        binding = self._bindings_by_character.get(character)
        if binding is None:
            logger.warning("[%s] No WhatsApp binding configured", character)
            return
        await self._transport.send_text(binding.whatsapp_number, text)

    async def on_incoming_message(
        self,
        whatsapp_number: str,
        inbound_message: WhatsAppInboundMessage,
    ) -> None:
        binding = self._bindings_by_number.get(whatsapp_number)
        if binding is None:
            logger.warning("No character bound to WhatsApp number '%s'", whatsapp_number)
            return

        if binding.character not in self._active_characters:
            return

        async def reply_callback(text: str) -> None:
            await self.send_message(binding.character, text)

        normalized_message = NormalizedMessage(
            character=binding.character,
            text=inbound_message.text,
            sender_id=f"whatsapp:{inbound_message.sender_id}",
            channel_type="whatsapp",
            attachments=self._normalize_attachments(inbound_message.attachments),
            reply_callback=reply_callback,
        )
        await self._queue_manager.enqueue_normalized(normalized_message)

    def _normalize_attachments(
        self, attachments: list[WhatsAppInboundAttachment]
    ) -> list[NormalizedAttachment]:
        normalized: list[NormalizedAttachment] = []
        for attachment in attachments:
            content_type = attachment.content_type or "application/octet-stream"
            size_bytes = attachment.size_bytes if attachment.size_bytes >= 0 else 0
            filename = attachment.filename or "attachment"

            fetch_fn: Callable[[], Awaitable[bytes]] | None = None
            if attachment.media_id:
                media_id = attachment.media_id

                async def _fetch(media_id: str = media_id) -> bytes:
                    return await self._transport.fetch_media_bytes(media_id)

                fetch_fn = _fetch

            normalized.append(
                NormalizedAttachment(
                    url=attachment.url,
                    fetch_fn=fetch_fn,
                    content_type=content_type,
                    size_bytes=size_bytes,
                    filename=filename,
                )
            )
        return normalized
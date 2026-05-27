from __future__ import annotations

import asyncio
import base64
import logging
import os
from dataclasses import dataclass
from typing import Awaitable, Callable

import aiohttp

from lib.normalized import NormalizedAttachment, NormalizedMessage
from lib.st_client import STClient

logger = logging.getLogger(__name__)

DEFAULT_ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024
DEFAULT_ATTACHMENT_FETCH_RETRIES = 3
DEFAULT_ATTACHMENT_FETCH_TIMEOUT_SECONDS = 15

ResponseCallback = Callable[[str, str], Awaitable[None]]


@dataclass(slots=True)
class QueueJob:
    character: str
    normalized_message: NormalizedMessage


class QueueManager:
    def __init__(
        self,
        st_client: STClient,
        on_response: ResponseCallback | None,
        max_queue_size_warning: int = 10,
    ) -> None:
        self._st_client = st_client
        self._on_response = on_response
        self._max_queue_size_warning = max_queue_size_warning
        self._attachment_max_bytes = int(
            os.getenv("OPENCLAW_BRIDGE_ATTACHMENT_MAX_BYTES", str(DEFAULT_ATTACHMENT_MAX_BYTES))
        )
        self._attachment_fetch_retries = int(
            os.getenv("OPENCLAW_BRIDGE_ATTACHMENT_FETCH_RETRIES", str(DEFAULT_ATTACHMENT_FETCH_RETRIES))
        )
        self._attachment_timeout_seconds = int(
            os.getenv(
                "OPENCLAW_BRIDGE_ATTACHMENT_FETCH_TIMEOUT_SECONDS",
                str(DEFAULT_ATTACHMENT_FETCH_TIMEOUT_SECONDS),
            )
        )
        self._queues: dict[str, asyncio.Queue[QueueJob]] = {}
        self._workers: dict[str, asyncio.Task[None]] = {}

    def start(self, characters: list[str]) -> None:
        for character in characters:
            self._ensure_character(character)

    async def stop(self) -> None:
        for task in self._workers.values():
            task.cancel()
        if self._workers:
            await asyncio.gather(*self._workers.values(), return_exceptions=True)
        self._workers.clear()
        self._queues.clear()

    async def enqueue(
        self,
        character: str,
        message: str,
        images: list[str] | None = None,
        channel: str = "discord",
        user_id: str = "bridge:unknown",
    ) -> None:
        attachments = [
            NormalizedAttachment(
                url=image,
                fetch_fn=None,
                content_type="image/*",
                size_bytes=0,
                filename="inline",
            )
            for image in (images or [])
        ]
        normalized_message = NormalizedMessage(
            character=character,
            text=message,
            sender_id=user_id,
            channel_type=channel,
            attachments=attachments,
            reply_callback=None,
        )
        await self.enqueue_normalized(normalized_message)

    async def enqueue_normalized(self, message: NormalizedMessage) -> None:
        queue = self._ensure_character(message.character)
        if queue.qsize() >= self._max_queue_size_warning:
            logger.warning(
                "[%s] Queue backlog is %s messages", message.character, queue.qsize()
            )
        await queue.put(
            QueueJob(
                character=message.character,
                normalized_message=message,
            )
        )

    def _ensure_character(self, character: str) -> asyncio.Queue[QueueJob]:
        if character in self._queues:
            return self._queues[character]

        queue: asyncio.Queue[QueueJob] = asyncio.Queue()
        self._queues[character] = queue
        self._workers[character] = asyncio.create_task(
            self._worker(character, queue), name=f"worker:{character}"
        )
        return queue

    async def _resolve_images(self, normalized_message: NormalizedMessage) -> list[str]:
        attachments = normalized_message.attachments or []
        if not attachments:
            return []

        timeout = aiohttp.ClientTimeout(total=self._attachment_timeout_seconds)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            images: list[str] = []
            for attachment in attachments:
                data_uri = await self._attachment_to_data_uri(session, attachment)
                if data_uri:
                    images.append(data_uri)
            return images

    async def _attachment_to_data_uri(
        self,
        session: aiohttp.ClientSession,
        attachment: NormalizedAttachment,
    ) -> str | None:
        content_type = attachment.content_type
        if not content_type.startswith("image/") and content_type != "image/*":
            return None

        if attachment.size_bytes > self._attachment_max_bytes:
            logger.warning(
                "Skipping attachment %s (%s bytes) because it exceeds max size %s",
                attachment.filename,
                attachment.size_bytes,
                self._attachment_max_bytes,
            )
            return None

        if attachment.url and attachment.url.startswith("data:"):
            return attachment.url

        payload: bytes | None = None
        for attempt in range(1, self._attachment_fetch_retries + 1):
            try:
                if attachment.url:
                    payload = await self._fetch_bytes_from_url(session, attachment.url)
                elif attachment.fetch_fn:
                    payload = await attachment.fetch_fn()
                else:
                    return None
                break
            except Exception as exc:
                if attempt >= self._attachment_fetch_retries:
                    logger.warning(
                        "Failed to fetch image attachment %s after %s attempts; continuing without image: %s",
                        attachment.filename,
                        self._attachment_fetch_retries,
                        exc,
                    )
                    return None
                await asyncio.sleep(0.25 * attempt)

        if payload is None:
            return None

        if len(payload) > self._attachment_max_bytes:
            logger.warning(
                "Skipping attachment %s after download because size %s exceeds max %s",
                attachment.filename,
                len(payload),
                self._attachment_max_bytes,
            )
            return None

        encoded = base64.b64encode(payload).decode("ascii")
        return f"data:{content_type};base64,{encoded}"

    async def _fetch_bytes_from_url(self, session: aiohttp.ClientSession, url: str) -> bytes:
        async with session.get(url) as response:
            if response.status >= 400:
                raise RuntimeError(f"HTTP {response.status}")
            return await response.read()

    async def _worker(self, character: str, queue: asyncio.Queue[QueueJob]) -> None:
        while True:
            job = await queue.get()
            try:
                normalized_message = job.normalized_message
                images = await self._resolve_images(normalized_message)
                response = await self._st_client.generate(
                    character=normalized_message.character,
                    message=normalized_message.text,
                    images=images,
                    channel=normalized_message.channel_type,
                    user_id=normalized_message.sender_id,
                )
                if normalized_message.reply_callback is not None:
                    await normalized_message.reply_callback(response)
                elif self._on_response is not None:
                    await self._on_response(job.character, response)
            except Exception as exc:
                logger.exception("[%s] Job failed: %s", character, exc)
            finally:
                queue.task_done()
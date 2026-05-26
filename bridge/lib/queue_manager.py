from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Awaitable, Callable

from lib.st_client import STClient

logger = logging.getLogger(__name__)


ResponseCallback = Callable[[str, str], Awaitable[None]]


@dataclass(slots=True)
class QueueJob:
    character: str
    message: str
    images: list[str]
    channel: str
    user_id: str


class QueueManager:
    def __init__(
        self,
        st_client: STClient,
        on_response: ResponseCallback,
        max_queue_size_warning: int = 10,
    ) -> None:
        self._st_client = st_client
        self._on_response = on_response
        self._max_queue_size_warning = max_queue_size_warning
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
        queue = self._ensure_character(character)
        if queue.qsize() >= self._max_queue_size_warning:
            logger.warning(
                "[%s] Queue backlog is %s messages", character, queue.qsize()
            )
        await queue.put(
            QueueJob(
                character=character,
                message=message,
                images=images or [],
                channel=channel,
                user_id=user_id,
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

    async def _worker(self, character: str, queue: asyncio.Queue[QueueJob]) -> None:
        while True:
            job = await queue.get()
            try:
                response = await self._st_client.generate(
                    character=job.character,
                    message=job.message,
                    images=job.images,
                    channel=job.channel,
                    user_id=job.user_id,
                )
                await self._on_response(job.character, response)
            except Exception as exc:
                logger.exception("[%s] Job failed: %s", character, exc)
            finally:
                queue.task_done()
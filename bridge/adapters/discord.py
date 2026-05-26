from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Any, Callable

from lib.queue_manager import QueueManager
from lib.registry import CharacterConfig

logger = logging.getLogger(__name__)

try:  # pragma: no cover - dependency may be unavailable in test sandboxes
    import discord
except Exception:  # pragma: no cover
    discord = None


@dataclass(slots=True)
class DiscordBinding:
    character: str
    channel_id: int
    token: str
    client: Any


ClientFactory = Callable[[Any], Any]


class DiscordAdapter:
    def __init__(
        self,
        queue_manager: QueueManager,
        client_factory: ClientFactory | None = None,
    ) -> None:
        self._queue_manager = queue_manager
        self._bindings_by_character: dict[str, DiscordBinding] = {}
        self._bindings_by_channel: dict[int, DiscordBinding] = {}
        self._client_factory = client_factory
        self._run_tasks: list[asyncio.Task[None]] = []

    async def start(self, registry: dict[str, CharacterConfig]) -> None:
        if discord is None and self._client_factory is None:
            raise RuntimeError("discord.py is not installed")

        for character, config in registry.items():
            if not config.active or not config.discord_bot_token or not config.discord_channel_id:
                continue

            channel_id = int(config.discord_channel_id)
            intents = None
            if discord is not None:
                intents = discord.Intents.default()
                intents.message_content = True

            if self._client_factory is not None:
                client = self._client_factory(intents)
            else:
                client = discord.Client(intents=intents)

            binding = DiscordBinding(
                character=character,
                channel_id=channel_id,
                token=config.discord_bot_token,
                client=client,
            )
            self._register_handlers(binding)
            self._bindings_by_character[character] = binding
            self._bindings_by_channel[channel_id] = binding
            self._run_tasks.append(asyncio.create_task(client.start(binding.token)))

    async def stop(self) -> None:
        for binding in self._bindings_by_character.values():
            close = getattr(binding.client, "close", None)
            if close is not None:
                await close()
        for task in self._run_tasks:
            task.cancel()
        if self._run_tasks:
            await asyncio.gather(*self._run_tasks, return_exceptions=True)
        self._run_tasks.clear()

    async def send_message(self, character: str, text: str) -> None:
        binding = self._bindings_by_character.get(character)
        if binding is None:
            logger.warning("[%s] No Discord binding configured", character)
            return

        get_channel = getattr(binding.client, "get_channel", None)
        fetch_channel = getattr(binding.client, "fetch_channel", None)
        channel = get_channel(binding.channel_id) if get_channel else None
        if channel is None and fetch_channel is not None:
            channel = await fetch_channel(binding.channel_id)
        if channel is None:
            raise RuntimeError(f"Unable to resolve Discord channel {binding.channel_id}")

        await channel.send(text)

    def _register_handlers(self, binding: DiscordBinding) -> None:
        client = binding.client

        @client.event
        async def on_ready() -> None:  # pragma: no cover - network callback
            logger.info(
                "[%s] Discord client connected as %s",
                binding.character,
                getattr(client, "user", "unknown"),
            )

        @client.event
        async def on_message(message: Any) -> None:  # pragma: no cover - network callback
            if getattr(message.author, "bot", False):
                return
            if getattr(message.channel, "id", None) != binding.channel_id:
                return
            await self._queue_manager.enqueue(
                character=binding.character,
                message=getattr(message, "content", ""),
                images=[],
                channel="discord",
                user_id=f"discord:{getattr(message.author, 'id', 'unknown')}",
            )
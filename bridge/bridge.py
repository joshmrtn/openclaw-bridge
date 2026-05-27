from __future__ import annotations

import argparse
import asyncio
import logging
from pathlib import Path
from typing import Sequence

from adapters.discord import DiscordAdapter
from lib.queue_manager import QueueManager
from lib.registry import CharacterConfig, RegistryError, load_character_registry
from lib.st_client import STClient, STClientError

LOG_FORMAT = "%(asctime)s %(levelname)s [bridge] %(message)s"
DEFAULT_CONFIG_PATH = Path(__file__).resolve().parent.parent / "characters.yaml"
DEFAULT_ST_BASE_URL = "http://localhost:8000/api/plugins/openclaw-bridge"
DEFAULT_LINK_REFRESH_SECONDS = 45

logger = logging.getLogger(__name__)


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="OpenClaw bridge service")
    parser.add_argument("--config", default=str(DEFAULT_CONFIG_PATH))
    parser.add_argument("--st-base-url", default=DEFAULT_ST_BASE_URL)
    parser.add_argument("--auth-token", default="")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--validate", action="store_true")
    parser.add_argument("--test-generate", action="store_true")
    parser.add_argument("--character")
    parser.add_argument("--message")
    parser.add_argument("--no-wait", action="store_true")
    return parser.parse_args(argv)


def configure_logging() -> None:
    logging.basicConfig(level=logging.INFO, format=LOG_FORMAT)


def _loaded_characters_message(registry: dict[str, CharacterConfig]) -> str:
    names = ", ".join(sorted(registry.keys())) or "none"
    return f"{len(registry)} characters loaded: {names}"


def resolve_active_characters(
    registry: dict[str, CharacterConfig], links: dict[str, dict[str, object]]
) -> set[str]:
    active: set[str] = set()
    if not links:
        # Fail-open to legacy local active flags when plugin state is unavailable.
        return {name for name, cfg in registry.items() if cfg.active}

    for name, link in links.items():
        if not bool(link.get("active", False)):
            continue
        if name not in registry:
            logger.warning(
                "Character '%s' is active in plugin link state but missing bridge credentials",
                name,
            )
            continue

        cfg = registry[name]
        if not cfg.discord_bot_token or not cfg.discord_channel_id:
            logger.warning(
                "Character '%s' is active in plugin link state but missing Discord credentials",
                name,
            )
            continue

        active.add(name)

    for name, cfg in registry.items():
        if not cfg.discord_bot_token or not cfg.discord_channel_id:
            continue
        link = links.get(name)
        if not link or not bool(link.get("active", False)):
            logger.info("Character '%s' has credentials but is inactive in plugin link state", name)

    return active


async def validate_characters_against_st(
    st_client: STClient, registry: dict[str, CharacterConfig]
) -> list[str]:
    if not registry:
        return []

    known_characters = await st_client.list_characters()
    unknown = sorted(set(registry.keys()) - set(known_characters))
    for name in unknown:
        logger.warning("Character '%s' not found in ST; bridge will still start", name)
    return unknown


async def fetch_active_characters(
    st_client: STClient, registry: dict[str, CharacterConfig]
) -> set[str]:
    try:
        links = await st_client.list_character_links()
    except STClientError as exc:
        logger.warning(
            "Failed to fetch plugin link state; using local active flags: %s",
            exc,
        )
        return resolve_active_characters(registry, {})

    return resolve_active_characters(registry, links)


async def run(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    configure_logging()

    try:
        registry = load_character_registry(args.config)
    except RegistryError as exc:
        logger.error("Failed to load config: %s", exc)
        return 1

    logger.info("Bridge startup complete: %s", _loaded_characters_message(registry))

    st_client = STClient(base_url=args.st_base_url, auth_token=args.auth_token)

    if args.validate:
        try:
            await validate_characters_against_st(st_client, registry)
        except STClientError as exc:
            logger.error("Validation failed: %s", exc)
            return 1

        print(f"Config valid. {_loaded_characters_message(registry)}")
        return 0

    if args.dry_run:
        logger.info("Dry run requested; exiting without network connections")
        return 0

    if args.test_generate:
        if not args.character or not args.message:
            logger.error("--test-generate requires --character and --message")
            return 1
        if args.no_wait:
            logger.info("--no-wait set; dispatching one generate request")
        try:
            response = await st_client.generate(
                character=args.character,
                message=args.message,
                channel="discord",
                user_id="bridge:test",
            )
        except STClientError as exc:
            logger.error("Generate test failed: %s", exc)
            return 1
        print(response)
        return 0

    queue_manager: QueueManager | None = None
    discord_adapter: DiscordAdapter | None = None
    refresh_task: asyncio.Task[None] | None = None

    async def dispatch_to_discord(character: str, text: str) -> None:
        if discord_adapter is None:
            logger.warning("[%s] Discord adapter is unavailable; dropping message", character)
            return
        await discord_adapter.send_message(character, text)

    async def refresh_active_loop() -> None:
        assert discord_adapter is not None
        while True:
            await asyncio.sleep(DEFAULT_LINK_REFRESH_SECONDS)
            active_now = await fetch_active_characters(st_client, registry)
            previous = discord_adapter.get_active_characters()
            if active_now == previous:
                continue

            discord_adapter.set_active_characters(active_now)
            enabled = sorted(active_now - previous)
            disabled = sorted(previous - active_now)
            if enabled:
                logger.info("Activated characters from plugin link state: %s", ", ".join(enabled))
            if disabled:
                logger.info("Deactivated characters from plugin link state: %s", ", ".join(disabled))

    try:
        active_characters = await fetch_active_characters(st_client, registry)
        logger.info(
            "Starting runtime mode for active characters: %s",
            ", ".join(sorted(active_characters)) or "none",
        )

        queue_manager = QueueManager(
            st_client=st_client,
            on_response=dispatch_to_discord,
        )
        queue_manager.start(sorted(active_characters))

        discord_adapter = DiscordAdapter(queue_manager=queue_manager)
        await discord_adapter.start(registry)
        discord_adapter.set_active_characters(active_characters)

        refresh_task = asyncio.create_task(refresh_active_loop(), name="link-state-refresh")

        await asyncio.Event().wait()
    except KeyboardInterrupt:
        logger.info("Shutdown requested")
    finally:
        if refresh_task is not None:
            refresh_task.cancel()
            await asyncio.gather(refresh_task, return_exceptions=True)
        if discord_adapter is not None:
            await discord_adapter.stop()
        if queue_manager is not None:
            await queue_manager.stop()

    return 0


def main() -> int:
    return asyncio.run(run())


if __name__ == "__main__":
    raise SystemExit(main())
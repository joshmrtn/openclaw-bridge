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

    active_characters = [name for name, cfg in registry.items() if cfg.active]
    logger.info("Starting runtime mode for active characters: %s", ", ".join(active_characters) or "none")

    queue_manager: QueueManager | None = None
    discord_adapter: DiscordAdapter | None = None

    async def dispatch_to_discord(character: str, text: str) -> None:
        if discord_adapter is None:
            logger.warning("[%s] Discord adapter is unavailable; dropping message", character)
            return
        await discord_adapter.send_message(character, text)

    try:
        queue_manager = QueueManager(
            st_client=st_client,
            on_response=dispatch_to_discord,
        )
        queue_manager.start(active_characters)

        discord_adapter = DiscordAdapter(queue_manager=queue_manager)
        await discord_adapter.start(registry)

        await asyncio.Event().wait()
    except KeyboardInterrupt:
        logger.info("Shutdown requested")
    finally:
        if discord_adapter is not None:
            await discord_adapter.stop()
        if queue_manager is not None:
            await queue_manager.stop()

    return 0


def main() -> int:
    return asyncio.run(run())


if __name__ == "__main__":
    raise SystemExit(main())
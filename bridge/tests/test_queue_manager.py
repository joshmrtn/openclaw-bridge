from __future__ import annotations

import asyncio
from pathlib import Path
import sys

BRIDGE_DIR = Path(__file__).resolve().parents[1]
if str(BRIDGE_DIR) not in sys.path:
    sys.path.insert(0, str(BRIDGE_DIR))

from lib.queue_manager import QueueManager


class FakeClient:
    def __init__(self, failures: set[str] | None = None) -> None:
        self.failures = failures or set()
        self.calls: list[tuple[str, str]] = []

    async def generate(self, character: str, message: str, **_: object) -> str:
        self.calls.append((character, message))
        if message in self.failures:
            raise RuntimeError("boom")
        await asyncio.sleep(0.01)
        return f"{character}:{message}"


def test_single_character_messages_processed_in_order() -> None:
    async def run() -> list[tuple[str, str]]:
        responses: list[tuple[str, str]] = []
        client = FakeClient()
        manager = QueueManager(
            st_client=client,
            on_response=lambda character, text: _capture(responses, character, text),
        )
        manager.start(["Gerard"])
        for idx in range(5):
            await manager.enqueue("Gerard", f"m{idx}")
        await asyncio.sleep(0.2)
        await manager.stop()
        return responses

    responses = asyncio.run(run())
    assert responses == [
        ("Gerard", "Gerard:m0"),
        ("Gerard", "Gerard:m1"),
        ("Gerard", "Gerard:m2"),
        ("Gerard", "Gerard:m3"),
        ("Gerard", "Gerard:m4"),
    ]


def test_two_characters_are_isolated() -> None:
    async def run() -> list[tuple[str, str]]:
        responses: list[tuple[str, str]] = []
        client = FakeClient()
        manager = QueueManager(
            st_client=client,
            on_response=lambda character, text: _capture(responses, character, text),
        )
        manager.start(["Gerard", "Edward"])
        for idx in range(5):
            await manager.enqueue("Gerard", f"g{idx}")
            await manager.enqueue("Edward", f"e{idx}")
        await asyncio.sleep(0.3)
        await manager.stop()
        return responses

    responses = asyncio.run(run())
    gerard = [text for character, text in responses if character == "Gerard"]
    edward = [text for character, text in responses if character == "Edward"]
    assert gerard == [f"Gerard:g{i}" for i in range(5)]
    assert edward == [f"Edward:e{i}" for i in range(5)]


def test_worker_continues_after_failure() -> None:
    async def run() -> list[tuple[str, str]]:
        responses: list[tuple[str, str]] = []
        client = FakeClient(failures={"bad"})
        manager = QueueManager(
            st_client=client,
            on_response=lambda character, text: _capture(responses, character, text),
        )
        manager.start(["Gerard"])
        await manager.enqueue("Gerard", "bad")
        await manager.enqueue("Gerard", "good")
        await asyncio.sleep(0.2)
        await manager.stop()
        return responses

    responses = asyncio.run(run())
    assert responses == [("Gerard", "Gerard:good")]


async def _capture(
    sink: list[tuple[str, str]], character: str, text: str
) -> None:
    sink.append((character, text))

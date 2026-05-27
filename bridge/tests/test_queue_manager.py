from __future__ import annotations

import asyncio
import base64
from pathlib import Path
import sys

BRIDGE_DIR = Path(__file__).resolve().parents[1]
if str(BRIDGE_DIR) not in sys.path:
    sys.path.insert(0, str(BRIDGE_DIR))

from lib.queue_manager import QueueManager
from lib.normalized import NormalizedAttachment, NormalizedMessage


class FakeClient:
    def __init__(self, failures: set[str] | None = None) -> None:
        self.failures = failures or set()
        self.calls: list[tuple[str, str]] = []
        self.generated_payloads: list[dict[str, object]] = []

    async def generate(self, character: str, message: str, **kwargs: object) -> str:
        self.calls.append((character, message))
        self.generated_payloads.append(
            {
                "character": character,
                "message": message,
                **kwargs,
            }
        )
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


def test_normalized_fetch_fn_attachment_is_encoded_and_sent() -> None:
    async def run() -> list[str]:
        responses: list[tuple[str, str]] = []
        replied: list[str] = []
        client = FakeClient()
        manager = QueueManager(
            st_client=client,
            on_response=lambda character, text: _capture(responses, character, text),
        )
        manager.start(["Gerard"])

        async def fetch_fn() -> bytes:
            return b"image-bytes"

        async def reply_callback(text: str) -> None:
            replied.append(text)

        message = NormalizedMessage(
            character="Gerard",
            text="look",
            sender_id="discord:42",
            channel_type="discord",
            attachments=[
                NormalizedAttachment(
                    url=None,
                    fetch_fn=fetch_fn,
                    content_type="image/png",
                    size_bytes=11,
                    filename="pic.png",
                )
            ],
            reply_callback=reply_callback,
        )

        await manager.enqueue_normalized(message)
        await asyncio.sleep(0.2)
        await manager.stop()

        payload_images = client.generated_payloads[0]["images"]
        assert isinstance(payload_images, list)
        return [payload_images[0], replied[0], str(len(responses))]

    encoded_image, reply_text, response_count = asyncio.run(run())
    expected_prefix = "data:image/png;base64,"
    assert encoded_image.startswith(expected_prefix)
    expected_b64 = base64.b64encode(b"image-bytes").decode("ascii")
    assert encoded_image == expected_prefix + expected_b64
    assert reply_text == "Gerard:look"
    assert response_count == "0"


def test_inline_data_uri_attachment_passthrough() -> None:
    async def run() -> str:
        responses: list[tuple[str, str]] = []
        client = FakeClient()
        manager = QueueManager(
            st_client=client,
            on_response=lambda character, text: _capture(responses, character, text),
        )
        manager.start(["Gerard"])

        data_uri = "data:image/png;base64,QUJD"
        message = NormalizedMessage(
            character="Gerard",
            text="inline",
            sender_id="discord:42",
            channel_type="discord",
            attachments=[
                NormalizedAttachment(
                    url=data_uri,
                    fetch_fn=None,
                    content_type="image/png",
                    size_bytes=3,
                    filename="inline.png",
                )
            ],
            reply_callback=None,
        )

        await manager.enqueue_normalized(message)
        await asyncio.sleep(0.2)
        await manager.stop()
        payload_images = client.generated_payloads[0]["images"]
        assert isinstance(payload_images, list)
        return payload_images[0]

    forwarded = asyncio.run(run())
    assert forwarded == "data:image/png;base64,QUJD"

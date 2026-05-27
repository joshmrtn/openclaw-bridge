from __future__ import annotations

from dataclasses import dataclass
from typing import Awaitable, Callable


FetchAttachmentFn = Callable[[], Awaitable[bytes]]
ReplyCallback = Callable[[str], Awaitable[None]]


@dataclass(slots=True)
class NormalizedAttachment:
    url: str | None
    fetch_fn: FetchAttachmentFn | None
    content_type: str
    size_bytes: int
    filename: str


@dataclass(slots=True)
class NormalizedMessage:
    character: str
    text: str
    sender_id: str
    channel_type: str
    attachments: list[NormalizedAttachment]
    reply_callback: ReplyCallback | None = None
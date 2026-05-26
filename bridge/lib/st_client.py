from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Any

import aiohttp

logger = logging.getLogger(__name__)


class STClientError(RuntimeError):
    """Base class for ST client failures."""


class AuthError(STClientError):
    """Raised when the bridge token is rejected by the plugin."""


class CharacterNotFoundError(STClientError):
    """Raised when the plugin does not recognize a character."""


class GenerationError(STClientError):
    """Raised when generation fails unexpectedly."""


@dataclass(slots=True)
class STClient:
    base_url: str
    auth_token: str
    timeout_seconds: int = 60
    max_retries: int = 3
    retry_backoff_seconds: float = 1.0

    @property
    def _headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self.auth_token:
            headers["Authorization"] = "Bearer " + self.auth_token
        return headers

    async def list_characters(self) -> list[str]:
        timeout = aiohttp.ClientTimeout(total=self.timeout_seconds)
        async with aiohttp.ClientSession(timeout=timeout, headers=self._headers) as session:
            async with session.get(f"{self.base_url}/characters") as response:
                if response.status == 401:
                    raise AuthError("Unauthorized while listing characters")
                if response.status >= 400:
                    raise STClientError(
                        f"Failed to list characters: HTTP {response.status}"
                    )

                payload = await response.json()

        if isinstance(payload, list):
            return [str(item) for item in payload]

        if isinstance(payload, dict):
            raw_characters = payload.get("characters", [])
            names: list[str] = []
            for entry in raw_characters:
                if isinstance(entry, str):
                    names.append(entry)
                elif isinstance(entry, dict) and isinstance(entry.get("name"), str):
                    names.append(entry["name"])
            return names

        raise STClientError("Unexpected /characters response format")

    async def generate(
        self,
        character: str,
        message: str,
        images: list[str] | None = None,
        channel: str = "discord",
        user_id: str = "bridge:unknown",
    ) -> str:
        payload = {
            "character": character,
            "message": message,
            "images": images or [],
            "channel": channel,
            "user_id": user_id,
        }

        attempt = 0
        while True:
            attempt += 1
            try:
                return await self._generate_once(payload=payload, character=character)
            except aiohttp.ClientConnectionError as exc:
                logger.warning(
                    "Generate attempt %s/%s failed for %s: %s",
                    attempt,
                    self.max_retries,
                    character,
                    exc,
                )
                if attempt >= self.max_retries:
                    raise STClientError(
                        f"Failed to reach ST plugin for '{character}' "
                        f"after {self.max_retries} attempts"
                    ) from exc
                await asyncio.sleep(self.retry_backoff_seconds * attempt)
            except asyncio.TimeoutError as exc:
                logger.warning(
                    "Generate attempt %s/%s timed out for %s",
                    attempt,
                    self.max_retries,
                    character,
                )
                if attempt >= self.max_retries:
                    raise TimeoutError(
                        f"Timed out while generating response for '{character}' "
                        f"after {self.max_retries} attempts"
                    ) from exc
                await asyncio.sleep(self.retry_backoff_seconds * attempt)

    async def _generate_once(self, payload: dict[str, Any], character: str) -> str:
        timeout = aiohttp.ClientTimeout(total=self.timeout_seconds)
        async with aiohttp.ClientSession(timeout=timeout, headers=self._headers) as session:
            async with session.post(f"{self.base_url}/generate", json=payload) as response:
                if response.status == 401:
                    raise AuthError("Unauthorized while calling /generate")
                if response.status == 404:
                    raise CharacterNotFoundError(
                        f"Character '{character}' not found in ST plugin"
                    )
                if response.status >= 500:
                    raise GenerationError(
                        f"Generation failed for '{character}' (HTTP {response.status})"
                    )
                if response.status >= 400:
                    raise STClientError(
                        f"Request failed for '{character}' (HTTP {response.status})"
                    )

                data = await response.json()

        response_text = data.get("response") if isinstance(data, dict) else None
        if not isinstance(response_text, str):
            raise GenerationError(
                f"Missing 'response' field for character '{character}' in plugin response"
            )
        return response_text
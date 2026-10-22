"""Conversion between Python values and the bridge's JSON encoding."""

from __future__ import annotations

import re
from typing import Any, Union

#: A name pattern. ``str`` is matched the way the TypeScript SDK matches a
#: string: case-insensitively, anywhere in the name ("goblin" matches
#: "Goblin" and "Goblin chief"; the shortest matching name wins). Use a
#: compiled ``re.Pattern`` for anything stricter, e.g.
#: ``re.compile(r"^goblin$", re.I)``.
Pattern = Union[str, re.Pattern[str]]

_FLAG_LETTERS = ((re.IGNORECASE, "i"), (re.MULTILINE, "m"), (re.DOTALL, "s"))


class RSObject(dict):  # type: ignore[type-arg]
    """A JSON object from the bridge with attribute access (``npc.name``).

    Still a plain ``dict``: index it, iterate it, or pass it back as an
    argument. Entities carry a ``"$kind"`` key so the bridge can look them up
    again in fresh state when you pass them back.
    """

    __slots__ = ()

    def __getattr__(self, name: str) -> Any:
        try:
            return self[name]
        except KeyError:
            raise AttributeError(f"{type(self).__name__} has no field {name!r}") from None

    @property
    def kind(self) -> str | None:
        """The entity kind ("npc", "loc", "inv", ...), or None for non-entities."""
        value = self.get("$kind", self.get("kind"))
        return value if isinstance(value, str) else None


class Result(RSObject):
    """An SDK result (ActionResult, AttackResult, EatResult, ...).

    ``success``, ``message`` and ``reason`` are always readable; ``reason`` and
    ``data`` are None when the SDK did not set them. Other fields (``hpGained``,
    ``targetType``...) read like any RSObject attribute.
    """

    __slots__ = ()

    @property
    def success(self) -> bool:
        return bool(self.get("success"))

    @property
    def message(self) -> str:
        value = self.get("message")
        return "" if value is None else str(value)

    @property
    def reason(self) -> str | None:
        return self.get("reason")

    @property
    def data(self) -> Any:
        return self.get("data")

    def __repr__(self) -> str:
        fields = ", ".join(f"{key}={value!r}" for key, value in self.items())
        return f"Result({fields})"


def encode_pattern(pattern: re.Pattern[str]) -> dict[str, str]:
    if not isinstance(pattern.pattern, str):
        raise TypeError("bytes patterns are not supported; compile a str pattern")
    if pattern.flags & re.VERBOSE:
        raise ValueError("re.VERBOSE has no JavaScript equivalent; remove it from the pattern")
    flags = "".join(letter for flag, letter in _FLAG_LETTERS if pattern.flags & flag)
    return {"$regex": pattern.pattern, "flags": flags}


def encode(value: Any) -> Any:
    """Encode a Python argument for the bridge."""
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, re.Pattern):
        return encode_pattern(value)
    if isinstance(value, dict):
        return {str(key): encode(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [encode(item) for item in value]
    raise TypeError(f"cannot send {type(value).__name__} to the bridge; use str, numbers, bool, None, re.Pattern, list or dict")


def decode(value: Any) -> Any:
    """Turn bridge JSON into RSObject / Result trees."""
    if isinstance(value, list):
        return [decode(item) for item in value]
    if isinstance(value, dict):
        items = {key: decode(item) for key, item in value.items()}
        if isinstance(items.get("success"), bool):
            return Result(items)
        return RSObject(items)
    return value

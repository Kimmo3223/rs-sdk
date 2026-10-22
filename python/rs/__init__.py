"""Python scripting for RS-SDK bots.

The game logic stays in the TypeScript SDK; this package asks a local bridge
process (``bun pybridge/server.ts <bot>``) to run it::

    import asyncio, re, rs

    async def main():
        rs.connect(bot="mybot")
        result = await rs.attack(re.compile(r"^goblin$", re.I))
        if not result.success:
            print("attack failed:", result.reason, result.message)

    asyncio.run(main())

Every method of :class:`Client` is also a module-level coroutine
(``rs.walk_to``, ``rs.eat_food``...) that uses the client from the last
:func:`connect`. See docs/python-scripting.md.
"""

from __future__ import annotations

from typing import Any

from ._client import Client, SyncClient, connect, connect_sync, default_client
from ._codec import Pattern, Result, RSObject
from ._errors import BridgeNotRunningError, NoClientError, RSError, StaleEntityError
from ._generated import METHODS

__all__ = [
    "BridgeNotRunningError",
    "Client",
    "METHODS",
    "NoClientError",
    "Pattern",
    "RSError",
    "RSObject",
    "Result",
    "StaleEntityError",
    "SyncClient",
    "connect",
    "connect_sync",
    "default_client",
]

_CLIENT_FUNCTIONS = frozenset(name for name in dir(Client) if not name.startswith("_") and callable(getattr(Client, name)))


def __getattr__(name: str) -> Any:
    # Minescript-style module calls: rs.attack(...) -> default_client().attack(...)
    if name in _CLIENT_FUNCTIONS:
        return getattr(default_client(), name)
    raise AttributeError(f"module 'rs' has no attribute {name!r}")


def __dir__() -> list[str]:
    return sorted(set(globals()) | _CLIENT_FUNCTIONS)

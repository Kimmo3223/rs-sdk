"""Errors raised by the rs client."""

from __future__ import annotations


class RSError(Exception):
    """A bridge-reported error or a failure to reach the bridge.

    ``code`` is the bridge's machine-readable category: ``no_client``,
    ``stale_entity``, ``call_failed`` (the SDK method threw), ``bad_argument``,
    ``unknown_method``, ``cancelled``, ``bridge_unreachable``, ...
    """

    def __init__(self, message: str, code: str | None = None, method: str | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.code = code
        self.method = method

    def __str__(self) -> str:
        prefix = f"{self.method}: " if self.method else ""
        return f"{prefix}{self.message}"


class BridgeNotRunningError(RSError):
    """Nothing answered on the bridge port."""


class NoClientError(RSError):
    """The bridge is up, but no game client (browser tab or lite runner) is attached."""


class StaleEntityError(RSError):
    """An entity argument no longer exists in fresh state (the NPC died, the item moved...)."""


_BY_CODE: dict[str, type[RSError]] = {
    "bridge_unreachable": BridgeNotRunningError,
    "no_client": NoClientError,
    "stale_entity": StaleEntityError,
}


def error_for(message: str, code: str | None, method: str | None = None) -> RSError:
    return _BY_CODE.get(code or "", RSError)(message, code, method)

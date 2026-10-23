"""HTTP clients for the RS-SDK Python bridge (pybridge/server.ts)."""

from __future__ import annotations

import asyncio
import os
import warnings
from types import TracebackType
from typing import Any

import httpx

from ._codec import RSObject, decode, encode
from ._errors import BridgeNotRunningError, RSError, error_for
from ._generated import METHODS, AsyncBotMethods, AsyncSdkMethods, SyncBotMethods, SyncSdkMethods

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765

# No read timeout: a call lasts as long as the SDK's own timeouts (walkTo can
# take a minute). Connecting to a local port either works at once or not at all.
_TIMEOUT = httpx.Timeout(connect=5.0, read=None, write=30.0, pool=None)


def _not_running(base_url: str, bot: str | None) -> BridgeNotRunningError:
    port = base_url.rsplit(":", 1)[-1]
    return BridgeNotRunningError(
        f"No RS bridge is answering on {base_url}. Start the game for this bot first, and leave it running: "
        f"bun play.ts {bot or '<botname>'}"
        + ("" if port == "8765" else f" (or bun pybridge/server.ts {bot or '<botname>'} --port {port})"),
        "bridge_unreachable",
    )


def _unwrap(response: httpx.Response, method: str | None) -> Any:
    try:
        body = response.json()
    except ValueError:
        raise RSError(f"bridge sent a non-JSON reply (HTTP {response.status_code})", "bad_response", method) from None
    if not isinstance(body, dict) or "ok" not in body:
        raise RSError(f"bridge sent an unexpected reply (HTTP {response.status_code})", "bad_response", method)
    if body["ok"]:
        return decode(body.get("result"))
    raise error_for(str(body.get("error", "unknown bridge error")), body.get("code"), method)


def _payload(method: str, args: tuple[Any, ...]) -> dict[str, Any]:
    trimmed = list(args)
    while trimmed and trimmed[-1] is None:
        trimmed.pop()
    return {"method": method, "args": [encode(arg) for arg in trimmed]}


def _check_methods(advertised: Any) -> None:
    """Warn when the bridge and this package were generated from different SDKs."""
    try:
        remote = {spec["id"] for spec in advertised["methods"]}
    except (TypeError, KeyError):
        return
    local = set(METHODS)
    missing, extra = sorted(local - remote), sorted(remote - local)
    if missing or extra:
        parts = []
        if missing:
            parts.append(f"not on the bridge: {', '.join(missing)}")
        if extra:
            parts.append(f"bridge-only (use client.call): {', '.join(extra)}")
        warnings.warn(
            "rs package and bridge disagree on the method list (" + "; ".join(parts) + "). "
            "Regenerate with `bun pybridge/gen-python.ts` and reinstall.",
            stacklevel=3,
        )


class _Namespace:
    def __init__(self, owner: Any) -> None:
        self._owner = owner

    def _call(self, method: str, *args: Any) -> Any:
        return self._owner._call(method, *args)


class _AsyncBot(_Namespace, AsyncBotMethods):
    """``client.bot``: BotActions methods only."""


class _AsyncSdk(_Namespace, AsyncSdkMethods):
    """``client.sdk``: BotSDK methods only."""


class _SyncBot(_Namespace, SyncBotMethods):
    """``client.bot``: BotActions methods only."""


class _SyncSdk(_Namespace, SyncSdkMethods):
    """``client.sdk``: BotSDK methods only."""


class Client(AsyncBotMethods, AsyncSdkMethods):
    """Async client for one bot's bridge.

    Every BotActions and BotSDK method from sdk/API.md is a snake_case
    coroutine here (``await client.walk_to(3222, 3218)``). Where both define a
    name, the ``bot`` one wins; ``client.bot`` and ``client.sdk`` reach either
    side explicitly.
    """

    def __init__(self, bot: str | None = None, port: int = DEFAULT_PORT, host: str = DEFAULT_HOST) -> None:
        self.bot_name = bot
        self.base_url = f"http://{host}:{port}"
        self.bot = _AsyncBot(self)
        self.sdk = _AsyncSdk(self)
        self._http: httpx.AsyncClient | None = None
        self._loop: asyncio.AbstractEventLoop | None = None

    def _client(self) -> httpx.AsyncClient:
        # An AsyncClient belongs to one event loop; asyncio.run() twice gets a new one.
        loop = asyncio.get_running_loop()
        if self._http is None or self._loop is not loop:
            self._http = httpx.AsyncClient(base_url=self.base_url, timeout=_TIMEOUT)
            self._loop = loop
        return self._http

    async def _request(self, verb: str, path: str, method: str | None, **kwargs: Any) -> Any:
        try:
            response = await self._client().request(verb, path, **kwargs)
        except httpx.ConnectError:
            raise _not_running(self.base_url, self.bot_name) from None
        except httpx.TransportError as error:
            raise BridgeNotRunningError(f"lost the bridge connection: {error}", "bridge_unreachable", method) from None
        return _unwrap(response, method)

    async def _call(self, method: str, *args: Any) -> Any:
        return await self._request("POST", "/call", method, json=_payload(method, args))

    async def call(self, method: str, *args: Any) -> Any:
        """Call any bridge method by id, e.g. ``await client.call("bot.attack", "goblin")``."""
        return await self._call(method, *args)

    async def get_state(self, allow_stale: bool = False) -> RSObject:
        """The current world state (``sdk.getState()``), entities tagged with ``$kind``.

        Raises NoClientError when no game client is publishing fresh state,
        unless ``allow_stale`` is set.
        """
        params = {"allowStale": "1"} if allow_stale else None
        return await self._request("GET", "/state", "sdk.getState", params=params)  # type: ignore[no-any-return]

    async def clone(self, name: str) -> Client:
        """Make a clone named ``name`` and return a client that controls it.

        See :meth:`SyncClient.clone`. Run the clone alongside this bot with
        ``asyncio.gather``.
        """
        info = await self._request("POST", "/clone", "clone", json={"name": name})
        return Client(info["name"], info["port"], _host_of(self.base_url))

    async def health(self) -> RSObject:
        """Bridge status: bot name, gateway state, whether a game client is attached, queue."""
        return await self._request("GET", "/health", None)  # type: ignore[no-any-return]

    async def methods(self) -> RSObject:
        """The bridge's callable and excluded methods."""
        return await self._request("GET", "/methods", None)  # type: ignore[no-any-return]

    async def aclose(self) -> None:
        if self._http is not None:
            await self._http.aclose()
            self._http = None

    async def __aenter__(self) -> Client:
        return self

    async def __aexit__(self, exc_type: type[BaseException] | None, exc: BaseException | None, tb: TracebackType | None) -> None:
        await self.aclose()


class SyncClient(SyncBotMethods, SyncSdkMethods):
    """Blocking twin of :class:`Client` for simple scripts: same methods, no ``await``."""

    def __init__(self, bot: str | None = None, port: int = DEFAULT_PORT, host: str = DEFAULT_HOST) -> None:
        self.bot_name = bot
        self.base_url = f"http://{host}:{port}"
        self.bot = _SyncBot(self)
        self.sdk = _SyncSdk(self)
        self._http = httpx.Client(base_url=self.base_url, timeout=_TIMEOUT)

    def _request(self, verb: str, path: str, method: str | None, **kwargs: Any) -> Any:
        try:
            response = self._http.request(verb, path, **kwargs)
        except httpx.ConnectError:
            raise _not_running(self.base_url, self.bot_name) from None
        except httpx.TransportError as error:
            raise BridgeNotRunningError(f"lost the bridge connection: {error}", "bridge_unreachable", method) from None
        return _unwrap(response, method)

    def _call(self, method: str, *args: Any) -> Any:
        return self._request("POST", "/call", method, json=_payload(method, args))

    def call(self, method: str, *args: Any) -> Any:
        """Call any bridge method by id, e.g. ``client.call("bot.attack", "goblin")``."""
        return self._call(method, *args)

    def get_state(self, allow_stale: bool = False) -> RSObject:
        """See :meth:`Client.get_state`."""
        params = {"allowStale": "1"} if allow_stale else None
        return self._request("GET", "/state", "sdk.getState", params=params)  # type: ignore[no-any-return]

    def clone(self, name: str) -> SyncClient:
        """Make a clone named ``name`` and return a client that controls it.

        A clone is a second character that shares this bot's bank and skill XP
        (XP either of them earns goes to both) but has its own inventory,
        equipment and position. Every 100 total levels unlock one clone. The
        clone gets its own game client (no browser tab) and starts in
        Lumbridge; it stops when this bot's ``play.ts`` stops.

        Calling it again with the same name gives the same clone back, so a
        script can simply start with ``jaska = bot.clone("jaska")``. Raises
        :class:`RSError` when the clone can't be made, e.g. it isn't unlocked
        yet or the name is taken. Making one can take up to a minute.
        """
        info = self._request("POST", "/clone", "clone", json={"name": name})
        return SyncClient(info["name"], info["port"], _host_of(self.base_url))

    def health(self) -> RSObject:
        return self._request("GET", "/health", None)  # type: ignore[no-any-return]

    def methods(self) -> RSObject:
        return self._request("GET", "/methods", None)  # type: ignore[no-any-return]

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> SyncClient:
        return self

    def __exit__(self, exc_type: type[BaseException] | None, exc: BaseException | None, tb: TracebackType | None) -> None:
        self.close()


def _host_of(base_url: str) -> str:
    return base_url.split("://", 1)[1].rsplit(":", 1)[0]


def _resolve(bot: str | None, port: int | None) -> tuple[str | None, int]:
    bot = bot or os.environ.get("RS_BOT") or None
    if port is None:
        port = int(os.environ.get("RS_PORT", DEFAULT_PORT))
    return bot, port


def _handshake(sync: SyncClient, bot: str | None) -> None:
    health = sync.health()
    served = health.get("bot")
    if bot and isinstance(served, str) and served.lower() != bot.lower():
        raise RSError(f"the bridge on {sync.base_url} serves bot {served!r}, not {bot!r}", "wrong_bot")
    _check_methods(sync.methods())


_default: Client | None = None


def connect(bot: str | None = None, port: int | None = None, host: str = DEFAULT_HOST, *, check: bool = True) -> Client:
    """Connect to a running bridge and make it the default for module-level calls.

    ``bot`` defaults to ``$RS_BOT`` and ``port`` to ``$RS_PORT`` or 8765. With
    ``check`` (the default) this verifies right away that the bridge is up and
    serves ``bot``, raising :class:`BridgeNotRunningError` or :class:`RSError`.
    A missing game client is reported by the first call, not here.
    """
    global _default
    bot, port = _resolve(bot, port)
    if check:
        with SyncClient(bot, port, host) as probe:
            _handshake(probe, bot)
    _default = Client(bot, port, host)
    return _default


def connect_sync(bot: str | None = None, port: int | None = None, host: str = DEFAULT_HOST, *, check: bool = True) -> SyncClient:
    """Blocking variant of :func:`connect`."""
    bot, port = _resolve(bot, port)
    client = SyncClient(bot, port, host)
    if check:
        try:
            _handshake(client, bot)
        except BaseException:
            client.close()
            raise
    return client


def default_client() -> Client:
    """The client from the last :func:`connect`, connecting with defaults if there is none."""
    return _default if _default is not None else connect()

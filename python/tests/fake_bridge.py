"""A stand-in for pybridge/server.ts that records requests and returns canned replies."""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable

from rs import METHODS

Reply = tuple[int, dict[str, Any]]

GOBLIN = {"kind": "npc", "$kind": "npc", "id": 100, "index": 7, "name": "Goblin", "x": 3210, "z": 3210, "optionsWithIndex": []}


def default_handler(method: str, args: list[Any]) -> Reply:
    if method == "sdk.findNearbyNpc":
        return 200, {"ok": True, "result": GOBLIN}
    if method == "bot.waitForIdle":
        return 500, {"ok": False, "error": "Timed out waiting for idle", "code": "call_failed", "errorName": "Error"}
    if method == "bot.eatFood":
        return 409, {"ok": False, "error": "Stale inv: no slot holds that item any more.", "code": "stale_entity"}
    if method == "sdk.getSkill":
        return 503, {"ok": False, "error": 'No game client is attached to "fakebot"', "code": "no_client"}
    if method == "sdk.getInventory":
        return 200, {"ok": True, "result": [{"slot": 0, "id": 2309, "name": "Bread", "count": 1, "$kind": "inv"}]}
    if method in METHODS:
        return 200, {"ok": True, "result": {"success": True, "message": f"did {method}", "echo": args}}
    return 404, {"ok": False, "error": f'Unknown or non-callable method "{method}"', "code": "unknown_method"}


class FakeBridge:
    def __init__(self, bot: str = "fakebot", handler: Callable[[str, list[Any]], Reply] = default_handler) -> None:
        self.bot = bot
        self.handler = handler
        self.calls: list[dict[str, Any]] = []
        self.extra_methods: list[str] = []
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args: Any) -> None:
                pass

            def _send(self, status: int, body: dict[str, Any]) -> None:
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self) -> None:
                if self.path == "/health":
                    self._send(200, {"ok": True, "result": {"bot": fake.bot, "gateway": "connected", "clientAttached": True}})
                elif self.path == "/methods":
                    ids = list(METHODS) + fake.extra_methods
                    self._send(200, {"ok": True, "result": {"methods": [{"id": i} for i in ids], "excluded": []}})
                elif self.path.startswith("/state"):
                    fake.calls.append({"path": self.path})
                    self._send(200, {"ok": True, "result": {"tick": 5, "player": {"worldX": 3222, "worldZ": 3218}, "nearbyNpcs": [GOBLIN]}})
                else:
                    self._send(404, {"ok": False, "error": "not found", "code": "not_found"})

            def do_POST(self) -> None:
                length = int(self.headers.get("content-length", "0"))
                body = json.loads(self.rfile.read(length))
                fake.calls.append(body)
                status, reply = fake.handler(body["method"], body["args"])
                self._send(status, reply)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self) -> FakeBridge:
        self.thread.start()
        return self

    def __exit__(self, *exc: Any) -> None:
        self.server.shutdown()
        self.server.server_close()

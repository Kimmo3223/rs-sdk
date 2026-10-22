from __future__ import annotations

import asyncio
import re
import socket
import warnings
from typing import Any, Iterator

import pytest

import rs
from rs._codec import decode, encode

from fake_bridge import GOBLIN, FakeBridge


@pytest.fixture
def bridge() -> Iterator[FakeBridge]:
    with FakeBridge() as fake:
        yield fake


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def run(coro: Any) -> Any:
    return asyncio.run(coro)


# ---- encoding -------------------------------------------------------------


def test_compiled_patterns_encode_as_regex() -> None:
    assert encode(re.compile(r"^goblin$", re.I)) == {"$regex": "^goblin$", "flags": "i"}
    assert encode(re.compile(r"a.b", re.M | re.S)) == {"$regex": "a.b", "flags": "ms"}
    assert encode("goblin") == "goblin"
    assert encode({"matching": re.compile("hi"), "list": (1, None)}) == {"matching": {"$regex": "hi", "flags": ""}, "list": [1, None]}


def test_unsupported_values_are_rejected() -> None:
    with pytest.raises(ValueError):
        encode(re.compile("a b", re.X))
    with pytest.raises(TypeError):
        encode(object())


def test_results_decode_to_attribute_objects() -> None:
    result = decode({"success": False, "message": "Target not found", "reason": "npc_not_found"})
    assert isinstance(result, rs.Result)
    assert (result.success, result.message, result.reason, result.data) == (False, "Target not found", "npc_not_found", None)
    no_reason = decode({"success": True, "message": "ok"})
    assert no_reason.reason is None
    npc = decode(GOBLIN)
    assert isinstance(npc, rs.RSObject) and npc.name == "Goblin" and npc.kind == "npc"
    with pytest.raises(AttributeError):
        _ = npc.missing_field


# ---- calls ----------------------------------------------------------------


def test_calls_send_method_ids_and_encoded_args(bridge: FakeBridge) -> None:
    client = rs.connect(bot="fakebot", port=bridge.port)

    async def main() -> None:
        result = await client.attack(re.compile(r"^goblin$", re.I))
        assert result.success and result.message == "did bot.attack"
        await client.walk_to(3222, 3218)
        await client.walk_to(3222, 3218, None, {"timeout": 5000})
        await client.chop_tree()

    run(main())
    assert bridge.calls == [
        {"method": "bot.attack", "args": [{"$regex": "^goblin$", "flags": "i"}]},
        {"method": "bot.walkTo", "args": [3222, 3218]},
        {"method": "bot.walkTo", "args": [3222, 3218, None, {"timeout": 5000}]},
        {"method": "bot.chopTree", "args": []},
    ]


def test_entities_round_trip_with_their_kind(bridge: FakeBridge) -> None:
    client = rs.connect(bot="fakebot", port=bridge.port)

    async def main() -> None:
        goblin = await client.find_nearby_npc("goblin")
        await client.attack(goblin)
        state = await client.get_state()
        await client.attack(state.nearbyNpcs[0])
        bread = (await client.get_inventory())[0]
        await client.drop_item(bread)

    run(main())
    sent = [call["args"][0] for call in bridge.calls if call.get("method") in ("bot.attack", "bot.dropItem")]
    assert sent[0] == GOBLIN and sent[1] == GOBLIN
    assert sent[2]["$kind"] == "inv" and sent[2]["slot"] == 0


def test_bot_wins_name_clashes_and_namespaces_reach_both(bridge: FakeBridge) -> None:
    client = rs.connect(bot="fakebot", port=bridge.port)

    async def main() -> None:
        await client.get_equipment()
        await client.sdk.get_equipment()
        await client.bot.get_equipment()

    run(main())
    assert [call["method"] for call in bridge.calls] == ["bot.getEquipment", "sdk.getEquipment", "bot.getEquipment"]


def test_module_level_calls_use_the_default_client(bridge: FakeBridge) -> None:
    rs.connect(bot="fakebot", port=bridge.port)

    async def main() -> None:
        assert (await rs.say("hi")).success
        await rs.attack("goblin")
        state = await rs.get_state(allow_stale=True)
        assert state.player.worldX == 3222

    run(main())
    assert bridge.calls[-2] == {"method": "bot.attack", "args": ["goblin"]}
    assert bridge.calls[-1] == {"path": "/state?allowStale=1"}
    with pytest.raises(AttributeError):
        _ = rs.not_a_method  # type: ignore[attr-defined]


def test_client_survives_several_event_loops(bridge: FakeBridge) -> None:
    client = rs.connect(bot="fakebot", port=bridge.port)
    run(client.attack("goblin"))
    run(client.attack("goblin"))
    assert len(bridge.calls) == 2


def test_sync_client(bridge: FakeBridge) -> None:
    with rs.connect_sync(bot="fakebot", port=bridge.port) as client:
        assert client.attack("goblin").success
        assert client.get_state().tick == 5
        with pytest.raises(rs.StaleEntityError):
            client.eat_food({"$kind": "inv", "slot": 0, "id": 2309})


def test_every_generated_method_exists_on_both_clients() -> None:
    for name in rs.METHODS.values():
        assert callable(getattr(rs.Client, name)), name
        assert callable(getattr(rs.SyncClient, name)), name
    assert asyncio.iscoroutinefunction(rs.Client.attack)


# ---- errors ---------------------------------------------------------------


def test_bridge_errors_raise_typed_rserrors(bridge: FakeBridge) -> None:
    client = rs.connect(bot="fakebot", port=bridge.port)

    async def main() -> None:
        with pytest.raises(rs.NoClientError, match="No game client is attached") as no_client:
            await client.get_skill("hitpoints")
        assert no_client.value.code == "no_client"
        with pytest.raises(rs.StaleEntityError):
            await client.eat_food({"$kind": "inv", "slot": 0, "id": 2309})
        with pytest.raises(rs.RSError) as failed:
            await client.wait_for_idle()
        assert failed.value.code == "call_failed"
        assert str(failed.value) == "bot.waitForIdle: Timed out waiting for idle"
        with pytest.raises(rs.RSError) as unknown:
            await client.call("sdk.disconnect")
        assert unknown.value.code == "unknown_method"

    run(main())


def test_bridge_not_running() -> None:
    port = free_port()
    with pytest.raises(rs.BridgeNotRunningError, match=f"bun pybridge/server.ts mybot --port {port}"):
        rs.connect(bot="mybot", port=port)
    with pytest.raises(rs.BridgeNotRunningError):
        rs.connect_sync(bot="mybot", port=port)
    client = rs.Client(bot="mybot", port=port)
    with pytest.raises(rs.BridgeNotRunningError) as error:
        run(client.attack("goblin"))
    assert error.value.code == "bridge_unreachable"


def test_wrong_bot_on_port(bridge: FakeBridge) -> None:
    with pytest.raises(rs.RSError, match="serves bot 'fakebot', not 'otherbot'"):
        rs.connect(bot="otherbot", port=bridge.port)


def test_method_list_drift_warns(bridge: FakeBridge) -> None:
    bridge.extra_methods = ["bot.brandNewMethod"]
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        rs.connect(bot="fakebot", port=bridge.port)
    assert any("bot.brandNewMethod" in str(w.message) for w in caught)

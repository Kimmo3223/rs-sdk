# Python scripting

Drive an RS-SDK bot from Python:

```python
import asyncio, re, rs

async def main():
    rs.connect(bot="mybot")
    result = await rs.attack(re.compile(r"^goblin$", re.I))
    print(result.success, result.reason, result.message)

asyncio.run(main())
```

Python only decides what to do. All game logic (pathfinding, doors, waiting
for evidence that an action worked) still runs in the TypeScript `bot.*` and
`sdk.*` code. A small Bun process, the **bridge**, owns one bot's SDK
connection and serves it as local JSON:

```
python script ──HTTP──▶ pybridge/server.ts ──WS──▶ gateway ◀──WS── game client ──▶ game server
 (rs package)          (BotSDK + BotActions)       :7780        (browser tab or lite runner)
```

## Setup

From the repo root:

```sh
bun install
(cd server/webclient && bun install)      # only needed for the headless lite client
python3 -m venv .venv && . .venv/bin/activate
pip install -e python/                    # the `rs` package; Python 3.9+, depends on httpx
```

Create a bot if you don't have one. For a local server use `--local`, which
writes `SERVER=localhost:8888` and `GATEWAY_URL=ws://localhost:7780`:

```sh
bun bots/create-bot.ts mybot --local
```

A blank `SERVER=` also works for the bridge (it then uses `ws://localhost:7780`,
as everywhere else in the SDK), but the lite runner then dials the game server
on port 80, so prefer `--local` when you run the lite client.

### Local server

Run these three, each in its own terminal (see the README):

```sh
cd server/engine && bun run start        # game engine on :8888
cd server/webclient && bun run watch     # web client bundler
cd server/gateway && bun run gateway     # gateway on ws://localhost:7780
```

If the engine stops at `.loc checksum mismatch!` on its first build, start it
with `BUILD_VERIFY=false bun run start`; `server/Dockerfile` builds the same way.

## Running a bot from Python

Three processes per bot, all left running:

1. **A game client**, which logs the character in and publishes its state.
   Either open the browser client at
   `http://localhost:8888/bot?bot=mybot&password=<PASSWORD from bot.env>`, or
   run the headless lite client:

   ```sh
   cd server/webclient && bun src/lite/runner.ts mybot
   ```

2. **The bridge**:

   ```sh
   bun pybridge/server.ts mybot              # port 8765
   bun pybridge/server.ts mybot --port 8766
   ```

   It reads `bots/mybot/bot.env` the same way `bun bots/mybot/script.ts`
   does, connects to the gateway in control mode, and listens on
   `127.0.0.1` only. It keeps reconnecting if the gateway restarts, and it
   starts fine before the game client: calls report `No game client is
   attached` until one is.

3. **Your script**:

   ```sh
   python python/examples/goblins.py --bot mybot
   ```

Like any controller, the bridge takes control of the bot when it connects. Do
not run a TypeScript script (or MCP `execute_code`) against the same bot while
the bridge is up; they will pre-empt each other.

## The Python API

### Connecting

```python
client = rs.connect(bot="mybot", port=8765)   # async client, also the module default
client = rs.connect_sync(bot="mybot")         # blocking client
```

`bot` defaults to `$RS_BOT` and `port` to `$RS_PORT` or 8765. `connect` checks
right away that the bridge is running and serves that bot, and raises
`rs.BridgeNotRunningError` or `rs.RSError` if not. It also warns when the
installed package and the bridge disagree on the method list.

### Methods

Every BotActions and BotSDK method listed in [`sdk/API.md`](../sdk/API.md) is
available in snake_case, with the same positional parameters:

| TypeScript | Python (async) | Python (sync) |
|---|---|---|
| `await bot.attack(target)` | `await client.attack(target)` | `client.attack(target)` |
| `await bot.walkTo(x, z, 2)` | `await client.walk_to(x, z, 2)` | `client.walk_to(x, z, 2)` |
| `sdk.findNearbyNpc(/^goblin$/i)` | `await client.find_nearby_npc(re.compile("^goblin$", re.I))` | ... |
| `await sdk.waitForTicks(3)` | `await client.wait_for_ticks(3)` | ... |
| `await bot.openGE()` | `await client.open_ge()` | ... |

Some useful ones: `attack`, `walk_to`, `eat_food`, `equip_item`,
`pickup_item`, `drop_item`, `talk_to`, `interact_npc`, `interact_loc`,
`chop_tree`, `open_bank`, `deposit_item`, `withdraw_item`, `open_shop`,
`buy_from_shop`, `skip_tutorial`, `find_nearby_npc`, `find_inventory_item`,
`find_ground_item`, `count_inventory_items`, `get_skill`, `get_chat`, `say`,
`wait_for_ticks`. Each method's docstring carries the TypeScript signature and
description.

- **Module level.** `rs.attack(...)`, `rs.get_state()` and so on call the
  client from the last `rs.connect()` (connecting with the defaults if there
  is none). Static type checkers cannot see these names; use the client
  object when you want type checking.
- **Name clashes.** `bot.getEquipment` and `sdk.getEquipment` both exist; the
  flat name uses the `bot` one. `client.bot.<name>` and `client.sdk.<name>`
  reach either side explicitly.
- **Defaults.** Pass `None` (or leave an argument off) to get the TypeScript
  default: the bridge turns top-level `null` arguments into `undefined`.
  Option objects are plain dicts: `await client.walk_to(x, z, None, {"timeout": 20000})`.
- **Anything else.** `await client.call("bot.attack", "goblin")` calls a
  method by its bridge id.
- **Not available.** `connect`, `disconnect` and `launchBrowser` (they belong
  to the bridge), and methods that take a callback, which JSON cannot carry:
  `waitForCondition`, `onStateUpdate`, `onConnectionStateChange`. Instead of
  `waitForCondition`, poll `get_state()` between `wait_for_ticks(1)` calls.
  `GET /methods` lists every excluded method with the reason.

### State

```python
state = await client.get_state()       # sdk.getState(), served from GET /state
state.player.worldX, state.player.hp
[npc.name for npc in state.nearbyNpcs]
```

`get_state` raises `rs.NoClientError` when no game client has published a new
tick for 10 s. Pass `allow_stale=True` to read the last cached state anyway.
Polling `get_state()` once per tick is fine; there is no push channel in v1.

### Results

JSON objects come back as `rs.RSObject`, a `dict` with attribute access
(`npc.name`, `state.player.combat.inCombat`). Objects with a boolean `success`
field (ActionResult, AttackResult, EatResult...) come back as `rs.Result`,
whose `success`, `message`, `reason` and `data` attributes are always
readable. `reason` is `None` when the SDK did not set one. Other fields read
like any attribute (`result.hpGained`, `result.targetType`).

As in TypeScript, a failed action is a result, not an exception:

```python
result = await client.attack("goblin")
if not result.success:
    print(result.reason, result.message)   # e.g. npc_not_found, out_of_reach
```

### Errors

Problems with the call itself raise `rs.RSError`, which has `code`, `message`
and `method` attributes:

| Exception | `code` | When |
|---|---|---|
| `rs.BridgeNotRunningError` | `bridge_unreachable` | Nothing answers on the port, or the bridge died mid-call |
| `rs.NoClientError` | `no_client` | Bridge is up, but no game client is attached |
| `rs.StaleEntityError` | `stale_entity` | An entity argument is gone from fresh state |
| `rs.RSError` | `call_failed` | The SDK method threw, e.g. a `waitFor*` timeout |
| `rs.RSError` | `bad_argument`, `bad_request` | Bad regex, unknown `$kind`, malformed request |
| `rs.RSError` | `unknown_method` | Not a callable method, or excluded |

## Patterns

Wherever the TypeScript API takes `string | RegExp`, pass a `str` or a
compiled `re.Pattern`:

- A **`str`** is passed through unchanged and matched the way the SDK matches
  strings: **case-insensitive substring**. `"goblin"` matches "Goblin" and
  "Goblin chief"; the `find*` lookups then prefer the shortest name. (The SDK
  compiles the string as a case-insensitive regex, and falls back to a plain
  substring match when it contains regex metacharacters and matches nothing.)
- A **`re.Pattern`** is sent as `{"$regex": "<source>", "flags": "<flags>"}`
  and rebuilt as a JavaScript `RegExp`. Use it for exact matches:
  `re.compile(r"^goblin$", re.I)`. `re.I`, `re.M` and `re.S` map to `i`, `m`,
  `s`; `re.X` is rejected. The source is compiled by JavaScript, so stick to
  syntax both languages share (no `(?P<name>...)`).

## Entity arguments

Methods such as `attack`, `chop_tree`, `eat_food` and `pickup_item` accept the
entity objects you read from state or from `find_*`. Pass them straight back:

```python
goblin = await client.find_nearby_npc(re.compile(r"^goblin$", re.I))
await client.attack(goblin)

state = await client.get_state()
await client.chop_tree(state.nearbyLocs[0])
```

The bridge never uses the coordinates in the object you send. It looks the
entity up again in the current state and hands the SDK that live entry, so an
NPC that walked off since your snapshot is attacked where it is now. Entities
in `/state` and in method results carry a `"$kind"` field that says how to
look them up:

| `$kind` | From | Looked up by |
|---|---|---|
| `npc` | `nearbyNpcs`, `find_nearby_npc` | `index`; also `id` must still match (world slots are reused) |
| `player` | `nearbyPlayers`, `find_nearby_player` | `index`; also `name` must still match |
| `loc` | `nearbyLocs`, `find_nearby_loc`, `scan_*` | `x`, `z`, `id` (and `level` if present) |
| `ground` | `groundItems`, `find_ground_item` | `x`, `z`, `id` |
| `inv` | `inventory`, `find_inventory_item` | `slot` + `id`, else the first slot holding `id` |
| `equip` | `equipment`, `get_equipment` | `slot` + `id`, else the first slot holding `id` |
| `bank` | `bank.items`, `find_bank_item` | `slot` + `id`, else the first slot holding `id` |
| `shop` | `shop.shopItems` | `id` in the open shop |

NPC and player objects also work without `$kind`, because they carry the
SDK's own `kind` field. To build a reference by hand, send just the lookup
fields: `{"$kind": "npc", "index": 2881, "id": 100}`.

If the entity is gone (the goblin died, the item was used up), the call raises
`rs.StaleEntityError` instead of acting on stale data. Look the entity up
again and retry. Objects without `$kind` or an npc/player `kind` are passed
through as plain data (option dicts, `GEOfferRequest`...).

## Concurrency and cancellation

One bridge drives one character, and two actions at once (a `walk_to` racing
an `attack`) would fight over the same player. So the bridge **queues**
actions: calls that move or act run one at a time, in arrival order. Reads and
waits (`get*`, `find*`, `is*`, `check*`, `waitFor*`, `getState`) and chat
(`say`, `dm`, `sendSay`, `sendPrivateMessage`), plus `sendScreenshot` and
`sendFindPath`, skip the queue and run alongside. `GET /health` shows what is
running and how many calls wait. Concurrent tasks in one script are therefore
safe, but their actions will not overlap.

Calls have no HTTP timeout on either side: a `walk_to` lasts as long as the
SDK lets it. When the Python side goes away mid-call (Ctrl+C, a cancelled
task, a killed process), the bridge sees the connection close and cancels the
call through the SDK's execution context. The SDK stops waiting and stops
sending further steps; a movement already sent to the game server may still
finish its current leg.

## Several bots

Run one game client and one bridge per bot, each bridge on its own port:

```sh
bun pybridge/server.ts alice --port 8765
bun pybridge/server.ts bob   --port 8766
```

```python
alice = rs.connect(bot="alice", port=8765)
bob = rs.connect(bot="bob", port=8766)
await asyncio.gather(alice.attack("goblin"), bob.chop_tree())
```

`rs.connect` checks that each port serves the bot you named. The module-level
functions use whichever client was connected last, so use the client objects
when you drive several bots.

## HTTP protocol

Usable from any language. All replies are JSON, either
`{"ok": true, "result": ...}` or `{"ok": false, "error": "...", "code": "..."}`.

| Request | Result |
|---|---|
| `GET /health` | `{bot, gateway, clientAttached, tick, stateAgeMs, queue, methods}` |
| `GET /state[?allowStale=1]` | `sdk.getState()` with `$kind` tags |
| `GET /methods` | `{methods: [...], excluded: [...]}`, each method with its params and TS signature |
| `POST /call` `{"method": "bot.attack", "args": [...]}` | The method's return value |

## Keeping Python in sync with the SDK

The bridge builds its method table from the same model that generates
`sdk/API.md`, so new SDK methods become callable through the bridge (and
`client.call`) right away. The snake_case wrappers in `python/rs/_generated.py`
come from that same table. Regenerate them after SDK changes:

```sh
bun pybridge/gen-python.ts       # or: bun run pybridge:python
```

`bun run test` fails while the generated file is stale.

## Tests

```sh
bun test pybridge/test                         # bridge, mocked SDK (also part of `bun run test`)
pip install -e 'python/[test]' && pytest python   # Python client against a fake bridge
```

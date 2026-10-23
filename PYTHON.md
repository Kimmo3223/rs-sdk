# Play with a Python bot

Write a few lines of Python, watch your character walk around and fight in
the game. No game knowledge or server setup needed.

```python
import rs

bot = rs.connect_sync("mybot")
bot.walk_to(3252, 3230)
bot.attack("goblin")
```

## 1. Install the tools (once)

You need:

- **Git**: <https://git-scm.com/downloads>
- **Bun** (runs the game): <https://bun.sh>. On macOS or Linux: `curl -fsSL https://bun.sh/install | bash`
- **Python 3.9 or newer**: <https://www.python.org/downloads/>

## 2. Get the game (once)

```sh
git clone https://github.com/MaxBittker/rs-sdk.git
cd rs-sdk
bun install
```

## 3. Start playing

Pick a name for your character (letters and numbers, at most 12) and run:

```sh
bun play.ts mybot
```

This one command does everything:

- creates your character,
- starts the game server on your computer (the **first start takes a few
  minutes** while it builds the game),
- sets up Python,
- opens the game in your browser and logs your character in,
- skips the tutorial, so you start in Lumbridge.

When it prints **Ready!**, leave that terminal and the browser tab open.

## 4. Run your bot

Every new character gets a starter bot in `bots/mybot/bot.py`. Open a
**second terminal** in the same folder and run it:

```sh
.venv/bin/python bots/mybot/bot.py        # macOS / Linux
.venv\Scripts\python bots\mybot\bot.py    # Windows
```

Look at the browser tab: your character walks to the goblins and fights five
of them. Press **Ctrl+C** to stop a bot early (Python then prints a
`KeyboardInterrupt` message; that's normal).

## 5. Change what it does

Open `bots/mybot/bot.py` in any editor, change it, save, and run it again.
You don't need to restart the game for that. Every script starts like this:

```python
import rs

bot = rs.connect_sync("mybot")
```

Then call commands on `bot`. Here are some to try.

### Where am I?

```python
me = bot.get_state().player
print(me.worldX, me.worldZ, me.hp, me.maxHp)
```

Positions are `(x, z)` map coordinates. Lumbridge castle is around
`(3222, 3218)`. To find a spot, walk there yourself in the browser, then print
your position.

### Walk

```python
bot.walk_to(3222, 3218)      # finds the way and opens doors and gates
```

### Fight, eat, pick things up

```python
bot.attack("goblin")          # walks to the nearest goblin and attacks it
bot.eat_food()                # eats whatever food you carry
bot.pickup_item("bones")      # picks bones up from the ground
```

### Chop trees and make fires

```python
bot.chop_tree()               # chops the nearest tree
bot.burn_logs()               # lights the logs with your tinderbox
bot.drop_item("logs")         # or drop them
```

### Talk

```python
bot.say("hello everyone")
```

### Wait

The game moves in **ticks** of about 0.4 seconds:

```python
bot.wait_for_ticks(5)         # wait about 2 seconds
```

### Check whether something worked

Commands give back a **result** with `success` and `message`:

```python
result = bot.attack("goblin")
if result.success:
    print("Fighting!")
else:
    print("Could not attack:", result.message)
```

### Names

Names are not case sensitive and match part of the name: `"goblin"` finds
"Goblin". To see what is around you:

```python
state = bot.get_state()
print([npc.name for npc in state.nearbyNpcs])     # people and monsters
print([loc.name for loc in state.nearbyLocs])     # trees, doors, rocks...
print([item.name for item in state.inventory])    # your backpack
```

### Keep going forever

```python
import rs

bot = rs.connect_sync("mybot")

while True:
    if bot.count_inventory_items("logs") >= 5:
        for _ in range(5):
            bot.burn_logs()
    bot.chop_tree()
```

Stop it with Ctrl+C.

## All commands

```sh
.venv/bin/python -m pydoc rs.SyncClient
```

lists every command with what it does. In an editor with Python support (VS
Code, Neovim, PyCharm...), choose `.venv` as the Python interpreter. Typing
`bot.` then shows the commands as you type. [sdk/API.md](sdk/API.md) has the
full list grouped by topic, under their original TypeScript names (`walkTo`
there is `walk_to` here).

## When something goes wrong

| You see | What to do |
|---|---|
| `No RS bridge is answering on http://127.0.0.1:8765` | The game isn't running. Start `bun play.ts mybot` and wait for **Ready!** |
| `No game client is attached` | The browser tab was closed or logged out. Reopen the link `play.ts` printed, or restart `play.ts` |
| `ModuleNotFoundError: No module named 'rs'` | Run your bot with `.venv/bin/python`, not just `python` |
| `Target not found: goblin` | Nothing with that name is nearby. Walk closer, or print `state.nearbyNpcs` to check the name |
| The character does nothing | Check that only one bot script runs for that character at a time |
| `play.ts` stops with an error | It names a log file in `.play-logs/`; the last lines usually say why |

## More characters

Each character needs its own `play.ts`, in its own terminal:

```sh
bun play.ts alice
bun play.ts bob        # play.ts picks the next free port and tells you
```

The first character's bot is on port 8765. For others, put the port
`play.ts` printed into the script: `rs.connect_sync("bob", port=8766)`.

## Going further

- [docs/python-scripting.md](docs/python-scripting.md) is the full Python
  reference: async scripts, exact-name patterns, errors, and how the parts
  fit together.
- `python/examples/goblins.py` is a longer fighting bot.
- [learnings/](learnings/) and [wiki/](wiki/) list where to find monsters,
  trees, shops and more.

### Playing with friends

[HOSTING.md](HOSTING.md) shows how to host the game for friends:
`bun host.ts` shares it through a Cloudflare tunnel with sign-in required, and
`bun host.ts add <name>` gives a friend an account.

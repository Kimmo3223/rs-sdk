"""Fight goblins: attack the nearest free goblin, eat when HP is low, wait out each fight.

Start the bridge and a game client first (see docs/python-scripting.md), then:

    python python/examples/goblins.py --bot mybot

The Lumbridge goblins are east of the castle, around (3252, 3230). Ctrl+C stops
the script and cancels whatever the bot is doing.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import re
import sys
import time

import rs

GOBLIN = re.compile(r"^goblin$", re.I)

log = logging.getLogger("goblins")


def pick_goblin(state: rs.RSObject) -> rs.RSObject | None:
    """Nearest goblin nobody else is fighting and that we can walk to."""
    candidates = [
        npc for npc in state.nearbyNpcs
        if GOBLIN.search(npc.name) and not npc.inCombat and npc.get("reachable") is not False
    ]
    return min(candidates, key=lambda npc: npc.distance, default=None)


async def fight(client: rs.Client, eat_below: float, duration: float | None) -> None:
    deadline = time.monotonic() + duration if duration else None
    kills_started = 0
    warned_no_food = False

    while deadline is None or time.monotonic() < deadline:
        try:
            state = await client.get_state()
            player = state.player

            if player.hp <= player.maxHp * eat_below:
                food = [item for item in state.inventory if any(o.text == "Eat" for o in item.optionsWithIndex)]
                if not food:
                    if not warned_no_food:
                        log.warning("HP %d/%d and no food left; fighting on", player.hp, player.maxHp)
                        warned_no_food = True
                else:
                    eaten = await client.eat_food(food[0])
                    if eaten.success:
                        log.info("ate: %s (+%s HP)", eaten.message, eaten.get("hpGained"))
                    else:
                        warned_no_food = True
                        log.warning("eat failed: reason=%s message=%s", eaten.reason, eaten.message)

            if player.combat.inCombat:
                await client.wait_for_ticks(1)
                continue

            goblin = pick_goblin(state)
            if goblin is None:
                log.info("no free goblin nearby; waiting")
                await client.wait_for_ticks(5)
                continue

            result = await client.attack(goblin)
            if result.success:
                kills_started += 1
                log.info("fight %d: %s at (%d, %d)", kills_started, result.message, goblin.x, goblin.z)
                # Give the combat state a couple of ticks to show the engagement.
                await client.wait_for_ticks(2)
            else:
                log.warning("attack failed: reason=%s message=%s", result.reason, result.message)
                await client.wait_for_ticks(2)

        except rs.StaleEntityError as error:
            # The goblin died or wandered off between reading state and attacking.
            log.info("target gone: %s", error.message)
        except rs.NoClientError as error:
            log.error("%s", error.message)
            await asyncio.sleep(5)

    log.info("time is up after %d fights", kills_started)


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--bot", help="bot name the bridge serves (default: $RS_BOT)")
    parser.add_argument("--port", type=int, help="bridge port (default: $RS_PORT or 8765)")
    parser.add_argument("--eat-below", type=float, default=0.5, help="eat when HP falls below this fraction of max (default 0.5)")
    parser.add_argument("--duration", type=float, help="stop after this many seconds (default: run until Ctrl+C)")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    try:
        client = rs.connect(bot=args.bot, port=args.port)
    except rs.RSError as error:
        log.error("%s", error)
        return 1
    async with client:
        await fight(client, args.eat_below, args.duration)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except KeyboardInterrupt:
        # asyncio.run cancelled the pending request; the bridge sees the
        # connection drop and cancels the bot's current action.
        log.info("stopped by Ctrl+C")
        sys.exit(130)

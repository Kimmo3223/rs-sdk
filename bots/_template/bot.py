"""{{USERNAME}}'s Python bot.

1. Start the game (leave it running):   bun play.ts {{USERNAME}}
2. Run this file in another terminal:   .venv/bin/python bots/{{USERNAME}}/bot.py
3. Press Ctrl+C to stop the bot.

PYTHON.md has a tutorial and a list of things to try.
"""

import rs

bot = rs.connect_sync("{{USERNAME}}")

me = bot.get_state().player
print(f"Hello, {me.name}! You are at ({me.worldX}, {me.worldZ}) with {me.hp} HP.")

# Walk to the goblins east of Lumbridge castle.
print(bot.walk_to(3252, 3230).message)

# Fight 5 goblins.
for fight in range(1, 6):
    if bot.get_state().player.hp < 5:
        print(bot.eat_food().message)

    result = bot.attack("goblin")
    print(f"Fight {fight}: {result.message}")
    if not result.success:
        bot.wait_for_ticks(5)  # nobody to fight right now; wait about 2 seconds
        continue

    # Wait until the fight is over.
    bot.wait_for_ticks(2)
    while bot.get_state().player.combat.inCombat:
        bot.wait_for_ticks(1)

print("Done!")

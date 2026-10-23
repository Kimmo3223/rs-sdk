// rs-sdk: spectating. `::spectate <name>` makes a player invisible and has them
// follow another player, so their normal game view shows what the other player
// sees; `::spectate` on its own puts them back where they started. While
// watching, game actions (walking, ops, inventory) are ignored (see
// SPECTATOR_BLOCKED in NetworkPlayer.decodeIn), and a save keeps the spot they
// started from, so watching never moves anyone.

import { Visibility } from '#/network/rsbuf/index.js';
import { BlockWalk } from '#/engine/entity/BlockWalk.js';
// Type-only Player import: Player imports this module.
import type Player from '#/engine/entity/Player.js';
import { changeNpcCollision, changePlayerOccCollision } from '#/engine/GameMap.js';

/** How far (in tiles) a spectator walks to keep up before it just jumps. */
const FOLLOW_RANGE = 3;

export type SpectateReturn = { x: number; z: number; level: number };

function hide(player: Player) {
    player.visibility = Visibility.HARD;
    player.blockWalk = BlockWalk.NONE;
    changeNpcCollision(player.width, player.x, player.z, player.level, false);
    changePlayerOccCollision(player.width, player.x, player.z, player.level, false);
}

function show(player: Player) {
    player.visibility = Visibility.DEFAULT;
    player.blockWalk = BlockWalk.PLAYER;
    changePlayerOccCollision(player.width, player.x, player.z, player.level, true);
}

/** Start (or switch) watching `target`. `find` looks a player up by name. Returns a message for the spectator. */
export function startSpectating(player: Player, targetName: string, find: (name: string) => Player | undefined): string {
    const target = find(targetName);
    if (!target || !target.isActive) return `${targetName} is not logged in.`;
    if (target === player) return 'You can\'t watch yourself.';
    if (target.spectating) return `${target.displayName} is watching someone else right now.`;

    if (!player.spectating) {
        // Invisible players can't be attacked, so no slipping away from a fight.
        if (player.isInWilderness()) return 'You can\'t start watching in the Wilderness.';
        player.closeModal();
        if (!player.canAccess()) return 'Please finish what you are doing first.';
        player.spectateReturn = { x: player.x, z: player.z, level: player.level };
        hide(player);
    } else {
        player.spectating.messageGame(`${player.displayName} stopped watching you.`);
    }

    player.clearInteraction();
    player.clearWaypoints();
    player.unsetMapFlag();
    player.spectating = target;
    player.teleJump(target.x, target.z, target.level);
    target.messageGame(`${player.displayName} is watching you.`);
    return `Watching ${target.displayName}. Type ::spectate to stop.`;
}

/** Stop watching and go back to where the player started. */
export function stopSpectating(player: Player, reason?: string) {
    const target = player.spectating;
    const back = player.spectateReturn;
    if (!target || !back) return;
    player.spectating = null;
    player.spectateReturn = null;
    player.clearInteraction();
    player.clearWaypoints();
    player.teleJump(back.x, back.z, back.level);
    show(player);
    if (target.isActive) target.messageGame(`${player.displayName} stopped watching you.`);
    player.messageGame(reason ? `${reason} You are back where you started.` : 'You stopped watching and are back where you started.');
}

/** Each tick, before the spectator moves: keep up with the target. */
export function followTarget(player: Player, isOnline: (target: Player) => boolean) {
    const target = player.spectating;
    if (!target) return;
    if (!isOnline(target)) {
        stopSpectating(player, `${target.displayName} logged out.`);
        return;
    }
    player.clearInteraction();
    player.runenergy = 10000;
    const far = player.level !== target.level || Math.abs(player.x - target.x) > FOLLOW_RANGE || Math.abs(player.z - target.z) > FOLLOW_RANGE;
    if (far) {
        player.clearWaypoints();
        player.teleJump(target.x, target.z, target.level);
    } else if (player.x !== target.x || player.z !== target.z) {
        player.queueWaypoint(target.x, target.z);
        player.tempRun = 1;
    }
}

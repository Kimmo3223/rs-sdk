// rs-sdk: clones. A clone is an extra account linked to a main account
// (`bun host.ts clone <main>`). Every 100 total levels unlock one clone.
// The main and its clones are a "family": they share one bank and one set of
// skill XP (XP any member gains goes to every member, online or not), while
// inventory, equipment, position and quests stay per account.
//
// State lives in data/clones.sqlite (CLONES_DATABASE), which host.ts creates
// when the first clone is linked; without it nothing here does anything.
//   clone(name, main)               the links, written by host.ts
//   family(main, stats, bank, total) shared XP and bank, written here
// The family row is the only copy of the shared bank that is ever read back:
// clone saves leave the bank out, and the main's own saved bank is used only to
// start the family.

import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import InvType from '#/cache/config/InvType.js';
import VarPlayerType from '#/cache/config/VarPlayerType.js';
// Type-only Player import, and no World import: Player imports this module.
import type Player from '#/engine/entity/Player.js';
import { getLevelByExp } from '#/engine/entity/Player.js';
import { PlayerStatEnabled } from '#/engine/entity/PlayerStat.js';
import { Inventory } from '#/engine/Inventory.js';

export const LEVELS_PER_CLONE = 100;
const XP_CAP = 2_000_000_000;
// ^tutorial_complete in content/scripts/general/configs/quest.constant.
const TUTORIAL_COMPLETE = 1000;

type Family = { main: string; stats: number[]; bank: Inventory; members: Set<Player> };
type FamilyRow = { stats: string; bank: string };

const families = new Map<string, Family>();
let db: Database | null = null;
let sharing = false;

function store(): Database | null {
    if (db) return db;
    const path = process.env.CLONES_DATABASE ?? 'data/clones.sqlite';
    if (!existsSync(path)) return null;
    db = new Database(path);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 10000');
    createTables(db);
    return db;
}

export function createTables(database: Database) {
    database.exec('CREATE TABLE IF NOT EXISTS clone (name TEXT PRIMARY KEY, main TEXT NOT NULL)');
    database.exec('CREATE TABLE IF NOT EXISTS family (main TEXT PRIMARY KEY, stats TEXT NOT NULL, bank TEXT NOT NULL, total INTEGER NOT NULL)');
    // Watcher accounts: a main's always-invisible character for spectating (engine/Spectate.ts).
    database.exec('CREATE TABLE IF NOT EXISTS watcher (name TEXT PRIMARY KEY, main TEXT NOT NULL)');
}

/** True for a watcher account (see Spectate.ts), which never plays. */
export function isWatcher(username: string): boolean {
    const database = store();
    return Boolean(database?.query('SELECT 1 FROM watcher WHERE name=?').get(username));
}

export function totalLevel(stats: number[]): number {
    let total = 0;
    for (let stat = 0; stat < stats.length; stat++) {
        if (PlayerStatEnabled[stat]) total += getLevelByExp(stats[stat]);
    }
    return total;
}

function bankType(): number {
    return InvType.getId('bank');
}

function encodeBank(bank: Inventory): string {
    const items: number[][] = [];
    for (let slot = 0; slot < bank.capacity; slot++) {
        const item = bank.get(slot);
        if (item) items.push([slot, item.id, item.count]);
    }
    return JSON.stringify(items);
}

function decodeBank(json: string): Inventory {
    const bank = Inventory.fromType(bankType());
    for (const [slot, id, count] of JSON.parse(json) as number[][]) {
        bank.set(slot, { id, count });
    }
    return bank;
}

function persist(database: Database, family: Family) {
    database
        .query('INSERT INTO family VALUES(?,?,?,?) ON CONFLICT(main) DO UPDATE SET stats=excluded.stats, bank=excluded.bank, total=excluded.total')
        .run(family.main, JSON.stringify(family.stats), encodeBank(family.bank), totalLevel(family.stats));
}

/** Write every online family's shared XP and bank. Runs with each save checkpoint. */
export function saveFamilies() {
    const database = store();
    if (!database || families.size === 0) return;
    database.transaction(() => {
        for (const family of families.values()) persist(database, family);
    })();
}

/**
 * Put a player who is entering the world into their family, if they have one:
 * they get the family's XP and its bank. Call before `onLogin` so the client
 * receives the shared stats and bank. Returns a message when the player is a
 * clone that may not play yet; the caller shows it and logs them out.
 * `online` finds a player who is in the world by username.
 */
export function joinFamily(player: Player, online: (username: string) => Player | null = () => null): string | null {
    const database = store();
    if (!database) return null;

    const link = database.query<{ main: string; rowid: number }, [string]>('SELECT main, rowid FROM clone WHERE name=?').get(player.username);
    let main: string;
    if (link) {
        main = link.main;
    } else if (database.query('SELECT 1 FROM clone WHERE main=?').get(player.username)) {
        main = player.username;
    } else {
        return null;
    }

    // Finishing the tutorial empties the bank (tutorial.rs2 inv_clear(bank)). A character
    // in the family would empty the shared bank, so it joins only once it is done.
    const tutorial = VarPlayerType.getId('tutorial');
    if (tutorial !== -1 && player.vars[tutorial] < TUTORIAL_COMPLETE) return null;

    let family = families.get(main);
    let created = false;
    if (!family) {
        const row = database.query<FamilyRow, [string]>('SELECT stats, bank FROM family WHERE main=?').get(main);
        const live = main === player.username ? player : online(main);
        if (row) {
            family = { main, stats: JSON.parse(row.stats), bank: decodeBank(row.bank), members: new Set() };
        } else if (live) {
            // First time: the family starts from the main's own XP and bank.
            family = { main, stats: [...live.stats], bank: live.getInventory(bankType())!, members: new Set() };
        } else {
            return `This clone isn't set up yet: log in as ${main} once first.`;
        }
        created = true;
        // A main who was already online when their first clone was linked joins now.
        if (live && live !== player) addMember(family, live, false);
    }

    if (link) {
        const index = database.query<{ n: number }, [string, number]>('SELECT COUNT(*) AS n FROM clone WHERE main=? AND rowid<=?').get(main, link.rowid)!.n;
        const total = totalLevel(family.stats);
        if (index > Math.floor(total / LEVELS_PER_CLONE)) {
            if (created && family.members.size > 0) {
                families.set(main, family);
                persist(database, family);
            }
            return `Clone ${index} of ${main} unlocks at total level ${index * LEVELS_PER_CLONE} (now ${total}).`;
        }
    }

    families.set(main, family);
    addMember(family, player, Boolean(link));
    if (created) persist(database, family);
    return null;
}

function addMember(family: Family, player: Player, isClone: boolean) {
    for (let stat = 0; stat < family.stats.length; stat++) {
        // Keep boosts and drains (and damage taken) on stats that were not at base.
        const atBase = player.levels[stat] === player.baseLevels[stat];
        player.stats[stat] = family.stats[stat];
        player.baseLevels[stat] = getLevelByExp(family.stats[stat]);
        player.levels[stat] = atBase ? player.baseLevels[stat] : Math.min(player.levels[stat], player.baseLevels[stat]);
    }
    player.combatLevel = player.getCombatLevel();

    const type = bankType();
    const own = player.invs.get(type);
    if (own && own !== family.bank && isClone) {
        // A clone's own bank is empty unless the account had items before it
        // became a clone (or saved overflow went there): move them over.
        for (const item of own.itemsFiltered) {
            const left = item.count - family.bank.add(item.id, item.count);
            if (left > 0) player.recoveryItems.push({ id: item.id, count: left });
        }
    }
    // The main's saved bank is an older copy of the family bank: drop it.
    player.invs.set(type, family.bank);

    player.family = family.main;
    player.isClone = isClone;
    family.members.add(player);
}

/** Take a player who left the world out of their family, saving it first. */
export function leaveFamily(player: Player) {
    if (!player.family) return;
    const family = families.get(player.family);
    if (!family || !family.members.delete(player)) return;
    const database = store();
    if (database) persist(database, family);
    if (family.members.size === 0) families.delete(family.main);
}

/** Give XP a family member gained to the family and every other online member. */
export function shareXp(player: Player, stat: number, xp: number) {
    if (sharing || !player.family) return;
    const family = families.get(player.family);
    if (!family || !family.members.has(player)) return;
    family.stats[stat] = Math.min(XP_CAP, family.stats[stat] + xp);
    sharing = true;
    try {
        for (const member of family.members) {
            if (member !== player) member.addXp(stat, xp, false);
        }
    } finally {
        sharing = false;
    }
}

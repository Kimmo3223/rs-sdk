// Clone links for host.ts, in the database the engine's clone code reads
// (server/engine/src/engine/Clones.ts). A clone shares its main's bank and
// skill XP; every 100 total levels of the family unlock one clone, in the
// order they were linked.

import { Database } from 'bun:sqlite';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { ENGINE_DIR, ensureAccount, listAccounts, toSafeName } from './accounts';

export const CLONES_DB_PATH = join(ENGINE_DIR, 'data', 'clones.sqlite');
export const LEVELS_PER_CLONE = 100;

function open(path = CLONES_DB_PATH): Database {
    mkdirSync(join(path, '..'), { recursive: true });
    const db = new Database(path);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 10000');
    // Same tables as createTables() in the engine's Clones.ts.
    db.exec('CREATE TABLE IF NOT EXISTS clone (name TEXT PRIMARY KEY, main TEXT NOT NULL)');
    db.exec('CREATE TABLE IF NOT EXISTS family (main TEXT PRIMARY KEY, stats TEXT NOT NULL, bank TEXT NOT NULL, total INTEGER NOT NULL)');
    return db;
}

export type CloneFamily = {
    main: string;
    /** Family total level, or null until the main has logged in with a clone linked. */
    total: number | null;
    clones: string[];
};

/** The main a clone belongs to, or null. */
export function mainOf(name: string, path = CLONES_DB_PATH): string | null {
    const db = open(path);
    try {
        return (db.query('SELECT main FROM clone WHERE name = ?').get(toSafeName(name)) as { main: string } | null)?.main ?? null;
    } finally {
        db.close();
    }
}

export function family(main: string, path = CLONES_DB_PATH): CloneFamily {
    const db = open(path);
    try {
        const safe = toSafeName(main);
        const clones = (db.query('SELECT name FROM clone WHERE main = ? ORDER BY rowid').all(safe) as Array<{ name: string }>).map(r => r.name);
        const row = db.query('SELECT total FROM family WHERE main = ?').get(safe) as { total: number } | null;
        return { main: safe, total: row?.total ?? null, clones };
    } finally {
        db.close();
    }
}

export function families(path = CLONES_DB_PATH): CloneFamily[] {
    const db = open(path);
    let mains: string[];
    try {
        mains = (db.query('SELECT main FROM clone GROUP BY main ORDER BY MIN(rowid)').all() as Array<{ main: string }>).map(r => r.main);
    } finally {
        db.close();
    }
    return mains.map(main => family(main, path));
}

/** A free default name for a main's next clone: the main's name plus "c1", "c2"... within 12 characters. */
export function nextCloneName(main: string, taken: (name: string) => boolean): string {
    const safe = toSafeName(main);
    for (let n = 1; ; n++) {
        const suffix = `c${n}`;
        const name = safe.slice(0, 12 - suffix.length).replace(/_+$/, '') + suffix;
        if (!taken(name)) return name;
    }
}

/** Link a clone to a main. Throws with a readable reason when the link isn't allowed. */
export function linkClone(main: string, name: string, path = CLONES_DB_PATH): void {
    const safeMain = toSafeName(main);
    const safeName = toSafeName(name);
    if (safeMain === safeName) throw new Error('An account can\'t be its own clone');
    const db = open(path);
    try {
        const cloneOf = (n: string) => (db.query('SELECT main FROM clone WHERE name = ?').get(n) as { main: string } | null)?.main;
        const existing = cloneOf(safeName);
        if (existing) throw new Error(`"${safeName}" is already a clone of ${existing}`);
        const mainIsClone = cloneOf(safeMain);
        if (mainIsClone) throw new Error(`"${safeMain}" is itself a clone of ${mainIsClone}; make clones of ${mainIsClone} instead`);
        if (db.query('SELECT 1 FROM clone WHERE main = ?').get(safeName)) throw new Error(`"${safeName}" has clones of its own, so it can't be a clone`);
        db.query('INSERT INTO clone (name, main) VALUES (?, ?)').run(safeName, safeMain);
    } finally {
        db.close();
    }
}

/** Unlink a clone. Its account and save stay; the bank stays with the family. */
export function unlinkClone(name: string, path = CLONES_DB_PATH): boolean {
    const db = open(path);
    try {
        return db.query('DELETE FROM clone WHERE name = ?').run(toSafeName(name)).changes > 0;
    } finally {
        db.close();
    }
}

/** "kimmo: total 245, 2 of 3 clones unlocked (next at 300)" style status lines. */
export function describeFamily(f: CloneFamily): string {
    if (f.total === null) {
        return `${f.main}: clones ${f.clones.join(', ')}. Log in as ${f.main} once to set them up.`;
    }
    const unlocked = Math.min(f.clones.length, Math.floor(f.total / LEVELS_PER_CLONE));
    const list = f.clones.map((c, i) => (i < unlocked ? c : `${c} (locked until total ${(i + 1) * LEVELS_PER_CLONE})`)).join(', ');
    return `${f.main} (total level ${f.total}): ${unlocked} of ${f.clones.length} clone${f.clones.length === 1 ? '' : 's'} unlocked: ${list}`;
}

export class CloneError extends Error {}

/**
 * Make `clone` a clone of `main`, for a main who asked for it themselves (a
 * bot's `clone("name")` call), so unlike host.ts this only creates brand-new
 * names and respects the unlock limit. With `accounts`, the clone also gets a
 * game account with the main's password. Calling it again for an existing
 * clone of the same main is fine and returns created: false.
 */
export async function createCloneFor(main: string, password: string, clone: string, options: { accounts: boolean; path?: string; accountsPath?: string }): Promise<{ name: string; created: boolean }> {
    if (!/^[A-Za-z0-9 ]{1,12}$/.test(clone.trim())) throw new CloneError(`Invalid clone name "${clone}" (letters, numbers and spaces, at most 12)`);
    const safeMain = toSafeName(main);
    const name = toSafeName(clone);
    const owner = mainOf(name, options.path);
    if (owner === safeMain) return { name, created: false };
    if (owner) throw new CloneError(`"${name}" is already someone else's clone`);

    if (options.accounts && listAccounts(options.accountsPath).includes(name)) throw new CloneError(`The name "${name}" is taken`);

    const f = family(safeMain, options.path);
    // Before the family exists its total is unknown; the first clone is always allowed
    // to be made, and the game itself keeps it locked below total level 100.
    const allowed = f.total === null ? 1 : Math.floor(f.total / LEVELS_PER_CLONE);
    if (f.clones.length >= allowed) {
        const next = (f.clones.length + 1) * LEVELS_PER_CLONE;
        throw new CloneError(`${safeMain} has ${f.clones.length} clone${f.clones.length === 1 ? '' : 's'} (${f.clones.join(', ')}); the next one needs total level ${next}${f.total === null ? '' : ` (now ${f.total})`}`);
    }

    try {
        linkClone(safeMain, name, options.path);
    } catch (error) {
        throw new CloneError((error as Error).message);
    }
    if (options.accounts) {
        try {
            await ensureAccount(name, password, { path: options.accountsPath });
        } catch (error) {
            unlinkClone(name, options.path);
            throw new CloneError((error as Error).message);
        }
    }
    return { name, created: true };
}

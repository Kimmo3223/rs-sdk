// Game accounts in the engine's SQLite database (server/engine/db.sqlite),
// used when the engine runs with LOGIN_SERVER=true. Passwords are bcrypt
// hashes, the same format the engine's login server writes and checks.

import { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'crypto';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

export const ENGINE_DIR = join(import.meta.dir, '..', 'engine');
export const DB_PATH = join(ENGINE_DIR, 'db.sqlite');
const MIGRATIONS_DIR = join(ENGINE_DIR, 'prisma', 'singleworld', 'migrations');

/**
 * Apply the engine's SQLite migrations (what `bun run sqlite:migrate` does).
 * Prisma ships no engine binaries for some platforms (NixOS among them), so
 * this runs the migration SQL directly and records each one in Prisma's own
 * _prisma_migrations table, the way `prisma migrate deploy` would, so either
 * tool can take over later. Returns the names of migrations applied now.
 */
export function migrateDatabase(path = DB_PATH, migrationsDir = MIGRATIONS_DIR): string[] {
    const db = new Database(path);
    try {
        db.exec('PRAGMA busy_timeout = 10000');
        db.exec(`CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
            "id" TEXT PRIMARY KEY NOT NULL,
            "checksum" TEXT NOT NULL,
            "finished_at" DATETIME,
            "migration_name" TEXT NOT NULL,
            "logs" TEXT,
            "rolled_back_at" DATETIME,
            "started_at" DATETIME NOT NULL DEFAULT current_timestamp,
            "applied_steps_count" INTEGER UNSIGNED NOT NULL DEFAULT 0
        )`);
        const done = new Set((db.query('SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL').all() as Array<{ migration_name: string }>)
            .map(row => row.migration_name));
        const applied: string[] = [];
        const names = readdirSync(migrationsDir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort();
        for (const name of names) {
            if (done.has(name)) continue;
            const sql = readFileSync(join(migrationsDir, name, 'migration.sql'), 'utf8');
            const checksum = createHash('sha256').update(sql).digest('hex');
            db.transaction(() => {
                db.exec(sql);
                db.query('INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, started_at, applied_steps_count) VALUES (?, ?, ?, ?, ?, 1)')
                    .run(randomUUID(), checksum, Date.now(), name, Date.now());
            })();
            applied.push(name);
        }
        return applied;
    } finally {
        db.close();
    }
}

const BASE37 = '_abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * The engine's account name normalization (toSafeName in
 * server/engine/src/util/JString.ts): a base-37 round trip that lowercases,
 * maps anything but letters and digits to "_", keeps at most 12 characters
 * and drops trailing underscores. Copied rather than imported so the root
 * typecheck does not pull in engine sources.
 */
export function toSafeName(name: string): string {
    const text = name.trim();
    let value = 0n;
    for (let i = 0; i < text.length && i < 12; i++) {
        const c = text.charCodeAt(i);
        value *= 37n;
        if (c >= 0x41 && c <= 0x5a) value += BigInt(c + 1 - 0x41);
        else if (c >= 0x61 && c <= 0x7a) value += BigInt(c + 1 - 0x61);
        else if (c >= 0x30 && c <= 0x39) value += BigInt(c + 27 - 0x30);
    }
    while (value % 37n === 0n && value !== 0n) value /= 37n;
    if (value === 0n) return 'invalid_name';
    let out = '';
    while (value !== 0n) {
        out = BASE37[Number(value % 37n)] + out;
        value /= 37n;
    }
    return out;
}

function open(path = DB_PATH): Database {
    const db = new Database(path);
    db.exec('PRAGMA busy_timeout = 10000');
    const table = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'account'").get();
    if (!table) {
        db.close();
        throw new Error(`No account table in ${path}. Run the database migrations first: cd server/engine && bun run sqlite:migrate`);
    }
    return db;
}

/** True when the username exists and the password matches. */
export async function checkLogin(username: string, password: string, path = DB_PATH): Promise<boolean> {
    const db = open(path);
    try {
        const row = db.query('SELECT password, banned_until FROM account WHERE username = ?').get(toSafeName(username)) as
            { password: string; banned_until: string | number | null } | null;
        if (!row || !password) return false;
        if (row.banned_until !== null && new Date(row.banned_until) > new Date()) return false;
        return await Bun.password.verify(password, row.password);
    } finally {
        db.close();
    }
}

/**
 * Create an account, or reset its password when `resetPassword` is set.
 * Returns what happened.
 */
export async function ensureAccount(username: string, password: string, options: { resetPassword?: boolean; path?: string } = {}): Promise<'created' | 'exists' | 'updated'> {
    // toSafeName would silently cut a long name to 12 characters: check the input instead.
    if (!/^[A-Za-z0-9 _]{1,12}$/.test(username.trim())) throw new Error(`Invalid username "${username}" (letters, numbers and spaces, at most 12)`);
    const name = toSafeName(username);
    // Hosted accounts face the internet: no short passwords. 20 is the game client's limit.
    if (password.length < 8 || password.length > 20) throw new Error('Password must be 8 to 20 characters (the game client allows at most 20)');
    const db = open(options.path);
    try {
        const existing = db.query('SELECT id FROM account WHERE username = ?').get(name) as { id: number } | null;
        if (existing && !options.resetPassword) return 'exists';
        const hash = await Bun.password.hash(password, { algorithm: 'bcrypt', cost: 10 });
        if (existing) {
            db.query('UPDATE account SET password = ? WHERE id = ?').run(hash, existing.id);
            return 'updated';
        }
        db.query('INSERT INTO account (username, password, registration_ip, registration_date) VALUES (?, ?, ?, ?)')
            .run(name, hash, 'host.ts', new Date().toISOString().slice(0, 19).replace('T', ' '));
        return 'created';
    } finally {
        db.close();
    }
}

/** Delete an account so it can no longer log in. Its character save file is kept. */
export function removeAccount(username: string, path = DB_PATH): boolean {
    const db = open(path);
    try {
        const row = db.query('SELECT id FROM account WHERE username = ?').get(toSafeName(username)) as { id: number } | null;
        if (!row) return false;
        db.transaction(() => {
            db.query('DELETE FROM account_login WHERE account_id = ?').run(row.id);
            db.query('DELETE FROM account WHERE id = ?').run(row.id);
        })();
        return true;
    } finally {
        db.close();
    }
}

export function listAccounts(path = DB_PATH): string[] {
    const db = open(path);
    try {
        return (db.query('SELECT username FROM account ORDER BY username').all() as Array<{ username: string }>).map(r => r.username);
    } finally {
        db.close();
    }
}

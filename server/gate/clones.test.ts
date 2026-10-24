import { afterAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { checkLogin, ensureAccount, listAccounts, migrateDatabase } from './accounts';
import { createCloneFor, createWatcherFor, family } from './clones';
import { createGate } from './gate';

const dir = mkdtempSync(join(tmpdir(), 'gate-clones-'));
const accountsPath = join(dir, 'db.sqlite');
const path = join(dir, 'clones.sqlite');
migrateDatabase(accountsPath);
await ensureAccount('kimmo', 'kimmo-password', { path: accountsPath });
await ensureAccount('esko', 'esko-password', { path: accountsPath });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const make = (main: string, clone: string, password = 'kimmo-password') => createCloneFor(main, password, clone, { accounts: true, path, accountsPath });
const setTotal = (main: string, total: number) => {
    const db = new Database(path);
    db.query("INSERT INTO family VALUES (?, '[]', '[]', ?) ON CONFLICT(main) DO UPDATE SET total = excluded.total").run(main, total);
    db.close();
};

describe('createCloneFor', () => {
    test('makes the first clone with the main\'s password, and again is a no-op', async () => {
        expect(await make('Kimmo', 'Jaska')).toEqual({ name: 'jaska', created: true });
        expect(await checkLogin('jaska', 'kimmo-password', accountsPath)).toBeTrue();
        expect(await make('kimmo', 'jaska')).toEqual({ name: 'jaska', created: false });
    });

    test('respects the unlock limit', async () => {
        await expect(make('kimmo', 'pekka')).rejects.toThrow('the next one needs total level 200');
        setTotal('kimmo', 150);
        await expect(make('kimmo', 'pekka')).rejects.toThrow('(now 150)');
        setTotal('kimmo', 210);
        expect((await make('kimmo', 'pekka')).created).toBeTrue();
        expect(family('kimmo', path).clones).toEqual(['jaska', 'pekka']);
    });

    test('never takes over an existing account or another main\'s clone', async () => {
        await expect(make('kimmo', 'esko')).rejects.toThrow('taken');
        await expect(make('esko', 'jaska', 'esko-password')).rejects.toThrow('someone else');
        await expect(make('jaska', 'matti')).rejects.toThrow('itself a clone');
        await expect(make('kimmo', 'bad-name!')).rejects.toThrow('Invalid clone name');
        expect(listAccounts(accountsPath)).not.toContain('matti');
    });
});

describe('POST /gate/clone', () => {
    const gate = createGate({
        upstream: 'http://127.0.0.1:1',
        secret: Buffer.alloc(32, 7),
        checkLogin: (u, p) => checkLogin(u, p, accountsPath),
        createClone: (main, password, clone) => createCloneFor(main, password, clone, { accounts: true, path, accountsPath }),
        maxFailures: 2,
    });
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: gate.fetch, websocket: gate.websocket });
    afterAll(() => server.stop(true));
    const post = (body: unknown, ip = '2.2.2.2') => fetch(`http://127.0.0.1:${server.port}/gate/clone`, {
        method: 'POST', headers: { 'cf-connecting-ip': ip, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });

    test('needs the main\'s own password, with sign-in rate limits', async () => {
        expect((await post({ username: 'esko', password: 'nope', clone: 'eskoc' })).status).toBe(401);
        expect((await post({ username: 'esko', password: 'nope', clone: 'eskoc' })).status).toBe(401);
        expect((await post({ username: 'esko', password: 'esko-password', clone: 'eskoc' })).status).toBe(429);
    });

    test('makes the clone, or says why not', async () => {
        const ok = await post({ username: 'esko', password: 'esko-password', clone: 'eskoc' }, '3.3.3.3');
        expect(await ok.json()).toEqual({ ok: true, result: { name: 'eskoc', created: true } });
        const refused = await post({ username: 'esko', password: 'esko-password', clone: 'eskod' }, '3.3.3.3');
        expect(refused.status).toBe(409);
        expect((await refused.json()).error).toContain('next one needs total level 200');
    });
});

describe('createWatcherFor', () => {
    test('makes "<main>_w" with the main\'s password, and again keeps it in step', async () => {
        const make = (password: string) => createWatcherFor('kimmo', password, { accounts: true, path, accountsPath });
        expect(await make('kimmo-password')).toEqual({ name: 'kimmo_w' });
        expect(await checkLogin('kimmo_w', 'kimmo-password', accountsPath)).toBeTrue();
        expect(await make('new-kimmo-password')).toEqual({ name: 'kimmo_w' });
        expect(await checkLogin('kimmo_w', 'new-kimmo-password', accountsPath)).toBeTrue();
    });

    test('never takes an existing account', async () => {
        await ensureAccount('esko_w', 'whatever-pass', { path: accountsPath });
        await expect(createWatcherFor('esko', 'esko-password', { accounts: true, path, accountsPath })).rejects.toThrow('taken');
    });
});

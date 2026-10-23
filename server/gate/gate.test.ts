import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { checkLogin, ensureAccount, listAccounts, migrateDatabase, toSafeName } from './accounts';
import { createGate, isOpenPath, makeSession, readSession, type AccessEntry } from './gate';

const secret = Buffer.alloc(32, 7);

describe('sessions', () => {
    test('round-trip, and reject forged, tampered and expired cookies', () => {
        const cookie = `rs_gate=${makeSession(secret, 'Esko')}`;
        expect(readSession(secret, cookie)).toBe('esko');
        expect(readSession(Buffer.alloc(32, 8), cookie)).toBeNull();
        expect(readSession(secret, cookie.replace(/.$/, c => (c === 'A' ? 'B' : 'A')))).toBeNull();
        const old = `rs_gate=${makeSession(secret, 'esko', Date.now() - 31 * 86_400_000)}`;
        expect(readSession(secret, old)).toBeNull();
        expect(readSession(secret, null)).toBeNull();
    });

    test('cache files are open, pages are not', () => {
        expect(isOpenPath('/crc')).toBeTrue();
        expect(isOpenPath('/config12345')).toBeTrue();
        expect(isOpenPath('/api/version')).toBeTrue();
        expect(isOpenPath('/')).toBeFalse();
        expect(isOpenPath('/bot')).toBeFalse();
        expect(isOpenPath('/hiscores')).toBeFalse();
    });
});

describe('gate', () => {
    const upstreamSeen: string[] = [];
    const upstream = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch(req) {
            upstreamSeen.push(new URL(req.url).pathname);
            return new Response('upstream ok');
        },
    });
    const logged: AccessEntry[] = [];
    const gate = createGate({
        upstream: `http://127.0.0.1:${upstream.port}`,
        secret,
        checkLogin: async (user, pass) => user.toLowerCase() === 'esko' && pass === 'correct-horse',
        maxFailures: 3,
        accessLog: entry => logged.push(entry),
    });
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: gate.fetch, websocket: gate.websocket });
    const base = `http://127.0.0.1:${server.port}`;
    afterAll(() => { server.stop(true); upstream.stop(true); });

    const login = (username: string, password: string, next = '/hiscores', ip = '1.1.1.1') => fetch(`${base}/gate/login`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'cf-connecting-ip': ip },
        body: new URLSearchParams({ username, password, next }),
    });

    test('sends browsers to the sign-in page and API callers a 401', async () => {
        const page = await fetch(`${base}/hiscores?x=1`, { redirect: 'manual', headers: { accept: 'text/html' } });
        expect(page.status).toBe(303);
        expect(page.headers.get('location')).toBe('/gate/login?next=%2Fhiscores%3Fx%3D1');
        const api = await fetch(`${base}/status`);
        expect(api.status).toBe(401);
        expect(upstreamSeen).not.toContain('/hiscores');
    });

    test('passes cache files through without signing in', async () => {
        const res = await fetch(`${base}/crc`);
        expect(await res.text()).toBe('upstream ok');
    });

    test('signs in with a game account and then proxies', async () => {
        const res = await login('Esko', 'correct-horse');
        expect(res.status).toBe(303);
        expect(res.headers.get('location')).toBe('/hiscores');
        const cookie = res.headers.get('set-cookie')!;
        expect(cookie).toContain('HttpOnly');
        const page = await fetch(`${base}/hiscores`, { headers: { cookie: cookie.split(';')[0]! } });
        expect(await page.text()).toBe('upstream ok');
    });

    test('never redirects off-site after sign-in', async () => {
        const res = await login('esko', 'correct-horse', '//evil.example');
        expect(res.headers.get('location')).toBe('/');
    });

    test('the browser client link keeps the password out of every URL the server sees', async () => {
        // Old-style ?password= links: redirected to sign in, without the password.
        const old = await fetch(`${base}/bot?bot=esko&password=correct-horse`, { redirect: 'manual', headers: { accept: 'text/html' } });
        expect(old.status).toBe(303);
        expect(old.headers.get('location')).toBe('/gate/login?next=%2Fbot%3Fbot%3Desko');
        expect(upstreamSeen.some(p => p.includes('password'))).toBeFalse();
        // The sign-in page posts the #fragment password and returns to the page with it in the fragment.
        const ok = await login('esko', 'correct-horse', '/bot?bot=esko#password=correct-horse');
        expect(ok.status).toBe(303);
        expect(ok.headers.get('location')).toBe('/bot?bot=esko#password=correct-horse');
        // A failed attempt never echoes the password back into the page.
        const bad = await login('esko', 'nope', '/bot?bot=esko#password=nope');
        expect(bad.status).toBe(401);
        expect(await bad.text()).not.toContain('password=nope');
    });

    test('locks out a client after repeated failures', async () => {
        for (let i = 0; i < 3; i++) expect((await login('esko', `guess${i}`, '/', '9.9.9.9')).status).toBe(401);
        expect((await login('esko', 'correct-horse', '/', '9.9.9.9')).status).toBe(429);
        expect((await login('esko', 'correct-horse', '/', '8.8.8.8')).status).toBe(303);
    });

    test('logs visits and sign-ins, never passwords', async () => {
        logged.length = 0;
        await fetch(`${base}/`, { redirect: 'manual', headers: { accept: 'text/html', 'cf-connecting-ip': '5.5.5.5', 'cf-ipcountry': 'FI' } });
        await login('intruder<script>', 'hunter2', '/', '5.5.5.5');
        await login('esko', 'correct-horse', '/', '5.5.5.5');
        expect(logged.map(e => [e.event, e.user, e.ip])).toEqual([
            ['visit', null, '5.5.5.5'],
            ['signin_failed', 'intruder?script?', '5.5.5.5'],
            ['signin', 'esko', '5.5.5.5'],
        ]);
        expect(logged[0]!.country).toBe('FI');
        expect(JSON.stringify(logged)).not.toContain('hunter2');
        expect(JSON.stringify(logged)).not.toContain('correct-horse');
    });

    test('refuses the world feed WebSocket without a session', async () => {
        const res = await fetch(`${base}/worldfeed`, { headers: { upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' } });
        expect(res.status).toBe(401);
    });
});

describe('accounts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-db-'));
    const db = join(dir, 'db.sqlite');
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    test('migrations apply once, then accounts can be created and checked', async () => {
        expect(migrateDatabase(db).length).toBeGreaterThan(0);
        expect(migrateDatabase(db)).toEqual([]);
        expect(await ensureAccount('My Friend', 'longenough1', { path: db })).toBe('created');
        expect(await ensureAccount('my_friend', 'different99', { path: db })).toBe('exists');
        expect(await checkLogin('MY FRIEND', 'longenough1', db)).toBeTrue();
        expect(await checkLogin('my_friend', 'different99', db)).toBeFalse();
        expect(await ensureAccount('my_friend', 'different99', { resetPassword: true, path: db })).toBe('updated');
        expect(await checkLogin('my_friend', 'different99', db)).toBeTrue();
        expect(await checkLogin('nobody', 'longenough1', db)).toBeFalse();
        expect(listAccounts(db)).toEqual(['my_friend']);
    });

    test('rejects weak passwords and bad names', async () => {
        await expect(ensureAccount('esko', 'abcd', { path: db })).rejects.toThrow('8 to 20');
        await expect(ensureAccount('averyveryverylongname', 'longenough1', { path: db })).rejects.toThrow('Invalid username');
    });

    test('name normalization matches the engine', () => {
        expect(toSafeName('My Friend')).toBe('my_friend');
        expect(toSafeName(' Esko ')).toBe('esko');
    });
});

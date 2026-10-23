import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { decodeInvite, encodeInvite, saveInvite, updateServer } from '../../join';

let dir = '';
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

function botsDir(): string {
    dir = mkdtempSync(join(tmpdir(), 'join-'));
    mkdirSync(join(dir, '_template'));
    writeFileSync(join(dir, '_template', 'bot.py'), 'bot = rs.connect_sync("{{USERNAME}}")\n');
    return dir;
}

describe('invite codes', () => {
    test('round-trip', () => {
        const invite = { name: 'Alice', password: 'Zq8-pW2xK7mN', server: 'some-words.trycloudflare.com' };
        const code = encodeInvite(invite);
        expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(decodeInvite(`  ${code}\n`)).toEqual(invite);
        expect(decodeInvite(encodeInvite({ name: 'bob', password: 'longenough' }))).toEqual({ name: 'bob', password: 'longenough', server: undefined });
    });

    test('rejects junk and unsafe values', () => {
        expect(() => decodeInvite('not a code')).toThrow('not valid');
        expect(() => decodeInvite(Buffer.from('{"n":"../../etc","p":"x"}').toString('base64url'))).toThrow('not valid');
        expect(() => decodeInvite(Buffer.from('{"n":"bob","p":"x","s":"evil.com/\\nPASSWORD=1"}').toString('base64url'))).toThrow('server address');
    });

    test('saves a bot.env and a starter script', () => {
        const bots = botsDir();
        expect(saveInvite({ name: 'My Friend', password: 'pw12345678', server: 'a.trycloudflare.com' }, bots)).toBe('my_friend');
        const env = readFileSync(join(bots, 'my_friend', 'bot.env'), 'utf8');
        expect(env).toContain('BOT_USERNAME=My Friend\nPASSWORD=pw12345678\nSERVER=a.trycloudflare.com\n');
        expect(readFileSync(join(bots, 'my_friend', 'bot.py'), 'utf8')).toContain('rs.connect_sync("My Friend")');
    });

    test('--server moves remote bots only', () => {
        const bots = botsDir();
        saveInvite({ name: 'alice', password: 'pw12345678', server: 'old.trycloudflare.com' }, bots);
        mkdirSync(join(bots, 'mine'));
        writeFileSync(join(bots, 'mine', 'bot.env'), 'BOT_USERNAME=mine\nPASSWORD=x\nSERVER=localhost:8888\n');
        expect(updateServer('new.trycloudflare.com', bots)).toEqual(['alice']);
        expect(readFileSync(join(bots, 'alice', 'bot.env'), 'utf8')).toContain('SERVER=new.trycloudflare.com\n');
        expect(readFileSync(join(bots, 'mine', 'bot.env'), 'utf8')).toContain('SERVER=localhost:8888');
    });
});

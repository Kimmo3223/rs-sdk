#!/usr/bin/env bun
// Join a friend's server:
//
//   bun join.ts <invite-code>        save the bot.env from an invite (bun host.ts add prints one)
//   bun join.ts --server <address>   the host restarted: point your bots at the new address
//
// An invite code is base64url JSON: {"n": name, "p": password, "s": server}.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { parseEnvFile } from './pybridge/env';

const ROOT = import.meta.dir;
const BOTS = join(ROOT, 'bots');

export interface Invite {
    name: string;
    password: string;
    server?: string;
}

export function encodeInvite(invite: Invite): string {
    const body: Record<string, string> = { n: invite.name, p: invite.password };
    if (invite.server) body.s = invite.server;
    return Buffer.from(JSON.stringify(body)).toString('base64url');
}

export function decodeInvite(code: string): Invite {
    let body: { n?: unknown; p?: unknown; s?: unknown };
    try {
        body = JSON.parse(Buffer.from(code.trim(), 'base64url').toString('utf8'));
    } catch {
        throw new Error('That invite code is not valid. Copy the whole code your host sent.');
    }
    if (typeof body.n !== 'string' || !/^[A-Za-z0-9 _]{1,12}$/.test(body.n) || typeof body.p !== 'string' || !body.p) {
        throw new Error('That invite code is not valid. Copy the whole code your host sent.');
    }
    if (body.s !== undefined && (typeof body.s !== 'string' || !/^[A-Za-z0-9.-]+(:\d+)?$/.test(body.s))) {
        throw new Error('The server address in that invite code is not valid.');
    }
    return { name: body.n, password: body.p, server: body.s as string | undefined };
}

function isLocal(server: string | undefined): boolean {
    return !server || server.startsWith('localhost') || server.startsWith('127.');
}

/** Rewrite one KEY=value line of a bot.env, appending it if missing. */
function setEnvLine(content: string, key: string, value: string): string {
    const line = `${key}=${value}`;
    return new RegExp(`^${key}=.*$`, 'm').test(content)
        ? content.replace(new RegExp(`^${key}=.*$`, 'm'), line)
        : `${content.replace(/\n?$/, '\n')}${line}\n`;
}

export function saveInvite(invite: Invite, botsDir = BOTS): string {
    const folder = invite.name.toLowerCase().replace(/ /g, '_');
    const dir = join(botsDir, folder);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'bot.env'), [
        `BOT_USERNAME=${invite.name}`,
        `PASSWORD=${invite.password}`,
        `SERVER=${invite.server ?? ''}`,
        'SHOW_CHAT=true',
        'TELEMETRY=false',
        '',
    ].join('\n'), { mode: 0o600 });
    const template = join(botsDir, '_template', 'bot.py');
    const script = join(dir, 'bot.py');
    if (!existsSync(script) && existsSync(template)) {
        writeFileSync(script, readFileSync(template, 'utf8').replaceAll('{{USERNAME}}', invite.name));
    }
    return folder;
}

/** Point every bot that plays on a remote server at `server`. Returns the folders changed. */
export function updateServer(server: string, botsDir = BOTS): string[] {
    const changed: string[] = [];
    for (const entry of readdirSync(botsDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
        const envPath = join(botsDir, entry.name, 'bot.env');
        if (!existsSync(envPath)) continue;
        const content = readFileSync(envPath, 'utf8');
        if (isLocal(parseEnvFile(content).SERVER)) continue;
        writeFileSync(envPath, setEnvLine(content, 'SERVER', server));
        changed.push(entry.name);
    }
    return changed;
}

if (import.meta.main) {
    const [first, second] = process.argv.slice(2);
    try {
        if (first === '--server' && second) {
            const server = second.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
            const changed = updateServer(server);
            console.log(changed.length ? `Now playing on ${server}: ${changed.join(', ')}` : 'No bots play on a remote server yet. Join with an invite code first.');
        } else if (first && !first.startsWith('-')) {
            const invite = decodeInvite(first);
            const folder = saveInvite(invite);
            console.log(`Saved bots/${folder}/bot.env for "${invite.name}"${invite.server ? ` on ${invite.server}` : ''}.`);
            if (!invite.server) console.log('The invite had no server address. Ask your host for it, then run: bun join.ts --server <address>');
            console.log(`\nStart playing:  bun play.ts ${folder}`);
        } else {
            console.error('Usage:\n  bun join.ts <invite-code>\n  bun join.ts --server <address>');
            process.exit(2);
        }
    } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
    }
}

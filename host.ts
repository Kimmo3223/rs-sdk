#!/usr/bin/env bun
// Host the game for friends through a Cloudflare tunnel:
//
//   bun host.ts                      start hosting (Ctrl+C stops)
//   bun host.ts add <name> [pass]    create a friend's account, print their bot.env
//   bun host.ts reset <name> [pass]  give an account a new password
//   bun host.ts remove <name>        delete an account (its save file stays)
//   bun host.ts list                 list accounts
//
// Without options the tunnel is a free "quick tunnel" whose address changes on
// every start. With a Cloudflare account and your own domain, use a named
// tunnel for a fixed address:
//   bun host.ts --tunnel <tunnel-name> --hostname game.example.com
//
// Hosting turns on real accounts (only names added with `add` can log in),
// binds every server to 127.0.0.1, puts a sign-in page in front of the website
// (server/gate/gate.ts) and shares only that gate through the tunnel. Your own
// bots keep working with `bun play.ts <name>` in another terminal.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { parseEnvFile } from './pybridge/env';
import { BUN, ENGINE_URL, GATEWAY_URL, LOGS, ROOT, createLauncher, ensureWebClient, isUp, waitUntil } from './launcher';
import { ensureAccount, listAccounts, migrateDatabase, removeAccount } from './server/gate/accounts';

const GATE_PORT = 8890;
const TUNNEL_FILE = join(LOGS, 'tunnel-url');
const ENGINE_DIR = join(ROOT, 'server', 'engine');

/** Engine settings for hosting. They override server/engine/.env (tick rate and XP rate stay yours). */
const HOST_ENGINE_ENV: Record<string, string> = {
    BUILD_VERIFY: 'false',
    LOGIN_SERVER: 'true',
    FRIEND_SERVER: 'true',
    DB_BACKEND: 'sqlite',
    EASY_STARTUP: 'true',
    // Unknown names are refused instead of registered on first login.
    WEBSITE_REGISTRATION: 'true',
    BIND_HOSTNAME: '127.0.0.1',
};

function usage(): never {
    console.error('Usage:\n  bun host.ts [--tunnel <name> --hostname <host>]\n  bun host.ts add <name> [password]\n  bun host.ts reset <name> [password]\n  bun host.ts remove <name>\n  bun host.ts list');
    process.exit(2);
}

function newPassword(): string {
    // 12 characters from an unambiguous alphabet, like bots/create-bot.ts.
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
    return Array.from(randomBytes(12), byte => alphabet[byte % alphabet.length]).join('');
}

function tunnelHost(): string | null {
    try {
        return new URL(readFileSync(TUNNEL_FILE, 'utf8').trim()).host;
    } catch {
        return null;
    }
}

function migrate(): void {
    migrateDatabase();
}

async function addAccount(command: 'add' | 'reset', name: string | undefined, password: string | undefined): Promise<void> {
    if (!name) usage();
    migrate();
    const pass = password ?? newPassword();
    const result = await ensureAccount(name, pass, { resetPassword: command === 'reset' });
    if (result === 'exists') {
        console.log(`Account "${name}" already exists. Use \`bun host.ts reset ${name}\` to give it a new password.`);
        process.exit(1);
    }
    const host = tunnelHost();
    console.log(`${result === 'created' ? 'Created' : 'Reset the password of'} account "${name}".

Send your friend this, to save as bots/${name}/bot.env in their copy of the game:

BOT_USERNAME=${name}
PASSWORD=${pass}
SERVER=${host ?? '<your tunnel address, printed by `bun host.ts`>'}
SHOW_CHAT=true
TELEMETRY=false
${host ? '' : '\n(Start `bun host.ts` to get the tunnel address.)'}
Then they run: bun play.ts ${name}
The tunnel address changes every time you restart hosting; send them the new SERVER line when it does.`);
    process.exit(0);
}

/** Your own local bots get accounts with the passwords already in their bot.env. */
async function syncLocalBots(say: (message: string) => void): Promise<void> {
    const botsDir = join(ROOT, 'bots');
    for (const entry of readdirSync(botsDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
        const envPath = join(botsDir, entry.name, 'bot.env');
        if (!existsSync(envPath)) continue;
        const env = parseEnvFile(readFileSync(envPath, 'utf8'));
        const local = !env.SERVER || env.SERVER.startsWith('localhost') || env.SERVER.startsWith('127.');
        if (!local || !env.BOT_USERNAME || !env.PASSWORD) continue;
        try {
            if (await ensureAccount(env.BOT_USERNAME, env.PASSWORD) === 'created') say(`Created an account for your bot "${env.BOT_USERNAME}".`);
        } catch (error) {
            say(`Skipped bots/${entry.name}: ${(error as Error).message}. Change PASSWORD in bots/${entry.name}/bot.env and restart hosting.`);
        }
    }
}

async function host(named: { tunnel: string; hostname: string } | null): Promise<void> {
    const launcher = createLauncher('host');
    const { say, fail, start } = launcher;

    if (await isUp(ENGINE_URL) || await isUp(GATEWAY_URL)) {
        fail('The game is already running (from play.ts?). Stop it first: hosting has to start the server with accounts on.');
    }

    await ensureWebClient(launcher);
    say('Setting up the account database...');
    migrate();
    await syncLocalBots(say);

    say('Starting the gateway...');
    start('gateway', [BUN, 'run', 'gateway.ts'], join(ROOT, 'server', 'gateway'), { LOGIN_SERVER: 'true', GATEWAY_HOSTNAME: '127.0.0.1' });
    if (!(await waitUntil(() => isUp(GATEWAY_URL), 30_000))) fail('The gateway did not start. See .play-logs/gateway.log');

    say('Starting the game server with accounts on (the first start builds the game and takes a few minutes)...');
    start('engine', [BUN, 'run', 'start'], ENGINE_DIR, HOST_ENGINE_ENV);
    if (!(await waitUntil(() => isUp(ENGINE_URL), 15 * 60_000, 2000))) fail('The game server did not start. See .play-logs/engine.log');

    say('Starting the sign-in gate...');
    start('gate', [BUN, 'server/gate/gate.ts', '--port', String(GATE_PORT)], ROOT);
    if (!(await waitUntil(() => isUp(`http://127.0.0.1:${GATE_PORT}/api/version`), 30_000))) fail('The gate did not start. See .play-logs/gate.log');

    const cloudflared = Bun.which('cloudflared');
    if (!cloudflared) {
        say(`cloudflared is not installed, so friends can't reach the game yet.
  Install it: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
  (NixOS: add pkgs.cloudflared to environment.systemPackages), then restart \`bun host.ts\`.
  The gate is running on http://127.0.0.1:${GATE_PORT} for testing.`);
    } else if (named) {
        say(`Opening the Cloudflare tunnel "${named.tunnel}"...`);
        start('tunnel', [cloudflared, 'tunnel', '--no-autoupdate', 'run', '--url', `http://127.0.0.1:${GATE_PORT}`, named.tunnel], ROOT);
        writeFileSync(TUNNEL_FILE, `https://${named.hostname}`);
        console.log(`
Hosting! Friends sign in at:

  https://${named.hostname}

Their bot.env needs:  SERVER=${named.hostname}
Add a friend:         bun host.ts add <name>
Play yourself:        bun play.ts <yourbot>   (in another terminal)

Press Ctrl+C here to stop.
`);
    } else {
        say('Opening the Cloudflare tunnel...');
        let announced = false;
        start('tunnel', [cloudflared, 'tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${GATE_PORT}`], ROOT, {}, line => {
            // The quick-tunnel address; api.trycloudflare.com only appears in errors.
            const match = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/.exec(line);
            if (!match || announced) return;
            announced = true;
            writeFileSync(TUNNEL_FILE, match[0]);
            const address = new URL(match[0]).host;
            console.log(`
Hosting! Friends sign in at:

  ${match[0]}

Their bot.env needs:  SERVER=${address}
Add a friend:         bun host.ts add <name>
Play yourself:        bun play.ts <yourbot>   (in another terminal)

This address changes when you restart hosting. Press Ctrl+C here to stop.
`);
        });
        if (!(await waitUntil(async () => announced, 60_000))) say('The tunnel has not reported its address yet. See .play-logs/tunnel.log');
    }
    say(`Accounts: ${listAccounts().join(', ') || '(none yet: bun host.ts add <name>)'}`);
    await new Promise(() => {});
}

const args = process.argv.slice(2);
const [command, name, password] = args;
if (!command || command.startsWith('--')) {
    const flag = (key: string) => {
        const i = args.indexOf(key);
        return i >= 0 ? args[i + 1] : undefined;
    };
    const tunnel = flag('--tunnel');
    const hostname = flag('--hostname');
    if (Boolean(tunnel) !== Boolean(hostname)) usage();
    await host(tunnel && hostname ? { tunnel, hostname } : null);
} else if (command === 'remove') {
    if (!name) usage();
    migrate();
    console.log(removeAccount(name) ? `Removed account "${name}". Its character save file is kept.` : `No account "${name}".`);
    process.exit(0);
} else if (command === 'add' || command === 'reset') {
    await addAccount(command, name, password);
} else if (command === 'list') {
    migrate();
    console.log(listAccounts().join('\n') || '(no accounts)');
    process.exit(0);
} else {
    usage();
}

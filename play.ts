#!/usr/bin/env bun
// One command to play with a Python bot:
//
//   bun play.ts <botname> [--port 8765] [--no-browser]
//
// Creates the bot if needed, starts the local game server and gateway (unless
// bot.env points at another server), the Python bridge, and the Python venv,
// opens the game in the browser, and skips the tutorial. Ctrl+C stops what it
// started. Logs go to .play-logs/.

import { existsSync, mkdirSync, openSync, readFileSync } from 'fs';
import { join } from 'path';
import type { Subprocess } from 'bun';
import { parseEnvFile } from './pybridge/env';

const ROOT = import.meta.dir;
const LOGS = join(ROOT, '.play-logs');
const BUN = process.execPath;
const ENGINE_URL = 'http://localhost:8888';
const GATEWAY_URL = 'http://localhost:7780';
const IS_WINDOWS = process.platform === 'win32';
const VENV_PYTHON = join(ROOT, '.venv', IS_WINDOWS ? 'Scripts/python.exe' : 'bin/python');

const started: Array<{ name: string; proc: Subprocess }> = [];

function say(message: string): void {
    console.log(`[play] ${message}`);
}

function fail(message: string): never {
    console.error(`[play] ${message}`);
    void stopAll(1);
    throw new Error(message);
}

function parseArgs(argv: string[]) {
    let botName: string | undefined;
    let port = 8765;
    let browser = true;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]!;
        if (arg === '--port') port = Number(argv[++i]);
        else if (arg.startsWith('--port=')) port = Number(arg.slice(7));
        else if (arg === '--no-browser') browser = false;
        else if (!arg.startsWith('-') && !botName) botName = arg;
        else {
            console.error(`Unknown argument: ${arg}\nUsage: bun play.ts <botname> [--port 8765] [--no-browser]`);
            process.exit(2);
        }
    }
    if (!botName) {
        console.error('Usage: bun play.ts <botname> [--port 8765] [--no-browser]\nExample: bun play.ts mybot');
        process.exit(2);
    }
    return { botName, port, browser };
}

async function isUp(url: string): Promise<boolean> {
    try {
        await fetch(url, { signal: AbortSignal.timeout(1500) });
        return true;
    } catch {
        return false;
    }
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs: number, everyMs = 1000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await check()) return true;
        await Bun.sleep(everyMs);
    }
    return false;
}

function logFile(name: string): number {
    mkdirSync(LOGS, { recursive: true });
    return openSync(join(LOGS, `${name}.log`), 'a');
}

function start(name: string, cmd: string[], cwd: string, env: Record<string, string> = {}): Subprocess {
    const log = logFile(name);
    const proc = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: log, stderr: log, stdin: 'ignore' });
    started.push({ name, proc });
    proc.exited.then(code => {
        if (!stopping) say(`${name} stopped (exit ${code}). See .play-logs/${name}.log`);
    });
    return proc;
}

async function run(cmd: string[], cwd: string, what: string): Promise<void> {
    const log = logFile('setup');
    const proc = Bun.spawn(cmd, { cwd, stdout: log, stderr: log, stdin: 'ignore' });
    if (await proc.exited !== 0) fail(`${what} failed. See .play-logs/setup.log`);
}

let stopping = false;
async function stopAll(code: number): Promise<void> {
    if (stopping) process.exit(code);
    stopping = true;
    for (const { proc } of [...started].reverse()) proc.kill('SIGINT');
    await Promise.race([Promise.all(started.map(s => s.proc.exited)), Bun.sleep(10_000)]);
    process.exit(code);
}

async function bridgeHealth(port: number): Promise<{ bot: string; clientAttached: boolean } | null> {
    try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
        const body = await res.json() as { ok: boolean; result?: { bot: string; clientAttached: boolean } };
        return body.ok && body.result ? body.result : null;
    } catch {
        return null;
    }
}

async function bridgeCall(port: number, method: string, args: unknown[] = []): Promise<any> {
    const res = await fetch(`http://127.0.0.1:${port}/call`, { method: 'POST', body: JSON.stringify({ method, args }) });
    return res.json();
}

/** Same derivation as sdk/runner.ts: where the browser client for this bot lives. */
function browserOrigin(server: string | undefined): string {
    if (!server || server.startsWith('localhost') || server.startsWith('127.')) return ENGINE_URL;
    return /^wss?:\/\//.test(server) ? server.replace(/^ws/, 'http').replace(/\/gateway$/, '') : `https://${server}`;
}

async function main(): Promise<void> {
    const { botName, port: wantedPort, browser } = parseArgs(process.argv.slice(2));
    process.on('SIGINT', () => { say('Stopping...'); void stopAll(0); });
    process.on('SIGTERM', () => void stopAll(0));

    // 1. The bot's account files.
    const botDir = join(ROOT, 'bots', botName);
    if (!existsSync(botDir)) {
        say(`Creating bot "${botName}"...`);
        await run([BUN, 'bots/create-bot.ts', botName, '--local'], ROOT, 'Creating the bot');
    }
    const env = parseEnvFile(readFileSync(join(botDir, 'bot.env'), 'utf8'));
    const local = !env.SERVER || env.SERVER.startsWith('localhost') || env.SERVER.startsWith('127.');

    // 2. Python: a venv with the rs package.
    if (!existsSync(VENV_PYTHON)) {
        say('Setting up Python (first time only)...');
        await run([IS_WINDOWS ? 'python' : 'python3', '-m', 'venv', '.venv'], ROOT, 'Creating the Python venv');
        await run([VENV_PYTHON, '-m', 'pip', 'install', '-q', '-e', 'python/'], ROOT, 'Installing the rs package');
    }

    // 3. The local game server, unless this bot plays somewhere else.
    if (local) {
        if (!existsSync(join(ROOT, 'server', 'webclient', 'out', 'bot', 'client.js'))) {
            say('Building the game client (first time only)...');
            await run([BUN, 'install'], join(ROOT, 'server', 'webclient'), 'Installing web client dependencies');
            await run([BUN, 'run', 'build'], join(ROOT, 'server', 'webclient'), 'Building the web client');
        }
        if (!(await isUp(GATEWAY_URL))) {
            say('Starting the gateway...');
            start('gateway', [BUN, 'run', 'gateway.ts'], join(ROOT, 'server', 'gateway'));
            if (!(await waitUntil(() => isUp(GATEWAY_URL), 30_000))) fail('The gateway did not start. See .play-logs/gateway.log');
        }
        if (!(await isUp(ENGINE_URL))) {
            say('Starting the game server (the first start builds the game and takes a few minutes)...');
            // The fork's content differs from upstream's checksums; server/Dockerfile builds the same way.
            start('engine', [BUN, 'run', 'start'], join(ROOT, 'server', 'engine'), { BUILD_VERIFY: 'false' });
            if (!(await waitUntil(() => isUp(ENGINE_URL), 15 * 60_000, 2000))) fail('The game server did not start. See .play-logs/engine.log');
        }
        say('Game server is up.');
    } else {
        say(`bot.env points at ${env.SERVER}; not starting a local server.`);
    }

    // 4. The bridge. Reuse one already serving this bot; skip ports other bots use.
    let port = wantedPort;
    for (;; port++) {
        const health = await bridgeHealth(port);
        if (health?.bot.toLowerCase() === (env.BOT_USERNAME ?? botName).toLowerCase()) {
            say(`Bridge for "${botName}" already running on port ${port}.`);
            break;
        }
        if (health || !(await portFree(port))) continue;
        start(`bridge-${botName}`, [BUN, 'pybridge/server.ts', botName, '--port', String(port)], ROOT);
        if (!(await waitUntil(async () => Boolean(await bridgeHealth(port)), 60_000))) fail(`The bridge did not start. See .play-logs/bridge-${botName}.log`);
        say(`Bridge for "${botName}" on port ${port}.`);
        break;
    }

    // 5. The game client: a browser tab you can watch.
    const url = `${browserOrigin(env.SERVER)}/bot?bot=${encodeURIComponent(env.BOT_USERNAME ?? botName)}&password=${encodeURIComponent(env.PASSWORD ?? '')}`;
    if (!(await bridgeHealth(port))?.clientAttached) {
        if (browser) {
            say('Opening the game in your browser. Keep that tab open while your bot plays.');
            const { default: open } = await import('open');
            await open(url).catch(() => say(`Could not open a browser. Open this link yourself:\n  ${url}`));
        } else {
            say(`Open the game client yourself:\n  ${url}`);
        }
        say('Waiting for the game to log in...');
        if (!(await waitUntil(async () => Boolean((await bridgeHealth(port))?.clientAttached), 5 * 60_000))) {
            fail('The game never logged in. Is the browser tab open?');
        }
    }

    // 6. New characters start on Tutorial Island: skip it.
    const guide = await bridgeCall(port, 'sdk.findNearbyNpc', [{ $regex: '^RuneScape Guide$', flags: 'i' }]);
    if (guide.ok && guide.result) {
        say('Skipping the tutorial...');
        const skip = await bridgeCall(port, 'bot.skipTutorial');
        say(skip.ok && skip.result?.success ? 'Tutorial skipped. Welcome to Lumbridge!' : `Could not skip the tutorial: ${skip.error ?? skip.result?.message}`);
    }

    const python = IS_WINDOWS ? '.venv\\Scripts\\python' : '.venv/bin/python';
    const portHint = port === 8765 ? '' : `\n  (this bot's bridge is on port ${port}: use rs.connect_sync("${botName}", port=${port}) in your script)`;
    console.log(`
Ready! In another terminal, from this folder, run your bot:

  ${python} bots/${botName}/bot.py
${portHint}
Edit bots/${botName}/bot.py to change what it does. PYTHON.md has a tutorial.
Leave this window open; press Ctrl+C here to stop the game.
`);
    await new Promise(() => {});
}

async function portFree(port: number): Promise<boolean> {
    try {
        const server = Bun.serve({ hostname: '127.0.0.1', port, fetch: () => new Response() });
        server.stop(true);
        return true;
    } catch {
        return false;
    }
}

main().catch(error => {
    if (!stopping) {
        console.error(`[play] ${error instanceof Error ? error.message : error}`);
        void stopAll(1);
    }
});

#!/usr/bin/env bun
// Python bridge: exposes one bot's BotSDK/BotActions over local HTTP JSON.
//
//   bun pybridge/server.ts <botname> [--port 8765]
//
// Builds the SDK pair directly instead of using runScript: runScript is a
// one-shot script lifecycle (it disconnects when its callback returns, aborts
// the whole run on any gateway blip, and gives every action one shared abort
// signal), while the bridge must stay up for hours and cancel calls one by one.
// The connection settings mirror sdk/runner.ts.

import { join } from 'path';
import { BotSDK } from '../sdk/index';
import { BotActions } from '../sdk/actions';
import { initPathfinding } from '../sdk/pathfinding';
import { loadBotEnv } from './env';
import { createBridge } from './bridge';
import { buildMethodTable } from './methods';
import { createCloneManager } from './clones';

const HOST = '127.0.0.1';
const DEFAULT_PORT = 8765;

function usage(): never {
    console.error('Usage: bun pybridge/server.ts <botname> [--port 8765]');
    process.exit(2);
}

function parseArgs(argv: string[]): { botName: string; port: number } {
    let botName: string | undefined;
    let port = DEFAULT_PORT;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]!;
        if (arg === '--port') {
            port = Number(argv[++i]);
        } else if (arg.startsWith('--port=')) {
            port = Number(arg.slice('--port='.length));
        } else if (arg === '-h' || arg === '--help') {
            usage();
        } else if (!arg.startsWith('-') && !botName) {
            botName = arg;
        } else {
            console.error(`Unknown argument: ${arg}`);
            usage();
        }
    }
    if (!botName) usage();
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        console.error(`Invalid port: ${port}`);
        usage();
    }
    return { botName, port };
}

const { botName, port } = parseArgs(process.argv.slice(2));
const repoRoot = join(import.meta.dir, '..');
const env = loadBotEnv(botName, repoRoot);

// Warm the pathfinder before the socket exists; see getOrCreateConnection in
// sdk/runner.ts for why paying it inside the first walkTo drops the connection.
initPathfinding();

const sdk = new BotSDK({
    botUsername: env.username,
    password: env.password,
    gatewayUrl: env.gatewayUrl,
    connectionMode: 'control',
    autoReconnect: true,
    autoLaunchBrowser: false,
    showChat: env.showChat,
});
const bot = new BotActions(sdk);
const table = await buildMethodTable();
const bridge = createBridge({ sdk, bot, username: env.username, methods: table.methods, excluded: table.excluded });
const clones = createCloneManager({
    main: env,
    mainDir: botName,
    repoRoot,
    mainHealth: async () => {
        const body = await (await bridge.fetch(new Request('http://bridge/health'))).json() as { ok: boolean; result?: { bot: string; clientAttached: boolean } };
        return body.ok ? body.result ?? null : null;
    },
    log: message => console.error(`[pybridge] ${message}`),
});

// The game tab runs on the game server's website and calls this local bridge, so
// /family and /switch answer only that website (CORS), and /switch needs a JSON
// body so another site can't trigger it without the browser's preflight check.
const gameOrigins = !env.server || env.server.startsWith('localhost') || env.server.startsWith('127.')
    ? ['http://localhost:8888', 'http://127.0.0.1:8888']
    : [/^wss?:\/\//.test(env.server) ? env.server.replace(/^ws/, 'http').replace(/\/gateway$/, '') : `https://${env.server}`];

async function browserRequest(req: Request, path: string): Promise<Response> {
    const origin = req.headers.get('origin') ?? '';
    if (!gameOrigins.includes(origin)) return new Response('Forbidden', { status: 403 });
    const cors = {
        'access-control-allow-origin': origin,
        'access-control-allow-methods': 'GET, POST',
        'access-control-allow-headers': 'content-type',
        'access-control-allow-private-network': 'true',
        vary: 'Origin',
    };
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (path === '/switch' && (req.method !== 'POST' || !req.headers.get('content-type')?.startsWith('application/json'))) {
        return new Response('POST JSON only', { status: 400, headers: cors });
    }
    const res = await clones.handleBrowser(req, path);
    for (const [key, value] of Object.entries(cors)) res.headers.set(key, value);
    return res;
}

// Listen before connecting so /health answers while the gateway is still
// coming up. idleTimeout 0: a call lasts as long as the SDK's own timeouts.
const server = Bun.serve({
    hostname: HOST,
    port,
    idleTimeout: 0,
    fetch: req => {
        const path = new URL(req.url).pathname;
        // POST /clone {"name"} makes and starts a clone of this bot (pybridge/clones.ts).
        if (req.method === 'POST' && path === '/clone') return clones.handle(req);
        // The browser game tab's character switcher.
        if (path === '/family' || path === '/switch') return browserRequest(req, path);
        return bridge.fetch(req);
    },
});
console.error(`[pybridge] Bot "${env.username}" listening on http://${HOST}:${server.port} (gateway ${env.gatewayUrl})`);

async function connectLoop(): Promise<void> {
    for (let attempt = 1; ; attempt++) {
        try {
            await sdk.connect();
            console.error(`[pybridge] Connected to gateway as "${env.username}"`);
            return;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            // The gateway rejected the credentials: retrying cannot help.
            if (/^Authentication failed/i.test(message)) {
                console.error(`[pybridge] Gateway refused "${env.username}": ${message}`);
                await shutdown(1);
            }
            const delay = Math.min(1000 * 2 ** (attempt - 1), 30_000);
            console.error(`[pybridge] Gateway connect failed (${message}); retrying in ${delay / 1000}s`);
            await Bun.sleep(delay);
        }
    }
}

let shuttingDown = false;
async function shutdown(code: number): Promise<never> {
    if (shuttingDown) process.exit(code);
    shuttingDown = true;
    console.error('[pybridge] Shutting down...');
    clones.stopAll();
    bridge.close();
    server.stop(true);
    setTimeout(() => process.exit(code), 5000).unref();
    await sdk.disconnect().catch(() => {});
    process.exit(code);
}

process.on('SIGINT', () => void shutdown(130));
process.on('SIGTERM', () => void shutdown(143));
process.on('SIGHUP', () => void shutdown(129));

void connectLoop();

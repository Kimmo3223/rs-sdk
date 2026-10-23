// Clones for the Python bridge: POST /clone {"name": "jaska"} on a main bot's
// bridge makes "jaska" a clone of that bot (shared bank and skill XP, see
// server/engine/src/engine/Clones.ts), then starts the clone's own headless
// game client and bridge and answers {"name", "port"} so Python can drive it.
//
// The clone account uses the main's password. On a local server the clone is
// linked directly in the server's files; on a hosted one the gate makes it
// (POST /gate/clone, signed in with the main's name and password).
// Clone processes stop when this bridge stops.

import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { Subprocess } from 'bun';
import { parseEnvFile, type BotEnv } from './env';

const FIRST_PORT = 8765;

type Health = { bot: string; clientAttached: boolean };
type Running = { port: number; procs: Subprocess[] };

export interface CloneManagerOptions {
    main: BotEnv;
    /** The main's folder under bots/ (where its bot.env is). */
    mainDir: string;
    repoRoot: string;
    /** This bridge's own /health, to check that the main is in the game. */
    mainHealth: () => Promise<Health | null>;
    log: (message: string) => void;
}

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function health(port: number): Promise<Health | null> {
    try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
        const body = await res.json() as { ok: boolean; result?: Health };
        return body.ok && body.result ? body.result : null;
    } catch {
        return null;
    }
}

async function portFree(port: number): Promise<boolean> {
    try {
        Bun.serve({ hostname: '127.0.0.1', port, fetch: () => new Response() }).stop(true);
        return true;
    } catch {
        return false;
    }
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await check()) return true;
        await Bun.sleep(1000);
    }
    return false;
}

function isLocal(server: string | undefined): boolean {
    return !server || server.startsWith('localhost') || server.startsWith('127.');
}

/** Where the gate lives for a hosted server, the same way play.ts finds the website. */
function serverOrigin(server: string): string {
    return /^wss?:\/\//.test(server) ? server.replace(/^ws/, 'http').replace(/\/gateway$/, '') : `https://${server}`;
}

export function createCloneManager(options: CloneManagerOptions) {
    const { main, repoRoot, log } = options;
    const logsDir = join(repoRoot, '.play-logs');
    const running = new Map<string, Running>();
    // One clone at a time, so two calls can't pick the same port.
    let chain: Promise<unknown> = Promise.resolve();

    /** Ask the server to make the clone. Returns its account name. */
    async function register(clone: string): Promise<string> {
        if (isLocal(main.server)) {
            const { createCloneFor, CloneError } = await import('../server/gate/clones');
            // A local server only checks passwords when host.ts runs it with accounts.
            const { DB_PATH } = await import('../server/gate/accounts');
            let accounts = false;
            if (existsSync(DB_PATH)) {
                const { Database } = await import('bun:sqlite');
                const db = new Database(DB_PATH, { readonly: true });
                accounts = Boolean(db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'account'").get());
                db.close();
            }
            try {
                return (await createCloneFor(main.username, main.password, clone, { accounts })).name;
            } catch (error) {
                if (error instanceof CloneError) throw new Error(error.message);
                throw error;
            }
        }
        let res: Response;
        try {
            res = await fetch(`${serverOrigin(main.server!)}/gate/clone`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ username: main.username, password: main.password, clone }),
                signal: AbortSignal.timeout(30_000),
            });
        } catch (error) {
            throw new Error(`Could not reach ${main.server}: ${(error as Error).message}`);
        }
        const body = await res.json().catch(() => null) as { ok?: boolean; error?: string; result?: { name: string } } | null;
        if (!body) throw new Error(`${main.server} doesn't make clones (HTTP ${res.status}); only servers hosted with this repo's host.ts do`);
        if (!body.ok || !body.result) throw new Error(body.error ?? `the server refused (HTTP ${res.status})`);
        return body.result.name;
    }

    /** bots/<clone>/bot.env with the main's server and password. */
    function checkBotDir(name: string): void {
        const envPath = join(repoRoot, 'bots', name, 'bot.env');
        if (!existsSync(envPath)) return;
        const existing = parseEnvFile(readFileSync(envPath, 'utf8'));
        if (existing.CLONE_OF?.toLowerCase() !== main.username.toLowerCase()) {
            throw new Error(`bots/${name} already exists and isn't a clone of ${main.username}; pick another name`);
        }
    }

    function writeBotEnv(name: string): void {
        checkBotDir(name);
        const dir = join(repoRoot, 'bots', name);
        const envPath = join(dir, 'bot.env');
        const mainEnv = parseEnvFile(readFileSync(join(repoRoot, 'bots', options.mainDir, 'bot.env'), 'utf8'));
        const lines = [
            `# Clone of ${main.username}, made by its bot's clone() call. Same password as ${main.username}.`,
            `BOT_USERNAME=${name}`,
            `PASSWORD=${main.password}`,
            `SERVER=${mainEnv.SERVER ?? ''}`,
            ...(mainEnv.GATEWAY_URL ? [`GATEWAY_URL=${mainEnv.GATEWAY_URL}`] : []),
            ...(mainEnv.SHOW_CHAT ? [`SHOW_CHAT=${mainEnv.SHOW_CHAT}`] : []),
            `CLONE_OF=${main.username}`,
        ];
        mkdirSync(dir, { recursive: true });
        writeFileSync(envPath, `${lines.join('\n')}\n`);
    }

    function spawn(name: string, cmd: string[], cwd: string): Subprocess {
        mkdirSync(logsDir, { recursive: true });
        const out = openSync(join(logsDir, `${name}.log`), 'a');
        return Bun.spawn(cmd, { cwd, stdout: out, stderr: out, stdin: 'ignore', env: { ...process.env } });
    }

    async function start(name: string): Promise<number> {
        const current = running.get(name);
        if (current) {
            const h = await health(current.port);
            if (h?.clientAttached) return current.port;
            for (const proc of current.procs) proc.kill('SIGINT');
            running.delete(name);
        }

        let port = FIRST_PORT;
        for (; ; port++) {
            const h = await health(port);
            // Already served by someone (another play.ts, say): use it.
            if (h?.bot.toLowerCase() === name.toLowerCase() && h.clientAttached) return port;
            if (!h && (await portFree(port))) break;
        }

        const webclient = join(repoRoot, 'server', 'webclient');
        if (!existsSync(join(webclient, 'node_modules'))) {
            log('Installing the headless game client (first time only)...');
            const install = Bun.spawnSync([process.execPath, 'install'], { cwd: webclient, stdout: 'ignore', stderr: 'ignore' });
            if (install.exitCode !== 0) throw new Error('bun install in server/webclient failed');
        }

        const bridge = spawn(`bridge-${name}`, [process.execPath, join(repoRoot, 'pybridge', 'server.ts'), name, '--port', String(port)], repoRoot);
        const client = spawn(`lite-${name}`, [process.execPath, 'src/lite/runner.ts', name], webclient);
        const procs = [bridge, client];
        running.set(name, { port, procs });
        let exited = false;
        for (const proc of procs) void proc.exited.then(() => { exited = true; });

        const attached = await waitFor(async () => exited || Boolean((await health(port))?.clientAttached), 3 * 60_000);
        if (!attached || exited) {
            for (const proc of procs) proc.kill('SIGINT');
            running.delete(name);
            throw new Error(`${name}'s game client did not log in. See .play-logs/lite-${name}.log and .play-logs/bridge-${name}.log`);
        }

        // A clone the game won't let play yet is told why and logged out after a few seconds.
        await Bun.sleep(6000);
        if (exited || !(await health(port))?.clientAttached) {
            for (const proc of procs) proc.kill('SIGINT');
            running.delete(name);
            throw new Error(`The game logged ${name} out: it is probably locked (one clone per 100 total level of ${main.username}). See .play-logs/lite-${name}.log`);
        }

        // New characters start on Tutorial Island.
        const call = async (method: string, args: unknown[] = []) => {
            const res = await fetch(`http://127.0.0.1:${port}/call`, { method: 'POST', body: JSON.stringify({ method, args }) });
            return res.json() as Promise<{ ok: boolean; result?: any; error?: string }>;
        };
        const guide = await call('sdk.findNearbyNpc', [{ $regex: '^RuneScape Guide$', flags: 'i' }]);
        if (guide.ok && guide.result) {
            log(`Skipping the tutorial for ${name}...`);
            await call('bot.skipTutorial');
        }
        return port;
    }

    async function make(clone: string): Promise<{ name: string; port: number }> {
        if (typeof clone !== 'string' || !clone.trim()) throw new Error('clone() needs a name, e.g. clone("jaska")');
        if (!(await options.mainHealth())?.clientAttached) {
            throw new Error(`${main.username} must be in the game to make a clone (start it with: bun play.ts ${main.username})`);
        }
        // Before asking the server, so a clash here doesn't use up a clone slot.
        checkBotDir(clone.trim().toLowerCase().replace(/ +/g, '_'));
        const name = await register(clone.trim());
        writeBotEnv(name);
        log(`Starting clone "${name}"...`);
        const port = await start(name);
        log(`Clone "${name}" is in the game; its bridge is on port ${port}.`);
        return { name, port };
    }

    return {
        async handle(req: Request): Promise<Response> {
            const body = await req.json().catch(() => null) as { name?: unknown } | null;
            const work = chain.then(() => make(body?.name as string));
            chain = work.catch(() => {});
            try {
                return json({ ok: true, result: await work });
            } catch (error) {
                return json({ ok: false, error: (error as Error).message, code: 'clone_failed' }, 409);
            }
        },
        stopAll(): void {
            for (const { procs } of running.values()) for (const proc of procs) proc.kill('SIGINT');
            running.clear();
        },
    };
}

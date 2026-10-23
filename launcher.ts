// Process helpers shared by play.ts and host.ts: start children with logs in
// .play-logs/, wait for ports, and stop everything this launcher started.

import { appendFileSync, existsSync, mkdirSync, openSync } from 'fs';
import { join } from 'path';
import type { Subprocess } from 'bun';

export const ROOT = import.meta.dir;
export const LOGS = join(ROOT, '.play-logs');
export const BUN = process.execPath;
// 127.0.0.1 rather than localhost: in host mode the servers bind IPv4 loopback only.
export const ENGINE_URL = 'http://127.0.0.1:8888';
export const GATEWAY_URL = 'http://127.0.0.1:7780';

export function createLauncher(tag: string) {
    const started: Array<{ name: string; proc: Subprocess }> = [];
    let stopping = false;

    const say = (message: string) => console.log(`[${tag}] ${message}`);

    function logFile(name: string): number {
        mkdirSync(LOGS, { recursive: true });
        return openSync(join(LOGS, `${name}.log`), 'a');
    }

    async function stopAll(code: number): Promise<void> {
        if (stopping) process.exit(code);
        stopping = true;
        for (const { proc } of [...started].reverse()) proc.kill('SIGINT');
        await Promise.race([Promise.all(started.map(s => s.proc.exited)), Bun.sleep(10_000)]);
        process.exit(code);
    }

    function fail(message: string): never {
        console.error(`[${tag}] ${message}`);
        void stopAll(1);
        throw new Error(message);
    }

    function start(name: string, cmd: string[], cwd: string, env: Record<string, string> = {}, onLine?: (line: string) => void): Subprocess {
        const log = logFile(name);
        const proc = Bun.spawn(cmd, {
            cwd,
            env: { ...process.env, ...env },
            stdout: log,
            stderr: onLine ? 'pipe' : log,
            stdin: 'ignore',
        });
        if (onLine && proc.stderr instanceof ReadableStream) {
            // Tee stderr: to the log file, and line by line to the caller.
            void (async () => {
                const decoder = new TextDecoder();
                let buffer = '';
                const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
                for (;;) {
                    const { done, value: chunk } = await reader.read();
                    if (done) break;
                    appendFileSync(join(LOGS, `${name}.log`), chunk);
                    buffer += decoder.decode(chunk, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop() ?? '';
                    for (const line of lines) onLine(line);
                }
            })();
        }
        started.push({ name, proc });
        proc.exited.then(code => {
            if (!stopping) say(`${name} stopped (exit ${code}). See .play-logs/${name}.log`);
        });
        return proc;
    }

    async function run(cmd: string[], cwd: string, what: string, env: Record<string, string> = {}): Promise<void> {
        const log = logFile('setup');
        const proc = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: log, stderr: log, stdin: 'ignore' });
        if (await proc.exited !== 0) fail(`${what} failed. See .play-logs/setup.log`);
    }

    process.on('SIGINT', () => { say('Stopping...'); void stopAll(0); });
    process.on('SIGTERM', () => void stopAll(0));

    return { say, fail, start, run, stopAll, isStopping: () => stopping };
}

export async function isUp(url: string): Promise<boolean> {
    try {
        await fetch(url, { signal: AbortSignal.timeout(1500) });
        return true;
    } catch {
        return false;
    }
}

export async function waitUntil(check: () => Promise<boolean>, timeoutMs: number, everyMs = 1000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await check()) return true;
        await Bun.sleep(everyMs);
    }
    return false;
}

export async function portFree(port: number): Promise<boolean> {
    try {
        const server = Bun.serve({ hostname: '127.0.0.1', port, fetch: () => new Response() });
        server.stop(true);
        return true;
    } catch {
        return false;
    }
}

/** Build the web client if it has never been built. */
export async function ensureWebClient(launcher: ReturnType<typeof createLauncher>): Promise<void> {
    if (existsSync(join(ROOT, 'server', 'webclient', 'out', 'bot', 'client.js'))) return;
    launcher.say('Building the game client (first time only)...');
    await launcher.run([BUN, 'install'], join(ROOT, 'server', 'webclient'), 'Installing web client dependencies');
    await launcher.run([BUN, 'run', 'build'], join(ROOT, 'server', 'webclient'), 'Building the web client');
}

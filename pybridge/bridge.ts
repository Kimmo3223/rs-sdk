// HTTP handler for the Python bridge. Transport-free so tests can drive it
// with a mocked BotSDK/BotActions pair; server.ts owns sockets and lifecycle.
//
//   GET  /health   bridge, gateway and game-client status
//   GET  /state    sdk.getState(), entities tagged with "$kind"
//   GET  /methods  the callable method table
//   POST /call     {"method": "bot.attack", "args": [...]}
//
// Every reply is {"ok": true, "result": ...} or {"ok": false, "error": "...", "code": "..."}.
//
// Concurrency: one BotSDK drives one game character, and two porcelain
// actions at once (a walkTo racing an attack) fight over the same player.
// Methods marked `queued` therefore run one at a time in arrival order;
// synchronous getters and pure waits (waitFor*, get*, is*, check*) run
// immediately alongside them.

import type { BotSDK } from '../sdk/index';
import type { BotActions } from '../sdk/actions';
import type { BotWorldState } from '../sdk/types';
import { executionContext, abortable } from '../sdk/execution-context';
import { BridgeError } from './errors';
import { decodeArgs, encodeState, encodeValue } from './codec';
import type { ExcludedMethod, MethodSpec } from './methods';

export interface BridgeOptions {
    sdk: BotSDK;
    bot: BotActions;
    username: string;
    methods: readonly MethodSpec[];
    /** Reported by GET /methods so a missing method explains itself. */
    excluded?: readonly ExcludedMethod[];
    /** How long a call waits for a fresh game tick before reporting no client (default 10s, as sdk/runner.ts). */
    liveClientWaitMs?: number;
    /** A tick older than this means the client is gone (default 10s). */
    staleAfterMs?: number;
}

export interface Bridge {
    fetch(req: Request): Promise<Response>;
    /** Stop listening to the SDK. Does not disconnect it. */
    close(): void;
}

const STATUS_BY_CODE: Record<string, number> = {
    bad_request: 400,
    bad_argument: 400,
    unknown_method: 404,
    not_found: 404,
    stale_entity: 409,
    no_client: 503,
    cancelled: 499,
};

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

function errorResponse(error: unknown): Response {
    if (error instanceof BridgeError) {
        return json({ ok: false, error: error.message, code: error.code }, STATUS_BY_CODE[error.code] ?? 500);
    }
    // Anything else was thrown by the SDK method itself (a waitFor* timeout,
    // a TypeError from a bad argument shape...). Report it, keep serving.
    const name = error instanceof Error ? error.name : 'Error';
    const message = error instanceof Error ? error.message : String(error);
    return json({ ok: false, error: message, code: 'call_failed', errorName: name }, 500);
}

export function createBridge(options: BridgeOptions): Bridge {
    const { sdk, bot, username } = options;
    const liveClientWaitMs = options.liveClientWaitMs ?? 10_000;
    const staleAfterMs = options.staleAfterMs ?? 10_000;
    const methods = new Map(options.methods.map(spec => [spec.id, spec]));
    const targets = { bot, sdk } as const;

    // A live client advances `tick` every game tick. The gateway replays its
    // last cached state after a client leaves, so "has state" is not enough.
    let lastTick: number | null = sdk.getState()?.tick ?? null;
    let lastTickAt = 0;
    const unsubscribe = sdk.onStateUpdate((state: BotWorldState) => {
        if (state.tick !== lastTick) {
            lastTick = state.tick;
            lastTickAt = Date.now();
        }
    });
    const attached = () => lastTickAt > 0 && Date.now() - lastTickAt < staleAfterMs;

    function noClientError(): BridgeError {
        return new BridgeError(
            `No game client is attached to "${username}" (no new game tick in ${Math.round(liveClientWaitMs / 1000)}s). ` +
            `Start one and leave it running: cd server/webclient && bun src/lite/runner.ts ${username} ` +
            `(or open the bot's browser client).`,
            'no_client',
        );
    }

    async function requireLiveClient(signal: AbortSignal): Promise<void> {
        if (attached()) return;
        const deadline = Date.now() + liveClientWaitMs;
        while (Date.now() < deadline) {
            if (signal.aborted) throw new BridgeError('Request cancelled', 'cancelled');
            await Bun.sleep(50);
            if (attached()) return;
        }
        throw noClientError();
    }

    // Action queue: a promise chain, one link per queued call.
    let queueTail: Promise<void> = Promise.resolve();
    let queued = 0;
    let running: string | null = null;
    async function inQueue<T>(id: string, signal: AbortSignal, work: () => Promise<T>): Promise<T> {
        const previous = queueTail;
        let release!: () => void;
        const mine = new Promise<void>(resolve => { release = resolve; });
        queueTail = previous.then(() => mine);
        queued++;
        try {
            await abortable(previous, signal);
            running = id;
            return await work();
        } finally {
            running = null;
            queued--;
            release();
        }
    }

    async function call(req: Request): Promise<Response> {
        let body: unknown;
        try {
            body = await req.json();
        } catch {
            throw new BridgeError('Body must be JSON: {"method": "bot.attack", "args": [...]}', 'bad_request');
        }
        const { method, args } = (body ?? {}) as { method?: unknown; args?: unknown };
        if (typeof method !== 'string') throw new BridgeError('"method" must be a string such as "bot.attack"', 'bad_request');
        const spec = methods.get(method);
        if (!spec) throw new BridgeError(`Unknown or non-callable method "${method}". GET /methods lists the callable ones.`, 'unknown_method');

        // Cancel the SDK work when Python goes away (Ctrl+C, task cancelled):
        // the SDK's execution context aborts its waits and blocks further dispatch.
        const controller = new AbortController();
        const onAbort = () => controller.abort(new BridgeError(`${method} cancelled: the Python client disconnected`, 'cancelled'));
        if (req.signal.aborted) onAbort();
        req.signal.addEventListener('abort', onAbort, { once: true });
        try {
            await requireLiveClient(controller.signal);
            const decoded = decodeArgs(args, { getState: () => sdk.getState() });
            const target = targets[spec.target] as unknown as Record<string, unknown>;
            const fn = target[spec.name];
            if (typeof fn !== 'function') throw new BridgeError(`${method} is not a function on this SDK build`, 'unknown_method');
            const invoke = () => executionContext.run(
                { signal: controller.signal },
                () => abortable(Promise.resolve().then(() => fn.apply(target, decoded))),
            );
            const result = spec.queued ? await inQueue(method, controller.signal, invoke) : await invoke();
            const encoded = spec.resultKind === 'state'
                ? (result ? encodeState(result as BotWorldState) : null)
                : encodeValue(result, spec.resultKind);
            return json({ ok: true, result: encoded });
        } finally {
            req.signal.removeEventListener('abort', onAbort);
            if (!controller.signal.aborted) controller.abort(new Error('Call finished'));
        }
    }

    function health() {
        const state = sdk.getState();
        return {
            bot: username,
            gateway: sdk.getConnectionState(),
            clientAttached: attached(),
            tick: state?.tick ?? null,
            stateAgeMs: state ? sdk.getStateAge() : null,
            queue: { running, waiting: Math.max(0, queued - (running ? 1 : 0)) },
            methods: methods.size,
        };
    }

    function getState(url: URL): Response {
        const state = sdk.getState();
        if (!state || (url.searchParams.get('allowStale') !== '1' && !attached())) throw noClientError();
        return json({ ok: true, result: encodeState(state), clientAttached: attached(), stateAgeMs: sdk.getStateAge() });
    }

    return {
        async fetch(req: Request): Promise<Response> {
            const url = new URL(req.url);
            try {
                if (req.method === 'GET' && url.pathname === '/health') return json({ ok: true, result: health() });
                if (req.method === 'GET' && url.pathname === '/state') return getState(url);
                if (req.method === 'GET' && url.pathname === '/methods') return json({ ok: true, result: { methods: [...methods.values()], excluded: options.excluded ?? [] } });
                if (req.method === 'POST' && url.pathname === '/call') return await call(req);
                throw new BridgeError(`Not found: ${req.method} ${url.pathname}`, 'not_found');
            } catch (error) {
                return errorResponse(error);
            }
        },
        close() {
            unsubscribe();
        },
    };
}

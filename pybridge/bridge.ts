// HTTP handler for the Python bridge. Transport-free so tests can drive it
// with a mocked BotSDK/BotActions pair; server.ts owns sockets and lifecycle.

import type { BotSDK } from '../sdk/index';
import type { BotActions } from '../sdk/actions';
import type { BotWorldState } from '../sdk/types';

export interface BridgeOptions {
    sdk: BotSDK;
    bot: BotActions;
    username: string;
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

export class BridgeError extends Error {
    constructor(message: string, readonly code: string) {
        super(message);
        this.name = 'BridgeError';
    }
}

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

export function createBridge(options: BridgeOptions): Bridge {
    const { sdk, bot, username } = options;
    const liveClientWaitMs = options.liveClientWaitMs ?? 10_000;
    const staleAfterMs = options.staleAfterMs ?? 10_000;

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

    async function requireLiveClient(signal?: AbortSignal): Promise<void> {
        if (attached()) return;
        const deadline = Date.now() + liveClientWaitMs;
        while (Date.now() < deadline) {
            if (signal?.aborted) throw new BridgeError('Request cancelled', 'cancelled');
            await Bun.sleep(100);
            if (attached()) return;
        }
        throw noClientError();
    }

    function health() {
        const state = sdk.getState();
        return {
            ok: true,
            bot: username,
            gateway: sdk.getConnectionState(),
            clientAttached: attached(),
            tick: state?.tick ?? null,
            stateAgeMs: state ? sdk.getStateAge() : null,
        };
    }

    async function getState(url: URL): Promise<Response> {
        if (url.searchParams.get('allowStale') !== '1' && !attached()) {
            return json({ ok: false, error: noClientError().message, code: 'no_client' }, 503);
        }
        const state = sdk.getState();
        if (!state) return json({ ok: false, error: noClientError().message, code: 'no_client' }, 503);
        return json({ ok: true, result: state, clientAttached: attached(), stateAgeMs: sdk.getStateAge() });
    }

    return {
        async fetch(req: Request): Promise<Response> {
            const url = new URL(req.url);
            try {
                if (req.method === 'GET' && url.pathname === '/health') return json(health());
                if (req.method === 'GET' && url.pathname === '/state') return await getState(url);
                return json({ ok: false, error: `Not found: ${req.method} ${url.pathname}`, code: 'not_found' }, 404);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                const code = error instanceof BridgeError ? error.code : 'internal';
                return json({ ok: false, error: message, code }, 500);
            }
        },
        close() {
            unsubscribe();
        },
    };
}

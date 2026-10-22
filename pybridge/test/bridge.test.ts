import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import type { BotSDK } from '../../sdk/index';
import type { BotActions } from '../../sdk/actions';
import { executionContext } from '../../sdk/execution-context';
import { buildApiModel } from '../../sdk/generate-api-docs';
import { createBridge } from '../bridge';
import { decodeArgs, encodeValue } from '../codec';
import { buildMethodTable, specFromSignature, type MethodSpec } from '../methods';
import { GENERATED_PATH, generatePython, snakeCase } from '../gen-python';

const table = await buildMethodTable();

function npc(index: number, x: number, z: number, extra: Record<string, unknown> = {}) {
    return { kind: 'npc', id: 100, index, name: 'Goblin', combatLevel: 2, x, z, distance: 3, optionsWithIndex: [{ text: 'Attack', opIndex: 2 }], options: ['Attack'], ...extra };
}

function harness(opts: { ticking?: boolean } = {}) {
    const listeners = new Set<(state: any) => void>();
    const state: any = {
        tick: 1,
        player: { name: 'test', worldX: 3200, worldZ: 3200 },
        nearbyNpcs: [npc(7, 3210, 3210)],
        nearbyPlayers: [],
        nearbyLocs: [{ id: 1276, name: 'Tree', x: 3205, z: 3205, level: 0, distance: 5, optionsWithIndex: [], options: [] }],
        groundItems: [],
        inventory: [{ slot: 3, id: 2309, name: 'Bread', count: 1, optionsWithIndex: [] }],
        equipment: [],
        bank: { isOpen: false, items: [], noteMode: false },
        shop: { isOpen: false, title: '', shopItems: [], playerItems: [] },
    };
    const calls: Array<{ name: string; args: unknown[]; signal?: AbortSignal }> = [];
    const record = (name: string, args: unknown[]) => calls.push({ name, args, signal: executionContext.getStore()?.signal });
    let release: (() => void) | null = null;

    const sdk = {
        getState: () => state,
        getStateAge: () => 5,
        getConnectionState: () => 'connected',
        onStateUpdate(listener: (s: any) => void) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        getSkill(name: string) { record('getSkill', [name]); return { name, level: 10 }; },
        findNearbyNpc(pattern: unknown) { record('findNearbyNpc', [pattern]); return state.nearbyNpcs[0]; },
        disconnect() { record('disconnect', []); },
        async waitForTicks(ticks: number = 1) { record('waitForTicks', [ticks]); return state; },
    };
    const bot = {
        async attack(target: unknown, timeout: number = 5000) {
            record('attack', [target, timeout]);
            return { success: true, message: 'Attacking', pattern: target instanceof RegExp ? target : undefined };
        },
        async walkTo(x: number, z: number) {
            record('walkTo', [x, z]);
            // Parks until released or cancelled through the execution context.
            const signal = executionContext.getStore()?.signal;
            await new Promise<void>((resolve, reject) => {
                release = resolve;
                signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
            });
            return { success: true, message: 'Arrived' };
        },
        async eatFood(target: unknown) { record('eatFood', [target]); return { success: true, hpGained: 3, message: 'Ate Bread' }; },
        async chopTree(target: unknown) { record('chopTree', [target]); return { success: true, message: 'Chopped' }; },
        async waitForIdle() { throw new Error('Timed out waiting for idle'); },
        getEquipment() {
            const node: any = { self: null, missing: undefined, fn: () => 1, big: 10n, nan: NaN, list: [undefined, 1] };
            node.self = node;
            return [node];
        },
    };

    const bridge = createBridge({
        sdk: sdk as unknown as BotSDK,
        bot: bot as unknown as BotActions,
        username: 'test',
        methods: table.methods,
        excluded: table.excluded,
        liveClientWaitMs: 150,
    });
    const tick = () => { state.tick++; for (const listener of listeners) listener(state); };
    if (opts.ticking !== false) tick();

    async function call(method: string, args: unknown[] = [], signal?: AbortSignal) {
        const res = await bridge.fetch(new Request('http://bridge/call', { method: 'POST', body: JSON.stringify({ method, args }), signal }));
        return { status: res.status, body: await res.json() as any };
    }
    async function get(path: string) {
        const res = await bridge.fetch(new Request(`http://bridge${path}`));
        return { status: res.status, body: await res.json() as any };
    }
    return { bridge, state, calls, call, get, tick, release: () => release?.() };
}

describe('method whitelist', () => {
    test('covers every documented method, minus the excluded ones', async () => {
        const model = await buildApiModel();
        const documented = new Set([
            ...model.botActionsMethods.map(m => `bot.${m.name}`),
            ...model.sdkMethods.map(m => `sdk.${m.name}`),
        ]);
        const callable = new Set(table.methods.map(m => m.id));
        const excluded = new Set(table.excluded.map(m => m.id));
        expect(new Set([...callable, ...excluded])).toEqual(documented);
        for (const id of ['bot.attack', 'bot.walkTo', 'bot.eatFood', 'bot.chopTree', 'sdk.getState', 'sdk.findNearbyNpc', 'sdk.waitForTicks', 'sdk.say']) {
            expect(callable.has(id)).toBeTrue();
        }
        for (const id of ['sdk.connect', 'sdk.disconnect', 'sdk.launchBrowser', 'sdk.waitForCondition', 'sdk.onStateUpdate', 'sdk.onConnectionStateChange']) {
            expect(excluded.has(id)).toBeTrue();
        }
    });

    test('classifies queueing and result kinds from the signature', () => {
        const attack = specFromSignature('bot', 'async attack(target: CombatTarget, timeout: number = 5000): Promise<AttackResult>', '') as MethodSpec;
        expect(attack.queued).toBeTrue();
        expect(attack.params).toEqual([
            { name: 'target', optional: false, type: 'CombatTarget' },
            { name: 'timeout', optional: true, type: 'number' },
        ]);
        const find = specFromSignature('sdk', 'findNearbyNpc(pattern: string | RegExp, options?: FindOptions): NearbyNpc | null', '') as MethodSpec;
        expect(find.queued).toBeFalse();
        expect(find.resultKind).toBe('npc');
        const wait = specFromSignature('sdk', 'async waitForTicks(ticks: number = 1): Promise<BotWorldState>', '') as MethodSpec;
        expect(wait.queued).toBeFalse();
        expect(wait.resultKind).toBe('state');
    });

    test('refuses excluded and unknown methods without touching the SDK', async () => {
        const h = harness();
        for (const method of ['sdk.disconnect', 'sdk.waitForCondition', 'bot.nope', 'process.exit']) {
            const { status, body } = await h.call(method);
            expect(status).toBe(404);
            expect(body).toMatchObject({ ok: false, code: 'unknown_method' });
        }
        expect(h.calls).toEqual([]);
        const methods = await h.get('/methods');
        expect(methods.body.result.excluded.map((m: any) => m.id)).toContain('sdk.disconnect');
    });
});

describe('argument decoding', () => {
    test('rebuilds {$regex} as a RegExp and round-trips it back', async () => {
        const h = harness();
        const { body } = await h.call('bot.attack', [{ $regex: '^goblin$', flags: 'i' }]);
        const pattern = h.calls[0]!.args[0];
        expect(pattern).toBeInstanceOf(RegExp);
        expect((pattern as RegExp).source).toBe('^goblin$');
        expect((pattern as RegExp).flags).toBe('i');
        expect(body.result.pattern).toEqual({ $regex: '^goblin$', flags: 'i' });
    });

    test('passes plain strings through unchanged', async () => {
        const h = harness();
        await h.call('bot.attack', ['goblin']);
        expect(h.calls[0]!.args[0]).toBe('goblin');
    });

    test('rejects malformed regexes as bad_argument', async () => {
        const h = harness();
        const { status, body } = await h.call('bot.attack', [{ $regex: '(' }]);
        expect(status).toBe(400);
        expect(body.code).toBe('bad_argument');
        expect(h.calls).toEqual([]);
    });

    test('top-level null becomes undefined so TS defaults apply', async () => {
        const h = harness();
        await h.call('bot.attack', ['goblin', null]);
        expect(h.calls[0]!.args).toEqual(['goblin', 5000]);
        expect(decodeArgs([1, null, { a: null }], { getState: () => null })).toEqual([1, undefined, { a: null }]);
    });

    test('resolves an NPC from JSON against fresh state, not its stale coordinates', async () => {
        const h = harness();
        const snapshot = (await h.get('/state')).body.result.nearbyNpcs[0];
        expect(snapshot.$kind).toBe('npc');
        // The goblin wandered off after the snapshot was taken.
        h.state.nearbyNpcs = [npc(7, 3215, 3212)];
        await h.call('bot.attack', [snapshot]);
        const target = h.calls[0]!.args[0] as any;
        expect(target).toBe(h.state.nearbyNpcs[0]);
        expect([target.x, target.z]).toEqual([3215, 3212]);
    });

    test('reports gone or replaced entities as stale_entity', async () => {
        const h = harness();
        const snapshot = (await h.get('/state')).body.result.nearbyNpcs[0];
        h.state.nearbyNpcs = [npc(7, 3210, 3210, { id: 555, name: 'Rat' })];
        const replaced = await h.call('bot.attack', [snapshot]);
        expect(replaced.status).toBe(409);
        expect(replaced.body.code).toBe('stale_entity');
        h.state.nearbyNpcs = [];
        const gone = await h.call('bot.attack', [snapshot]);
        expect(gone.body.code).toBe('stale_entity');
        expect(h.calls).toEqual([]);
    });

    test('resolves $kind-tagged locs and inventory items', async () => {
        const h = harness();
        const state = (await h.get('/state')).body.result;
        await h.call('bot.chopTree', [state.nearbyLocs[0]]);
        expect(h.calls[0]!.args[0]).toBe(h.state.nearbyLocs[0]);
        // The bread moved to another slot: matched by id.
        h.state.inventory = [{ slot: 9, id: 2309, name: 'Bread', count: 1, optionsWithIndex: [] }];
        await h.call('bot.eatFood', [state.inventory[0]]);
        expect(h.calls[1]!.args[0]).toBe(h.state.inventory[0]);
        const bad = await h.call('bot.eatFood', [{ $kind: 'spaceship', id: 1 }]);
        expect(bad.body.code).toBe('bad_argument');
    });
});

describe('results and errors', () => {
    test('serializes circular refs, undefined, functions and bigints safely', async () => {
        const h = harness();
        const { body } = await h.call('bot.getEquipment');
        expect(body.ok).toBeTrue();
        expect(body.result[0]).toEqual({ self: '[Circular]', big: '10', nan: null, list: [null, 1], $kind: 'equip' });
        expect(encodeValue(undefined)).toBeNull();
    });

    test('a thrown SDK error is a structured error and the bridge keeps serving', async () => {
        const h = harness();
        const failed = await h.call('bot.waitForIdle');
        expect(failed.status).toBe(500);
        expect(failed.body).toMatchObject({ ok: false, code: 'call_failed', error: 'Timed out waiting for idle', errorName: 'Error' });
        const next = await h.call('sdk.getSkill', ['hitpoints']);
        expect(next.body).toEqual({ ok: true, result: { name: 'hitpoints', level: 10 } });
    });

    test('bad request bodies are reported, not thrown', async () => {
        const h = harness();
        const res = await h.bridge.fetch(new Request('http://bridge/call', { method: 'POST', body: 'not json' }));
        expect(res.status).toBe(400);
        expect((await res.json() as any).code).toBe('bad_request');
    });

    test('reports a missing game client', async () => {
        const h = harness({ ticking: false });
        const { status, body } = await h.call('bot.attack', ['goblin']);
        expect(status).toBe(503);
        expect(body.code).toBe('no_client');
        expect(body.error).toContain('No game client is attached');
        expect((await h.get('/state')).body.code).toBe('no_client');
        expect((await h.get('/health')).body.result.clientAttached).toBeFalse();
        expect((await h.get('/state?allowStale=1')).body.ok).toBeTrue();
    });

    test('tags world-state results with $kind', async () => {
        const h = harness();
        const { body } = await h.call('sdk.waitForTicks', [2]);
        expect(body.result.nearbyNpcs[0].$kind).toBe('npc');
        expect(body.result.inventory[0].$kind).toBe('inv');
        expect(h.state.nearbyNpcs[0].$kind).toBeUndefined();
    });
});

describe('concurrency', () => {
    test('queues porcelain actions but lets getters through', async () => {
        const h = harness();
        const walk = h.call('bot.walkTo', [3222, 3218]);
        const attack = h.call('bot.attack', ['goblin']);
        await Bun.sleep(20);
        expect(h.calls.map(c => c.name)).toEqual(['walkTo']);
        const getter = await h.call('sdk.getSkill', ['attack']);
        expect(getter.body.ok).toBeTrue();
        expect((await h.get('/health')).body.result.queue).toEqual({ running: 'bot.walkTo', waiting: 1 });
        h.release();
        expect((await walk).body.result.message).toBe('Arrived');
        expect((await attack).body.ok).toBeTrue();
        expect(h.calls.map(c => c.name)).toEqual(['walkTo', 'getSkill', 'attack']);
    });

    test('a disconnected Python client cancels its call and frees the queue', async () => {
        const h = harness();
        const controller = new AbortController();
        const walk = h.call('bot.walkTo', [3222, 3218], controller.signal);
        await Bun.sleep(20);
        controller.abort();
        const { body } = await walk;
        expect(body.code).toBe('cancelled');
        expect(h.calls[0]!.signal?.aborted).toBeTrue();
        const next = await h.call('bot.attack', ['goblin']);
        expect(next.body.ok).toBeTrue();
    });
});

describe('generated Python', () => {
    test('snake_case names', () => {
        expect(snakeCase('walkTo')).toBe('walk_to');
        expect(snakeCase('openGE')).toBe('open_ge');
        expect(snakeCase('getGEAvailability')).toBe('get_ge_availability');
        expect(snakeCase('dismissBlockingUI')).toBe('dismiss_blocking_ui');
        expect(snakeCase('scanFindNearbyLoc')).toBe('scan_find_nearby_loc');
    });

    test('python/rs/_generated.py is up to date (run `bun pybridge/gen-python.ts`)', async () => {
        expect(await readFile(GENERATED_PATH, 'utf8')).toBe(await generatePython());
    });
});

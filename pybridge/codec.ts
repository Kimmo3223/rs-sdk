// JSON <-> SDK value conversion for the Python bridge.
//
// Inbound (Python -> SDK):
//   {"$regex": "^goblin$", "flags": "i"}   -> new RegExp("^goblin$", "i")
//   {"$kind": "loc", ...}                  -> the live entry from fresh state
//   {"kind": "npc" | "player", "index": n} -> the live entry from fresh state
//   top-level null argument                -> undefined, so TS defaults apply
// Outbound (SDK -> Python): JSON-safe copies. Entities found in results and in
// /state get a "$kind" tag so passing them back resolves them again.

import type { BotWorldState } from '../sdk/types';
import { BridgeError } from './errors';

export type EntityKind = 'npc' | 'player' | 'loc' | 'ground' | 'inv' | 'equip' | 'bank' | 'shop';
export const ENTITY_KINDS: readonly EntityKind[] = ['npc', 'player', 'loc', 'ground', 'inv', 'equip', 'bank', 'shop'];

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Obj = Record<string, unknown>;

function isPlainObject(value: unknown): value is Obj {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

function describe(ref: Obj): string {
    const name = typeof ref.name === 'string' ? ` "${ref.name}"` : '';
    const where = typeof ref.x === 'number' ? ` at (${ref.x}, ${ref.z})` : '';
    const slot = typeof ref.slot === 'number' ? ` in slot ${ref.slot}` : '';
    const index = typeof ref.index === 'number' ? ` #${ref.index}` : '';
    return `${name}${index}${where}${slot}`;
}

function stale(kind: EntityKind, ref: Obj, why: string): BridgeError {
    return new BridgeError(`Stale ${kind}${describe(ref)}: ${why}. Look it up again from fresh state.`, 'stale_entity');
}

/** Slot-addressed items: same slot and id, else the first slot holding that id. */
function resolveSlotted<T extends { slot: number; id: number }>(kind: EntityKind, items: readonly T[] | undefined, ref: Obj): T {
    if (typeof ref.id !== 'number') throw stale(kind, ref, 'the reference has no numeric "id"');
    const list = items ?? [];
    const found = list.find(item => item.slot === ref.slot && item.id === ref.id) ?? list.find(item => item.id === ref.id);
    if (!found) throw stale(kind, ref, 'no slot holds that item any more');
    return found;
}

/** Find the live entry a JSON entity reference points at. Throws a stale_entity error when it is gone. */
export function resolveEntity(kind: EntityKind, ref: Obj, state: BotWorldState | null): unknown {
    if (!state) throw new BridgeError('No game state yet, so an entity argument cannot be resolved', 'no_client');
    switch (kind) {
        case 'npc': {
            const npc = state.nearbyNpcs.find(n => n.index === ref.index);
            if (!npc) throw stale(kind, ref, 'that NPC is no longer nearby');
            // World slots are reused after a death or despawn.
            if (typeof ref.id === 'number' && npc.id !== ref.id) throw stale(kind, ref, `slot ${npc.index} now holds a different NPC ("${npc.name}")`);
            return npc;
        }
        case 'player': {
            const player = state.nearbyPlayers.find(p => p.index === ref.index);
            if (!player) throw stale(kind, ref, 'that player is no longer nearby');
            if (typeof ref.name === 'string' && player.name !== ref.name) throw stale(kind, ref, `slot ${player.index} now holds "${player.name}"`);
            return player;
        }
        case 'loc': {
            const loc = state.nearbyLocs.find(l => l.x === ref.x && l.z === ref.z && l.id === ref.id &&
                (typeof ref.level !== 'number' || l.level === ref.level));
            if (!loc) throw stale(kind, ref, 'no such loc is nearby (it may have changed state, or you moved floors)');
            return loc;
        }
        case 'ground': {
            const item = state.groundItems.find(g => g.x === ref.x && g.z === ref.z && g.id === ref.id);
            if (!item) throw stale(kind, ref, 'that ground item is gone');
            return item;
        }
        case 'inv': return resolveSlotted(kind, state.inventory, ref);
        case 'equip': return resolveSlotted(kind, state.equipment, ref);
        case 'bank': return resolveSlotted(kind, state.bank?.items, ref);
        case 'shop': {
            const item = state.shop?.shopItems.find(s => s.id === ref.id);
            if (!item) throw stale(kind, ref, 'the open shop does not stock that item');
            return item;
        }
    }
}

export interface DecodeContext {
    getState(): BotWorldState | null;
}

/** Rebuild SDK argument values from their JSON form. */
export function decodeValue(value: unknown, ctx: DecodeContext): unknown {
    if (Array.isArray(value)) return value.map(item => decodeValue(item, ctx));
    if (!isPlainObject(value)) return value;

    if ('$regex' in value) {
        if (typeof value.$regex !== 'string') throw new BridgeError('"$regex" must be a string', 'bad_argument');
        const flags = value.flags ?? '';
        if (typeof flags !== 'string') throw new BridgeError('"flags" must be a string', 'bad_argument');
        try {
            return new RegExp(value.$regex, flags);
        } catch (error) {
            throw new BridgeError(`Invalid regex /${value.$regex}/${flags}: ${(error as Error).message}`, 'bad_argument');
        }
    }

    const tagged = value.$kind;
    if (tagged !== undefined) {
        if (typeof tagged !== 'string' || !ENTITY_KINDS.includes(tagged as EntityKind)) {
            throw new BridgeError(`Unknown "$kind" ${JSON.stringify(tagged)}; expected one of ${ENTITY_KINDS.join(', ')}`, 'bad_argument');
        }
        return resolveEntity(tagged as EntityKind, value, ctx.getState());
    }
    // NearbyNpc / NearbyPlayer carry their own discriminator.
    if ((value.kind === 'npc' || value.kind === 'player') && typeof value.index === 'number') {
        return resolveEntity(value.kind, value, ctx.getState());
    }

    const out: Obj = {};
    for (const [key, item] of Object.entries(value)) out[key] = decodeValue(item, ctx);
    return out;
}

/** Decode a positional argument list. Top-level nulls become undefined so TS parameter defaults apply. */
export function decodeArgs(args: unknown, ctx: DecodeContext): unknown[] {
    if (args === undefined || args === null) return [];
    if (!Array.isArray(args)) throw new BridgeError('"args" must be an array', 'bad_request');
    const decoded = args.map(arg => (arg === null ? undefined : decodeValue(arg, ctx)));
    while (decoded.length > 0 && decoded[decoded.length - 1] === undefined) decoded.pop();
    return decoded;
}

/**
 * Where entities sit inside a world state. Used to tag /state and results so a
 * Python script can hand an entry straight back as an argument.
 */
const STATE_ENTITY_PATHS: ReadonlyArray<[string[], EntityKind]> = [
    [['nearbyNpcs'], 'npc'],
    [['nearbyPlayers'], 'player'],
    [['nearbyLocs'], 'loc'],
    [['groundItems'], 'ground'],
    [['inventory'], 'inv'],
    [['equipment'], 'equip'],
    [['bank', 'items'], 'bank'],
    [['shop', 'shopItems'], 'shop'],
];

/** JSON-safe copy of any SDK value. Circular references become "[Circular]"; undefined is dropped from objects and null in arrays. */
export function encodeValue(value: unknown, kind?: EntityKind): Json {
    const ancestors: object[] = [];
    const walk = (item: unknown, itemKind: EntityKind | undefined): Json | undefined => {
        switch (typeof item) {
            case 'undefined':
            case 'function':
            case 'symbol':
                return undefined;
            case 'bigint':
                return item.toString();
            case 'number':
                return Number.isFinite(item) ? item : null;
            case 'string':
            case 'boolean':
                return item;
        }
        if (item === null) return null;
        const obj = item as object;
        if (ancestors.includes(obj)) return '[Circular]';
        if (obj instanceof RegExp) return { $regex: obj.source, flags: obj.flags };
        if (obj instanceof Date) return obj.toISOString();
        if (obj instanceof Error) return { name: obj.name, message: obj.message };
        ancestors.push(obj);
        try {
            if (Array.isArray(obj) || obj instanceof Set) {
                return Array.from(obj as Iterable<unknown>, element => walk(element, itemKind) ?? null);
            }
            const entries: Iterable<[unknown, unknown]> = obj instanceof Map ? obj.entries() : Object.entries(obj);
            const out: { [key: string]: Json } = {};
            for (const [key, element] of entries) {
                const encoded = walk(element, undefined);
                if (encoded !== undefined) out[String(key)] = encoded;
            }
            if (itemKind && !('$kind' in out)) out.$kind = itemKind;
            return out;
        } finally {
            ancestors.pop();
        }
    };
    return walk(value, kind) ?? null;
}

/** encodeValue for a world state, tagging every entity list with its $kind. */
export function encodeState(state: BotWorldState): Json {
    const encoded = encodeValue(state) as { [key: string]: Json };
    for (const [path, kind] of STATE_ENTITY_PATHS) {
        let parent: Json | undefined = encoded;
        for (const key of path.slice(0, -1)) parent = (parent as { [key: string]: Json } | null)?.[key];
        const list = (parent as { [key: string]: Json } | null | undefined)?.[path[path.length - 1]!];
        if (!Array.isArray(list)) continue;
        for (const entry of list) {
            if (entry && typeof entry === 'object' && !Array.isArray(entry)) entry.$kind = kind;
        }
    }
    return encoded;
}

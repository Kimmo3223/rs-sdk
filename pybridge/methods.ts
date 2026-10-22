// The callable method table: what Python may invoke as "bot.x" / "sdk.x".

import type { EntityKind } from './codec';

export interface ParamSpec {
    name: string;
    /** Has a default or is marked optional in TS. */
    optional: boolean;
    /** TS type text, for docs and generated Python hints. */
    type: string;
}

export interface MethodSpec {
    /** "bot.attack" */
    id: string;
    target: 'bot' | 'sdk';
    name: string;
    params: ParamSpec[];
    returns: string;
    description: string;
    /** Sent through the per-bot action queue (see bridge.ts). */
    queued: boolean;
    /** Tag entities in the result with this $kind. */
    resultKind?: EntityKind;
}

export const STAGE_TWO_METHODS: MethodSpec[] = [{
    id: 'bot.attack',
    target: 'bot',
    name: 'attack',
    params: [
        { name: 'target', optional: false, type: 'CombatTarget' },
        { name: 'timeout', optional: true, type: 'number' },
    ],
    returns: 'Promise<AttackResult>',
    description: 'Attack an NPC or another player, walking to the target if needed.',
    queued: true,
}];

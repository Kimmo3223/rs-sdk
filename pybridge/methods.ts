// The callable method table: what Python may invoke as "bot.x" / "sdk.x".
//
// Built from buildApiModel() in sdk/generate-api-docs.ts - the same model
// that generates sdk/API.md - so a method appears here exactly when it is
// documented there. New SDK methods show up without touching the bridge.

import ts from 'typescript';
import { buildApiModel } from '../sdk/generate-api-docs';
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
    /** TS return type text, e.g. "Promise<AttackResult>". */
    returns: string;
    /** Full TS signature as printed in sdk/API.md. */
    signature: string;
    description: string;
    /** Sent through the per-bot action queue (see bridge.ts). */
    queued: boolean;
    /** Tag entities in the result with this $kind ("state" = a whole world state). */
    resultKind?: EntityKind | 'state';
}

export interface ExcludedMethod {
    id: string;
    reason: string;
}

export interface MethodTable {
    methods: MethodSpec[];
    excluded: ExcludedMethod[];
}

/** Never callable from Python: they would tear down or re-plumb the bridge's own connection. */
const EXCLUDED: Record<string, string> = {
    connect: 'the bridge owns the gateway connection',
    disconnect: 'would shut down the bridge connection',
    launchBrowser: 'the bridge never starts a game client',
};

/**
 * Pure reads and waits run concurrently with the action queue, as do chat
 * (the gateway lets an observer chat alongside a controller) and queries that
 * move nothing.
 */
const UNQUEUED_PREFIX = /^(get|is|find|check|waitFor)/;
const UNQUEUED_NAMES = new Set(['say', 'dm', 'sendSay', 'sendPrivateMessage', 'sendScreenshot', 'sendFindPath']);

function containsFunctionType(node: ts.Node): boolean {
    if (ts.isFunctionTypeNode(node) || ts.isConstructorTypeNode(node)) return true;
    return ts.forEachChild(node, child => containsFunctionType(child) || undefined) ?? false;
}

function parseSignature(signature: string): ts.MethodDeclaration {
    const file = ts.createSourceFile('signature.ts', `class X { ${signature} {} }`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const cls = file.statements[0];
    const method = cls && ts.isClassDeclaration(cls) ? cls.members.find(ts.isMethodDeclaration) : undefined;
    if (!method) throw new Error(`Could not parse SDK signature: ${signature}`);
    return method;
}

function unwrapPromise(type: string): string {
    const match = /^Promise<(.*)>$/s.exec(type.trim());
    return match ? match[1]!.trim() : type.trim();
}

function resultKindFor(name: string, returns: string): MethodSpec['resultKind'] {
    const inner = unwrapPromise(returns).replace(/\s*\|\s*null$/, '').replace(/\[\]$/, '').trim();
    switch (inner) {
        case 'BotWorldState': return 'state';
        case 'NearbyNpc': return 'npc';
        case 'NearbyPlayer': return 'player';
        case 'NearbyLoc': return 'loc';
        case 'GroundItem': return 'ground';
        case 'InventoryItem': return /equip/i.test(name) ? 'equip' : 'inv';
        case 'BankItem': return 'bank';
        case 'ShopItem': return 'shop';
        default: return undefined;
    }
}

export function specFromSignature(target: 'bot' | 'sdk', signature: string, description: string): MethodSpec | ExcludedMethod {
    const node = parseSignature(signature);
    const name = node.name.getText();
    const id = `${target}.${name}`;
    if (EXCLUDED[name]) return { id, reason: EXCLUDED[name]! };
    const fnParam = node.parameters.find(param => param.type && containsFunctionType(param.type));
    if (fnParam) return { id, reason: `parameter "${fnParam.name.getText()}" is a function, which JSON cannot carry` };

    const returns = node.type ? node.type.getText() : 'unknown';
    const isAsync = Boolean(node.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword)) || /^Promise</.test(returns);
    return {
        id,
        target,
        name,
        params: node.parameters.map(param => ({
            name: param.name.getText(),
            optional: Boolean(param.questionToken || param.initializer),
            type: param.type ? param.type.getText().replace(/\s+/g, ' ') : 'unknown',
        })),
        returns,
        signature,
        description,
        queued: isAsync && !UNQUEUED_PREFIX.test(name) && !UNQUEUED_NAMES.has(name),
        resultKind: resultKindFor(name, returns),
    };
}

export async function buildMethodTable(): Promise<MethodTable> {
    const model = await buildApiModel();
    const table: MethodTable = { methods: [], excluded: [] };
    const surfaces: Array<['bot' | 'sdk', typeof model.sdkMethods]> = [['bot', model.botActionsMethods], ['sdk', model.sdkMethods]];
    for (const [target, docs] of surfaces) {
        const seen = new Set<string>();
        for (const doc of docs) {
            // Overloads document one name several times; dispatch is by name.
            if (seen.has(doc.name)) continue;
            seen.add(doc.name);
            const spec = specFromSignature(target, doc.signature, doc.description);
            if ('target' in spec) table.methods.push(spec);
            else table.excluded.push(spec);
        }
    }
    return table;
}

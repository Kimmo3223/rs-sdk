#!/usr/bin/env bun
/**
 * Generate python/rs/_generated.py from the bridge's method table, so the
 * Python wrappers and the bridge whitelist come from one source.
 *
 * Usage:
 *   bun pybridge/gen-python.ts          # write
 *   bun pybridge/gen-python.ts --check  # fail if stale
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildMethodTable, type MethodSpec } from './methods';

export const GENERATED_PATH = join(import.meta.dir, '..', 'python', 'rs', '_generated.py');

const PY_KEYWORDS = new Set([
    'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del',
    'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal',
    'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield', 'match', 'case', 'type',
]);

/** walkTo -> walk_to, openGE -> open_ge, dismissBlockingUI -> dismiss_blocking_ui */
export function snakeCase(name: string): string {
    const snake = name
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .toLowerCase();
    return PY_KEYWORDS.has(snake) ? `${snake}_` : snake;
}

function splitUnion(type: string): string[] | null {
    // Only flat unions are mapped; anything structural becomes Any.
    if (/[{}()<>[\]]/.test(type.replace(/\[\]$/, ''))) return null;
    return type.split('|').map(part => part.trim()).filter(Boolean);
}

function pyMember(member: string, position: 'param' | 'return'): string | null {
    if (member === 'number') return 'float';
    if (member === 'string' || /^'[^']*'$/.test(member)) return 'str';
    if (member === 'boolean') return 'bool';
    if (member === 'null' || member === 'undefined' || member === 'void') return 'None';
    if (member === 'RegExp') return 're.Pattern[str]';
    if (position === 'return' && /^[A-Z]\w*$/.test(member)) return /Result$/.test(member) ? 'Result' : 'RSObject';
    return null;
}

function pyType(type: string, position: 'param' | 'return'): string {
    let text = type.trim();
    if (position === 'return') text = text.replace(/^Promise<(.*)>$/s, '$1').trim();
    if (position === 'return' && /^[A-Z]\w*\[\]$/.test(text)) {
        return `list[${pyType(text.slice(0, -2), position)}]`;
    }
    const members = splitUnion(text);
    if (!members) return 'Any';
    const mapped: string[] = [];
    for (const member of members) {
        const py = pyMember(member, position);
        if (!py) return 'Any';
        if (!mapped.includes(py)) mapped.push(py);
    }
    if (mapped.includes('str') && mapped.includes('re.Pattern[str]')) {
        mapped.splice(mapped.indexOf('re.Pattern[str]'), 1);
        mapped[mapped.indexOf('str')] = 'Pattern';
    }
    return mapped.join(' | ');
}

function docstring(spec: MethodSpec, indent: string): string {
    const body = [`\`\`${spec.signature}\`\`` + ` (${spec.id})`];
    if (spec.description) body.push('', spec.description);
    const text = body.join('\n').replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"');
    return `${indent}"""${text.split('\n').join(`\n${indent}`)}\n${indent}"""`;
}

function methodSource(spec: MethodSpec, mode: 'async' | 'sync'): string {
    const indent = '    ';
    const params = spec.params.map(param => {
        const name = snakeCase(param.name);
        const hint = pyType(param.type, 'param');
        return param.optional ? `${name}: ${hint === 'Any' ? 'Any' : `${hint} | None`} = None` : `${name}: ${hint}`;
    });
    const args = spec.params.map(param => snakeCase(param.name));
    const returns = pyType(spec.returns, 'return');
    const def = mode === 'async' ? 'async def' : 'def';
    const call = mode === 'async' ? 'await self._call' : 'self._call';
    return [
        `${indent}${def} ${snakeCase(spec.name)}(${['self', ...params].join(', ')}) -> ${returns}:`,
        docstring(spec, indent + indent),
        `${indent}${indent}return ${call}(${[JSON.stringify(spec.id), ...args].join(', ')})${returns === 'Any' ? '' : '  # type: ignore[no-any-return]'}`,
    ].join('\n');
}

function classSource(name: string, doc: string, specs: MethodSpec[], mode: 'async' | 'sync'): string {
    const callStub = mode === 'async'
        ? '    async def _call(self, method: str, *args: Any) -> Any:\n        raise NotImplementedError'
        : '    def _call(self, method: str, *args: Any) -> Any:\n        raise NotImplementedError';
    return [`class ${name}:`, `    """${doc}"""`, '', callStub, '', specs.map(spec => methodSource(spec, mode)).join('\n\n')].join('\n');
}

export function renderPython(methods: readonly MethodSpec[]): string {
    const bot = methods.filter(spec => spec.target === 'bot');
    const sdk = methods.filter(spec => spec.target === 'sdk');
    for (const group of [bot, sdk]) {
        const seen = new Map<string, string>();
        for (const spec of group) {
            const snake = snakeCase(spec.name);
            const clash = seen.get(snake);
            if (clash) throw new Error(`${spec.id} and ${clash} both map to Python name "${snake}"`);
            seen.set(snake, spec.id);
        }
    }
    const names = methods.map(spec => `    ${JSON.stringify(spec.id)}: ${JSON.stringify(snakeCase(spec.name))},`);
    return [
        '# Generated by `bun pybridge/gen-python.ts` from the bridge method table',
        '# (the same model as sdk/API.md). Do not edit by hand.',
        '# fmt: off',
        'from __future__ import annotations',
        '',
        'import re',
        'from typing import Any',
        '',
        'from ._codec import Pattern, Result, RSObject',
        '',
        '__all__ = ["METHODS", "AsyncBotMethods", "AsyncSdkMethods", "SyncBotMethods", "SyncSdkMethods"]',
        '',
        '_ = (re, Pattern, Result, RSObject)',
        '',
        '#: Bridge method id -> Python method name.',
        'METHODS: dict[str, str] = {',
        ...names,
        '}',
        '',
        '',
        classSource('AsyncBotMethods', 'High-level ``bot.*`` (BotActions) methods.', bot, 'async'),
        '',
        '',
        classSource('AsyncSdkMethods', 'Low-level ``sdk.*`` (BotSDK) methods.', sdk, 'async'),
        '',
        '',
        classSource('SyncBotMethods', 'Blocking twins of AsyncBotMethods.', bot, 'sync'),
        '',
        '',
        classSource('SyncSdkMethods', 'Blocking twins of AsyncSdkMethods.', sdk, 'sync'),
        '',
    ].join('\n');
}

export async function generatePython(): Promise<string> {
    return renderPython((await buildMethodTable()).methods);
}

async function main(): Promise<void> {
    const source = await generatePython();
    if (process.argv.includes('--check')) {
        const current = await readFile(GENERATED_PATH, 'utf8').catch(() => '');
        if (current !== source) throw new Error('python/rs/_generated.py is stale. Run `bun pybridge/gen-python.ts`.');
        console.log(`Verified ${GENERATED_PATH}`);
    } else {
        await writeFile(GENERATED_PATH, source);
        console.log(`Generated ${GENERATED_PATH}`);
    }
}

if (import.meta.main) {
    main().catch(error => {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
    });
}

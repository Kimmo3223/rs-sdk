// Bot credential loading for the Python bridge.
//
// Same rules as sdk/runner.ts: every KEY=VALUE line of bots/<name>/bot.env is
// copied into process.env (so a GATEWAY_URL there reaches deriveGatewayUrl),
// and a blank SERVER means the local gateway at ws://localhost:7780.

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { deriveGatewayUrl } from '../sdk/index';

export interface BotEnv {
    username: string;
    password: string;
    server: string | undefined;
    gatewayUrl: string;
    showChat: boolean;
}

export function parseEnvFile(content: string): Record<string, string> {
    const env: Record<string, string> = {};
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIndex = trimmed.indexOf('=');
        if (eqIndex > 0) {
            env[trimmed.slice(0, eqIndex).trim()] = trimmed.slice(eqIndex + 1).trim();
        }
    }
    return env;
}

export function loadBotEnv(botName: string, repoRoot: string): BotEnv {
    const envPath = join(repoRoot, 'bots', botName, 'bot.env');
    if (!existsSync(envPath)) {
        throw new Error(`Bot "${botName}" not found at ${envPath}. Create it first with: bun bots/create-bot.ts ${botName}`);
    }
    const env = parseEnvFile(readFileSync(envPath, 'utf-8'));
    for (const [key, value] of Object.entries(env)) process.env[key] = value;

    const username = env.BOT_USERNAME;
    const password = env.PASSWORD;
    if (!username) throw new Error(`BOT_USERNAME not set in ${envPath}`);
    if (!password) throw new Error(`PASSWORD not set in ${envPath}`);
    return {
        username,
        password,
        server: env.SERVER || undefined,
        gatewayUrl: deriveGatewayUrl(env.SERVER),
        showChat: env.SHOW_CHAT?.toLowerCase() !== 'false',
    };
}

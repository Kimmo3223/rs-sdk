#!/usr/bin/env bun
// Login wall in front of the game server, for hosting through a tunnel.
//
//   bun server/gate/gate.ts [--port 8890] [--upstream http://127.0.0.1:8888]
//
// Nothing on the website opens without signing in with a game account
// (username + password from the engine's account database). Two kinds of
// traffic pass without the cookie because they authenticate themselves or
// carry no private data:
//   - WebSockets for the game itself and /gateway (the game login and the
//     gateway check the account password; /worldfeed still needs the cookie)
//   - game cache files (/crc, /config..., /api/version) that the headless
//     lite client downloads before it logs in
// POST /gate/clone also needs no cookie: a bot's clone("name") call sends its
// own name and password, which are checked like a sign-in.
// The browser client link play.ts opens (/bot?bot=<name>#password=<password>)
// signs in by itself: the sign-in page picks the password out of the #fragment,
// which browsers never send to a server, and posts it like a normal sign-in.

import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { ServerWebSocket } from 'bun';
import { checkLogin, toSafeName } from './accounts';
import { CloneError, createCloneFor } from './clones';

const COOKIE = 'rs_gate';
const SESSION_DAYS = 30;
const SECRET_PATH = join(import.meta.dir, '.secret');

const CACHE_PREFIXES = ['/crc', '/title', '/config', '/interface', '/media', '/versionlist', '/textures', '/wordenc', '/sounds', '/build', '/ondemand.zip', '/worldmap.jag'];
const OPEN_PATHS = new Set(['/api/version', '/favicon.ico']);

export interface GateOptions {
    upstream: string;
    secret: Buffer;
    checkLogin: (username: string, password: string) => Promise<boolean>;
    /** Make a clone for a signed-in main (see createCloneFor). Without it /gate/clone answers 404. */
    createClone?: (main: string, password: string, clone: string) => Promise<{ name: string; created: boolean }>;
    /** Called for every visit, sign-in and connection (never with a password). */
    accessLog?: (entry: AccessEntry) => void;
    /** Failed sign-ins allowed per client in `failWindowMs` (default 10 per 10 minutes). */
    maxFailures?: number;
    failWindowMs?: number;
}

export type AccessEvent = 'visit' | 'signin' | 'signin_failed' | 'locked_out' | 'connect' | 'clone';

export interface AccessEntry {
    time: string;
    event: AccessEvent;
    ip: string;
    country: string | null;
    /** The signed-in user, or for signin_failed the name that was tried. */
    user: string | null;
    path: string;
    agent: string | null;
}

/** Append entries as JSON lines (one per line) to `path`. */
export function fileAccessLog(path: string): (entry: AccessEntry) => void {
    mkdirSync(join(path, '..'), { recursive: true });
    return entry => {
        appendFileSync(path, `${JSON.stringify(entry)}\n`);
        console.log(`[gate] ${entry.time} ${entry.event} ${entry.user ?? '-'} ${entry.ip}${entry.country ? ` (${entry.country})` : ''} ${entry.path}`);
    };
}

function loadSecret(): Buffer {
    if (existsSync(SECRET_PATH)) return Buffer.from(readFileSync(SECRET_PATH, 'utf8').trim(), 'hex');
    const secret = randomBytes(32);
    writeFileSync(SECRET_PATH, secret.toString('hex'), { mode: 0o600 });
    return secret;
}

export function isOpenPath(pathname: string): boolean {
    return OPEN_PATHS.has(pathname) || CACHE_PREFIXES.some(prefix => pathname.startsWith(prefix));
}

function sign(secret: Buffer, payload: string): string {
    return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function makeSession(secret: Buffer, username: string, now = Date.now()): string {
    const payload = Buffer.from(`${toSafeName(username)}|${now + SESSION_DAYS * 86_400_000}`).toString('base64url');
    return `${payload}.${sign(secret, payload)}`;
}

/** The signed-in username, or null. */
export function readSession(secret: Buffer, cookieHeader: string | null, now = Date.now()): string | null {
    const value = cookieHeader?.split(/;\s*/).find(part => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    if (!value) return null;
    const [payload, signature] = value.split('.');
    if (!payload || !signature) return null;
    const expected = Buffer.from(sign(secret, payload));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    const [username, expires] = Buffer.from(payload, 'base64url').toString().split('|');
    if (!username || !(Number(expires) > now)) return null;
    return username;
}

function cookieHeader(value: string, maxAgeSeconds: number): string {
    return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

function safeNext(next: string | null): string {
    return next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/gate/') ? next : '/';
}

/** next without its #fragment, which may carry a password and must not be echoed into a page. */
function withoutFragment(next: string): string {
    const hash = next.indexOf('#');
    return hash < 0 ? next : next.slice(0, hash);
}

function loginPage(next: string, error?: string, status = 200): Response {
    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in</title>
<style>
  :root { color-scheme: light dark; --bg: #f4f1ea; --card: #fff; --ink: #222; --muted: #666; --accent: #7a5c2e; --err: #b00020; }
  @media (prefers-color-scheme: dark) { :root { --bg: #1b1a17; --card: #26241f; --ink: #eee; --muted: #aaa; --accent: #d9b66f; --err: #ff6b7a; } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--ink); font: 16px/1.4 system-ui, sans-serif; }
  form { background: var(--card); padding: 28px; border-radius: 12px; width: min(320px, calc(100vw - 32px)); box-shadow: 0 4px 24px #0002; }
  h1 { margin: 0 0 4px; font-size: 22px; } p { margin: 0 0 18px; color: var(--muted); font-size: 14px; }
  label { display: block; font-size: 14px; margin: 12px 0 4px; }
  input { width: 100%; box-sizing: border-box; padding: 10px; border: 1px solid #8886; border-radius: 8px; background: transparent; color: inherit; font: inherit; }
  button { margin-top: 18px; width: 100%; padding: 10px; border: 0; border-radius: 8px; background: var(--accent); color: var(--card); font: inherit; font-weight: 600; cursor: pointer; }
  .err { color: var(--err); font-size: 14px; margin-top: 12px; }
</style></head><body>
<form method="post" action="/gate/login">
  <h1>Sign in</h1><p>Use your game account (the name and password from your bot.env).</p>
  <input type="hidden" name="next" value="${escapeHtml(next)}">
  <label for="u">Username</label><input id="u" name="username" autocomplete="username" required maxlength="12" autofocus>
  <label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password" required maxlength="20">
  <button type="submit">Sign in</button>
  ${error ? `<div class="err">${escapeHtml(error)}</div>` : ''}
</form>
<script>
  // The browser client link carries the bot password in the #fragment (never sent to the
  // server). Sign in with it once, keeping it in the fragment of the page we return to.
  (function () {
    var hash = new URLSearchParams(location.hash.slice(1));
    var password = hash.get('password');
    if (!password || ${error ? 'true' : 'false'}) return;
    var form = document.forms[0];
    var bot = new URL(form.next.value, location.origin).searchParams.get('bot');
    history.replaceState(null, '', location.pathname + location.search);
    if (!bot) return;
    form.username.value = bot;
    form.password.value = password;
    // The whole fragment: it can also carry the local bridge port (bridge=...).
    form.next.value = form.next.value + '#' + hash.toString();
    form.submit();
  })();
</script></body></html>`;
    return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

interface SocketData {
    path: string;
    protocol: string | null;
    upstream?: WebSocket;
    pending: Array<string | ArrayBuffer | Uint8Array>;
}

export function createGate(options: GateOptions) {
    const upstream = options.upstream.replace(/\/$/, '');
    const upstreamWs = upstream.replace(/^http/, 'ws');
    const maxFailures = options.maxFailures ?? 10;
    const failWindowMs = options.failWindowMs ?? 10 * 60_000;
    const failures = new Map<string, number[]>();

    function clientIp(req: Request, server: Bun.Server): string {
        // Behind cloudflared every request comes from loopback; Cloudflare names the real client.
        return req.headers.get('cf-connecting-ip') ?? server.requestIP(req)?.address ?? 'unknown';
    }

    function log(event: AccessEvent, req: Request, ip: string, user: string | null, url: URL): void {
        if (!options.accessLog) return;
        options.accessLog({
            time: new Date().toISOString(),
            event,
            ip,
            country: req.headers.get('cf-ipcountry'),
            // Names come from the client: keep them short and printable.
            user: user ? user.replace(/[^\w ]/g, '?').slice(0, 20) : null,
            path: url.pathname.slice(0, 100),
            agent: req.headers.get('user-agent')?.slice(0, 160) ?? null,
        });
    }

    function tooManyFailures(ip: string): boolean {
        const now = Date.now();
        const recent = (failures.get(ip) ?? []).filter(t => now - t < failWindowMs);
        failures.set(ip, recent);
        return recent.length >= maxFailures;
    }

    function recordFailure(ip: string): void {
        const list = failures.get(ip) ?? [];
        list.push(Date.now());
        failures.set(ip, list);
    }

    async function proxy(req: Request, url: URL, extraHeaders: Record<string, string> = {}): Promise<Response> {
        const headers = new Headers(req.headers);
        headers.delete('host');
        const res = await fetch(`${upstream}${url.pathname}${url.search}`, {
            method: req.method,
            headers,
            body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer(),
            redirect: 'manual',
        });
        // fetch already decoded the body, so the upstream encoding/length no longer apply.
        const out = new Headers(res.headers);
        out.delete('content-encoding');
        out.delete('content-length');
        for (const [key, value] of Object.entries(extraHeaders)) out.append(key, value);
        return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
    }

    async function handleLogin(req: Request, url: URL, ip: string): Promise<Response> {
        const form = await req.formData().catch(() => null);
        const next = safeNext(form?.get('next')?.toString() ?? null);
        const username = form?.get('username')?.toString() ?? '';
        if (tooManyFailures(ip)) {
            log('locked_out', req, ip, username, url);
            return loginPage(withoutFragment(next), 'Too many failed attempts. Try again in a few minutes.', 429);
        }
        const password = form?.get('password')?.toString() ?? '';
        if (!(await options.checkLogin(username, password))) {
            recordFailure(ip);
            log('signin_failed', req, ip, username, url);
            return loginPage(withoutFragment(next), 'Wrong username or password.', 401);
        }
        log('signin', req, ip, toSafeName(username), url);
        return new Response(null, {
            status: 303,
            headers: { location: next, 'set-cookie': cookieHeader(makeSession(options.secret, username), SESSION_DAYS * 86_400) },
        });
    }

    async function handleClone(req: Request, url: URL, ip: string): Promise<Response> {
        if (!options.createClone) return Response.json({ ok: false, error: 'This server does not make clones' }, { status: 404 });
        const body = await req.json().catch(() => null) as { username?: unknown; password?: unknown; clone?: unknown } | null;
        const username = typeof body?.username === 'string' ? body.username : '';
        const password = typeof body?.password === 'string' ? body.password : '';
        const clone = typeof body?.clone === 'string' ? body.clone : '';
        if (tooManyFailures(ip)) {
            log('locked_out', req, ip, username, url);
            return Response.json({ ok: false, error: 'Too many failed attempts. Try again in a few minutes.' }, { status: 429 });
        }
        if (!(await options.checkLogin(username, password))) {
            recordFailure(ip);
            log('signin_failed', req, ip, username, url);
            return Response.json({ ok: false, error: 'Wrong username or password' }, { status: 401 });
        }
        try {
            const result = await options.createClone(username, password, clone);
            if (result.created) log('clone', req, ip, toSafeName(username), new URL(`/gate/clone/${result.name}`, url));
            return Response.json({ ok: true, result });
        } catch (error) {
            if (!(error instanceof CloneError)) throw error;
            return Response.json({ ok: false, error: error.message }, { status: 409 });
        }
    }

    return {
        async fetch(req: Request, server: Bun.Server): Promise<Response | undefined> {
            const url = new URL(req.url);
            const ip = clientIp(req, server);
            const user = readSession(options.secret, req.headers.get('cookie'));

            if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
                if (url.pathname.startsWith('/worldfeed') && !user) return new Response('Sign in first', { status: 401 });
                log('connect', req, ip, user, url);
                const protocol = req.headers.get('sec-websocket-protocol')?.split(',')[0]?.trim() || null;
                const ok = server.upgrade(req, {
                    data: { path: `${url.pathname}${url.search}`, protocol, pending: [] },
                    headers: protocol ? { 'Sec-WebSocket-Protocol': protocol } : undefined,
                });
                return ok ? undefined : new Response('WebSocket upgrade failed', { status: 400 });
            }

            if (url.pathname === '/gate/login') {
                if (req.method === 'POST') return handleLogin(req, url, ip);
                return user ? Response.redirect(safeNext(url.searchParams.get('next')), 303) : loginPage(safeNext(url.searchParams.get('next')));
            }
            if (url.pathname === '/gate/clone' && req.method === 'POST') return handleClone(req, url, ip);
            if (url.pathname === '/gate/logout') {
                return new Response(null, { status: 303, headers: { location: '/gate/login', 'set-cookie': cookieHeader('', 0) } });
            }

            const wantsHtml = req.method === 'GET' && (req.headers.get('accept') ?? '').includes('text/html');
            if (wantsHtml) log('visit', req, ip, user, url);
            if (user || isOpenPath(url.pathname)) return proxy(req, url);

            if (wantsHtml) {
                // Never carry an old-style ?password= into the sign-in page's address.
                const next = new URL(url);
                next.searchParams.delete('password');
                return Response.redirect(`/gate/login?next=${encodeURIComponent(next.pathname + next.search)}`, 303);
            }
            return Response.json({ ok: false, error: 'Sign in first' }, { status: 401 });
        },
        websocket: {
            open(ws: ServerWebSocket<SocketData>) {
                const up = new WebSocket(`${upstreamWs}${ws.data.path}`, ws.data.protocol ? [ws.data.protocol] : undefined);
                up.binaryType = 'arraybuffer';
                ws.data.upstream = up;
                up.onopen = () => {
                    for (const message of ws.data.pending) up.send(message);
                    ws.data.pending = [];
                };
                up.onmessage = event => ws.send(event.data as string | ArrayBuffer);
                up.onclose = event => ws.close(event.code === 1005 || event.code === 1006 ? 1000 : event.code, event.reason);
                up.onerror = () => ws.close(1011, 'Upstream error');
            },
            message(ws: ServerWebSocket<SocketData>, message: string | Buffer) {
                const up = ws.data.upstream;
                const data = typeof message === 'string' ? message : new Uint8Array(message);
                if (up?.readyState === WebSocket.OPEN) up.send(data);
                else ws.data.pending.push(data);
            },
            close(ws: ServerWebSocket<SocketData>) {
                ws.data.upstream?.close();
            },
        },
    };
}

if (import.meta.main) {
    const args = process.argv.slice(2);
    const arg = (name: string, fallback: string) => {
        const i = args.indexOf(name);
        return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
    };
    const port = Number(arg('--port', '8890'));
    const logPath = arg('--log', join(import.meta.dir, '..', '..', '.play-logs', 'access.log'));
    const gate = createGate({ upstream: arg('--upstream', 'http://127.0.0.1:8888'), secret: loadSecret(), checkLogin,
        createClone: (main, password, clone) => createCloneFor(main, password, clone, { accounts: true }),
        accessLog: fileAccessLog(logPath) });
    Bun.serve({ hostname: '127.0.0.1', port, idleTimeout: 0, fetch: gate.fetch, websocket: gate.websocket });
    console.log(`[gate] Sign-in required on http://127.0.0.1:${port}`);
}

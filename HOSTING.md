# Hosting for friends

Run the game on your computer and let friends play with their Python bots
through a Cloudflare tunnel:

```
friend's bot ─https─▶ Cloudflare ──tunnel──▶ sign-in gate ──▶ game server ──▶ gateway
                                             (your computer, nothing else reachable)
```

```sh
bun host.ts                 # start hosting; prints the address for friends
bun host.ts add alice       # give a friend an account; prints their bot.env
```

## What keeps it safe

- **Sign in required for everything.** The website shows a sign-in page
  first. Only game accounts work, and passwords are checked.
- **Only people you add can play.** New names are refused. You create every
  account with `bun host.ts add`.
- **Nothing is open on your network.** The game server, gateway and login
  server listen on `127.0.0.1` only, and you don't open ports on your router.
  The tunnel is the only way in, and it leads to the sign-in gate.
- **Encrypted.** Friends connect over https, and your home IP stays hidden
  behind Cloudflare.
- **Guessing is slowed down.** After 10 wrong passwords in 10 minutes, a
  client has to wait.
- **Strong passwords.** Accounts need 8 to 20 characters.
  `bun host.ts add` makes random 12-character ones.

The game server is a hobby project that hasn't had a security audit, and
anyone with the address can reach the sign-in page. Treat it like any small
self-hosted service: don't host from a computer with things on it you can't
afford to lose, and keep the address among friends.

## 1. Install cloudflared (once)

- NixOS: add `pkgs.cloudflared` to `environment.systemPackages`.
- Others: <https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/>

### If the tunnel says "no such host"

Some internet providers' DNS servers block `trycloudflare.com`, the domain
used by the free tunnel. Check:

```sh
nslookup api.trycloudflare.com
```

If there's no address, either:

- switch your computer to Cloudflare's DNS. NixOS:
  `networking.nameservers = [ "1.1.1.1" "1.0.0.1" ];`. Friends on the same
  provider need the same change to open the address. Or
- use a **fixed address** on your own domain (below). It isn't on the blocked
  domain, and friends need no changes.

## 2. Start hosting

Stop `play.ts` if it's running, then:

```sh
bun host.ts
```

It sets up the account database, creates accounts for your own bots (using the
passwords in their `bot.env`), and starts the game server, the gateway, the
sign-in gate and the tunnel. Then it prints:

```
Hosting! Friends sign in at:

  https://some-random-words.trycloudflare.com

Their bot.env needs:  SERVER=some-random-words.trycloudflare.com
```

Leave it running; Ctrl+C stops everything. The free tunnel gets a **new
address every time** you start it.

### Your own bots

In another terminal, as always:

```sh
bun play.ts mybot
```

New bots get an account automatically. A bot whose password is shorter than 8
characters is skipped: change `PASSWORD` in its `bot.env`.

## 3. Add a friend

```sh
bun host.ts add alice
```

It prints a `bot.env` to send them (by private message, not in a public
channel: it contains their password). Your friend:

1. installs Git, Bun and Python and gets the game (steps 1–2 of
   [PYTHON.md](PYTHON.md)),
2. saves the file as `bots/alice/bot.env`,
3. runs `bun play.ts alice`.

`play.ts` sees that the server is somewhere else and doesn't start one. It
opens the game in their browser, which signs them in with the same account,
and they write bots exactly as in PYTHON.md.

When you restart hosting, the address changes: send friends the new `SERVER=`
line.

### Managing accounts

```sh
bun host.ts list              # all accounts
bun host.ts reset alice       # new password (prints a new bot.env)
bun host.ts remove alice      # delete the account; their character's save file stays
```

## A fixed address (optional)

The free tunnel's address changes on every start and its domain is blocked by
some providers. With a free Cloudflare account and a domain of your own (about
10 € a year), you get a permanent address such as `game.example.com`:

1. Add your domain to Cloudflare (<https://dash.cloudflare.com>).
2. Log in once and create the tunnel:
   ```sh
   cloudflared tunnel login
   cloudflared tunnel create rsgame
   cloudflared tunnel route dns rsgame game.example.com
   ```
3. Host with it:
   ```sh
   bun host.ts --tunnel rsgame --hostname game.example.com
   ```

Friends then use `SERVER=game.example.com`, and it never changes.

## Going back to playing alone

Stop `host.ts` and use `bun play.ts mybot` as before. Without `host.ts` the
server runs as it did before, **without** accounts or password checks, so
only do that while nobody else can reach it.

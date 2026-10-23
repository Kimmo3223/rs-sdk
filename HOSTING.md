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

## 3. Put your version on GitHub (once)

Friends' installer downloads the game from GitHub, and it needs **your**
version (with the Python bridge, `play.ts` and hosting), not the original.
You need a GitHub account. The installer downloads without logging in, so the
repository must be **public**. Bot passwords, `bot.env` files, saves and the
account database are never committed (`.gitignore` covers them).

```sh
nix shell nixpkgs#gh                     # or install GitHub's gh tool another way
gh auth login                            # log in with your browser
gh repo fork --remote --remote-name fork   # run inside your copy of the game
git push -u fork python-bridge
```

After pushing changes later, run `git push` again; friends get them by
running their install command again.

## 4. Add a friend

```sh
bun host.ts add alice
```

It prints a **one-line install command** with alice's invite code (name,
password and your server address). Send it to her privately, because it
contains her password. She pastes it into a terminal:

- **Linux / macOS:** `curl -fsSL …/install.sh | … bash -s -- <code>`
- **Windows:** the PowerShell line it prints (`… irm …/install.ps1 | iex`)

The installer:
- installs Git, Python and Bun if they're missing (it may ask for her
  password once to install system packages);
- downloads the game into `~/rs-sdk`;
- installs everything and saves her `bot.env`.

Then she runs:

```sh
cd ~/rs-sdk
bun play.ts alice
```

It sees that the server is yours and doesn't start one. It opens the game in
her browser, signed in, and she writes bots exactly as in
[PYTHON.md](PYTHON.md).

When you restart hosting, the free tunnel's address changes. Friends then
run `bun join.ts --server <new address>` (`bun host.ts` prints the address).
Someone who already has the game can join with `bun join.ts <code>`.

On NixOS the installer can't install system packages. Friends on NixOS run
it inside `nix-shell -p git python3 curl unzip bun`.

### Managing accounts

```sh
bun host.ts list              # all accounts
bun host.ts reset alice       # new password (prints a new bot.env)
bun host.ts remove alice      # delete the account; their character's save file stays
```

### Who visited or tried to sign in

```sh
bun host.ts log            # recent visits, sign-ins, failed attempts and connections
bun host.ts log --follow   # keep watching live
```

Every website visit, sign-in, failed sign-in (with the name that was tried),
lockout and game or bot connection is listed with the visitor's IP address and
country (from Cloudflare). Refused game and bot logins come from the game
server's log. Passwords are never logged. The raw data is in
`.play-logs/access.log`, one JSON entry per line.

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

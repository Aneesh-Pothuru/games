# Parlour

Phone-first multiplayer party games. Everyone's in the same room, each holding
their own phone; the phone is the private channel and the talking is the game.
No app, no signup — one person starts a room, everyone else types four letters.

## The games

| Game | Players | Length | Based on |
|---|---|---|---|
| **Odd One Out** | 3–12 | 8–10 min/round | Spyfall |
| **The Council** | 5–10 | 25–45 min | Secret Hitler |
| **Sabotage** | 5–10 | 20–30 min | The Resistance: Avalon |
| **Spectrum** | 2–16 | 15–20 min | Wavelength |

Each is implemented from the **official rulebook**, not from an aggregator
summary. `test/rules.test.js` covers the specific rules that implementations
habitually get wrong — see [Rules fidelity](#rules-fidelity).

## Running it

```sh
npm install
npm run dev          # http://localhost:8787
npm test             # 60 rules-engine unit tests, no deps
```

End-to-end, against a running `npm run dev`:

```sh
npm run test:protocol   # HTTP + WebSocket + Durable Object, incl. leak checks
npm run test:browser    # six real phone-sized browsers playing a game
```

`test:browser` needs `playwright` installed and a Chromium at
`$CHROMIUM_PATH` (default `/opt/pw-browsers/chromium`).

## Deploying

```sh
npx wrangler login
npm run deploy
```

That's it — no build step. Wrangler bundles the hand-written ES modules with
its internal esbuild, and `public/` is served as static assets.

**This is a Worker, not a Pages project.** Cloudflare Pages
[cannot define a Durable Object](https://developers.cloudflare.com/pages/functions/bindings/)
— you would need a second Worker project and a cross-project binding wired
separately for production and preview. Workers with static assets is
Cloudflare's [recommended path](https://blog.cloudflare.com/full-stack-development-on-cloudflare-workers/),
serves static assets free and unlimited exactly like Pages, and supports
Durable Objects natively. If you have an existing Pages project on this repo,
delete it (`npx wrangler pages project delete <name>`) so the two don't fight
over the same domain.

Custom domains on Workers require Cloudflare-managed nameservers, which Pages
did not.

## Architecture

```
Browser ──WebSocket──> Worker ──> Lobby Durable Object (one per room code)
             │                       │
             └── static assets ──────┘   (free, unlimited)
```

- **One Durable Object per lobby.** `idFromName(code)` maps a room code
  straight to an instance, so there's no registry, no KV, and no second round
  trip on join. Code collisions are resolved by a compare-and-set `claim()` on
  the object itself, which is atomic because a DO is single-threaded.
- **SQLite-backed** (`new_sqlite_classes`) — the only storage backend
  available on the Workers free plan.
- **WebSocket Hibernation** (`ctx.acceptWebSocket`, never `ws.accept()`). An
  idle lobby costs nothing while eight people argue. There is deliberately no
  `setTimeout`/`setInterval` anywhere in the DO: one pending timer would block
  hibernation permanently for every lobby.
- **Heartbeat via `setWebSocketAutoResponse`** so pings are answered at the
  edge without waking the object. It has to be an application-level ping
  because browsers cannot send WebSocket protocol pings from JavaScript.
- **Presence is derived** from `getWebSockets()`, never persisted. A phone on
  a flaky connection would otherwise write a storage row every time its radio
  blinked, and rows-written is the real free-tier ceiling.
- **Alarms** carry both game deadlines and lobby TTL on a single armed alarm,
  and `deleteAll()` on expiry so a dead room stops costing storage.

### The security boundary

Every game module exports `viewFor(room, viewerId)`, and **that is the only
code path that puts game state on the wire**. There is no "send everything and
hide it in the UI" anywhere:

- a spy's payload never contains the location — not in a collapsed field, not
  in the DOM, not anywhere
- a player's policy hand goes only to that player
- votes are private until the reveal, then public and permanent
- who played which mission card is never revealed, to anyone, ever

This is enforced by tests (`test/rules.test.js`) and re-checked end-to-end
against a live DO (`test/e2e/protocol.mjs`).

## Rules fidelity

Things the research turned up that are commonly implemented wrong, and that
this codebase gets right:

**The Council** (Secret Hitler)
- A policy enacted by the deadlock tracker grants **no** power, resets the
  tracker, and **wipes term limits**.
- The tracker resets on *policy enactment*, not on a successful election — so
  a passed election that ends in a veto keeps its increment.
- A veto advances the tracker and can therefore trigger deadlock.
- "Only the last Deputy is term-limited" counts **living** players, so it
  switches on mid-game after purges.
- Audit reveals **party**, not role, so the Architect audits as Cabal.
- A tied vote fails (the printed board's "at least 50%" is wrong; the rulebook
  requires a strict majority).

**Odd One Out** (Spyfall)
- An accusation needs **unanimity among everyone except the accused**, with
  the accuser an automatic yes. It is not a plurality vote.
- When the timer expires the official procedure is **sequential
  single-suspect ballots** starting with the dealer — not "everyone points at
  once", which is an app convention. Sequential ballots also can't tie.
- The clock pauses for a vote and resumes at the exact value.
- Official scoring: spy survives 2, spy names the location 4, an innocent
  convicted 4, spy caught 1 to every non-spy plus 1 more to the first accuser.

**Sabotage** (Avalon)
- A tied approval vote is a **rejection**.
- Five consecutive rejections in one round loses outright — with no
  assassination phase.
- Mission four needs **two** fails, and only at 7+ players. The team-size
  table is genuinely non-monotonic at 5 and 6 players; it is not a typo.
- The fail **count** is public; who played what never is.

**Spectrum** (Wavelength)
- The opposing team's left/right bet scores nothing when the psychic's team
  hits the bullseye.
- The team going second starts on 1.
- Score 4 while still behind and you immediately take another turn.

## Mobile

- App shell is a non-scrolling `100dvh` grid. Because the body never scrolls,
  the iOS URL bar never retracts, so `dvh` never thrashes.
- `viewport-fit=cover` plus `env(safe-area-inset-*)`; no `user-scalable=no`
  (ignored by iOS since iOS 10 and fails WCAG 1.4.4).
- `touch-action: manipulation` kills double-tap zoom while **keeping** pinch
  zoom. `overscroll-behavior: none` kills pull-to-refresh.
- Inputs are `max(16px, 1rem)` so iOS never zooms the viewport on focus.
- Bottom action bar lifts above the iOS keyboard via `VisualViewport`.
- Screen Wake Lock with a muted-video fallback for older iOS.
- Reconnection is treated as the normal case, not an error: seat tokens in
  `localStorage`, reconnect probes on `online`/`pageshow`/`visibilitychange`/
  `focus`, full snapshot on resync, and the banner stays quiet for the first
  two seconds so a blip doesn't make a good connection feel broken.
- Every control is ≥44px; primary actions are ≥56px in the thumb zone, and
  the commit button always **names its target** ("Nominate Priya") so a
  misfire is caught by reading rather than by dismissing a dialog.

## Design

No web fonts, no image files, no icon library, no CSS framework, no JS
animation library. One hand-written stylesheet, inline SVG icons via a
`<symbol>` sprite, and deterministic seed-generated avatars that differ in
**shape** as well as hue — the player set stays distinguishable in greyscale,
and no faction is ever encoded by colour alone.

Dark by default (these are night games), `#0E1116` rather than pure black to
avoid OLED smear, with a manual toggle that wins over the system preference
in both directions. Every animation is redundant with a static cue, so
`prefers-reduced-motion` removes motion without removing information.

## On the names

Game *mechanics* are not copyrightable — see
*DaVinci Editrice S.R.L. v. Ziko Games, LLC* (S.D. Tex.), where a hidden-role
card game with a one-to-one identical role structure and identical win
conditions was held non-infringing because the theme and art differed. What
*is* protected is expression: rulebook text, art, and **curated lists**.

So: every game here is renamed and re-themed, and every word of content is
original — 60 locations × 8 roles and 148 spectrum pairs, all authored for
this project rather than lifted from a published deck. Nothing in this repo
relies on anyone else's licence.

## Content

| Deck | Now | Healthy |
|---|---|---|
| Locations × 8 roles | 60 | 100 |
| Spectrum pairs | 148 | 300 |

Adding more is a pure data change in `src/content/` — no deploy logic to
touch. A group burns through locations fast, and a repeat hurts here more
than in a word game, because the whole tension is "do I recognise this place".

# Parlour

Phone-first multiplayer party games. Everyone's in the same room, each holding
their own phone; the phone is the private channel and the talking is the game.
No app, no signup — one person starts a room, everyone else types four letters.

## The games

| Game | Players | Length | Based on |
|---|---|---|---|
| **Odd One Out** | 3–12 | 8–10 min/round | Spyfall |
| **Nightfall** | 5–16 | 10–20 min | Werewolf / Mafia |
| **The Council** | 5–10 | 25–45 min | Secret Hitler |
| **Sabotage** | 5–10 | 20–30 min | The Resistance: Avalon |
| **Spectrum** | 2–16 | 15–20 min | Wavelength |
| **Texas Hold'em** | 2–9 | 25–45 min | No-limit poker |
| **Cheat** | 3–10 | 10–20 min | Cheat / BS / I Doubt It |

Each is implemented from the **official rulebook**, not from an aggregator
summary. `test/rules.test.js` covers the specific rules that implementations
habitually get wrong — see [Rules fidelity](#rules-fidelity).

## Running it

```sh
npm install
npm run dev          # http://localhost:8787
npm test             # 90 rules-engine unit tests, no deps
```

End-to-end, against a running `npm run dev`:

```sh
npm run test:protocol   # HTTP + WebSocket + Durable Object, incl. leak checks
npm run test:browser    # six real phone-sized browsers playing two games
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

**Texas Hold'em**
- Side pots are **derived** from each player's `totalCommitted`, never tracked
  as a running total. A scalar pot cannot answer "which chips was this short
  stack eligible for", which is the root of most incorrect payouts. The test
  is conservation: `sum(pots) + sum(refunds) === sum(totalCommitted)`.
- An **uncalled bet is returned** before any pot is built, so shoving into a
  shorter stack never wins chips nobody could match.
- An all-in short of a full raise **does not re-open the betting** to a player
  who has already acted and is not facing a full raise (TDA 47-A). They may
  call the extra or fold. This is the most commonly missed rule in poker
  software.
- The minimum raise is always the size of the **last full** bet or raise, which
  a short all-in does not update.
- **A-2-3-4-5 is the lowest straight**, not an ace-high one — and the steel
  wheel is the lowest straight flush.
- Heads-up, the button posts the **small** blind and acts **first** pre-flop,
  **last** on every street after it.
- Odd chips in a split pot go to the first seat left of the button.
- The action clock **checks when it can** and folds only when it must, so a
  phone that locks never folds a hand that was free to continue.

**Cheat**
- Playing your last card is **not** winning — you have to survive the challenge
  window first, and getting caught on it puts the pile in your hand like anyone
  else. This is why going out is a phase and not a return value.
- The **wrong** party takes the pile: a caller who is right gives it to the
  liar, a caller who is wrong takes it themselves.
- A partly-true claim is a lie. Three claimed, two actually Twos, is a lie.
- Card ownership is checked server-side, including duplicates, so a doctored
  client cannot play a card it does not hold or the same card four times.

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
- **The five wedges are equal width.** The common misreading is that the bands
  get progressively wider; the 2- and 3-point scores only cover more arc
  because each appears twice, once per side. The rulebook never states the
  angle in words — measuring the official artwork puts each wedge at ~7.45°,
  rounded here to 7.5° (1/24 of the spectrum).
- A dial landing exactly on a boundary scores the *higher* value. The band
  edges are twenty-fourths, so an exact hit is never representable in binary
  floating point — without an epsilon a dial on the line loses a point roughly
  half the time.
- The opposing team's left/right bet scores nothing when the psychic's team
  hits the bullseye.
- The team going second starts on 1.
- Score 4 while still behind and you immediately take another turn.

**Nightfall** (Werewolf) — a folk game with no owner, so it keeps its name
- Night actions are **collected then resolved in a single pass**, never
  resolved at submit time. Deaths cascade through a FIFO queue so a Hunter's
  shot chains deterministically, and the win check runs exactly once at the
  end rather than mid-cascade.
- The Seer's answer is delivered even if the target dies the same night —
  alignment is static, so the result is order-independent.
- Witch poison kills *through* the Doctor's protection: protection is against
  the wolf attack only.
- A save is never announced; the table learns only who died.
- A deadlocked wolf pack kills nobody, and a tied day vote hangs nobody.
- Wolves win at parity (`>=`), because from there they can always carry the
  vote. Configurable to play-to-the-last-villager instead.

## Dead ends

A dead end is any state a player can reach where no visible control moves them
forward. These are the ones that existed and how each is closed — every one has
a test in `test/e2e/journeys.mjs`, because none of them is observable from the
API alone.

| Journey | What used to happen | Now |
|---|---|---|
| The host closes their tab | Nobody could start; the room was stuck until it expired | Presence flips, and anyone may **take over as host** — but only while the host has no live socket |
| You arrive mid-round | `409 in_progress`, permanently: a room never returns to the lobby phase | Your seat is **held for the next round** and you are dealt in automatically |
| The room is already full | You typed your name, tapped Join, and got a toast | The join screen says so **before** the name field, and offers to start your own room |
| One more than the game seats | Join succeeded; Start then failed with "too many players" | Refused at the door, against the **game's** maximum rather than the global one |
| Someone needs removing | `kick` and `makeHost` existed on the wire with no UI at all | Host taps a player; a sheet offers hand-over or removal |
| You want to know the rules first | Reachable only from inside a running game | One tap from the home screen once a game is picked |

The presence bug behind the first row is worth calling out: inside
`webSocketClose`, `ctx.getWebSockets()` still returns the socket being torn
down, so the departing player counted as online in the very broadcast meant to
announce they had left — and nothing broadcast again until someone acted. The
offline indicator therefore never fired for anyone who simply closed their tab.

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

## CSS traps worth knowing

Two of these shipped and were caught by eye rather than by a test, which is why
`test/e2e/visual.mjs` now asserts computed values instead of asserting that a
stylesheet was served. CSS fails silently: an invalid value drops one
declaration and everything still renders, just wrong.

- **Container query units used ON the container resolve against the nearest
  ANCESTOR container** — the viewport, usually — not the element itself. And
  for anything that affects the container's own size (padding, width) the
  declaration is dropped outright as a cyclic dependency. Measured:
  `inset 0 0 0 5.5cqw` on a 46px card produced a 21px frame that swallowed the
  face, and `padding: 7cqw` silently did nothing. Children are fine; the
  container itself must use `calc(var(--pc-w) * n)`.
- **A `@container` rule can only style DESCENDANTS of its container.**
  `@container (min-width: 58px) { .pcard { padding } }` never applies to the
  card it was written for, even though the same block's `.pcard__rank` rule
  does. Size-class selectors, not container queries, for the element itself.
- **The colour interpolation method belongs with the direction.**
  `linear-gradient(180deg in oklab, …)`, not `linear-gradient(in oklab, 180deg, …)`.
  The wrong order is invalid and takes the whole declaration with it.
- **`background:` is a shorthand.** A later `background-image` wipes out the
  colour the shorthand set, which is how card backs ended up transparent.

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

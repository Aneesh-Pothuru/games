/**
 * Per-game screens.
 *
 * Each entry renders from the server's redacted projection and returns
 * intents. Two conventions hold everywhere:
 *   - the middle pane always says what phase we are in and who we are waiting
 *     for, by name; there is no screen that just spins
 *   - the bottom bar holds exactly one primary action, and its LABEL names the
 *     target ("Nominate Priya"), so a misfire is caught by reading, not by
 *     dismissing a dialog
 */

import { el, icon, buzz, celebrate, toast } from './ui.js';

const waiting = (text) => el('div', { class: 'banner banner--accent', text });
const label = (text) => el('div', { class: 'label', text });

function bottom(children) {
  return el('footer', { class: 'bar bar--bottom' }, [].concat(children).filter(Boolean));
}

function primary(text, opts = {}) {
  return el('button', {
    class: `btn ${opts.danger ? 'btn--danger' : 'btn--primary'} btn--block`,
    disabled: opts.disabled,
    onclick: opts.onclick,
  }, [text]);
}

function waitingBar(text) {
  return bottom([el('button', { class: 'btn btn--primary btn--block', disabled: true }, [text])]);
}

/**
 * The most-tapped button in the product. It must not require anyone to rejoin,
 * retype the code, or re-enter their name — the lobby and every seat survive.
 */
function playAgainBar(ctx) {
  return bottom([
    ctx.isHost
      ? primary('Play again — same players', { onclick: () => ctx.again() })
      : el('button', { class: 'btn btn--secondary btn--block', disabled: true }, ['Waiting for the host']),
  ]);
}

/**
 * The dramatic reveal object. Hold to peek is pure CSS; the commit is a 700ms
 * hold so nobody taps through without reading.
 */
function roleCard({ kicker, name, detail, emblem, tone }) {
  const card = el('div', { class: 'rolecard', style: tone ? `--tc:${tone};--tint:${tone}33` : '' }, [
    el('button', { class: 'rolecard__btn', 'aria-pressed': 'false', 'aria-label': 'Hold to reveal your role' }, [
      el('div', { class: 'rolecard__inner' }, [
        el('div', { class: 'rolecard__face rolecard__back' }, [
          icon(emblem ?? 'g-council', 'rolecard__emblem'),
          el('span', { class: 'label', text: 'Hold to reveal' }),
          el('span', {
            class: 'holdring', html:
              '<svg viewBox="0 0 44 44" aria-hidden="true"><circle class="holdring__t" cx="22" cy="22" r="20"/><circle class="holdring__p" cx="22" cy="22" r="20"/></svg>',
          }),
        ]),
        el('div', { class: 'rolecard__face rolecard__front' }, [
          el('span', { class: 'label', text: kicker }),
          el('h2', { class: 'rolecard__name', text: name }),
          detail && el('p', { class: 'rolecard__obj', text: detail }),
        ]),
      ]),
    ]),
  ]);

  const btn = card.querySelector('.rolecard__btn');
  let timer = 0;
  const start = () => {
    timer = setTimeout(() => {
      card.classList.add('is-revealed');
      btn.setAttribute('aria-pressed', 'true');
      buzz('reveal');
    }, 700);
  };
  const stop = () => clearTimeout(timer);
  btn.addEventListener('pointerdown', start);
  for (const evt of ['pointerup', 'pointercancel', 'pointerleave']) btn.addEventListener(evt, stop);
  // A hold gesture cannot be the only path: keyboard and AT users get a toggle.
  btn.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      card.classList.toggle('is-revealed');
      btn.setAttribute('aria-pressed', String(card.classList.contains('is-revealed')));
    }
  });
  return card;
}

/** Two-stage select then commit, with the target's name in the button. */
function pickList(ctx, { candidates, disabled, stateFor, subFor }) {
  return el('ul', { class: 'plist is-picking' },
    ctx.room.players.map((p) => ctx.playerTile(ctx, p, {
      pick: candidates.includes(p.id),
      selected: ctx.selected() === p.id,
      disabled: disabled || !candidates.includes(p.id),
      state: stateFor?.(p),
      sub: subFor?.(p),
      onPick: candidates.includes(p.id) && !disabled ? () => ctx.select(p.id) : undefined,
    })),
  );
}

function readyBar(ctx, { acked, onAck, text = 'I’ve got it' }) {
  const done = acked?.[ctx.me];
  const pending = ctx.room.players.filter((p) => !acked?.[p.id]).map((p) => p.name);
  if (done) return waitingBar(pending.length ? `Waiting for ${pending.join(', ')}` : 'Starting…');
  return bottom([primary(text, { onclick: onAck })]);
}

function voteButtons({ yes, no, current, onVote }) {
  return el('div', { class: 'votepair', role: 'radiogroup', 'aria-label': 'Your vote' }, [
    el('button', {
      class: 'vote vote--yes', role: 'radio', 'aria-checked': String(current === yes.value),
      onclick: () => onVote(yes.value),
    }, [icon('i-check', 'ico ico--lg'), el('span', { text: yes.label })]),
    el('button', {
      class: 'vote vote--no', role: 'radio', 'aria-checked': String(current === no.value),
      onclick: () => onVote(no.value),
    }, [icon('i-x', 'ico ico--lg'), el('span', { text: no.label })]),
  ]);
}

function outcomeBanner(text, tone = '') {
  return el('div', { class: `banner ${tone}` }, [el('b', { text })]);
}

/**
 * Your role, in the top bar, hidden until you hold it.
 *
 * Printing the role as plain persistent text is a real secrecy bug in a
 * secrecy game: six people are sitting around one table, and anyone glancing
 * at your phone reads it. The text is not in the DOM at rest, so a screenshot
 * or a shoulder-glance gets nothing.
 */
function peekChip(label, tone) {
  const chip = el('button', {
    class: 'chip chip--peek', style: tone ? `color:${tone}` : '',
    'aria-label': `Hold to see your role. Currently hidden.`,
  }, [el('span', { class: 'chip__masked', text: 'Your role' })]);

  const show = () => {
    chip.firstChild.textContent = label;
    chip.classList.add('is-peeking');
    buzz('reveal');
  };
  const hide = () => {
    chip.firstChild.textContent = 'Your role';
    chip.classList.remove('is-peeking');
  };
  chip.addEventListener('pointerdown', show);
  for (const e of ['pointerup', 'pointercancel', 'pointerleave']) chip.addEventListener(e, hide);
  // Hold is not an accessible sole path; space/enter toggles instead.
  chip.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      chip.classList.contains('is-peeking') ? hide() : show();
    }
  });
  // Never leave a secret on screen when the phone is put down or backgrounded.
  document.addEventListener('visibilitychange', hide);
  return chip;
}

// ------------------------------------------------------------------- cards --

/**
 * Card rendering.
 *
 * The server sends cards as ints 0..51; these four lines are the only thing the
 * client needs to know about that encoding, and they are deliberately a copy of
 * the server's rather than a shared module — `public/` is static assets and
 * `src/` is the Worker, and wiring a build step to share twelve characters
 * would cost more than it saves.
 */
const CARD_RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const CARD_SUITS = [
  { glyph: '♣', name: 'clubs', red: false },
  { glyph: '♦', name: 'diamonds', red: true },
  { glyph: '♥', name: 'hearts', red: true },
  { glyph: '♠', name: 'spades', red: false },
];

/** Chips read as money or they read as noise. Always grouped. */
const chips = (n) => Number(n ?? 0).toLocaleString('en-US');

function playingCard(card, opts = {}) {
  if (card === null || card === undefined) {
    return el('span', { class: `pcard pcard--${opts.size ?? 'md'} pcard--back`, 'aria-hidden': 'true' });
  }
  const rank = CARD_RANKS[card >> 2];
  const suit = CARD_SUITS[card & 3];
  return el('span', {
    class: [
      'pcard', `pcard--${opts.size ?? 'md'}`,
      suit.red ? 'pcard--red' : 'pcard--black',
      opts.dim ? 'is-dim' : '', opts.best ? 'is-best' : '',
    ].join(' '),
    role: 'img',
    'aria-label': `${rank} of ${suit.name}`,
  }, [
    el('span', { class: 'pcard__rank', text: rank }),
    el('span', { class: 'pcard__suit', text: suit.glyph }),
  ]);
}

/** An empty slot, so the board is always five wide and never reflows. */
const cardSlot = () => el('span', { class: 'pcard pcard--md pcard--slot', 'aria-hidden': 'true' });

// ------------------------------------------------------------------ council --

const COUNCIL_ROLE = {
  STEWARD: { name: 'Steward', tone: 'var(--team-1)', aim: 'Enact five Charters, or purge the Architect.' },
  CABAL: { name: 'Cabal', tone: 'var(--team-2)', aim: 'Enact six Decrees, or seat the Architect as Deputy.' },
  ARCHITECT: { name: 'The Architect', tone: 'var(--team-2)', aim: 'Stay hidden. Get elected Deputy once three Decrees are down.' },
};

const POWER_NAME = { AUDIT: 'Audit', SESSION: 'Emergency Session', FORESIGHT: 'Foresight', PURGE: 'Purge' };

const council = {
  roleChip: (ctx) => {
    const info = COUNCIL_ROLE[ctx.view?.myRole];
    return info ? peekChip(info.name, info.tone) : null;
  },

  body(ctx) {
    const v = ctx.view;
    if (!v) return [waiting('Dealing roles…')];

    const track = el('div', { class: 'card stack stack--tight' }, [
      el('div', { class: 'row' }, [
        el('span', { class: 'grow' }, [
          label('Charters'),
          el('b', { class: 'num t-lg', text: `${v.charters} / 5` }),
        ]),
        el('span', { class: 'grow' }, [
          label('Decrees'),
          el('b', { class: 'num t-lg', text: `${v.decrees} / 6` }),
        ]),
        el('span', {}, [label('Deadlock'), el('b', { class: 'num t-lg', text: `${v.tracker} / 3` })]),
      ]),
      el('div', { class: 'label', text: `Deck ${v.drawCount} · discard ${v.discardCount}${v.vetoUnlocked ? ' · veto unlocked' : ''}` }),
      v.decrees >= 3 && el('div', {
        class: 'banner banner--danger',
        text: 'Danger zone: electing the Architect as Deputy now ends the game.',
      }),
    ]);

    const roster = playersFor(ctx, v);

    switch (v.phase) {
      case 'reveal': {
        const info = COUNCIL_ROLE[v.myRole];
        return [
          waiting('Everyone — pick up your phone.'),
          roleCard({
            kicker: 'Your role', name: info.name, detail: info.aim,
            emblem: 'g-council', tone: info.tone,
          }),
          v.known.length
            ? el('div', { class: 'card stack stack--tight' }, [
                label('You also know'),
                ...v.known.map((k) =>
                  el('div', { class: 'row' }, [
                    el('b', { text: ctx.nameOf(ctx, k.id) }),
                    el('span', { class: 'dim', text: k.role === 'ARCHITECT' ? 'is the Architect' : 'is Cabal' }),
                  ])),
              ])
            : el('div', { class: 'banner', text: 'You know nothing about anyone else. Work it out.' }),
        ];
      }

      case 'nominate':
        return [track,
          v.speaker === ctx.me
            ? label('You are Speaker. Nominate a Deputy.')
            : waiting(`Waiting for ${ctx.nameOf(ctx, v.speaker)} to nominate a Deputy.`),
          pickList(ctx, {
            candidates: v.speaker === ctx.me ? v.eligible : [],
            stateFor: (p) => (!v.alive[p.id] ? 'dead' : p.id === v.speaker ? 'turn' : null),
            subFor: (p) =>
              !v.alive[p.id] ? 'Purged'
              : p.id === v.speaker ? 'Speaker'
              : p.id === v.lastElectedDeputy || (p.id === v.lastElectedSpeaker && !v.eligible.includes(p.id))
                ? 'Term-limited' : null,
          }), roster];

      case 'vote': {
        const mine = v.votes[ctx.me];
        return [track,
          el('div', { class: 'card center stack stack--tight' }, [
            label('Proposed government'),
            el('b', { class: 't-lg', text: `${ctx.nameOf(ctx, v.speaker)} — Speaker` }),
            el('b', { class: 't-lg', text: `${ctx.nameOf(ctx, v.nominee)} — Deputy` }),
          ]),
          mine
            ? el('div', { class: 'banner banner--good', text: `You voted ${mine === 'YES' ? 'yes' : 'no'}. Waiting for the rest.` })
            : label('Vote on this government'),
          el('div', { class: 'label', text: `${v.voted.length} of ${ctx.room.players.filter((p) => v.alive[p.id]).length} voted` }),
          roster];
      }

      case 'legislate_speaker':
      case 'legislate_deputy':
      case 'veto_consent':
        return [track, ...legislative(ctx, v), roster];

      case 'power_audit':
        return [track, label('Audit a member’s allegiance'),
          pickList(ctx, {
            candidates: v.electedSpeaker === ctx.me
              ? ctx.room.players.filter((p) => v.alive[p.id] && p.id !== ctx.me && !v.audited[p.id]).map((p) => p.id)
              : [],
            subFor: (p) => (v.audited[p.id] ? 'Already audited' : null),
          })];

      case 'power_audit_result':
        return [track,
          v.auditResult?.party
            ? el('div', { class: 'secret' }, [
                label(`${ctx.nameOf(ctx, v.auditResult.target)} is registered as`),
                el('b', { class: 'secret__value', text: v.auditResult.party === 'CABAL' ? 'CABAL' : 'STEWARD' }),
                el('p', { class: 'dim t-sm', text: 'This is party membership, not role. You may tell the table whatever you like.' }),
              ])
            : waiting(`${ctx.nameOf(ctx, v.electedSpeaker)} is reading the audit.`),
          roster];

      case 'power_foresight':
        return [track,
          v.foresight
            ? el('div', { class: 'secret' }, [
                label('The next three policies, in order'),
                el('div', { class: 'row' }, v.foresight.map((t) =>
                  el('span', {
                    class: 'chip',
                    style: `color:${t === 'CHARTER' ? 'var(--team-1)' : 'var(--danger)'}`,
                    text: t === 'CHARTER' ? 'Charter' : 'Decree',
                  }))),
              ])
            : waiting(`${ctx.nameOf(ctx, v.electedSpeaker)} is looking ahead.`),
          roster];

      case 'power_session':
        return [track, label('Choose who chairs the emergency session'),
          pickList(ctx, {
            candidates: v.electedSpeaker === ctx.me
              ? ctx.room.players.filter((p) => v.alive[p.id] && p.id !== ctx.me).map((p) => p.id) : [],
          })];

      case 'power_purge':
        return [track,
          el('div', { class: 'banner banner--danger', text: 'A purge is permanent. They cannot vote, speak, or hold office again.' }),
          pickList(ctx, {
            candidates: v.electedSpeaker === ctx.me
              ? ctx.room.players.filter((p) => v.alive[p.id] && p.id !== ctx.me).map((p) => p.id) : [],
          })];

      case 'over':
        return [track, ...councilResult(ctx, v)];

      default:
        return [track, roster];
    }
  },

  bottom(ctx) {
    const v = ctx.view;
    if (!v) return bottom([]);
    const pick = ctx.selected();

    switch (v.phase) {
      case 'reveal':
        return readyBar(ctx, { acked: v.acked, onAck: () => ctx.send({ type: 'ack' }) });

      case 'nominate':
        if (v.speaker !== ctx.me) return waitingBar(`Waiting for ${ctx.nameOf(ctx, v.speaker)}`);
        return bottom([primary(pick ? `Nominate ${ctx.nameOf(ctx, pick)}` : 'Select a Deputy', {
          disabled: !pick,
          onclick: () => ctx.send({ type: 'nominate', target: pick }),
        })]);

      case 'vote': {
        const mine = v.votes[ctx.me];
        if (!v.alive[ctx.me]) return waitingBar('Purged players do not vote');
        return bottom([voteButtons({
          yes: { value: 'YES', label: 'Yes' }, no: { value: 'NO', label: 'No' },
          current: mine, onVote: (value) => ctx.send({ type: 'vote', value }),
        })]);
      }

      case 'legislate_speaker':
      case 'legislate_deputy':
      case 'veto_consent':
        return legislativeBottom(ctx, v);

      case 'power_audit':
      case 'power_session':
      case 'power_purge': {
        if (v.electedSpeaker !== ctx.me) {
          return waitingBar(`Waiting for ${ctx.nameOf(ctx, v.electedSpeaker)}`);
        }
        const verb = { power_audit: 'Audit', power_session: 'Hand the chair to', power_purge: 'Purge' }[v.phase];
        const type = { power_audit: 'audit', power_session: 'session', power_purge: 'purge' }[v.phase];
        return bottom([primary(pick ? `${verb} ${ctx.nameOf(ctx, pick)}` : 'Select a player', {
          disabled: !pick, danger: v.phase === 'power_purge',
          onclick: () => {
            ctx.send({ type, target: pick });
            ctx.select(pick);
          },
        })]);
      }

      case 'power_audit_result':
      case 'power_foresight':
        if (v.electedSpeaker !== ctx.me) return waitingBar(`Waiting for ${ctx.nameOf(ctx, v.electedSpeaker)}`);
        return bottom([primary('Done', { onclick: () => ctx.send({ type: 'ackPower' }) })]);

      case 'over':
        return playAgainBar(ctx);

      default:
        return bottom([]);
    }
  },

  options: (ctx, set) => [
    toggleRow('Speaker may purge themselves', ctx.room.config.allowSelfPurge, (v) => set({ allowSelfPurge: v })),
    toggleRow('Speaker may audit themselves', ctx.room.config.allowSelfAudit, (v) => set({ allowSelfAudit: v })),
  ],
};

function legislative(ctx, v) {
  const iAmSpeaker = v.electedSpeaker === ctx.me;
  const iAmDeputy = v.electedDeputy === ctx.me;

  if (v.phase === 'legislate_speaker' && iAmSpeaker) {
    return [label('Discard one. The other two go to the Deputy.'), policyRow(ctx, v.myHand, 'discard')];
  }
  if (v.phase === 'legislate_deputy' && iAmDeputy) {
    return [label('Enact one of these two.'), policyRow(ctx, v.myHand, 'enact'),
      v.vetoRefused && el('div', { class: 'banner banner--danger', text: 'The Speaker refused the veto. You must enact.' })];
  }
  if (v.phase === 'veto_consent') {
    if (iAmSpeaker) return [label('The Deputy wants to veto this agenda. Do you agree?')];
    return [waiting(`${ctx.nameOf(ctx, v.electedSpeaker)} is deciding on the veto.`)];
  }
  const who = v.phase === 'legislate_speaker' ? v.electedSpeaker : v.electedDeputy;
  const role = v.phase === 'legislate_speaker' ? 'Speaker' : 'Deputy';
  return [waiting(`${ctx.nameOf(ctx, who)} (${role}) is choosing a policy. They may tell you anything about it afterwards.`)];
}

function policyRow(ctx, hand, mode) {
  if (!hand) return el('div');
  return el('div', { class: 'row', style: 'gap:var(--sp-3)' }, hand.map((tile, i) =>
    el('button', {
      class: 'card grow center',
      style: `--tc:${tile === 'CHARTER' ? 'var(--team-1)' : 'var(--danger)'};box-shadow:var(--e-2),inset 0 0 0 2px var(--tc);min-height:120px`,
      onclick: () => {
        ctx.send({ type: mode === 'discard' ? 'discardPolicy' : 'enactPolicy', index: i });
        buzz('confirm');
      },
    }, [
      el('b', {
        class: 't-lg',
        style: `color:${tile === 'CHARTER' ? 'var(--team-1)' : 'var(--danger)'}`,
        text: tile === 'CHARTER' ? 'Charter' : 'Decree',
      }),
      el('span', { class: 'label', text: mode === 'discard' ? 'Discard' : 'Enact' }),
    ])));
}

function legislativeBottom(ctx, v) {
  if (v.phase === 'veto_consent' && v.electedSpeaker === ctx.me) {
    return bottom([voteButtons({
      yes: { value: true, label: 'Agree to veto' }, no: { value: false, label: 'Refuse' },
      current: null, onVote: (value) => ctx.send({ type: 'vetoConsent', value }),
    })]);
  }
  if (v.phase === 'legislate_deputy' && v.electedDeputy === ctx.me && v.vetoUnlocked && !v.vetoRefused) {
    return bottom([el('button', {
      class: 'btn btn--secondary btn--block',
      onclick: () => ctx.send({ type: 'proposeVeto' }),
    }, ['Propose a veto'])]);
  }
  const who = v.phase === 'legislate_speaker' ? v.electedSpeaker : v.electedDeputy;
  if (who === ctx.me) return bottom([]);
  return waitingBar(`Waiting for ${ctx.nameOf(ctx, who)}`);
}

function councilResult(ctx, v) {
  const won = v.over.winner === (v.myRole === 'STEWARD' ? 'STEWARD' : 'CABAL');
  if (won) celebrate();
  const reason = {
    CHARTERS: 'Five Charters enacted.',
    DECREES: 'Six Decrees enacted.',
    ARCHITECT_SEATED: 'The Architect was elected Deputy.',
    ARCHITECT_PURGED: 'The Architect was purged.',
  }[v.over.reason];
  return [
    outcomeBanner(`${v.over.winner === 'STEWARD' ? 'Stewards' : 'Cabal'} win — ${reason}`, won ? 'banner--good' : 'banner--danger'),
    label('Everyone’s role'),
    el('ul', { class: 'plist' }, ctx.room.players.map((p) =>
      ctx.playerTile(ctx, p, {
        sub: COUNCIL_ROLE[v.reveal[p.id]]?.name,
        state: v.alive[p.id] ? null : 'dead',
      }))),
  ];
}

function playersFor(ctx, v) {
  return el('ul', { class: 'plist' }, ctx.room.players.map((p) =>
    ctx.playerTile(ctx, p, {
      host: true,
      state: v.alive && !v.alive[p.id] ? 'dead' : null,
      sub: v.voted?.includes(p.id) ? 'Voted' : null,
    })));
}

function toggleRow(text, value, onChange) {
  return el('div', { class: 'optionrow' }, [
    el('span', { text }),
    el('button', {
      class: 'btn btn--secondary', 'aria-pressed': String(value),
      onclick: () => onChange(!value),
    }, [value ? 'On' : 'Off']),
  ]);
}

// ---------------------------------------------------------------- oddoneout --

const oddoneout = {
  roleChip: (ctx) =>
    ctx.view?.amSpy
      ? peekChip('Spy', 'var(--danger)')
      : ctx.view?.myRole ? peekChip(ctx.view.myRole, null) : null,

  body(ctx) {
    const v = ctx.view;
    if (!v) return [waiting('Dealing…')];

    const header = el('div', { class: 'row' }, [
      el('span', { class: 'label grow', text: `Round ${v.round} of ${v.totalRounds}` }),
      el('span', { class: 'label', text: `${v.spyCount} spy${v.spyCount === 1 ? '' : 'ies'}` }),
    ]);

    switch (v.phase) {
      case 'reveal':
        return [header, waiting('Everyone — pick up your phone.'),
          roleCard(v.amSpy
            ? { kicker: 'Your card', name: 'SPY', detail: 'You have no idea where you are. Work it out, or survive the vote.', emblem: 'g-oddoneout', tone: 'var(--danger)' }
            : { kicker: v.myLocation, name: v.myRole, detail: 'Answer questions convincingly. Don’t hand the location to the spy.', emblem: 'g-oddoneout', tone: 'var(--team-6)' }),
        ];

      case 'questioning':
        return [header,
          el('div', { class: 'card center stack stack--tight' }, [
            label(v.amSpy ? 'You are the spy' : 'You are at'),
            el('b', { class: 'secret__value', text: v.amSpy ? '???' : v.myLocation }),
            !v.amSpy && el('span', { class: 'dim', text: `as the ${v.myRole}` }),
          ]),
          el('div', { class: 'banner', text: 'Ask someone a question out loud, by name. You may not ask back whoever just asked you.' }),
          label(v.usedAccusation ? 'You have used your accusation' : 'Accuse someone (once per round)'),
          pickList(ctx, {
            candidates: v.usedAccusation ? [] : ctx.room.players.filter((p) => p.id !== ctx.me).map((p) => p.id),
          }),
          locationList(v, ctx),
        ];

      case 'accusation': {
        const a = v.accusation;
        const amAccused = a.accused === ctx.me;
        return [
          el('div', { class: 'card center stack stack--tight' }, [
            label('Accusation'),
            el('b', { class: 't-lg', text: `${ctx.nameOf(ctx, a.accuser)} says it’s ${ctx.nameOf(ctx, a.accused)}` }),
            el('span', { class: 'dim t-sm', text: 'Everyone except the accused must agree. One "no" and the clock restarts.' }),
          ]),
          amAccused && el('div', { class: 'banner banner--danger', text: 'You are the accused. You do not vote — make your case out loud.' }),
          el('div', { class: 'label', text: `${a.voted.length} of ${ctx.room.players.length - 1} voted` }),
          playersFor(ctx, v),
        ];
      }

      case 'endgame': {
        const suspect = v.accusation.accused;
        return [
          el('div', { class: 'card center stack stack--tight' }, [
            label(`Ballot ${v.ballotIndex + 1} of ${v.ballotTotal}`),
            el('b', { class: 't-lg', text: `Is it ${ctx.nameOf(ctx, suspect)}?` }),
            el('span', { class: 'dim t-sm', text: 'Unanimous, or we move to the next person.' }),
          ]),
          suspect === ctx.me && el('div', { class: 'banner banner--danger', text: 'You are up. Defend yourself.' }),
          playersFor(ctx, v),
        ];
      }

      case 'spyGuess':
        return [
          el('div', { class: 'banner banner--danger', text: 'The spy has revealed and is naming the location.' }),
          v.amSpy && !v.myGuess ? locationPicker(ctx, v) : null,
          v.myGuess && waiting('Guess locked in.'),
        ];

      case 'result':
        return oddResult(ctx, v);

      default:
        return [header];
    }
  },

  bottom(ctx) {
    const v = ctx.view;
    if (!v) return bottom([]);
    const pick = ctx.selected();

    switch (v.phase) {
      case 'reveal':
        return readyBar(ctx, { acked: v.acked, onAck: () => ctx.send({ type: 'ack' }) });

      case 'questioning':
        return bottom([
          primary(pick ? `Accuse ${ctx.nameOf(ctx, pick)}` : 'Stop the clock to accuse', {
            disabled: !pick || v.usedAccusation, danger: true,
            onclick: () => ctx.send({ type: 'accuse', target: pick }),
          }),
          v.amSpy && el('button', {
            class: 'btn btn--secondary btn--block',
            onclick: () => ctx.send({ type: 'spyReveal' }),
          }, ['Reveal and name the location']),
        ]);

      case 'accusation': {
        if (v.accusation.accused === ctx.me) return waitingBar('You cannot vote on yourself');
        if (v.accusation.myVote) return waitingBar('Vote cast — waiting for the rest');
        return bottom([voteButtons({
          yes: { value: 'YES', label: 'It’s them' }, no: { value: 'NO', label: 'Not sure' },
          current: v.accusation.myVote, onVote: (value) => ctx.send({ type: 'accusationVote', value }),
        })]);
      }

      case 'endgame': {
        if (v.accusation.accused === ctx.me) return waitingBar('You cannot vote on yourself');
        if (v.accusation.myVote) return waitingBar('Vote cast — waiting for the rest');
        return bottom([voteButtons({
          yes: { value: 'YES', label: 'Guilty' }, no: { value: 'NO', label: 'Innocent' },
          current: v.accusation.myVote, onVote: (value) => ctx.send({ type: 'endgameVote', value }),
        })]);
      }

      case 'spyGuess':
        if (!v.amSpy) return waitingBar('The spy is choosing');
        if (v.myGuess) return waitingBar('Waiting for the reveal');
        return bottom([primary(pick ? 'Lock in that location' : 'Pick a location', {
          disabled: !pick, onclick: () => ctx.send({ type: 'spyGuess', locationId: pick }),
        })]);

      case 'result':
        if (v.round >= v.totalRounds) return playAgainBar(ctx);
        return bottom([ctx.isHost
          ? primary('Next round', { onclick: () => ctx.send({ type: 'nextRound' }) })
          : el('button', { class: 'btn btn--secondary btn--block', disabled: true }, ['Waiting for the host'])]);

      default:
        return bottom([]);
    }
  },

  options: (ctx, set) => [
    el('div', { class: 'optionrow' }, [
      el('span', { text: 'Rounds' }),
      el('div', { class: 'seg' }, [3, 5, 7].map((n) =>
        el('button', {
          'aria-pressed': String(ctx.room.config.rounds === n),
          onclick: () => set({ rounds: n }),
        }, [String(n)]))),
    ]),
    el('div', { class: 'optionrow' }, [
      el('span', { text: 'Round length' }),
      el('div', { class: 'seg' }, [['short', 'Short'], ['official', 'Official'], ['long', 'Long']].map(([v, l]) =>
        el('button', {
          'aria-pressed': String(ctx.room.config.timerMode === v),
          onclick: () => set({ timerMode: v }),
        }, [l]))),
    ]),
  ],
};

function locationList(v, ctx) {
  return el('details', { class: 'card' }, [
    el('summary', { class: 'label', text: `All ${v.locations.length} possible locations` }),
    el('div', { class: 'row', style: 'flex-wrap:wrap;gap:var(--sp-1);margin-top:var(--sp-3)' },
      v.locations.map((l) => el('span', { class: 'chip', text: l.name }))),
  ]);
}

function locationPicker(ctx, v) {
  return el('div', { class: 'stack stack--tight' }, [
    label('Where are you?'),
    el('div', { class: 'row', style: 'flex-wrap:wrap;gap:var(--sp-2)' }, v.locations.map((l) =>
      el('button', {
        class: 'chip',
        style: ctx.selected() === l.id ? 'box-shadow:inset 0 0 0 2px var(--game-accent)' : '',
        onclick: () => ctx.select(l.id),
      }, [l.name]))),
  ]);
}

function oddResult(ctx, v) {
  const r = v.result;
  const spyNames = r.spies.map((id) => ctx.nameOf(ctx, id)).join(' & ');
  const headline = {
    spyCaught: `Caught! ${spyNames} was the spy.`,
    innocentConvicted: `Wrong! ${ctx.nameOf(ctx, r.convicted)} was innocent — ${spyNames} got away.`,
    spyGuess: r.correct ? `${spyNames} named the location correctly.` : `${spyNames} guessed wrong.`,
    spySurvived: `Nobody was convicted. ${spyNames} walks.`,
  }[r.kind];
  const good = r.kind === 'spyCaught' || (r.kind === 'spyGuess' && !r.correct);
  if (good !== v.amSpy) celebrate();

  return [
    outcomeBanner(headline, good ? 'banner--good' : 'banner--danger'),
    el('div', { class: 'card center stack stack--tight' }, [
      label('The location was'),
      el('b', { class: 'secret__value', text: r.location }),
    ]),
    label('Scores'),
    el('ul', { class: 'plist' }, [...ctx.room.players]
      .sort((a, b) => (v.scores[b.id] ?? 0) - (v.scores[a.id] ?? 0))
      .map((p) => ctx.playerTile(ctx, p, {
        sub: `${r.spies.includes(p.id) ? 'Spy' : (r.roles[p.id] ?? '')} · ${r.deltas[p.id] > 0 ? `+${r.deltas[p.id]}` : '0'}`,
        badges: [el('span', { class: 'chip num', text: String(v.scores[p.id] ?? 0) })],
      }))),
  ];
}

// ----------------------------------------------------------------- sabotage --

const sabotage = {
  roleChip: (ctx) =>
    ctx.view?.myRoleInfo
      ? peekChip(ctx.view.myRoleInfo.name, ctx.view.myTeam === 'CREW' ? 'var(--team-1)' : 'var(--team-2)')
      : null,

  body(ctx) {
    const v = ctx.view;
    if (!v) return [waiting('Dealing…')];

    const track = el('div', { class: 'card stack stack--tight' }, [
      label('Missions'),
      el('div', { class: 'row' }, v.results.map((r, i) =>
        el('span', {
          class: 'chip', style: r === 'SUCCESS' ? 'color:var(--success)' : r === 'FAIL' ? 'color:var(--danger)' : '',
          title: `Mission ${i + 1}`,
        }, [
          `${v.teamSizes[i]}${v.failTable[i] === 2 ? '✚' : ''}`,
          r === 'SUCCESS' ? ' ✓' : r === 'FAIL' ? ' ✕' : '',
        ]))),
      el('div', { class: 'label', text: `Rejections this round: ${v.rejections} / 5` }),
      v.failsNeeded === 2 && el('div', { class: 'banner banner--accent', text: 'This mission needs TWO fails to go down.' }),
    ]);

    switch (v.phase) {
      case 'reveal':
        return [waiting('Everyone — pick up your phone.'),
          roleCard({
            kicker: v.myTeam === 'CREW' ? 'Crew' : 'Saboteur',
            name: v.myRoleInfo.name, detail: v.myRoleInfo.desc, emblem: 'g-sabotage',
            tone: v.myTeam === 'CREW' ? 'var(--team-1)' : 'var(--team-2)',
          }),
          v.known.length
            ? el('div', { class: 'card stack stack--tight' }, [
                label('You can see'),
                ...v.known.map((k) => el('div', { class: 'row' }, [
                  el('b', { text: ctx.nameOf(ctx, k.id) }), el('span', { class: 'dim', text: k.label }),
                ])),
              ])
            : el('div', { class: 'banner', text: 'You see nobody. The voting record is all you have.' }),
        ];

      case 'propose':
        return [track,
          v.leader === ctx.me
            ? label(`You are leader. Choose ${v.requiredSize} for the mission.`)
            : waiting(`Waiting for ${ctx.nameOf(ctx, v.leader)} to propose a team of ${v.requiredSize}.`),
          teamPicker(ctx, v)];

      case 'vote':
        return [track,
          el('div', { class: 'card stack stack--tight' }, [
            label('Proposed team'),
            el('div', { class: 'row', style: 'flex-wrap:wrap' },
              v.proposal.map((id) => el('span', { class: 'chip', text: ctx.nameOf(ctx, id) }))),
          ]),
          v.votes[ctx.me]
            ? el('div', { class: 'banner banner--good', text: 'Vote cast. A tie counts as a rejection.' })
            : label('Approve this team?'),
          el('div', { class: 'label', text: `${v.voted.length} of ${ctx.room.players.length} voted` }),
          playersFor(ctx, v)];

      case 'mission':
        return [track,
          v.onTeam
            ? label('Play your card in secret')
            : waiting(`On the mission: ${v.proposal.map((id) => ctx.nameOf(ctx, id)).join(', ')}. Waiting for them.`),
          el('div', { class: 'label', text: `${v.playedCard.length} of ${v.proposal.length} played` }),
          v.myTeam === 'CREW' && v.onTeam
            && el('div', { class: 'banner', text: 'You are Crew, so you must play success.' })];

      case 'assassinate':
        return [track,
          el('div', { class: 'banner banner--accent', text: 'The Crew completed three missions. The Handler gets one guess at the Analyst.' }),
          v.myRole === 'HANDLER'
            ? pickList(ctx, { candidates: ctx.room.players.filter((p) => p.id !== ctx.me).map((p) => p.id) })
            : waiting('The saboteurs are deciding. Listen carefully.')];

      case 'over':
        return [track, ...sabotageResult(ctx, v)];

      default:
        return [track];
    }
  },

  bottom(ctx) {
    const v = ctx.view;
    if (!v) return bottom([]);

    switch (v.phase) {
      case 'reveal':
        return readyBar(ctx, { acked: v.acked, onAck: () => ctx.send({ type: 'ack' }) });

      case 'propose': {
        if (v.leader !== ctx.me) return waitingBar(`Waiting for ${ctx.nameOf(ctx, v.leader)}`);
        const team = ctx.selected() ?? [];
        const ready = Array.isArray(team) && team.length === v.requiredSize;
        return bottom([primary(
          ready ? `Propose ${team.map((id) => ctx.nameOf(ctx, id)).join(', ')}` : `Choose ${v.requiredSize} players`,
          { disabled: !ready, onclick: () => ctx.send({ type: 'propose', team }) },
        )]);
      }

      case 'vote':
        if (v.votes[ctx.me]) return waitingBar('Waiting for the rest of the table');
        return bottom([voteButtons({
          yes: { value: 'APPROVE', label: 'Approve' }, no: { value: 'REJECT', label: 'Reject' },
          current: v.votes[ctx.me], onVote: (value) => ctx.send({ type: 'vote', value }),
        })]);

      case 'mission':
        if (!v.onTeam) return waitingBar('Waiting for the mission team');
        if (v.myCard) return waitingBar('Card played — waiting for the rest');
        return bottom([voteButtons({
          yes: { value: 'SUCCESS', label: 'Success' }, no: { value: 'FAIL', label: 'Fail' },
          current: v.myCard,
          onVote: (value) => ctx.send({ type: 'missionCard', value }),
        })]);

      case 'over':
        return playAgainBar(ctx);

      case 'assassinate': {
        if (v.myRole !== 'HANDLER') return waitingBar('Waiting for the Handler');
        const pick = ctx.selected();
        return bottom([primary(pick ? `Name ${ctx.nameOf(ctx, pick)} as the Analyst` : 'Choose a target', {
          disabled: !pick, danger: true, onclick: () => ctx.send({ type: 'assassinate', target: pick }),
        })]);
      }

      default:
        return bottom([]);
    }
  },

  options: (ctx, set) => [
    toggleRow('Special roles (Analyst, Decoy…)', ctx.room.config.specialRoles, (v) => set({ specialRoles: v })),
  ],
};

function teamPicker(ctx, v) {
  const current = Array.isArray(ctx.selected()) ? ctx.selected() : [];
  const toggle = (id) => {
    const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
    if (next.length > v.requiredSize) next.shift();
    ctx.select(next);
  };
  return el('ul', { class: 'plist is-picking' }, ctx.room.players.map((p) =>
    ctx.playerTile(ctx, p, {
      pick: v.leader === ctx.me,
      selected: current.includes(p.id),
      state: p.id === v.leader ? 'turn' : null,
      sub: p.id === v.leader ? 'Leader' : null,
      onPick: v.leader === ctx.me ? () => toggle(p.id) : undefined,
    })));
}

function sabotageResult(ctx, v) {
  const won = v.over.winner === v.myTeam;
  if (won) celebrate();
  const reason = {
    FIVE_REJECTIONS: 'Five teams rejected in a row.',
    THREE_FAILED: 'Three missions sabotaged.',
    THREE_SUCCEEDED: 'Three missions completed.',
    ANALYST_FOUND: 'The Handler named the Analyst.',
    ANALYST_SAFE: 'The Handler guessed wrong.',
  }[v.over.reason];
  return [
    outcomeBanner(`${v.over.winner === 'CREW' ? 'Crew' : 'Saboteurs'} win — ${reason}`, won ? 'banner--good' : 'banner--danger'),
    label('Everyone’s role'),
    el('ul', { class: 'plist' }, ctx.room.players.map((p) =>
      ctx.playerTile(ctx, p, { sub: v.reveal[p.id] }))),
  ];
}

// ----------------------------------------------------------------- spectrum --

const spectrum = {
  roleChip: (ctx) =>
    ctx.view?.amPsychic ? el('span', { class: 'chip', style: 'color:var(--game-accent)' }, ['Psychic']) : null,

  body(ctx) {
    const v = ctx.view;
    if (!v) return [waiting('Shuffling…')];

    const score = v.mode === 'coop'
      ? el('div', { class: 'row' }, [
          el('span', { class: 'label grow', text: `Score ${v.scores.coop}` }),
          el('span', { class: 'label', text: `${v.cardsLeft} left` }),
        ])
      : el('div', { class: 'row' }, [
          el('span', { class: `chip ${v.activeTeam === 'A' ? '' : 'dim'}`, style: 'color:var(--team-1)' }, [`Team A — ${v.scores.A}`]),
          el('span', { class: `chip ${v.activeTeam === 'B' ? '' : 'dim'}`, style: 'color:var(--team-2)' }, [`Team B — ${v.scores.B}`]),
          el('span', { class: 'label grow center', text: `First to ${v.winScore}` }),
        ]);

    const dial = dialWidget(ctx, v);

    switch (v.phase) {
      case 'clue':
        return [score,
          v.amPsychic
            ? el('div', { class: 'stack stack--tight' }, [
                el('div', { class: 'banner banner--danger', text: 'Your team can see your face, not your screen.' }),
                dial,
                el('input', {
                  class: 'input', id: 'clue', maxlength: '60', autofocus: true,
                  placeholder: 'One word or short phrase',
                }),
              ])
            : [waiting(`${ctx.nameOf(ctx, v.psychic)} is thinking of a clue.`), dial],
        ].flat();

      case 'guess':
        return [score,
          el('div', { class: 'card center stack stack--tight' }, [
            label('The clue'), el('b', { class: 'secret__value', text: v.clue }),
          ]),
          dial,
          v.amPsychic
            ? el('div', { class: 'banner banner--danger', text: 'Say nothing. Don’t react.' })
            : label('Drag the dial. It locks when most of your team agrees.'),
          el('div', { class: 'label', text: `${v.locks.length} locked in` })];

      case 'bet': {
        const mine = v.myBet;
        const onOther = v.myTeam && v.myTeam !== v.activeTeam;
        return [score, dial,
          onOther
            ? el('div', { class: 'banner banner--accent', text: 'Is the real target left or right of the dial?' })
            : waiting('The other team is placing their bet.'),
          mine && el('div', { class: 'banner banner--good', text: `You said ${mine.toLowerCase()}.` })];
      }

      case 'reveal': {
        const r = v.lastResult;
        return [score, dial,
          outcomeBanner(
            `${r.points} point${r.points === 1 ? '' : 's'}${r.betPoints ? ` · other team +${r.betPoints}` : ''}`,
            r.points >= 3 ? 'banner--good' : r.points === 0 ? 'banner--danger' : '',
          ),
          el('div', { class: 'card stack stack--tight' }, [
            label('Clue'), el('b', { text: r.clue }),
            el('span', { class: 'dim t-sm', text: `Target was ${r.target.toFixed(1)}, you said ${r.dial.toFixed(1)}` }),
          ])];
      }

      case 'over':
        celebrate();
        return [score, outcomeBanner(
          v.mode === 'coop' ? `Final score: ${v.over.score}` : `Team ${v.over.winner} wins`,
          'banner--good',
        )];

      default:
        return [score];
    }
  },

  bottom(ctx) {
    const v = ctx.view;
    if (!v) return bottom([]);

    switch (v.phase) {
      case 'clue':
        if (!v.amPsychic) return waitingBar(`Waiting for ${ctx.nameOf(ctx, v.psychic)}`);
        return bottom([primary('Give this clue', {
          onclick: () => {
            const input = document.getElementById('clue');
            if (input?.value.trim()) ctx.send({ type: 'clue', clue: input.value });
          },
        })]);

      case 'guess':
        if (v.amPsychic) return waitingBar('Your team is deciding');
        if (v.locks.includes(ctx.me)) return waitingBar('Locked — waiting for your team');
        return bottom([primary('Lock in this position', { onclick: () => ctx.send({ type: 'lock' }) })]);

      case 'bet': {
        if (!v.myTeam || v.myTeam === v.activeTeam) return waitingBar('Waiting for the other team');
        if (v.myBet) return waitingBar('Bet placed');
        return bottom([voteButtons({
          yes: { value: 'LEFT', label: 'Further left' }, no: { value: 'RIGHT', label: 'Further right' },
          current: v.myBet, onVote: (value) => ctx.send({ type: 'bet', value }),
        })]);
      }

      case 'reveal':
        return bottom([ctx.isHost
          ? primary('Next round', { onclick: () => ctx.send({ type: 'next' }) })
          : el('button', { class: 'btn btn--secondary btn--block', disabled: true }, ['Waiting for the host'])]);

      case 'over':
        return playAgainBar(ctx);

      default:
        return bottom([]);
    }
  },

  options: (ctx, set) => [
    el('div', { class: 'optionrow' }, [
      el('span', { text: 'Mode' }),
      el('div', { class: 'seg' }, [['auto', 'Auto'], ['coop', 'Co-op'], ['teams', 'Teams']].map(([val, l]) =>
        el('button', {
          'aria-pressed': String(ctx.room.config.mode === val),
          onclick: () => set({ mode: val }),
        }, [l]))),
    ]),
  ],
};

/**
 * A horizontal track, not a rotary knob — thumbs are bad at arcs. The band is
 * only rendered when the server actually sent a target, so a non-psychic
 * client has nothing to reveal in devtools.
 */
function dialWidget(ctx, v) {
  const showBand = v.target !== null && v.target !== undefined;
  const canDrag = v.phase === 'guess' && !v.amPsychic && v.myTeam === v.activeTeam;

  const track = el('div', {
    class: 'well', style: 'position:relative;height:64px;margin:var(--sp-3) 0;overflow:hidden',
  }, [
    showBand && el('div', {
      style: `position:absolute;inset-block:0;left:${v.target - v.bands.outer}%;width:${v.bands.outer * 2}%;background:var(--game-accent);opacity:.18`,
    }),
    showBand && el('div', {
      style: `position:absolute;inset-block:0;left:${v.target - v.bands.inner}%;width:${v.bands.inner * 2}%;background:var(--game-accent);opacity:.28`,
    }),
    showBand && el('div', {
      style: `position:absolute;inset-block:0;left:${v.target - v.bands.bullseye}%;width:${v.bands.bullseye * 2}%;background:var(--game-accent);opacity:.55`,
    }),
    el('div', {
      style: `position:absolute;inset-block:6px;left:calc(${v.dial}% - 3px);width:6px;border-radius:3px;background:var(--text-1);box-shadow:var(--e-2)`,
    }),
  ]);

  if (canDrag) {
    const move = (clientX) => {
      const rect = track.getBoundingClientRect();
      const pct = Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100));
      ctx.send({ type: 'dial', value: Math.round(pct * 10) / 10 });
    };
    track.style.touchAction = 'none';
    track.addEventListener('pointerdown', (e) => {
      track.setPointerCapture(e.pointerId);
      move(e.clientX);
    });
    track.addEventListener('pointermove', (e) => {
      if (track.hasPointerCapture(e.pointerId)) move(e.clientX);
    });
  }

  const nudge = (delta) =>
    el('button', {
      class: 'btn btn--secondary', disabled: !canDrag,
      onclick: () => ctx.send({ type: 'dial', value: Math.max(0, Math.min(100, v.dial + delta)) }),
    }, [delta > 0 ? '+' : '−']);

  return el('div', { class: 'stack stack--tight' }, [
    el('div', { class: 'row' }, [
      el('span', { class: 'label grow', text: v.pair.low }),
      el('span', { class: 'label', style: 'text-align:right', text: v.pair.high }),
    ]),
    track,
    canDrag && el('div', { class: 'row' }, [nudge(-1), el('span', { class: 'grow center num t-lg', text: v.dial.toFixed(1) }), nudge(1)]),
  ]);
}


// ---------------------------------------------------------------- nightfall --

const NIGHT_TONE = { WOLF: 'var(--danger)', VILLAGE: 'var(--team-1)' };

const nightfall = {
  roleChip: (ctx) =>
    ctx.view?.myRoleInfo
      ? el('span', {
          class: 'chip',
          style: `color:${NIGHT_TONE[ctx.view.myTeam] ?? 'var(--text-2)'}`,
        }, [ctx.view.myRoleInfo.name])
      : null,

  body(ctx) {
    const v = ctx.view;
    if (!v) return [waiting('Dealing…')];
    const alive = ctx.room.players.filter((p) => v.alive[p.id]);
    const roster = () => el('ul', { class: 'plist' }, ctx.room.players.map((p) =>
      ctx.playerTile(ctx, p, {
        state: v.alive[p.id] ? null : 'dead',
        sub: !v.alive[p.id]
          ? (v.deadRoles[p.id] ? ROLE_LABEL(v, p.id) : 'Dead')
          : v.dayVoted.includes(p.id) ? 'Voted' : null,
      })));

    switch (v.phase) {
      case 'reveal':
        return [waiting('Everyone — pick up your phone.'),
          roleCard({
            kicker: v.myTeam === 'WOLF' ? 'Werewolf' : 'Village',
            name: v.myRoleInfo.name, detail: v.myRoleInfo.desc, emblem: 'g-nightfall',
            tone: NIGHT_TONE[v.myTeam],
          }),
          v.packmates.length
            ? el('div', { class: 'card stack stack--tight' }, [
                label('Your pack'),
                ...v.packmates.map((id) => el('b', { text: ctx.nameOf(ctx, id) })),
              ])
            : el('div', { class: 'banner', text: 'You know nobody. Everything you learn, you learn out loud.' }),
          el('div', { class: 'card stack stack--tight' }, [
            label('Roles in this game'),
            el('div', { class: 'row', style: 'flex-wrap:wrap' },
              v.rolesInPlay.map((r) => el('span', { class: 'chip', text: r.toLowerCase() }))),
          ])];

      case 'night':
        return [el('div', { class: 'banner banner--accent', text: `Night ${v.night}. Keep your voice down.` }),
          ...nightActionFor(ctx, v), roster()];

      case 'hunter':
        return [
          el('div', { class: 'banner banner--danger', text:
            v.pendingHunter === ctx.me
              ? 'You are down. Take someone with you.'
              : `${ctx.nameOf(ctx, v.pendingHunter)} was the Hunter and is taking a shot.` }),
          v.pendingHunter === ctx.me
            ? pickList(ctx, { candidates: alive.filter((p) => p.id !== ctx.me).map((p) => p.id) })
            : roster()];

      case 'day': {
        const dead = v.lastNight?.deaths ?? [];
        return [
          el('div', { class: `banner ${dead.length ? 'banner--danger' : 'banner--good'}` }, [
            el('b', { text: dead.length
              ? `${dead.map((id) => ctx.nameOf(ctx, id)).join(' and ')} died in the night.`
              : 'Nobody died in the night.' }),
          ]),
          !v.amAlive && el('div', { class: 'banner', text: 'You are dead. Watch, enjoy, and say nothing.' }),
          label('Who hangs?'),
          pickList(ctx, {
            candidates: v.amAlive ? alive.map((p) => p.id) : [],
            stateFor: (p) => (v.alive[p.id] ? null : 'dead'),
            subFor: (p) => (v.dayVoted.includes(p.id) ? 'Voted' : null),
          }),
          el('div', { class: 'label', text: `${v.dayVoted.length} of ${alive.length} voted` })];
      }

      case 'over': {
        const won = v.over.winner === v.myTeam;
        if (won) celebrate();
        return [
          outcomeBanner(
            v.over.winner === 'VILLAGE' ? 'The village survives.' : 'The wolves take the village.',
            won ? 'banner--good' : 'banner--danger'),
          label('Everyone’s role'),
          el('ul', { class: 'plist' }, ctx.room.players.map((p) =>
            ctx.playerTile(ctx, p, {
              sub: ROLE_INFO_NAME(v.reveal[p.id]),
              state: v.alive[p.id] ? null : 'dead',
            }))),
        ];
      }

      default:
        return [roster()];
    }
  },

  bottom(ctx) {
    const v = ctx.view;
    if (!v) return bottom([]);
    const pick = ctx.selected();

    switch (v.phase) {
      case 'reveal':
        return readyBar(ctx, { acked: v.acked, onAck: () => ctx.send({ type: 'ack' }) });

      case 'night':
        return nightBottom(ctx, v, pick);

      case 'hunter':
        if (v.pendingHunter !== ctx.me) return waitingBar(`Waiting for ${ctx.nameOf(ctx, v.pendingHunter)}`);
        return bottom([primary(pick ? `Take ${ctx.nameOf(ctx, pick)} with you` : 'Choose a target', {
          disabled: !pick, danger: true,
          onclick: () => ctx.send({ type: 'hunterShoot', target: pick }),
        })]);

      case 'day':
        if (!v.amAlive) return waitingBar('The dead do not vote');
        if (v.myDayVote) return waitingBar(`You voted for ${ctx.nameOf(ctx, v.myDayVote)}`);
        return bottom([primary(pick ? `Vote to hang ${ctx.nameOf(ctx, pick)}` : 'Select someone', {
          disabled: !pick, danger: true,
          onclick: () => ctx.send({ type: 'dayVote', target: pick }),
        })]);

      case 'over':
        return playAgainBar(ctx);

      default:
        return bottom([]);
    }
  },

  options: (ctx, set) => [
    toggleRow('Wolves win at parity', ctx.room.config.parityWin, (v) => set({ parityWin: v })),
    toggleRow('Reveal roles on death', ctx.room.config.revealRoleOnDeath, (v) => set({ revealRoleOnDeath: v })),
    toggleRow('No kill on the first night', ctx.room.config.noKillFirstNight, (v) => set({ noKillFirstNight: v })),
  ],
};

const ROLE_NAMES = {
  WOLF: 'Werewolf', VILLAGER: 'Villager', SEER: 'Seer',
  DOCTOR: 'Doctor', HUNTER: 'Hunter', WITCH: 'Witch',
};
const ROLE_INFO_NAME = (role) => ROLE_NAMES[role] ?? role;
const ROLE_LABEL = (v, id) => ROLE_INFO_NAME(v.deadRoles[id]);

/** Only the roles with something to do at night get an action surface. */
function nightActionFor(ctx, v) {
  const alive = ctx.room.players.filter((p) => v.alive[p.id]);
  const others = alive.filter((p) => p.id !== ctx.me);

  if (!v.amAlive) return [el('div', { class: 'banner', text: 'You are dead. Enjoy the show.' })];

  switch (v.myRole) {
    case 'WOLF':
      return [label('Agree on someone to take'),
        v.packmates.length
          ? el('div', { class: 'banner', text: `Your pack: ${v.packmates.map((id) => ctx.nameOf(ctx, id)).join(', ')}. You all have to agree.` })
          : null,
        pickList(ctx, {
          candidates: alive.filter((p) => !v.packmates.includes(p.id) && p.id !== ctx.me).map((p) => p.id),
          subFor: (p) => {
            const voters = Object.entries(v.wolfVotes).filter(([, t]) => t === p.id).map(([w]) => ctx.nameOf(ctx, w));
            return voters.length ? `${voters.join(', ')} wants this` : null;
          },
        })];

    case 'SEER':
      return [label('Check one player'),
        pickList(ctx, { candidates: others.map((p) => p.id) }),
        Object.keys(v.seerResults).length
          ? el('div', { class: 'card stack stack--tight' }, [
              label('What you know'),
              ...Object.entries(v.seerResults).map(([id, isWolf]) =>
                el('div', { class: 'row' }, [
                  el('b', { text: ctx.nameOf(ctx, id) }),
                  el('span', { style: `color:${isWolf ? 'var(--danger)' : 'var(--success)'}`,
                    text: isWolf ? 'is a werewolf' : 'is not a werewolf' }),
                ])),
            ])
          : null];

    case 'DOCTOR':
      return [label('Protect one player'),
        v.lastProtected && el('div', { class: 'banner', text: `You protected ${ctx.nameOf(ctx, v.lastProtected)} last night — not them again.` }),
        pickList(ctx, { candidates: alive.filter((p) => p.id !== v.lastProtected).map((p) => p.id) })];

    case 'WITCH':
      return [
        v.witchVictim
          ? el('div', { class: 'secret' }, [
              label('The wolves have chosen'),
              el('b', { class: 'secret__value', text: ctx.nameOf(ctx, v.witchVictim) }),
            ])
          : waiting('Waiting to see who the wolves choose.'),
        el('div', { class: 'label', text:
          `Potions left: ${v.witch.healUsed ? '' : 'heal'}${!v.witch.healUsed && !v.witch.poisonUsed ? ' + ' : ''}${v.witch.poisonUsed ? '' : 'poison'}` || 'none' }),
        !v.witch.poisonUsed && v.witchVictim !== null
          ? el('div', { class: 'stack stack--tight' }, [label('Poison someone (optional)'),
              pickList(ctx, { candidates: alive.map((p) => p.id) })])
          : null];

    default:
      return [waiting('You have nothing to do tonight. Sit tight and listen.')];
  }
}

function nightBottom(ctx, v, pick) {
  const submitted = {
    WOLF: v.wolfVotes[ctx.me] !== undefined,
    SEER: Object.keys(v.seerResults).length > 0 && v.phase === 'night',
    DOCTOR: v.myDoctorTarget !== null,
    WITCH: v.witchDone,
  }[v.myRole];

  if (!v.amAlive) return waitingBar('The night passes without you');

  switch (v.myRole) {
    case 'WOLF':
      return bottom([primary(pick ? `Take ${ctx.nameOf(ctx, pick)}` : 'Choose a victim', {
        disabled: !pick, danger: true,
        onclick: () => ctx.send({ type: 'wolfKill', target: pick }),
      })]);

    case 'SEER':
      if (submitted) return waitingBar('Checked — waiting for the night to pass');
      return bottom([primary(pick ? `Check ${ctx.nameOf(ctx, pick)}` : 'Choose someone to check', {
        disabled: !pick, onclick: () => ctx.send({ type: 'inspect', target: pick }),
      })]);

    case 'DOCTOR':
      if (submitted) return waitingBar('Protected — waiting for the night to pass');
      return bottom([primary(pick ? `Protect ${ctx.nameOf(ctx, pick)}` : 'Choose someone to protect', {
        disabled: !pick, onclick: () => ctx.send({ type: 'protect', target: pick }),
      })]);

    case 'WITCH': {
      if (submitted) return waitingBar('Waiting for the night to pass');
      if (v.witchVictim === null) return waitingBar('Waiting for the wolves');
      // Saving is the affirmative move, so it takes the primary slot; poison
      // is the destructive one and reads as danger. Every branch keeps exactly
      // one primary so the bar is never just a row of grey options.
      return bottom([
        !v.witch.healUsed
          ? primary(`Save ${ctx.nameOf(ctx, v.witchVictim)}`, {
              onclick: () => ctx.send({ type: 'witch', heal: true, poison: null }),
            })
          : primary(pick ? `Poison ${ctx.nameOf(ctx, pick)}` : 'Choose someone to poison', {
              disabled: !pick || v.witch.poisonUsed, danger: true,
              onclick: () => ctx.send({ type: 'witch', heal: false, poison: pick }),
            }),
        !v.witch.healUsed && pick && !v.witch.poisonUsed && el('button', {
          class: 'btn btn--danger btn--block',
          onclick: () => ctx.send({ type: 'witch', heal: false, poison: pick }),
        }, [`Poison ${ctx.nameOf(ctx, pick)}`]),
        el('button', {
          class: 'btn btn--ghost btn--block',
          onclick: () => ctx.send({ type: 'witch', heal: false, poison: null }),
        }, ['Do nothing tonight']),
      ]);
    }

    default:
      return waitingBar('Waiting for the night to pass');
  }
}

// ------------------------------------------------------------------ holdem --

/**
 * Raise sizing has to live outside the render tree.
 *
 * Every server broadcast re-renders the screen. If the slider position lived in
 * the DOM, a player reconnecting elsewhere at the table would reset your bet
 * mid-drag. Keyed on the betting situation so it resets exactly when the
 * decision changes and never otherwise.
 */
let raiseUi = { key: null, open: false, to: 0 };

function raiseKeyFor(v) {
  return `${v.handNo}:${v.street}:${v.currentBet}:${v.legal?.maxRaiseTo ?? 0}`;
}

function syncRaiseUi(v) {
  const key = raiseKeyFor(v);
  if (raiseUi.key === key) return;
  raiseUi = { key, open: false, to: v.legal?.minRaiseTo ?? 0 };
}

const STREET_NAME = { preflop: 'Pre-flop', flop: 'Flop', turn: 'Turn', river: 'River' };

function potStrip(v) {
  return el('div', { class: 'pokerpot' }, [
    el('span', { class: 'label', text: `${STREET_NAME[v.street] ?? ''} · Hand ${v.handNo}` }),
    el('b', { class: 'pokerpot__amt', text: `${chips(v.potTotal)}` }),
    el('span', { class: 'label', text: `Blinds ${chips(v.blinds.sb)}/${chips(v.blinds.bb)}` }),
  ]);
}

function boardRow(ctx, v) {
  // Highlighting only ever uses YOUR winning five — the server sends other
  // players' best hands at showdown, and drawing theirs on the board would be
  // unreadable rather than informative.
  const best = new Set(v.seats.find((s) => s.id === ctx.me)?.best ?? []);
  const cards = [];
  for (let i = 0; i < 5; i++) {
    cards.push(v.board[i] === undefined ? cardSlot() : playingCard(v.board[i], { best: best.has(v.board[i]) }));
  }
  return el('div', { class: 'pokerboard' }, cards);
}

/** Your own two cards, always the largest thing on the screen. */
function myCards(ctx, v) {
  const me = v.seats.find((s) => s.id === ctx.me);
  if (!me || !me.hole?.length) {
    return el('div', { class: 'card center stack stack--tight' }, [
      label(me ? 'Sitting out this hand' : 'Watching'),
      me?.place ? el('b', { text: `You finished ${ordinal(me.place)}` }) : null,
    ]);
  }
  const best = new Set(me.best ?? []);
  return el('div', { class: `pokerhand ${me.folded ? 'is-folded' : ''}` }, [
    el('div', { class: 'pokerhand__cards' }, me.hole.map((c) => playingCard(c, { size: 'lg', best: best.has(c), dim: me.folded }))),
    el('div', { class: 'pokerhand__meta' }, [
      el('b', { class: 'pokerhand__name', text: me.folded ? 'Folded' : (v.myHand ?? 'Waiting for the flop') }),
      el('span', { class: 'label', text: `Your stack ${chips(me.stack)}` }),
    ]),
  ]);
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'][(n % 100 > 10 && n % 100 < 14) || n % 10 > 3 ? 0 : n % 10];
  return `${n}${s}`;
}

function actionLabel(seat) {
  const a = seat.lastAction;
  if (!a) return null;
  if (a.kind === 'fold') return 'Fold';
  if (a.kind === 'check') return 'Check';
  if (a.kind === 'sb') return `SB ${chips(a.amount)}`;
  if (a.kind === 'bb') return `BB ${chips(a.amount)}`;
  if (a.kind === 'allIn') return `All in ${chips(a.amount)}`;
  return `${a.kind === 'call' ? 'Call' : a.kind === 'bet' ? 'Bet' : 'Raise'} ${chips(a.amount)}`;
}

function seatRows(ctx, v) {
  return el('ul', { class: 'plist' }, v.seats.map((s) => {
    const player = ctx.room.players.find((p) => p.id === s.id) ?? { id: s.id, name: 'Player', online: true };
    const badges = [];
    if (s.isButton) badges.push(el('span', { class: 'bdg bdg--btn', title: 'Dealer button' }, ['D']));
    if (s.hole && s.id !== ctx.me) {
      badges.push(el('span', { class: 'pokerpeek' }, s.hole.map((c) => playingCard(c, { size: 'xs' }))));
    }
    const bits = [`${chips(s.stack)}`];
    if (s.committed > 0) bits.push(actionLabel(s) ?? `In ${chips(s.committed)}`);
    else if (s.lastAction) bits.push(actionLabel(s));
    if (s.handName) bits.push(s.handName);
    if (s.won > 0) bits.push(`won ${chips(s.won)}`);

    return ctx.playerTile(ctx, player, {
      sub: bits.join(' · '),
      state: s.place ? 'OUT' : s.folded && s.inHand ? 'FOLDED' : s.allIn ? 'ALL IN' : s.acting ? 'TO ACT' : undefined,
      badges,
    });
  }));
}

function handoverBanner(ctx, v) {
  const r = v.result;
  if (!r) return null;
  const winners = Object.entries(r.won).filter(([, amount]) => amount > 0);
  if (!winners.length) return null;
  const text = winners
    .map(([id, amount]) => `${ctx.nameOf(ctx, id)} wins ${chips(amount)}`)
    .join(' · ');
  const mine = r.won[ctx.me] > 0;
  if (mine) celebrate();
  return outcomeBanner(text, mine ? 'banner--good' : '');
}

/** Presets are how people actually bet. A raw slider alone is unusable. */
function raisePresets(v, onPick) {
  const legal = v.legal;
  const options = [
    ['Min', legal.minRaiseTo],
    ['½ pot', Math.round(v.potTotal / 2) + v.currentBet],
    ['Pot', v.potTotal + v.currentBet],
    ['All in', legal.maxRaiseTo],
  ];
  const seen = new Set();
  return el('div', { class: 'seg seg--wrap' }, options.map(([name, raw]) => {
    const to = Math.max(legal.minRaiseTo, Math.min(legal.maxRaiseTo, raw));
    // Short stacks collapse every preset onto the same number; show it once.
    if (seen.has(to) && name !== 'All in') return null;
    seen.add(to);
    return el('button', {
      'aria-pressed': String(raiseUi.to === to),
      onclick: () => onPick(to),
    }, [name]);
  }).filter(Boolean));
}

function raisePanel(ctx, v) {
  const legal = v.legal;
  const readout = el('b', { class: 'raise__amt', text: chips(raiseUi.to) });
  const slider = el('input', {
    class: 'raise__slider', type: 'range', min: String(legal.minRaiseTo), max: String(legal.maxRaiseTo),
    step: String(Math.max(1, v.blinds.sb)), value: String(raiseUi.to),
    'aria-label': 'Raise to',
  });
  // Updated in place rather than through render(), so the drag is never
  // interrupted by an unrelated broadcast.
  slider.addEventListener('input', () => {
    raiseUi.to = Number(slider.value);
    readout.textContent = chips(raiseUi.to);
    for (const b of panel.querySelectorAll('.seg button')) b.setAttribute('aria-pressed', 'false');
  });

  const setTo = (to) => {
    raiseUi.to = to;
    slider.value = String(to);
    readout.textContent = chips(to);
    for (const b of panel.querySelectorAll('.seg button')) {
      b.setAttribute('aria-pressed', String(b.textContent === 'All in' && to === legal.maxRaiseTo));
    }
    buzz('confirm');
  };

  const panel = el('div', { class: 'raise' }, [
    el('div', { class: 'raise__head' }, [
      el('span', { class: 'label', text: legal.raiseIsBet ? 'Bet' : 'Raise to' }),
      readout,
    ]),
    slider,
    raisePresets(v, setTo),
    el('div', { class: 'row row--split' }, [
      el('button', {
        class: 'btn btn--ghost grow',
        onclick: () => { raiseUi.open = false; ctx.rerender(); },
      }, ['Back']),
      el('button', {
        class: 'btn btn--primary grow',
        onclick: () => {
          raiseUi.open = false;
          ctx.send({ type: 'act', move: 'raise', to: raiseUi.to });
        },
      }, [`${legal.raiseIsBet ? 'Bet' : 'Raise to'} ${chips(raiseUi.to)}`]),
    ]),
  ]);
  return panel;
}

const holdem = {
  roleChip: (ctx) => {
    const v = ctx.view;
    const me = v?.seats.find((s) => s.id === ctx.me);
    if (!me) return null;
    // Stacks are public information at a poker table, so this one is plain.
    return el('span', { class: 'chip', style: 'color:var(--game-accent)' }, [chips(me.stack)]);
  },

  body(ctx) {
    const v = ctx.view;
    if (!v) return [waiting('Shuffling…')];

    if (v.phase === 'over') {
      const iWon = v.over.winner === ctx.me;
      if (iWon) celebrate();
      return [
        outcomeBanner(`${ctx.nameOf(ctx, v.over.winner)} wins the tournament`, iWon ? 'banner--good' : ''),
        label('Finishing order'),
        el('ul', { class: 'plist' }, v.over.standings.map((s) => {
          const player = ctx.room.players.find((p) => p.id === s.id) ?? { id: s.id, name: 'Player', online: true };
          return ctx.playerTile(ctx, player, { sub: ordinal(s.place), state: s.place === 1 ? 'WON' : undefined });
        })),
      ];
    }

    return [
      potStrip(v),
      boardRow(ctx, v),
      v.phase === 'handover' && handoverBanner(ctx, v),
      myCards(ctx, v),
      v.myTurn && el('div', { class: 'banner banner--accent', text: 'Your turn.' }),
      seatRows(ctx, v),
    ].filter(Boolean);
  },

  bottom(ctx) {
    const v = ctx.view;
    if (!v) return bottom([]);

    if (v.phase === 'over') return playAgainBar(ctx);
    if (v.phase === 'handover') {
      return bottom([primary('Deal the next hand', { onclick: () => ctx.send({ type: 'deal' }) })]);
    }

    const me = v.seats.find((s) => s.id === ctx.me);
    if (!me || !me.inHand) return waitingBar(me?.place ? `Out in ${ordinal(me.place)}` : 'Watching this hand');
    if (!v.myTurn) {
      if (me.folded) return waitingBar('You folded — sit tight');
      if (me.allIn) return waitingBar('All in — nothing more to do');
      return waitingBar(v.actor ? `Waiting for ${ctx.nameOf(ctx, v.actor)}` : 'Dealing…');
    }

    syncRaiseUi(v);
    const legal = v.legal;
    if (raiseUi.open && legal.raise) return bottom([raisePanel(ctx, v)]);

    // Fold sits away from the two safe actions and is never the widest target,
    // because the one misfire nobody forgives is folding the winning hand.
    return bottom([
      el('div', { class: 'pokeract' }, [
        el('button', {
          class: 'btn btn--danger',
          onclick: () => ctx.send({ type: 'act', move: 'fold' }),
        }, ['Fold']),
        legal.check
          ? el('button', {
              class: 'btn btn--primary grow',
              onclick: () => ctx.send({ type: 'act', move: 'check' }),
            }, ['Check'])
          : el('button', {
              class: 'btn btn--primary grow',
              onclick: () => ctx.send({ type: 'act', move: 'call' }),
            }, [legal.callIsAllIn ? `Call all in ${chips(legal.callAmount)}` : `Call ${chips(legal.callAmount)}`]),
        legal.raise && el('button', {
          class: 'btn btn--secondary grow',
          onclick: () => { raiseUi.open = true; ctx.rerender(); },
        }, [legal.raiseIsBet ? 'Bet' : 'Raise']),
      ].filter(Boolean)),
    ]);
  },

  options: (ctx, set) => [
    el('div', { class: 'optionrow' }, [
      el('span', { text: 'Stacks' }),
      el('div', { class: 'seg' }, [[1000, 'Short'], [2000, 'Normal'], [5000, 'Deep']].map(([val, l]) =>
        el('button', {
          'aria-pressed': String(ctx.room.config.startingStack === val),
          onclick: () => set({ startingStack: val }),
        }, [l]))),
    ]),
    el('div', { class: 'optionrow' }, [
      el('span', { text: 'Blinds up' }),
      el('div', { class: 'seg' }, [[3, 'Fast'], [6, 'Normal'], [12, 'Slow'], [0, 'Never']].map(([val, l]) =>
        el('button', {
          'aria-pressed': String(ctx.room.config.blindMinutes === val),
          onclick: () => set({ blindMinutes: val }),
        }, [l]))),
    ]),
    el('div', { class: 'optionrow' }, [
      el('span', { text: 'Clock' }),
      el('div', { class: 'seg' }, [[20, '20s'], [45, '45s'], [90, '90s']].map(([val, l]) =>
        el('button', {
          'aria-pressed': String(ctx.room.config.actionSeconds === val),
          onclick: () => set({ actionSeconds: val }),
        }, [l]))),
    ]),
  ],
};

// ------------------------------------------------------------------- cheat --

/**
 * Which cards are selected has to outlive a re-render for the same reason the
 * bet sizer does: someone else joining or reconnecting redraws the screen, and
 * losing a half-built play mid-turn is maddening.
 */
let cheatPick = { key: null, cards: [] };

function syncCheatPick(v) {
  const key = `${v.rank}:${v.turn}:${v.phase}`;
  if (cheatPick.key !== key) cheatPick = { key, cards: [] };
}

/** Your hand: a wrapping grid, because ten cards on a phone will not fit a row. */
function cheatHand(ctx, v) {
  const selectable = v.myTurn;
  return el('div', { class: 'cheathand', role: selectable ? 'group' : null, 'aria-label': 'Your cards' },
    (v.hand ?? []).map((card) => {
      const picked = cheatPick.cards.includes(card);
      const node = el('button', {
        class: `cheatcard ${picked ? 'is-picked' : ''}`,
        disabled: !selectable,
        'aria-pressed': String(picked),
        onclick: () => {
          if (picked) cheatPick.cards = cheatPick.cards.filter((c) => c !== card);
          // Four is the cap, and silently ignoring a fifth tap reads as broken.
          else if (cheatPick.cards.length >= 4) return toast('Four cards is the most you can put down');
          else cheatPick.cards = [...cheatPick.cards, card];
          buzz('confirm');
          ctx.rerender();
        },
      }, [playingCard(card, { size: 'md' })]);
      return node;
    }),
  );
}

function cheatPile(ctx, v) {
  const stack = Math.min(4, v.pileCount);
  return el('div', { class: 'cheatpile' }, [
    el('div', { class: 'cheatpile__stack' },
      stack ? Array.from({ length: stack }, () => playingCard(null, { size: 'md' })) : [cardSlot()]),
    el('div', { class: 'stack stack--tight' }, [
      el('b', { class: 'cheatpile__n', text: String(v.pileCount) }),
      el('span', { class: 'label', text: v.pileCount === 1 ? 'card face down' : 'cards face down' }),
    ]),
  ]);
}

const cheat = {
  roleChip: (ctx) => {
    const n = ctx.view?.counts?.[ctx.me];
    if (n === undefined) return null;
    return el('span', { class: 'chip', style: 'color:var(--game-accent)' }, [`${n} left`]);
  },

  body(ctx) {
    const v = ctx.view;
    if (!v) return [waiting('Dealing…')];

    if (v.phase === 'over') {
      const won = v.over.winner === ctx.me;
      if (won) celebrate();
      return [
        outcomeBanner(`${ctx.nameOf(ctx, v.over.winner)} got rid of every card`, won ? 'banner--good' : ''),
        label('Left holding'),
        el('ul', { class: 'plist' }, v.over.standings.map((s) => {
          const p = ctx.room.players.find((x) => x.id === s.id) ?? { id: s.id, name: 'Player', online: true };
          return ctx.playerTile(ctx, p, {
            sub: s.cards === 0 ? 'Nothing' : `${s.cards} card${s.cards === 1 ? '' : 's'}`,
            state: s.place === 1 ? 'WON' : undefined,
          });
        })),
      ];
    }

    const claim = v.lastPlay && el('div', { class: 'card center stack stack--tight' }, [
      label(`${ctx.nameOf(ctx, v.lastPlay.by)} says`),
      el('b', { class: 'secret__value', text: `${v.lastPlay.count} × ${v.lastPlay.rankName}` }),
      v.lastPlay.cards
        ? el('div', { class: 'row', style: 'justify-content:center;gap:var(--sp-2)' },
            v.lastPlay.cards.map((c) => playingCard(c, { size: 'md' })))
        : el('div', { class: 'row', style: 'justify-content:center;gap:var(--sp-2)' },
            Array.from({ length: v.lastPlay.count }, () => playingCard(null, { size: 'md' }))),
    ]);

    const verdict = v.reveal && outcomeBanner(
      v.reveal.lying
        ? `${ctx.nameOf(ctx, v.lastPlay.by)} was lying — ${ctx.nameOf(ctx, v.reveal.loser)} takes ${v.reveal.pileSize + v.lastPlay.count}`
        : `It was true — ${ctx.nameOf(ctx, v.reveal.caller)} takes ${v.reveal.pileSize + v.lastPlay.count}`,
      v.reveal.loser === ctx.me ? 'banner--danger' : 'banner--good',
    );

    return [
      el('div', { class: 'row' }, [
        el('span', { class: 'label grow', text: `Next up: ${v.rankName}` }),
        el('span', { class: 'label', text: `${v.pileCount} in the pile` }),
      ]),
      cheatPile(ctx, v),
      verdict,
      claim,
      v.phase === 'play' && (v.myTurn
        ? el('div', { class: 'banner banner--accent', text: `Put down anything and call it ${v.rankName}.` })
        : waiting(`${ctx.nameOf(ctx, v.turn)} is choosing.`)),
      v.phase === 'challenge' && !v.canChallenge && v.lastPlay.by !== ctx.me
        && el('div', { class: 'banner', text: 'You let it go.' }),
      v.goingOut && el('div', { class: 'banner banner--danger', text:
        `${ctx.nameOf(ctx, v.goingOut)} is out of cards. Call it now or they win.` }),
      label('Your hand'),
      cheatHand(ctx, v),
      el('ul', { class: 'plist' }, v.order.map((id) => {
        const p = ctx.room.players.find((x) => x.id === id) ?? { id, name: 'Player', online: true };
        return ctx.playerTile(ctx, p, {
          sub: `${v.counts[id]} card${v.counts[id] === 1 ? '' : 's'}`,
          state: id === v.turn && v.phase === 'play' ? 'turn' : undefined,
        });
      })),
    ].filter(Boolean);
  },

  bottom(ctx) {
    const v = ctx.view;
    if (!v) return bottom([]);
    if (v.phase === 'over') return playAgainBar(ctx);
    if (v.phase === 'reveal') return waitingBar('Next player up…');

    if (v.phase === 'challenge') {
      if (v.lastPlay.by === ctx.me) return waitingBar('See if anyone calls it');
      if (!v.canChallenge) return waitingBar('Waiting for the others');
      return bottom([
        el('div', { class: 'row row--split' }, [
          el('button', {
            class: 'btn btn--danger grow',
            onclick: () => ctx.send({ type: 'challenge' }),
          }, [`Cheat!`]),
          el('button', {
            class: 'btn btn--secondary grow',
            onclick: () => ctx.send({ type: 'pass' }),
          }, ['Let it go']),
        ]),
      ]);
    }

    if (!v.myTurn) return waitingBar(`Waiting for ${ctx.nameOf(ctx, v.turn)}`);

    syncCheatPick(v);
    const n = cheatPick.cards.length;
    return bottom([
      primary(n ? `Play ${n} as ${v.rankName}` : `Pick cards to call ${v.rankName}`, {
        disabled: n === 0,
        onclick: () => {
          const cards = cheatPick.cards;
          cheatPick = { key: null, cards: [] };
          ctx.send({ type: 'play', cards });
        },
      }),
    ]);
  },

  options: (ctx, set) => [
    el('div', { class: 'optionrow' }, [
      el('span', { text: 'Time to call' }),
      el('div', { class: 'seg' }, [[8, 'Snappy'], [15, 'Normal'], [30, 'Relaxed']].map(([val, l]) =>
        el('button', {
          'aria-pressed': String(ctx.room.config.challengeSeconds === val),
          onclick: () => set({ challengeSeconds: val }),
        }, [l]))),
    ]),
  ],
};

export const GAME_UI = { council, oddoneout, sabotage, spectrum, nightfall, holdem, cheat };

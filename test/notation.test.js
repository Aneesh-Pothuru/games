/**
 * Range notation.
 *
 * Every published chart is a string in this notation, so a parsing bug here
 * silently corrupts every piece of preflop advice the coach gives. The one
 * that matters most: `+` climbs the PAIRS for 77+ and the KICKER for A9s+,
 * and getting that backwards produces a range that looks plausible and is
 * completely wrong.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  ALL_CLASSES, COMBO_COUNT, classOf, comboCount, combosOf, describeRange,
  parseRange, rangeCombos, rangePercent,
} from '../src/games/poker/notation.js';
import { parseCard } from '../src/games/poker/cards.js';

const R = (s) => parseRange(s);
const sorted = (range) => ALL_CLASSES.filter((c) => range.has(c));

describe('hand classes', () => {
  test('there are exactly 169 of them', () => {
    assert.equal(ALL_CLASSES.length, 169);
    assert.equal(new Set(ALL_CLASSES).size, 169);
    assert.equal(ALL_CLASSES.filter((c) => c.length === 2).length, 13);
    assert.equal(ALL_CLASSES.filter((c) => c.endsWith('s')).length, 78);
    assert.equal(ALL_CLASSES.filter((c) => c.endsWith('o')).length, 78);
  });

  test('the combos add up to all 1326 hands', () => {
    const total = ALL_CLASSES.reduce((n, c) => n + COMBO_COUNT(c), 0);
    assert.equal(total, 1326);
    assert.equal(13 * 6 + 78 * 4 + 78 * 12, 1326);
  });

  test('every combo of every class is a real, distinct pair of cards', () => {
    const seen = new Set();
    for (const cls of ALL_CLASSES) {
      const combos = combosOf(cls);
      assert.equal(combos.length, COMBO_COUNT(cls), cls);
      for (const [a, b] of combos) {
        assert.notEqual(a, b, cls);
        assert.ok(a >= 0 && a < 52 && b >= 0 && b < 52, cls);
        const key = a < b ? `${a}:${b}` : `${b}:${a}`;
        assert.ok(!seen.has(key), `${cls} duplicates a combo`);
        seen.add(key);
      }
    }
    assert.equal(seen.size, 1326, 'every one of the 1326 hands appears once');
  });

  test('classOf is the inverse of combosOf', () => {
    for (const cls of ALL_CLASSES) {
      for (const [a, b] of combosOf(cls)) assert.equal(classOf(a, b), cls);
    }
  });

  test('classOf does not care which card comes first', () => {
    const [ah, ks] = [parseCard('Ah'), parseCard('Ks')];
    assert.equal(classOf(ah, ks), 'AKo');
    assert.equal(classOf(ks, ah), 'AKo');
    assert.equal(classOf(parseCard('Ah'), parseCard('Kh')), 'AKs');
  });
});

describe('parsing', () => {
  test('a single class', () => {
    assert.deepEqual(sorted(R('AA')), ['AA']);
    assert.deepEqual(sorted(R('AKs')), ['AKs']);
    assert.deepEqual(sorted(R('72o')), ['72o']);
  });

  test('+ on a pair climbs the pairs', () => {
    assert.deepEqual(sorted(R('TT+')), ['AA', 'KK', 'QQ', 'JJ', 'TT']);
    assert.equal(R('22+').size, 13);
  });

  test('+ on a non-pair climbs the KICKER, not the top card', () => {
    // The classic parsing bug: A9s+ must NOT include KTs.
    assert.deepEqual(sorted(R('A9s+')), ['AKs', 'AQs', 'AJs', 'ATs', 'A9s']);
    assert.deepEqual(sorted(R('KTs+')), ['KQs', 'KJs', 'KTs']);
    assert.deepEqual(sorted(R('AJo+')), ['AKo', 'AQo', 'AJo']);
    assert.ok(!R('A9s+').has('KTs'));
    assert.ok(!R('KTs+').has('AKs'));
  });

  test('+ on the top of a row is just that hand', () => {
    assert.deepEqual(sorted(R('AKs+')), ['AKs']);
    assert.deepEqual(sorted(R('AA+')), ['AA']);
  });

  test('runs of pairs', () => {
    assert.deepEqual(sorted(R('99-66')), ['99', '88', '77', '66']);
    assert.deepEqual(sorted(R('66-99')), ['99', '88', '77', '66'], 'either order');
  });

  test('runs along a row', () => {
    assert.deepEqual(sorted(R('A5s-A2s')), ['A5s', 'A4s', 'A3s', 'A2s']);
  });

  test('runs down the connector diagonal', () => {
    assert.deepEqual(sorted(R('T9s-76s')), ['T9s', '98s', '87s', '76s']);
    assert.deepEqual(sorted(R('QJo-9To'.replace('9To', 'T9o'))), ['QJo', 'JTo', 'T9o']);
  });

  test('a run of unequal gaps is refused rather than guessed at', () => {
    assert.equal(R('T9s-75s').size, 0);
  });

  test('AXs takes the whole row', () => {
    const row = sorted(R('AXs'));
    assert.equal(row.length, 12);
    assert.ok(row.includes('AKs') && row.includes('A2s'));
    assert.ok(!row.includes('AA'), 'AA is a pair, not part of the ace row');
  });

  test('a whole chart line', () => {
    const range = R('77+, A9s+, KTs+, QTs+, JTs, AJo+, KQo');
    assert.ok(range.has('AA') && range.has('77') && !range.has('66'));
    assert.ok(range.has('A9s') && !range.has('A8s'));
    assert.ok(range.has('KQo') && !range.has('KJo'));
    assert.ok(range.has('JTs') && !range.has('J9s'));
  });

  test('whitespace and case do not matter', () => {
    assert.deepEqual(sorted(R('  aKs ,  tt+ ')), sorted(R('AKs,TT+')));
  });

  test('garbage is ignored, not thrown', () => {
    assert.doesNotThrow(() => R('AA, ZZ, 1s, , A9x, --'));
    assert.ok(R('AA, ZZ, ???').has('AA'));
  });

  test('the notation round-trips', () => {
    const text = '88+, ATs+, KJs+, QJs, AQo+';
    assert.deepEqual(sorted(R(describeRange(R(text)))), sorted(R(text)));
  });
});

describe('range weight', () => {
  test('combo counts', () => {
    assert.equal(comboCount(R('AA')), 6);
    assert.equal(comboCount(R('AKs')), 4);
    assert.equal(comboCount(R('AKo')), 12);
    assert.equal(comboCount(R('AK')), 0, 'AK without a suffix is not a class');
    assert.equal(comboCount(R('AKs, AKo')), 16, 'all of AK is 16 combos');
  });

  test('every hand is 100%', () => {
    const all = new Set(ALL_CLASSES);
    assert.equal(comboCount(all), 1326);
    assert.equal(Math.round(rangePercent(all)), 100);
  });

  test('a typical button open is around a fifth of hands', () => {
    // 22+, A2s+, K9s+, Q9s+, J9s+, T8s+, 97s+, 86s+, 75s+, 65s, 54s,
    // A9o+, KTo+, QTo+, JTo  — a standard ~40% BTN RFI is much wider; this
    // is a mid-position open and should land near 20%.
    const pct = rangePercent(R('22+, A9s+, KTs+, QTs+, JTs, AJo+, KQo'));
    assert.ok(pct > 8 && pct < 16, `${pct.toFixed(1)}%`);
  });

  test('percentages rise monotonically as a range widens', () => {
    const a = rangePercent(R('QQ+, AKs'));
    const b = rangePercent(R('TT+, AQs+, AKo'));
    const c = rangePercent(R('22+, A2s+, K9s+, QTs+, JTs, ATo+, KQo'));
    assert.ok(a < b && b < c, `${a} ${b} ${c}`);
  });
});

describe('card removal', () => {
  test('holding an ace removes ace combos from the opponent range', () => {
    const range = R('AA, AKs');
    assert.equal(rangeCombos(range).length, 10);
    // Ace of spades in our hand: AA loses 3 of 6, AKs loses 1 of 4.
    const dead = [parseCard('As')];
    assert.equal(rangeCombos(range, dead).length, 6);
  });

  test('holding both blockers removes more', () => {
    const range = R('AA');
    assert.equal(rangeCombos(range, [parseCard('As')]).length, 3);
    assert.equal(rangeCombos(range, [parseCard('As'), parseCard('Ah')]).length, 1);
  });

  test('a board card blocks too', () => {
    const range = R('AKs');
    const dead = [parseCard('Ah'), parseCard('7c'), parseCard('2d')];
    assert.equal(rangeCombos(range, dead).length, 3, 'only the heart combo is gone');
  });

  test('removal never invents a combo', () => {
    const range = new Set(ALL_CLASSES);
    const dead = [parseCard('As'), parseCard('Kd'), parseCard('7h')];
    const combos = rangeCombos(range, dead);
    // C(49,2) = 1176 hands remain once three cards are visible.
    assert.equal(combos.length, 1176);
    for (const [a, b] of combos) {
      assert.ok(!dead.includes(a) && !dead.includes(b));
    }
  });
});

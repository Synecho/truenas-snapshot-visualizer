import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuery, parseSize, parseAge } from '../../static/js/query.js';

const GiB = 2 ** 30;
const MiB = 2 ** 20;
const DAY = 86400;

function snap(dataset, name, { used = 0, written = 0, referenced = 0, ageDays = 1, holds = 0 } = {}) {
  const id = `${dataset}@${name}`;
  return { id, lower: id.toLowerCase(), dataset, name, used, written, referenced, age: ageDays * DAY, holds };
}

const SNAPS = [
  snap('tank/vm', 'auto-hourly-1', { used: 200 * MiB, written: 2 * GiB, referenced: 50 * GiB, ageDays: 0.5 }),
  snap('tank/vm', 'auto-daily-1', { used: 12 * GiB, written: 20 * GiB, referenced: 60 * GiB, ageDays: 10 }),
  snap('tank/home', 'auto-weekly-1', { used: 3 * GiB, written: 1 * GiB, referenced: 900 * GiB, ageDays: 45, holds: 1 }),
  snap('tank/home', 'manual-2026-01', { used: 0, written: 0, referenced: 2048 * GiB, ageDays: 400 }),
];

const names = (q, metric) => {
  const { match } = parseQuery(q, metric);
  return SNAPS.filter(s => !match || match(s)).map(s => s.name);
};

test('units', () => {
  assert.equal(parseSize('10g').value, 10 * GiB);
  assert.equal(parseSize('1,5GiB').value, 1.5 * GiB);
  assert.equal(parseSize('500mb').value, 500 * MiB);
  assert.equal(parseSize('7b').value, 7);
  assert.equal(parseSize('abc'), null);
  assert.equal(parseAge('2w').value, 14 * DAY);
  assert.equal(parseAge('30').value, 30 * DAY);
  assert.equal(parseAge('12h').value, 12 * 3600);
  assert.equal(parseAge('x'), null);
});

test('plain text and negation', () => {
  assert.deepEqual(names('auto'), ['auto-hourly-1', 'auto-daily-1', 'auto-weekly-1']);
  assert.deepEqual(names('tank/vm -hourly'), ['auto-daily-1']);
  assert.deepEqual(names('2026'), ['manual-2026-01']);
});

test('size uses the current metric unless one is named', () => {
  assert.deepEqual(names('>1g'), ['auto-daily-1', 'auto-weekly-1']);
  assert.deepEqual(names('>1g', 'written'), ['auto-hourly-1', 'auto-daily-1']);
  assert.deepEqual(names('ref>=1t'), ['manual-2026-01']);
  assert.deepEqual(names('used<1m'), ['manual-2026-01']);
  assert.deepEqual(names('100m..5g'), ['auto-hourly-1', 'auto-weekly-1']);
  assert.deepEqual(names('5g..100m'), ['auto-hourly-1', 'auto-weekly-1'], 'reversed range');
  assert.deepEqual(names('=12g'), ['auto-daily-1'], 'about 12 GiB');
});

test('age', () => {
  assert.deepEqual(names('age>30d'), ['auto-weekly-1', 'manual-2026-01']);
  assert.deepEqual(names('age<1d'), ['auto-hourly-1']);
  assert.deepEqual(names('age:1w..2mo'), ['auto-daily-1', 'auto-weekly-1']);
  assert.deepEqual(names('age>1y'), ['manual-2026-01']);
  assert.deepEqual(names('age:10d'), ['auto-daily-1']);
});

test('held and combinations', () => {
  assert.deepEqual(names('held'), ['auto-weekly-1']);
  assert.deepEqual(names('-held tank/home'), ['manual-2026-01']);
  assert.deepEqual(names('tank/vm >1g age<30d'), ['auto-daily-1']);
});

test('words that only look like fields stay text', () => {
  for (const w of ['agent', 'reference', 'used', 'size', 'age']) {
    assert.deepEqual(parseQuery(w).invalid, [], w);
  }
});

test('invalid terms are reported and ignored', () => {
  assert.deepEqual(parseQuery('age>abc tank').invalid, ['age>abc']);
  assert.deepEqual(names('age>abc tank/vm'), ['auto-hourly-1', 'auto-daily-1']);
  assert.deepEqual(parseQuery('>5g..10g').invalid, ['>5g..10g']);
  assert.deepEqual(parseQuery('1g..2g..3g').invalid, ['1g..2g..3g']);
  assert.deepEqual(parseQuery('/[/').invalid, ['/[/']);
});

test('regex', () => {
  assert.deepEqual(names('/^tank\\/home@auto/'), ['auto-weekly-1']);
});

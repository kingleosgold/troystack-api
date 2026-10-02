// scripts/backfill-ptpd.js puts frozen platinum and palladium values in
// price_log back to Yahoo's daily close, and leaves everything else alone.
//   node --test
// In-process only: axios, supabase and fs are fakes, no network.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { parseArgs, closeOn, readRows, planBackfill, undoRecord, main, MIN_FROZEN_DAYS } = require(path.join(__dirname, '..', 'scripts', 'backfill-ptpd.js'));

const ts = (date, hour) => `${date}T${String(hour).padStart(2, '0')}:00:00+00:00`;

function frozenRows() {
  const rows = [];
  let id = 1;
  // Five frozen days, three rows a day, the way the fetcher re-logged them.
  for (const date of ['2026-06-15', '2026-06-16', '2026-06-17', '2026-06-18', '2026-06-19']) {
    for (const hour of [0, 8, 16]) rows.push({ id: id++, timestamp: ts(date, hour), platinum_price: 2098.09, palladium_price: 1560.02 });
  }
  // A live day, every value different.
  [[0, 1720.4, 1180.5], [8, 1722.9, 1182], [16, 1719.6, 1179.25]].forEach(([hour, pt, pd]) => {
    rows.push({ id: id++, timestamp: ts('2026-09-28', hour), platinum_price: pt, palladium_price: pd });
  });
  // The switch day, frozen in the morning and live after the fix.
  rows.push({ id: id++, timestamp: ts('2026-09-25', 6), platinum_price: 2098.09, palladium_price: 1560.02 });
  rows.push({ id: id++, timestamp: ts('2026-09-25', 23), platinum_price: 1774.1, palladium_price: 1270.5 });
  // A row with no platinum logged.
  rows.push({ id: id++, timestamp: ts('2026-06-20', 12), platinum_price: null, palladium_price: null });
  return rows;
}

const BARS = {
  platinum: [
    { date: '2026-06-15', close: 1770 }, { date: '2026-06-16', close: 1812.1 }, { date: '2026-06-17', close: 1790.7 },
    { date: '2026-06-18', close: 1705.2 }, { date: '2026-06-19', close: 1731.5 }, { date: '2026-09-25', close: 1774.7 },
    { date: '2026-09-28', close: 1721.2 },
  ],
  palladium: [
    { date: '2026-06-15', close: 1201 }, { date: '2026-06-16', close: 1212.5 }, { date: '2026-06-17', close: 1199 },
    { date: '2026-06-18', close: 1188 }, { date: '2026-06-19', close: 1190.5 }, { date: '2026-09-25', close: 1271 },
    { date: '2026-09-28', close: 1181 },
  ],
};

test('frozen values get their day\'s Yahoo close, live and null rows stay', () => {
  const plan = planBackfill(frozenRows(), BARS);

  assert.deepStrictEqual(plan.platinum.frozen, [{ value: 2098.09, days: 6 }]);
  assert.deepStrictEqual(plan.palladium.frozen, [{ value: 1560.02, days: 6 }]);
  assert.deepStrictEqual(plan.platinum.days.map((d) => [d.date, d.close, d.ids.length]), [
    ['2026-06-15', 1770, 3], ['2026-06-16', 1812.1, 3], ['2026-06-17', 1790.7, 3],
    ['2026-06-18', 1705.2, 3], ['2026-06-19', 1731.5, 3], ['2026-09-25', 1774.7, 1],
  ]);
  assert.strictEqual(plan.platinum.rowCount, 16);
  assert.strictEqual(plan.palladium.rowCount, 16);
  const touched = new Set(plan.platinum.days.flatMap((d) => d.ids));
  for (const row of frozenRows()) {
    const live = row.timestamp.startsWith('2026-09-28') || row.platinum_price === 1774.1 || row.platinum_price === null;
    assert.strictEqual(touched.has(row.id), !live, `row ${row.id} at ${row.timestamp}`);
  }
});

test('a real quote that repeats on two days stays, even more than 1% off the close', () => {
  // From price_log on 10/2: platinum printed 1,827.03 at 22:00 on Sunday 8/30
  // and again at midnight going into Monday. Friday 8/28 settled at 1,847.60
  // and Monday 8/31 at 1,788.40, so both rows sit more than 1% off.
  const rows = [
    ...frozenRows(),
    { id: 101, timestamp: ts('2026-08-30', 22), platinum_price: 1827.03, palladium_price: 1422.47 },
    { id: 102, timestamp: ts('2026-08-31', 0), platinum_price: 1827.03, palladium_price: 1422.47 },
  ];
  const bars = {
    platinum: [...BARS.platinum, { date: '2026-08-28', close: 1847.6 }, { date: '2026-08-31', close: 1788.4 }].sort((a, b) => a.date.localeCompare(b.date)),
    palladium: [...BARS.palladium, { date: '2026-08-28', close: 1428.6 }, { date: '2026-08-31', close: 1362.9 }].sort((a, b) => a.date.localeCompare(b.date)),
  };
  const plan = planBackfill(rows, bars);
  const touched = new Set([...plan.platinum.days, ...plan.palladium.days].flatMap((d) => d.ids));
  assert.ok(!touched.has(101) && !touched.has(102), 'the live repeat is left alone');
  assert.strictEqual(plan.platinum.rowCount, 16, 'the frozen rows still change');
  assert.ok(MIN_FROZEN_DAYS >= 5);
});

test('a weekend repeat of Friday\'s price within 1% of the close is left alone', () => {
  const rows = [
    { id: 1, timestamp: ts('2026-07-10', 20), platinum_price: 1801.25, palladium_price: 1190.1 },
    { id: 2, timestamp: ts('2026-07-11', 12), platinum_price: 1801.25, palladium_price: 1190.1 },
    { id: 3, timestamp: ts('2026-07-12', 12), platinum_price: 1801.25, palladium_price: 1190.1 },
  ];
  const bars = { platinum: [{ date: '2026-07-10', close: 1805 }], palladium: [{ date: '2026-07-10', close: 1192 }] };
  const plan = planBackfill(rows, bars, { minDays: 2 });
  assert.strictEqual(plan.platinum.rowCount, 0);
  assert.strictEqual(plan.palladium.rowCount, 0);
});

test('weekends and holidays use the last close before them', () => {
  const bars = [{ date: '2026-07-10', close: 1805 }, { date: '2026-07-13', close: 1790 }];
  assert.strictEqual(closeOn(bars, '2026-07-12'), 1805);
  assert.strictEqual(closeOn(bars, '2026-07-13'), 1790);
  assert.strictEqual(closeOn(bars, '2026-07-09'), null);
});

test('arguments are checked before anything runs', () => {
  assert.deepStrictEqual(parseArgs([]), { apply: false, undo: null, from: '2026-04-01', to: '2026-09-27' });
  assert.deepStrictEqual(parseArgs(['--apply', '--from', '2026-05-01', '--to', '2026-05-31']), { apply: true, undo: null, from: '2026-05-01', to: '2026-05-31' });
  assert.strictEqual(parseArgs(['--undo', 'undo.json']).undo, 'undo.json');
  assert.throws(() => parseArgs(['--undo']));
  assert.throws(() => parseArgs(['--undo', 'undo.json', '--apply']));
  assert.throws(() => parseArgs(['--from', '5/1']));
  assert.throws(() => parseArgs(['--from', '2026-06-01', '--to', '2026-05-01']));
  assert.throws(() => parseArgs(['--yes']));
});

// ---------- the driver, with fakes ----------

function fakeSupabase(rows) {
  const updates = [];
  const selects = [];
  return {
    updates,
    selects,
    from(table) {
      assert.strictEqual(table, 'price_log');
      const q = { gt: null, gte: null, lt: null, limit: Infinity };
      const select = {
        select() { return select; },
        gt(col, v) { q.gt = v; return select; },
        gte(col, v) { q.gte = v; return select; },
        lt(col, v) { q.lt = v; return select; },
        order() { return select; },
        limit(n) { q.limit = n; return select; },
        then(resolve, reject) {
          selects.push({ ...q });
          const t = (r) => Date.parse(r.timestamp);
          const data = rows
            .filter((r) => (q.gt == null || t(r) > Date.parse(q.gt)) && (q.gte == null || t(r) >= Date.parse(q.gte)) && (q.lt == null || t(r) < Date.parse(q.lt)))
            .sort((a, b) => t(a) - t(b))
            .slice(0, Math.min(q.limit, 1000));
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      };
      return {
        select: select.select,
        update(values) {
          return {
            in(col, ids) {
              assert.strictEqual(col, 'id');
              updates.push({ values, ids });
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
  };
}

function fakeAxios() {
  return {
    async get(url) {
      const symbol = url.match(/chart\/([A-Z]+=F)\?/)[1];
      const bars = symbol === 'PL=F' ? BARS.platinum : BARS.palladium;
      return {
        data: {
          chart: {
            result: [{
              meta: { gmtoffset: -14400 },
              timestamp: bars.map((b) => Date.parse(`${b.date}T04:00:00Z`) / 1000),
              indicators: { quote: [{ close: bars.map((b) => b.close) }] },
            }],
          },
        },
      };
    },
  };
}

function fakeFs() {
  const files = {};
  return {
    files,
    writeFileSync(p, data) { files[p] = String(data); },
    readFileSync(p) {
      if (!(p in files)) throw new Error(`ENOENT ${p}`);
      return files[p];
    },
  };
}

test('a dry run plans the changes and writes nothing', async () => {
  const supabase = fakeSupabase(frozenRows());
  const files = fakeFs();
  const lines = [];
  const { plan, written } = await main(['--from', '2026-06-01', '--to', '2026-09-30'], { supabase, axios: fakeAxios(), fs: files, log: (l) => lines.push(l) });
  assert.strictEqual(written, 0);
  assert.strictEqual(supabase.updates.length, 0);
  assert.deepStrictEqual(Object.keys(files.files), [], 'no undo file on a dry run');
  assert.strictEqual(plan.platinum.rowCount, 16);
  assert.ok(lines.some((l) => l.includes('frozen values 2098.09 on 6 days')));
  assert.ok(lines.some((l) => l.includes('Dry run')));
});

test('--apply writes an undo file first, then each day\'s close to only the frozen rows', async () => {
  const supabase = fakeSupabase(frozenRows());
  const files = fakeFs();
  const { written, undoPath } = await main(['--apply', '--from', '2026-06-01', '--to', '2026-09-30'], { supabase, axios: fakeAxios(), fs: files, undoDir: '/undo', log: () => {} });
  assert.strictEqual(written, 32);
  assert.ok(supabase.updates.every((u) => u.ids.length <= 150));
  const june15 = supabase.updates.find((u) => u.values.platinum_price === 1770);
  assert.deepStrictEqual(june15.ids, [1, 2, 3]);
  const pdSwitchDay = supabase.updates.find((u) => u.values.palladium_price === 1271);
  assert.strictEqual(pdSwitchDay.ids.length, 1, 'only the frozen morning row on the switch day');

  assert.ok(undoPath.startsWith(path.join('/undo', 'backfill-ptpd-undo-')));
  const record = JSON.parse(files.files[undoPath]);
  assert.deepStrictEqual(record.entries.map((e) => [e.column, e.value, e.ids.length]), [
    ['platinum_price', 2098.09, 16], ['palladium_price', 1560.02, 16],
  ]);
  assert.deepStrictEqual(record.entries[0].ids, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 19]);
});

test('--undo puts the recorded rows back to their old values', async () => {
  const plan = planBackfill(frozenRows(), BARS);
  const record = undoRecord(plan, { from: '2026-06-01', to: '2026-09-30' });
  const files = fakeFs();
  files.writeFileSync('undo.json', JSON.stringify(record));
  const supabase = fakeSupabase([]);

  const { written } = await main(['--undo', 'undo.json'], { supabase, axios: fakeAxios(), fs: files, log: () => {} });
  assert.strictEqual(written, 32);
  assert.deepStrictEqual(supabase.updates.map((u) => [Object.keys(u.values)[0], Object.values(u.values)[0], u.ids.length]), [
    ['platinum_price', 2098.09, 16], ['palladium_price', 1560.02, 16],
  ]);

  files.writeFileSync('bad.json', JSON.stringify({ script: 'something-else', entries: [] }));
  await assert.rejects(main(['--undo', 'bad.json'], { supabase, axios: fakeAxios(), fs: files, log: () => {} }));
  files.writeFileSync('gold.json', JSON.stringify({ script: 'backfill-ptpd', entries: [{ column: 'gold_price', value: 1, ids: [1] }] }));
  await assert.rejects(main(['--undo', 'gold.json'], { supabase, axios: fakeAxios(), fs: files, log: () => {} }));
});

test('the row reader pages past 1,000 rows', async () => {
  const rows = [];
  for (let i = 0; i < 2500; i++) {
    rows.push({ id: i + 1, timestamp: new Date(Date.parse('2026-05-01T00:00:00Z') + i * 300000).toISOString().replace('Z', '+00:00'), platinum_price: 2098.09, palladium_price: 1560.02 });
  }
  const supabase = fakeSupabase(rows);
  const got = await readRows(supabase, '2026-05-01', '2026-05-31');
  assert.strictEqual(got.length, 2500);
  assert.ok(supabase.selects.length >= 3);
});

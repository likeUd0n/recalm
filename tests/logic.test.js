// 実行: npm test(= node --test)。時刻はすべて端末のローカル時刻で作る。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dayKeyOf, normalizeMatch, matchesNeedingUpdate, runningTallies, dailyTally, tallyText,
  shiftDayKey, reviewRates, isPeakTime, isWeekendDay, matchTimeTags, timeSlotOf,
  buildBackup, parseBackup, backupStatus, timeTagStats, statsScope, sessionElapsedStats, winRateHold, splitHeroInput, trialProgress, askSteps, isAskEmpty, buildDraft, restoreDraft,
  searchByName, roleRecords, reviewEntries, latestNextMove,
} from '../js/logic.js';

// 日本時間で書く(設計書 F3)。月は1始まり(Date の月は0始まりなので -1 する)。端末のタイムゾーンに左右されないよう UTC から作る。
const at = (y, mo, d, h, mi = 0) => new Date(Date.UTC(y, mo - 1, d, h - 9, mi));
const match = (id, when, role, result) => ({ id, createdAt: when.toISOString(), role, result });

// 手計算用の5試合。2026-10-19 の夜から翌 1:30 まで遊んだ想定。モード(Ranked・Quick)は記録しない。
//   1. 10/19 21:00 Tank       Victory
//   2. 10/19 21:30 ロールなし Defeat   ← ロールのない以前の記録
//   3. 10/19 22:10 Tank       Defeat
//   4. 10/19 23:50 DPS        Victory
//   5. 10/20  1:30 Tank       Defeat   ← 0:00 を過ぎているので 10/20 の1日
const five = [
  match('m1', at(2026, 10, 19, 21, 0), 'tank', 'win'),
  match('m2', at(2026, 10, 19, 21, 30), null, 'loss'),
  match('m3', at(2026, 10, 19, 22, 10), 'tank', 'loss'),
  match('m4', at(2026, 10, 19, 23, 50), 'damage', 'win'),
  match('m5', at(2026, 10, 20, 1, 30), 'tank', 'loss'),
];

test('5試合の1日の累計: ロール別。10/19 は Tank 1-1・DPS 1-0・ロール不明 0-1、10/20 は Tank 0-1', () => {
  // 10/19 Tank: m1 勝(1-0) → m3 負(1-1)。DPS: m4 勝(1-0)。ロール不明: m2 負(0-1)
  // 10/20(0:00〜): m5 Tank 負 → 0勝1敗
  // 並び順は Tank → DPS → Support → ロール不明。
  const tally = dailyTally(five, '2026-10-19');
  assert.deepEqual(tally.map((t) => tallyText(t)), ['Tank 1-1', 'DPS 1-0', 'ロール不明 0-1']);
  assert.deepEqual(dailyTally(five, '2026-10-20').map((t) => tallyText(t)), ['Tank 0-1']);
});

test('5試合の試合ごとの累計(手書きの「Tank:1-2」の行にあたる)', () => {
  // 上の計算過程の各段階がそのまま試合ごとの値になる。
  const running = runningTallies(five);
  const text = (id) => tallyText(running.get(id), ':');
  assert.equal(text('m1'), 'Tank:1-0');
  assert.equal(text('m2'), 'ロール不明:0-1');
  assert.equal(text('m3'), 'Tank:1-1');
  assert.equal(text('m4'), 'DPS:1-0');
  assert.equal(text('m5'), 'Tank:0-1'); // 0:00 を過ぎたので累計はリセット
});

test('入力順に並んでいなくても、入力時刻の順で数える', () => {
  const running = runningTallies([...five].reverse());
  assert.equal(tallyText(running.get('m3'), ':'), 'Tank:1-1');
});

test('日付の区切り: 23:59 は当日、0:00 は翌日', () => {
  assert.equal(dayKeyOf(at(2026, 10, 19, 23, 59)), '2026-10-19');
  assert.equal(dayKeyOf(at(2026, 10, 20, 0, 0)), '2026-10-20');
  assert.equal(dayKeyOf(at(2026, 10, 20, 3, 59)), '2026-10-20');
  // 月をまたぐ場合: 11/1 0:30 は 11/1 の1日。
  assert.equal(dayKeyOf(at(2026, 11, 1, 0, 30)), '2026-11-01');
});

test('日付をまたぐと累計がリセットされる(23:59 と 0:00)', () => {
  // a: 10/19 23:59 Tank 勝 → 10/19 の1日で Tank 1-0
  // b: 10/20 0:00 Tank 負 → 10/20 の1日の最初の試合なので Tank 0-1(1-1 にはならない)
  const a = match('a', at(2026, 10, 19, 23, 59), 'tank', 'win');
  const b = match('b', at(2026, 10, 20, 0, 0), 'tank', 'loss');
  const running = runningTallies([a, b]);
  assert.equal(tallyText(running.get('a'), ':'), 'Tank:1-0');
  assert.equal(tallyText(running.get('b'), ':'), 'Tank:0-1');
  assert.deepEqual(dailyTally([a, b], '2026-10-19').map((t) => tallyText(t)), ['Tank 1-0']);
  assert.deepEqual(dailyTally([a, b], '2026-10-20').map((t) => tallyText(t)), ['Tank 0-1']);
});

test('以前の記録の移行: モードの値(mode・ranked)を消し、日付を 0:00 区切りで計算し直す', () => {
  // 4:00 区切りで保存された、10/20 1:00 の試合は date が 10-19 で保存されている。
  const legacy = { id: 'L', createdAt: at(2026, 10, 20, 1, 0).toISOString(), date: '2026-10-19', timeSlot: 'late-night', ranked: true, inputSeconds: 12 };
  const fixed = normalizeMatch(legacy);
  assert.equal(fixed.date, '2026-10-20');
  assert.equal(fixed.role, null);
  assert.equal('ranked' in fixed, false);
  assert.equal('mode' in fixed, false);
  assert.equal(fixed.inputSeconds, 12); // ほかの項目は消さない
  assert.deepEqual(matchesNeedingUpdate([legacy]), [fixed]);
  // 計算し直しても変わらない試合は返さない。
  assert.deepEqual(matchesNeedingUpdate([fixed]), []);
  // 日付などは合っていて、mode だけが残っている試合も、消すために返す。
  const withMode = { ...fixed, mode: 'quick' };
  assert.deepEqual(matchesNeedingUpdate([withMode]), [fixed]);
});

test('日をずらす: 月末をまたぐ', () => {
  assert.equal(shiftDayKey('2026-10-31', 1), '2026-11-01');
  assert.equal(shiftDayKey('2026-11-01', -1), '2026-10-31');
});

test('振り返りの記入率(上の5試合)', () => {
  // 振り返り(pickReason = ピックの理由、failure = うまくいかなかったこと、improvement = 改善点、memo = 自由メモ。
  // 以前の did = 成長したこと・didNot = 反省点は数えない):
  //   m1 勝: なし
  //   m2 負: 3欄すべて
  //   m3 負: 自由メモと以前の成長したことだけ(数えない)
  //   m4 勝: ピックの理由だけ
  //   m5 負: うまくいかなかったことだけ
  const reviews = new Map([
    ['m2', { pickReason: '前線を押すためにロードホッグ', failure: '分断された', improvement: '味方と離れない' }],
    ['m3', { memo: 'ドゥームに一生バックラインを荒らされた。', did: '以前の記録' }],
    ['m4', { pickReason: 'カウンターでベンチャー' }],
    ['m5', { failure: '前に出すぎた' }],
  ]);
  //   振り返り記入率   = 書いた試合 m2, m4, m5 / 5試合                         = 3/5
  //   改善点(負けた試合) = 負け m2, m3, m5 のうち改善点あり m2                  = 1/3  ← 成功の判定
  //   改善点への到達率 = 理由か失敗あり m2, m4, m5 のうち改善点あり m2           = 1/3
  const all = reviewRates(five, reviews);
  assert.deepEqual(all.reviewed, { num: 3, den: 5 });
  assert.deepEqual(all.improvementOnLoss, { num: 1, den: 3 });
  assert.deepEqual(all.improvementAfterFacts, { num: 1, den: 3 });
});

test('気持ちの記入率: 自由メモ(いまの気持ち)を書いた試合 / 全試合。空白だけは数えない', () => {
  const reviews = new Map([
    ['m1', { memo: 'イライラした' }],
    ['m2', { memo: '   ', improvement: '味方と離れない' }],
    ['m4', { memo: '落ち着いて打てた' }],
  ]);
  assert.deepEqual(reviewRates(five, reviews).feeling, { num: 2, den: 5 });
  assert.deepEqual(reviewRates([], new Map()).feeling, { num: 0, den: 0 });
});

test('空白だけの欄は書いたことにしない', () => {
  const reviews = new Map([['m2', { improvement: '   ' }]]);
  assert.deepEqual(reviewRates(five, reviews).improvementOnLoss, { num: 0, den: 3 });
});

test('実力差の移行: 以前の「実力差のあるマッチ」の印は mismatch に、印なしは空のまま', () => {
  const old = [
    { ...match('o1', at(2026, 10, 19, 20, 0), 'tank', 'win'), mismatch: true },
    { ...match('o2', at(2026, 10, 19, 20, 30), 'tank', 'win'), mismatch: false },
    { ...match('o3', at(2026, 10, 19, 21, 0), 'damage', 'loss'), skillGap: 'gg', mismatch: true },
  ];
  assert.deepEqual(old.map((m) => normalizeMatch(m).skillGap), ['mismatch', null, 'gg']);
  // 一度移行した試合は、もう計算し直さない。
  assert.equal(matchesNeedingUpdate(matchesNeedingUpdate(old)).length, 0);
});

test('ピークタイム: 19:00〜24:00(ゴールデン)だけ。それ以外はオフピーク', () => {
  const peak = (h, mi = 0) => isPeakTime(at(2026, 10, 19, h, mi));
  assert.deepEqual(
    [peak(18, 59), peak(19, 0), peak(22, 0), peak(23, 59), peak(0, 0), peak(0, 59), peak(11, 0), peak(4, 0)],
    [false, true, true, true, false, false, false, false],
  );
});

test('時間帯の5区分(日本サーバー基準): 朝6-11・昼11-16・夕方16-19・ゴールデン19-24・深夜0-6', () => {
  const slot = (h, mi = 0) => timeSlotOf(at(2026, 10, 19, h, mi)).id;
  assert.deepEqual(
    [slot(5, 59), slot(6, 0), slot(10, 59), slot(11, 0), slot(15, 59), slot(16, 0), slot(18, 59), slot(19, 0), slot(23, 59), slot(0, 0), slot(3, 0)],
    ['late-night', 'morning', 'morning', 'daytime', 'daytime', 'evening', 'evening', 'golden', 'golden', 'late-night', 'late-night'],
  );
});

test('土日の判定は日付(0:00区切り)で行う(2026-10-17 は土曜、10-18 は日曜)', () => {
  assert.deepEqual(['2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19'].map(isWeekendDay), [false, true, true, false]);
  // 月曜 10/19 の 2:00 は月曜 → 平日。土曜 10/17 の 3:00 は土曜 → 土日。
  assert.deepEqual(matchTimeTags(at(2026, 10, 19, 2, 0)), { peak: false, weekend: false });
  assert.deepEqual(matchTimeTags(at(2026, 10, 17, 3, 0)), { peak: false, weekend: true });
  // 平日の夜はピークタイムで土日ではない。土曜の夜はピークタイムだが土日(質は不安定として扱う)。
  assert.deepEqual(matchTimeTags(at(2026, 10, 19, 21, 0)), { peak: true, weekend: false });
  assert.deepEqual(matchTimeTags(at(2026, 10, 17, 21, 0)), { peak: true, weekend: true });
});

test('時間帯別の勝敗: ピークタイム/オフピークと土日/平日は別々に数える(5試合の手計算)', () => {
  const m = (id, d, result) => ({ id, createdAt: d.toISOString(), result });
  const ms = [
    m('1', at(2026, 10, 19, 21, 0), 'win'), // 月曜21:00 → ピーク・平日
    m('2', at(2026, 10, 19, 21, 30), 'loss'), // 月曜21:30 → ピーク・平日
    m('3', at(2026, 10, 19, 10, 0), 'win'), // 月曜10:00 → オフピーク・平日
    m('4', at(2026, 10, 17, 21, 0), 'win'), // 土曜21:00 → ピーク・土日
    m('5', at(2026, 10, 19, 2, 0), 'loss'), // 月曜2:00 → オフピーク・平日
  ];
  // ピーク: 1(勝)・2(負)・4(勝) → 2-1(3試合)。オフピーク: 3(勝)・5(負) → 1-1(2試合)。
  // 土日: 4(勝) → 1-0(1試合)。平日: 1(勝)・2(負)・3(勝)・5(負) → 2-2(4試合)。どれも10試合未満なので参考値。
  const s = timeTagStats(ms);
  const pick = (rows) => rows.map((r) => [r.key, r.wins, r.losses, r.total, r.reference]);
  assert.deepEqual(pick(s.peak), [['peak', 2, 1, 3, true], ['offpeak', 1, 1, 2, true]]);
  assert.deepEqual(pick(s.weekend), [['weekend', 1, 0, 1, true], ['weekday', 2, 2, 4, true]]);
  assert.equal(s.peak[0].rate, 2 / 3);
  // 記録がなければ、どの行も0試合で勝率は null
  const empty = timeTagStats([]);
  assert.deepEqual(empty.peak.map((r) => [r.total, r.rate]), [[0, null], [0, null]]);
  // 入力時刻が読めない試合は数えない
  assert.equal(timeTagStats([{ id: 'x', createdAt: 'x', result: 'win' }]).peak[0].total, 0);
});

test('セッションの経過時間: 30分ごとに分け、10試合未満の区分から後ろをまとめる', () => {
  const m = (id, d, result) => ({ id, createdAt: d.toISOString(), result });
  const ms = [
    // 1つ目のセッション: 20:00 から3分ごとに20試合(0〜30分に10試合、30〜60分に10試合)
    ...Array.from({ length: 10 }, (_, i) => m(`a${i}`, at(2026, 10, 19, 20, i * 3), 'win')),
    ...Array.from({ length: 10 }, (_, i) => m(`b${i}`, at(2026, 10, 19, 20, 30 + i * 3), i % 2 ? 'loss' : 'win')),
    // 60〜90分に3試合、90〜120分に1試合。60〜90分が10試合未満なので、そこから後ろは「60分〜」にまとめる
    m('c0', at(2026, 10, 19, 21, 0), 'loss'),
    m('c1', at(2026, 10, 19, 21, 10), 'loss'),
    m('c2', at(2026, 10, 19, 21, 20), 'draw'),
    m('c3', at(2026, 10, 19, 21, 40), 'win'),
    // 前の記録(21:40)から60分ちょうどは新しいセッションの0分目
    m('d0', at(2026, 10, 19, 22, 40), 'loss'),
  ].reverse(); // 入力順に並んでいなくても、入力時刻の順で数える
  const s = sessionElapsedStats(ms);
  assert.deepEqual(s.map((r) => [r.from, r.last, r.wins, r.losses, r.draws, r.total, r.reference]), [
    [0, false, 10, 1, 0, 11, false],
    [30, false, 5, 5, 0, 10, false],
    [60, true, 1, 2, 1, 4, true],
  ]);
  assert.equal(s[1].rate, 0.5);
  assert.equal(s[2].rate, 1 / 3);
  // 0〜30分が10試合未満なら、1つの区分「0分〜」だけになる
  assert.deepEqual(sessionElapsedStats(ms.slice(-3)).map((r) => [r.from, r.last, r.total]), [[0, true, 3]]);
  // 記録がなければ空。入力時刻が読めない試合は数えない
  assert.deepEqual(sessionElapsedStats([]), []);
  assert.deepEqual(sessionElapsedStats([{ id: 'x', createdAt: 'x', result: 'win' }]), []);
});

test('winRateHold: 0分から続けて勝率50%以上だった区分の終わりを返す', () => {
  const r = (from, rate, total, last = false) => ({ from, rate, total, last, reference: total < 10 });
  // 0〜30・30〜60 は50%以上、60〜90 で下回る → 60分まで
  assert.deepEqual(winRateHold([r(0, 0.6, 10), r(30, 0.5, 12), r(60, 0.4, 10), r(90, 0.7, 3, true)]), { until: 60, toEnd: false });
  // 参考値の区分で止まる
  assert.deepEqual(winRateHold([r(0, 0.6, 10), r(30, 0.8, 4, true)]), { until: 30, toEnd: false });
  // 最後の「N分〜」まで保てた
  assert.deepEqual(winRateHold([r(0, 0.6, 10), r(30, 0.6, 10, true)]), { until: 30, toEnd: true });
  // 最初の区分で止まれば出さない
  assert.equal(winRateHold([r(0, 0.4, 10), r(30, 0.6, 10, true)]), null);
  assert.equal(winRateHold([r(0, 0.9, 5, true)]), null);
  assert.equal(winRateHold([]), null);
});

test('成功の判定の試用: 負けた試合が10試合たまるまでの残りを数える', () => {
  assert.deepEqual(trialProgress(0), { done: false, remaining: 10 });
  assert.deepEqual(trialProgress(7), { done: false, remaining: 3 });
  assert.deepEqual(trialProgress(10), { done: true, remaining: 0 });
  assert.deepEqual(trialProgress(12), { done: true, remaining: 0 });
});

test('マスター: Reaper は Flex DPS、Hanzo は Main DPS(ユーザー指定)', async () => {
  const { readFile } = await import('node:fs/promises');
  const master = JSON.parse(await readFile(new URL('../data/master.json', import.meta.url), 'utf8'));
  const sub = (id) => master.heroes.find((x) => x.id === id).subrole;
  assert.equal(sub('reaper'), 'flexdps');
  assert.equal(sub('hanzo'), 'maindps');
});

test('バックアップ: 書き出したものをそのまま読み込める', () => {
  const stores = {
    matches: [{ id: 'm1', createdAt: at(2026, 10, 19, 21).toISOString(), result: 'win' }],
    reviews: [{ matchId: 'm1', memo: 'メモ', did: '以前の記録' }],
    meta: [{ key: 'lastRole', value: 'tank' }, { key: 'lastBackupAt', value: 'x' }, { key: 'autoSaveDir', value: {} }],
    images: [{ key: 'map:a', data: 'ignored' }], // 画像は含めない
  };
  const backup = buildBackup(stores, at(2026, 10, 19, 22));
  assert.equal(backup.app, 'recalm');
  assert.deepEqual(Object.keys(backup.stores).sort(), ['bans', 'compTypes', 'days', 'matches', 'meta', 'reviews', 'slots']);
  assert.deepEqual(backup.stores.meta.map((r) => r.key), ['lastRole']); // lastBackupAt・autoSaveDir は書き出さない
  const parsed = parseBackup(JSON.stringify(backup));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.matchCount, 1);
  assert.deepEqual(parsed.stores.reviews, stores.reviews); // 以前の項目(did)も消えない
  // この端末の状態(lastBackupAt)は取り込まない
  assert.deepEqual(parsed.stores.meta.map((r) => r.key), ['lastRole']);
});

test('バックアップ: 形式が違うものは取り込まない', () => {
  assert.equal(parseBackup('これはJSONではない').ok, false);
  assert.equal(parseBackup('{"app":"other","stores":{}}').ok, false);
  assert.equal(parseBackup('{"app":"recalm","version":2,"stores":{}}').ok, false);
  assert.equal(parseBackup('{"app":"recalm","version":1,"stores":{"matches":{}}}').ok, false);
  const noTime = JSON.stringify({ app: 'recalm', version: 1, stores: { matches: [{ id: 'm1' }] } });
  assert.equal(parseBackup(noTime).ok, false);
});

test('バックアップ: 不正な行が1つでもあれば取り込まない(途中で失敗して記録が欠けないように)', () => {
  const ok = { id: 'm1', createdAt: at(2026, 10, 19, 21).toISOString(), result: 'win' };
  const with_ = (stores) => parseBackup(JSON.stringify({ app: 'recalm', version: 1, stores: { matches: [ok], ...stores } })).ok;
  assert.equal(with_({}), true);
  assert.equal(with_({ matches: [{ ...ok, createdAt: 1700000000000 }] }), false); // 入力時刻が文字列でない
  assert.equal(with_({ matches: [{ ...ok, result: 'WIN' }] }), false);
  assert.equal(with_({ reviews: [{ memo: 'matchId がない' }] }), false);
  assert.equal(with_({ days: [null] }), false);
  assert.equal(with_({ slots: [{ matchId: 'm1', id: { x: 1 } }] }), false);
  assert.equal(with_({ slots: [{ matchId: 'm1' }] }), true); // id は自動採番なので、なくてよい
  assert.equal(with_({ meta: ['lastRole'] }), false);
});

test('日付・時間帯は日本時間で決める(端末のタイムゾーンに左右されない)', () => {
  // UTC 15:00 = 日本時間の翌 0:00
  assert.equal(dayKeyOf(new Date('2026-10-19T14:59:00Z')), '2026-10-19');
  assert.equal(dayKeyOf(new Date('2026-10-19T15:00:00Z')), '2026-10-20');
  assert.equal(timeSlotOf(new Date('2026-10-19T10:00:00Z')).id, 'golden'); // 日本時間 19:00
  assert.equal(shiftDayKey('2026-10-31', 1), '2026-11-01');
});

test('バックアップを促す条件: 記録があり、未実施か7日以上たっているとき', () => {
  const now = at(2026, 10, 19, 12);
  const ago = (days) => new Date(now.getTime() - days * 86400000).toISOString();
  assert.equal(backupStatus(0, null, now).due, false);       // 記録がない
  assert.equal(backupStatus(3, null, now).due, true);        // 一度も書き出していない
  assert.equal(backupStatus(3, ago(6), now).due, false);     // 6日前
  assert.equal(backupStatus(3, ago(7), now).due, true);      // ちょうど7日前
});

// ---------- 問いかけ入力と入力途中の下書き ----------

test('問いの順番: 気持ち → 結果 → マッチの質 → マップ → ヒーロー、続けて結果ごとの振り返り', () => {
  assert.deepEqual(askSteps(null), ['memo', 'result', 'skillGap', 'map', 'hero']);
  assert.deepEqual(askSteps('loss').slice(5), ['improvement']);
  assert.deepEqual(askSteps('win').slice(5), ['nextMove']);
  assert.deepEqual(askSteps('draw').slice(5), ['nextMove']);
});

const emptyAsk = () => ({
  answers: { memo: '', result: null, skillGap: null, mapId: null, heroId: null, otherHeroIds: [] }, step: 'memo', matchId: null, text: '',
});
const heroById = new Map([['rein', { id: 'rein', role: 'tank' }], ['ana', { id: 'ana', role: 'support' }]]);
const ctx = (over = {}) => ({
  now: at(2026, 10, 19, 22, 0), mapIds: new Set(['dorado']), heroById, matchIds: new Set(['m1']), ...over,
});

test('下書き: 何も入力していなければ保存しない(消す)', () => {
  assert.equal(isAskEmpty(emptyAsk()), true);
  assert.equal(buildDraft(emptyAsk(), at(2026, 10, 19, 21)), null);
  assert.equal(buildDraft({ ...emptyAsk(), text: '  ' }, at(2026, 10, 19, 21)), null);
});

test('下書き: 保存して戻すと、答えといまの問い、打ちかけの文がそのまま戻る', () => {
  const ask = { answers: { memo: 'メモ', result: 'loss', skillGap: 'even', mapId: 'dorado', heroId: null, otherHeroIds: [] }, step: 'hero', matchId: null, text: 'rei' };
  const back = restoreDraft(JSON.stringify(buildDraft(ask, at(2026, 10, 19, 21))), ctx());
  assert.deepEqual(back, ask);
});

test('下書き: 以前の段階の gg(相手がやや格上)は、勝機あり(even)として戻す', () => {
  const ask = { ...emptyAsk(), answers: { ...emptyAsk().answers, skillGap: 'gg', mapId: 'dorado' }, step: 'hero' };
  const back = restoreDraft(JSON.stringify(buildDraft(ask, at(2026, 10, 19, 21))), ctx());
  assert.equal(back.answers.skillGap, 'even');
});

test('下書き: 24時間より古い、壊れている、以前の形式、マスターから外れた内容は戻さない', () => {
  const ask = { ...emptyAsk(), answers: { ...emptyAsk().answers, skillGap: 'ez', mapId: 'dorado', heroId: 'rein' }, step: 'hero' };
  const text = JSON.stringify(buildDraft(ask, at(2026, 10, 19, 21)));
  assert.notEqual(restoreDraft(text, ctx({ now: at(2026, 10, 20, 20, 59) })), null);       // 23時間59分後
  assert.equal(restoreDraft(text, ctx({ now: at(2026, 10, 20, 21, 1) })), null);            // 24時間1分後
  assert.equal(restoreDraft('これはJSONではない', ctx()), null);
  assert.equal(restoreDraft(JSON.stringify({ version: 1, savedAt: at(2026, 10, 19, 21).toISOString(), form: {} }), ctx()), null);
  // マップがマスターにない → マップだけ外れ、ほかは戻る
  const noMap = restoreDraft(text, ctx({ mapIds: new Set() }));
  assert.equal(noMap.answers.mapId, null);
  assert.equal(noMap.answers.skillGap, 'ez');
  assert.equal(restoreDraft(text, ctx({ heroById: new Map() })).answers.heroId, null);
  // 戻せるものが何もなければ null
  const onlyHero = JSON.stringify(buildDraft({ ...emptyAsk(), answers: { ...emptyAsk().answers, heroId: 'rein' } }, at(2026, 10, 19, 21)));
  assert.equal(restoreDraft(onlyHero, ctx({ heroById: new Map() })), null);
});

test('下書き: 2人目からのヒーローも戻す。マスターにないヒーローは外し、1人目がなければ戻さない', () => {
  const ask = { ...emptyAsk(), answers: { ...emptyAsk().answers, mapId: 'dorado', heroId: 'rein', otherHeroIds: ['ana', 'gone'] }, step: 'hero' };
  const text = JSON.stringify(buildDraft(ask, at(2026, 10, 19, 21)));
  assert.deepEqual(restoreDraft(text, ctx()).answers.otherHeroIds, ['ana']);
  assert.deepEqual(restoreDraft(text, ctx({ heroById: new Map([['ana', {}]]) })).answers.otherHeroIds, []);
});

test('splitHeroInput: 空白で区切った複数のヒーローに分け、最後の語は打ちかけとして返す', () => {
  const heroes = [
    { id: 'tracer', name: 'Tracer', yomi: 'とれーさー' }, { id: 'genji', name: 'Genji', yomi: 'げんじ' },
    { id: 'junker-queen', name: 'Junker Queen', yomi: 'じゃんかーくいーん' }, { id: 'soldier-76', name: 'Soldier: 76', yomi: 'そるじゃー' },
  ];
  const s = (t) => splitHeroInput(heroes, t);
  assert.deepEqual(s('tracer gen'), { ids: ['tracer'], head: 'tracer', query: 'gen' });
  assert.deepEqual(s('tracer '), { ids: ['tracer'], head: 'tracer', query: '' });
  assert.deepEqual(s('とれーさー げんじ'), { ids: ['tracer'], head: 'とれーさー', query: 'げんじ' });
  // 名前に空白を含むヒーローは、つなげて1人にする(打ちかけの語でも)
  assert.deepEqual(s('junker queen tracer').ids, ['junker-queen']);
  assert.deepEqual(s('tracer junker qu'), { ids: ['tracer'], head: 'tracer', query: 'junker qu' });
  assert.deepEqual(s('soldier 76 genji').ids, ['soldier-76']);
  // 「Tracer → Genji」(答えの表示)や読点でも区切る。一致しない語と重複は捨てる
  assert.deepEqual(s('Tracer → Genji ').ids, ['tracer', 'genji']);
  assert.deepEqual(s('tracer、xxx tracer genji').ids, ['tracer']);
  assert.deepEqual(s('gen'), { ids: [], head: '', query: 'gen' });
});

test('下書き: 保存した後は、その試合が残っているときだけ、振り返りの問いに戻す', () => {
  const ask = { answers: { ...emptyAsk().answers, result: 'loss' }, step: 'improvement', matchId: 'm1', text: '前に出すぎた' };
  const text = JSON.stringify(buildDraft(ask, at(2026, 10, 19, 21)));
  assert.deepEqual(restoreDraft(text, ctx()), { ...ask, answers: { ...ask.answers } });
  assert.equal(restoreDraft(text, ctx({ matchIds: new Set() })), null); // 試合を削除済み
  // 保存した後に、保存より前の問いの位置が入っていたら、振り返りの最初の問いにする
  const before = JSON.stringify(buildDraft({ ...ask, step: 'map' }, at(2026, 10, 19, 21)));
  assert.equal(restoreDraft(before, ctx()).step, 'improvement');
});

test('引き分け: 累計は「勝-敗-分」で、引き分けのない区分は「勝-敗」のまま', () => {
  const ms = [
    match('d1', at(2026, 10, 21, 20, 0), 'tank', 'win'),
    match('d2', at(2026, 10, 21, 20, 30), 'tank', 'draw'),
    match('d3', at(2026, 10, 21, 21, 0), 'tank', 'loss'),
    match('d4', at(2026, 10, 21, 21, 30), 'support', 'win'),
  ];
  assert.deepEqual(dailyTally(ms, '2026-10-21').map((t) => tallyText(t)), ['Tank 1-1-1', 'Support 1-0']);
  assert.equal(tallyText(runningTallies(ms).get('d2'), ':'), 'Tank:1-0-1');
});

test('引き分け: 勝率は 勝ち÷(勝ち+負け) で、試合数には含める。引き分けだけなら勝率なし', () => {
  const ms = [
    match('d1', at(2026, 10, 21, 20, 0), 'tank', 'win'),
    match('d2', at(2026, 10, 21, 20, 30), 'tank', 'draw'),
    match('d3', at(2026, 10, 21, 21, 0), 'tank', 'loss'),
  ];
  const [peak] = timeTagStats(ms).peak;
  assert.deepEqual([peak.wins, peak.losses, peak.draws, peak.total, peak.rate], [1, 1, 1, 3, 0.5]);
  assert.equal(timeTagStats([ms[1]]).peak[0].rate, null);
});

test('引き分け: 改善点記入率の対象にしない。バックアップで読み込める', () => {
  const ms = [match('d1', at(2026, 10, 21, 20, 0), 'tank', 'draw')];
  assert.deepEqual(reviewRates(ms, new Map()).improvementOnLoss, { num: 0, den: 0 });
  const parsed = parseBackup(JSON.stringify(buildBackup({ matches: ms })));
  assert.equal(parsed.ok, true);
});

test('読みの検索: ひらがな・カタカナ、長音・中黒、「ヴァ」と「バ」を区別しない。全角の英字は半角として探す', () => {
  const maps = [
    { id: 'ilios', name: 'Ilios', yomi: 'いりおす' },
    { id: 'gib', name: 'Watchpoint: Gibraltar', yomi: 'かんしぽいんとじぶらるたる' },
    { id: 'eich', name: 'Eichenwalde', yomi: 'あいへんゔぁるで' },
  ];
  assert.deepEqual(searchByName(maps, 'いり', []).map((m) => m.id), ['ilios']);
  assert.deepEqual(searchByName(maps, 'イリオス', []).map((m) => m.id), ['ilios']);
  assert.deepEqual(searchByName(maps, 'じぶら', []).map((m) => m.id), ['gib']);         // 名前の途中でも当たる
  assert.deepEqual(searchByName(maps, 'アイヘンバルデ', []).map((m) => m.id), ['eich']);
  assert.deepEqual(searchByName(maps, 'ｉｌ', []).map((m) => m.id), ['ilios']);
  const heroes = [{ id: 'tracer', name: 'Tracer', yomi: 'とれーさー' }];
  assert.deepEqual(searchByName(heroes, 'とれさ', []).map((x) => x.id), ['tracer']);    // 長音を打たなくても当たる
  assert.deepEqual(searchByName(heroes, 'トレーサー', []).map((x) => x.id), ['tracer']);
  assert.deepEqual(searchByName(heroes, 'とれえさあ', []).map((x) => x.id), ['tracer']); // 長音を直前の母音で打っても当たる
});

test('読みの検索: 長音は、打たなくても、直前の母音で打っても当たる', () => {
  const maps = [{ id: 'aatlis', name: 'Aatlis', yomi: 'あーとりす' }, { id: 'ilios', name: 'Ilios', yomi: 'いりおす' }];
  for (const q of ['あーとりす', 'ああとりす', 'あとりす', 'アアトリス', 'ああと']) {
    assert.deepEqual(searchByName(maps, q, []).map((m) => m.id), ['aatlis'], q);
  }
  const heroes = [{ id: 'dva', name: 'D.Va', yomi: 'でぃーゔぁ' }, { id: 'lw', name: 'Lifeweaver', yomi: 'らいふうぃーばー' }];
  assert.deepEqual(searchByName(heroes, 'でぃいば', []).map((x) => x.id), ['dva']);
  assert.deepEqual(searchByName(heroes, 'らいふうぃいばあ', []).map((x) => x.id), ['lw']);
});

test('読みの検索: ローマ字でも読みに当たる。名前の一致を前にし、打ちかけの子音は捨てる', () => {
  const gaps = [
    { id: 'ez', name: '圧勝', yomi: ['あっしょう'] }, { id: 'even', name: '互角', yomi: ['ごかく'] },
    { id: 'gg', name: '勝機あり', yomi: ['しょうきあり'] }, { id: 'mismatch', name: '一方的', yomi: ['いっぽうてき'] },
  ];
  for (const [q, id] of [['gokaku', 'even'], ['go', 'even'], ['assyou', 'ez'], ['asshou', 'ez'], ['sho', 'gg'], ['ippo', 'mismatch'], ['gokak', 'even']]) {
    assert.deepEqual(searchByName(gaps, q, []).map((x) => x.id), [id], q);
  }
  const heroes = [{ id: 'tracer', name: 'Tracer', yomi: 'とれーさー' }, { id: 'ana', name: 'Ana', yomi: 'あな' }, { id: 'hav', name: 'Havana', yomi: 'はばな' }];
  assert.deepEqual(searchByName(heroes, 'toresa', []).map((x) => x.id), ['tracer']);
  assert.deepEqual(searchByName(heroes, 'ana', []).map((x) => x.id), ['ana', 'hav']);
});

test('結果の検索: 1文字では DRAW と DEFEAT を決めない。読みは配列でもよい', () => {
  const results = [
    { id: 'win', name: 'VICTORY', yomi: ['かち', 'しょうり'] },
    { id: 'draw', name: 'DRAW', yomi: ['ひきわけ'] },
    { id: 'loss', name: 'DEFEAT', yomi: ['まけ', 'はいぼく'] },
  ];
  assert.deepEqual(searchByName(results, 'v', []).map((x) => x.id), ['win']);
  assert.deepEqual(searchByName(results, 'd', []).map((x) => x.id), ['draw', 'loss']);
  assert.deepEqual(searchByName(results, 'de', []).map((x) => x.id), ['loss']);
  assert.deepEqual(searchByName(results, 'しょう', []).map((x) => x.id), ['win']);
  assert.deepEqual(searchByName(results, 'ま', []).map((x) => x.id), ['loss']);
});

test('マスター: すべてのマップ・ヒーローに読み(ひらがな。複数あれば配列)がある', async () => {
  const { readFile } = await import('node:fs/promises');
  const m = JSON.parse(await readFile(new URL('../data/master.json', import.meta.url), 'utf8'));
  for (const x of [...m.maps, ...m.heroes]) {
    const ys = [].concat(x.yomi ?? []);
    assert.ok(ys.length > 0, x.name);
    for (const y of ys) assert.match(y, /^[ぁ-ゖー0-9]+$/, x.name);
  }
});

test('マップの検索: 大文字小文字とアクセントを区別せず、先頭の一致を前にする。空欄なら候補なし', () => {
  const maps = [
    { id: 'lijiang', name: 'Lijiang Tower', mode: 'control' },
    { id: 'ilios', name: 'Ilios', mode: 'control' },
    { id: 'grim', name: 'Watchpoint: Grímsvötn', mode: 'escort' },
    { id: 'kings', name: "King's Row", mode: 'hybrid' },
  ];
  assert.deepEqual(searchByName(maps, 'IL', []).map((m) => m.id), ['ilios']);
  assert.deepEqual(searchByName(maps, 'i', []).map((m) => m.id), ['ilios', 'lijiang', 'grim', 'kings']);
  assert.deepEqual(searchByName(maps, 'grims', []).map((m) => m.id), ['grim']);
  assert.deepEqual(searchByName(maps, 'row', []).map((m) => m.id), ['kings']);
  assert.deepEqual(searchByName(maps, '  ', []), []);
});

test('マップの検索: 一致の強さが同じなら、最近選んだ順', () => {
  const maps = [
    { id: 'a', name: 'Busan', mode: 'control' },
    { id: 'b', name: 'Blizzard World', mode: 'hybrid' },
  ];
  assert.deepEqual(searchByName(maps, 'b', ['b']).map((m) => m.id), ['b', 'a']);
});

test('ヒーローの検索: 記号を区別せず(dva で D.Va)、全ロールから探す', () => {
  const heroes = [
    { id: 'dva', name: 'D.Va', role: 'tank' },
    { id: 'doom', name: 'Doomfist', role: 'tank' },
    { id: 'lucio', name: 'Lúcio', role: 'support' },
    { id: 's76', name: 'Soldier: 76', role: 'damage' },
  ];
  assert.deepEqual(searchByName(heroes, 'dva', []).map((x) => x.id), ['dva']);
  assert.deepEqual(searchByName(heroes, 'd', []).map((x) => x.id), ['dva', 'doom', 's76']);
  assert.deepEqual(searchByName(heroes, 'luc', []).map((x) => x.id), ['lucio']);
  assert.deepEqual(searchByName(heroes, 'soldier76', []).map((x) => x.id), ['s76']);
});

test('statsScope: 全期間の試合数と、最初と最後の試合の日付を返す', () => {
  assert.equal(statsScope([]), null);
  const ms = [
    match('b', at(2026, 10, 24, 23, 50), 'tank', 'win'),
    match('a', at(2026, 10, 19, 0, 10), 'tank', 'loss'),
    { id: 'x', createdAt: 'bad', result: 'win' },
  ];
  const s = statsScope(ms);
  assert.equal(s.total, 2);
  assert.deepEqual([s.from.month, s.from.day, s.to.month, s.to.day], [10, 19, 10, 24]);
});

test('roleRecords: 全期間のロール別の勝敗を、試合の多い順に返す。記録のないロールは出さない', () => {
  // five: Tank 1-2(3試合)、ロール不明 0-1、DPS 1-0。同じ1試合なら DPS → ロール不明の順
  const out = roleRecords(five);
  assert.deepEqual(out.map((t) => [t.key, t.wins, t.losses, t.total]), [['tank', 1, 2, 3], ['damage', 1, 0, 1], ['', 0, 1, 1]]);
  assert.ok(!out.some((t) => t.key === 'support'));
});

test('reviewEntries: 負けは改善点、勝ちは決め手を主に、新しい順。何も書いていない試合は出さない', () => {
  const ms = [...five, match('m6', at(2026, 10, 20, 2, 0), 'tank', 'draw')];
  const reviews = new Map([
    ['m1', { winKey: ' 先にアナを落とせた ', winRisk: '' }],
    ['m3', { improvement: '', failure: '高台を取られた' }],
    ['m5', { improvement: '一度下がればよかった', failure: '深追いした' }],
    ['m6', { improvement: '引き分けの改善点は出さない' }],
    ['m2', { pickReason: '理由だけ' }],
  ]);
  const out = reviewEntries(ms, reviews);
  assert.deepEqual(out.map((e) => e.match.id), ['m5', 'm3', 'm1']);
  assert.deepEqual(out[0].main, { key: 'improvement', text: '一度下がればよかった' });
  assert.deepEqual(out[0].sub, { key: 'failure', text: '深追いした' });
  assert.equal(out[1].main, null);
  assert.deepEqual(out[2].main, { key: 'winKey', text: '先にアナを落とせた' });
  assert.equal(out[2].sub, null);
  assert.equal(out[2].next, null);

  // 引き分けは勝ち切れなかった場面と次はどう動く
  reviews.set('m6', { drawMiss: '延長で取り切れなかった', nextMove: '早めに戻る' });
  const d = reviewEntries(ms, reviews)[0];
  assert.equal(d.match.id, 'm6');
  assert.equal(d.main, null);
  assert.deepEqual(d.sub, { key: 'drawMiss', text: '延長で取り切れなかった' });
  assert.deepEqual(d.next, { key: 'nextMove', text: '早めに戻る' });
});

test('latestNextMove: 負けの改善点か、勝ち・引き分けの次はどう動くの、いちばん新しい1件', () => {
  const ms = [...five, match('m6', at(2026, 10, 20, 2, 0), 'tank', 'draw')];
  const reviews = new Map([
    ['m5', { improvement: '一度下がればよかった' }],
    ['m6', { drawMiss: '延長で取り切れなかった' }], // 次はどう動くを書いていない引き分けは出さない
  ]);
  const a = latestNextMove(ms, reviews);
  assert.equal(a.match.id, 'm5');
  assert.equal(a.text, '一度下がればよかった');
  assert.equal(a.from, null);
  reviews.set('m6', { drawMiss: '延長で取り切れなかった', nextMove: '早めに戻る' });
  const b = latestNextMove(ms, reviews);
  assert.equal(b.match.id, 'm6');
  assert.equal(b.text, '早めに戻る');
  assert.deepEqual(b.from, { key: 'drawMiss', text: '延長で取り切れなかった' });
  assert.equal(latestNextMove(ms, new Map()), null);
});

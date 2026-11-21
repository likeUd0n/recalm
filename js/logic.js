// 画面に依存しない計算。後で node --test から読み込めるよう DOM を使わない。
import {
  TIME_SLOTS, PEAK_SLOT_IDS, ROLES, UNKNOWN_ROLE_LABEL, DAY_START_HOUR,
  BACKUP_STORES, BACKUP_STALE_DAYS, DEVICE_META_KEYS, REFERENCE_MIN_GAMES,
  SKILL_GAPS, SKILL_GAP_ALIASES, DRAFT_MAX_AGE_HOURS,
  SESSION_GAP_MINUTES, SESSION_ELAPSED_STEP_MINUTES,
} from './config.js';

const pad2 = (n) => String(n).padStart(2, '0');

// 日付・時間帯・曜日・表示する時刻は、端末のタイムゾーンによらず日本時間で決める(設計書 F3、ユーザー指定)。
// 日本には夏時間がないので、UTC に9時間足して UTC の値として読む。
const JST_OFFSET_MS = 9 * 3600000;

// 日本時間での年・月(1始まり)・日・時・分。
export function jstParts(d) {
  const x = new Date(d.getTime() + JST_OFFSET_MS);
  return { year: x.getUTCFullYear(), month: x.getUTCMonth() + 1, day: x.getUTCDate(), hour: x.getUTCHours(), minute: x.getUTCMinutes() };
}

// UTC の値として読んだ日付を YYYY-MM-DD で返す。
function utcDateKey(d) {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

// 記録上の「1日」を YYYY-MM-DD で返す。DAY_START_HOUR より前は前日に入れる(0 のとき暦の日付と同じ)。
// Match.date と DayCondition のキーはこれを使う。
export function dayKeyOf(d) {
  return utcDateKey(new Date(d.getTime() + JST_OFFSET_MS - DAY_START_HOUR * 3600000));
}

// 保存済みの試合を、今の決まりで計算し直した形にする。
// 日付・時間帯は入力時刻から決める。
// モード(Ranked・Quick)は記録しないので、以前の記録に残る mode・ranked は消す(設計書 F3、ユーザー指定)。ほかの項目は消さない。
const DROPPED_MATCH_KEYS = ['mode', 'ranked'];
export function normalizeMatch(m) {
  const at = new Date(m.createdAt);
  const rest = { ...m };
  for (const k of DROPPED_MATCH_KEYS) delete rest[k];
  return {
    ...rest,
    date: dayKeyOf(at),
    timeSlot: timeSlotOf(at).id,
    role: m.role ?? null,
    // 実力差(設計書 F3)。以前の「実力差のあるマッチ」の印は、その段階として読み替える。
    skillGap: m.skillGap ?? (m.mismatch ? 'mismatch' : null),
  };
}

// 計算し直すと値が変わる試合(消す項目が残っている試合を含む)だけを、新しい値にして返す。
export function matchesNeedingUpdate(matches) {
  const keys = ['date', 'timeSlot', 'role', 'skillGap'];
  return matches
    .map((m) => [m, normalizeMatch(m)])
    .filter(([a, b]) => keys.some((k) => a[k] !== b[k]) || DROPPED_MATCH_KEYS.some((k) => k in a))
    .map(([, b]) => b);
}

// 累計勝敗をまとめる区分。ロール別(ロールのない以前の記録は空文字の区分にまとめる)。
function tallyKey(m) {
  return m.role ?? '';
}

// 区分の表示名。ロール名か、「ロール不明」。
export function tallyLabel(key) {
  return ROLES.find((r) => r.id === key)?.label ?? UNKNOWN_ROLE_LABEL;
}

// 区分の並び順: Tank, DPS, Support, ロール不明。
const TALLY_ORDER = [...ROLES.map((r) => r.id), ''];

// 試合ごとに、その1日(0:00区切り)の同じ区分での累計勝敗(その試合を含む)を返す。
// 戻り値は Map<matchId, { key, wins, losses, draws }>。
export function runningTallies(matches) {
  const sorted = [...matches].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const totals = new Map();
  const out = new Map();
  for (const m of sorted) {
    const key = tallyKey(m);
    const bucket = `${dayKeyOf(new Date(m.createdAt))}|${key}`;
    const prev = totals.get(bucket) ?? { wins: 0, losses: 0, draws: 0 };
    const next = { ...prev, key };
    countResult(next, m);
    totals.set(bucket, next);
    out.set(m.id, next);
  }
  return out;
}

// 指定した1日の区分別の累計勝敗。試合のある区分だけを決まった順で返す。
export function dailyTally(matches, dayKey) {
  const byKey = new Map();
  for (const m of matches) {
    if (dayKeyOf(new Date(m.createdAt)) !== dayKey) continue;
    const key = tallyKey(m);
    const t = byKey.get(key) ?? { key, wins: 0, losses: 0, draws: 0 };
    countResult(t, m);
    byKey.set(key, t);
  }
  return TALLY_ORDER.filter((k) => byKey.has(k)).map((k) => byKey.get(k));
}

// 勝敗を1つ数える。引き分け(draw)は勝ちにも負けにも入れない(設計書 F3・F5)。
function countResult(t, m) {
  if (m.result === 'win') t.wins += 1;
  else if (m.result === 'draw') t.draws += 1;
  else t.losses += 1;
}

// 「勝-敗」。引き分けがあるときだけ「勝-敗-分」にする。
export const winLossText = (t) => `${t.wins}-${t.losses}${t.draws ? `-${t.draws}` : ''}`;

export const tallyText = (t, sep = ' ') => `${tallyLabel(t.key)}${sep}${winLossText(t)}`;

// 履歴の「振り返り」: 全期間のロール別の勝敗(設計書 画面設計 履歴)。試合のある区分だけを、試合の多い順に返す。
// 試合数が同じなら Tank, DPS, Support, ロール不明の順。total は引き分けを含む試合数。
export function roleRecords(matches) {
  const byKey = new Map();
  for (const m of matches) {
    const key = tallyKey(m);
    const t = byKey.get(key) ?? { key, wins: 0, losses: 0, draws: 0, total: 0 };
    countResult(t, m);
    t.total += 1;
    byKey.set(key, t);
  }
  return TALLY_ORDER.filter((k) => byKey.has(k)).map((k) => byKey.get(k)).sort((a, b) => b.total - a.total);
}

// 履歴の「振り返り」の一覧。負けた試合は改善点(main)とうまくいかなかったこと(sub)、
// 勝った試合は勝てた決め手(main)と危なかった場面(sub)と次はどう動く(next)、
// 引き分けの試合は勝ち切れなかった場面(sub)と次はどう動く(next)。どれも書いていない試合は出さない。新しい順。
// reviews は Map<matchId, Review>。戻り値の main・sub・next は { key, text }(書いていなければ null)。
export function reviewEntries(matches, reviews) {
  const keys = { loss: ['improvement', 'failure'], win: ['winKey', 'winRisk', 'nextMove'], draw: [null, 'drawMiss', 'nextMove'] };
  return [...matches]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .flatMap((m) => {
      const [mainKey, subKey, nextKey] = keys[m.result] ?? [];
      if (!subKey) return [];
      const r = reviews.get(m.id) ?? {};
      const pick = (k) => (k && filled(r[k]) ? { key: k, text: r[k].trim() } : null);
      const main = pick(mainKey);
      const sub = pick(subKey);
      const next = pick(nextKey);
      return main || sub || next ? [{ match: m, main, sub, next }] : [];
    });
}

// 記録画面の「次の試合で試すこと」: いちばん新しい次の行動(負け=改善点、勝ち・引き分け=次はどう動く)を1件。
// from は元になった場面(勝ち=危なかった場面、引き分け=勝ち切れなかった場面。負けは null)。なければ null。
export function latestNextMove(matches, reviews) {
  const e = reviewEntries(matches, reviews)
    .find((x) => (x.match.result === 'loss' ? x.main?.key === 'improvement' : x.next));
  if (!e) return null;
  return e.match.result === 'loss' ? { match: e.match, text: e.main.text, from: null } : { match: e.match, text: e.next.text, from: e.sub };
}

// 1日(YYYY-MM-DD)を n 日ずらす。
export function shiftDayKey(dayKey, n) {
  const [y, m, d] = dayKey.split('-').map(Number);
  return utcDateKey(new Date(Date.UTC(y, m - 1, d + n)));
}

const filled = (s) => typeof s === 'string' && s.trim() !== '';

// 振り返りの記入率(設計書「集計指標」)。reviews は Map<matchId, Review>。
// Review の pickReason が「ピックの理由」、failure が「うまくいかなかったこと」、improvement が「改善点」。
// 自由メモ(memo)と、以前の did(成長したこと)・didNot(反省点)は数えない。
// それぞれ { num: 分子, den: 分母 } で返す。
export function reviewRates(ms, reviews) {
  const r = (m) => reviews.get(m.id) ?? {};
  const losses = ms.filter((m) => m.result === 'loss');
  const withFacts = ms.filter((m) => filled(r(m).pickReason) || filled(r(m).failure));
  return {
    // 振り返り記入率: 3欄のどれかを書いた試合 / 全試合
    reviewed: {
      num: ms.filter((m) => filled(r(m).pickReason) || filled(r(m).failure) || filled(r(m).improvement)).length,
      den: ms.length,
    },
    // 次に試すことの記入率(負けた試合。improvement): 成功の判定
    improvementOnLoss: { num: losses.filter((m) => filled(r(m).improvement)).length, den: losses.length },
    // 改善点への到達率: ピックの理由かうまくいかなかったことを書いた試合のうち、改善点も書いた試合
    improvementAfterFacts: { num: withFacts.filter((m) => filled(r(m).improvement)).length, den: withFacts.length },
    // 気持ちの記入率: 「いまの気持ちは?」(自由メモ memo)を書いた試合 / 全試合。中身は数えない
    feeling: { num: ms.filter((m) => filled(r(m).memo)).length, den: ms.length },
  };
}

// 振り返り欄(設計書 F6)。2026-11-13 に結果ごと1問に統合・簡略化。
// 負けは improvement に保存して「次に試すこと」の集計に入れ、勝ち・引き分けは nextMove に保存する。
export const LOSS_REVIEW_FIELDS = [
  {
    key: 'improvement',
    label: () => '危なかった場面、もし次また来たらどう動く?',
    sub: 'やられた瞬間やヒヤッとした場面を1つ思い浮かべて、自分の動きを1つ',
    short: () => '次に試すこと',
    example: '例(トレーサー): 単独で前に出て2回落ちたので、次はタンクが当たるのを待ってから入る。',
  },
];

export const WIN_REVIEW_FIELDS = [
  {
    key: 'nextMove',
    label: () => '次の試合ではどうしたい?',
    sub: 'うまくいった動きや、次に意識すること',
    short: () => '次に試すこと',
    example: '例(トレーサー): 次の集団戦でも味方のタンクとタイミングを合わせて裏から入る。',
  },
];

export const DRAW_REVIEW_FIELDS = [
  {
    key: 'nextMove',
    label: () => '危なかった場面、もし次また来たらどう動く?',
    sub: 'やられた瞬間やヒヤッとした場面を1つ思い浮かべて、自分の動きを1つ',
    short: () => '次に試すこと',
    example: '例(トレーサー): 単独で前に出て2回落ちたので、次はタンクが当たるのを待ってから入る。',
  },
];

// 過去の記録に表示・編集用のラベルを残すための旧フィールド定義(新規入力では聞かない)。
export const LEGACY_REVIEW_FIELDS = {
  loss: [
    { key: 'pickReason', label: (hero) => `なぜ${hero}を選んだか?`, sub: 'この試合で、どんな役割を果たしたかったか?', short: (hero) => `なぜ${hero}を選んだか` },
    { key: 'failure', label: () => 'うまくいかなかったことは何か?', short: () => 'うまくいかなかったこと' },
  ],
  win: [
    { key: 'winKey', label: () => '勝てた決め手は何か?', short: () => '勝てた決め手' },
    { key: 'winRisk', label: () => '危なかった場面はあったか?', short: () => '危なかった場面' },
  ],
  draw: [
    { key: 'drawMiss', label: () => '勝ち切れなかった場面はあったか?', short: () => '勝ち切れなかった場面' },
  ],
};

// ---------- 問いかけ入力(設計書「簡易入力の設計」) ----------

// 保存する前に聞く問い(主観の整理 → 事実)。hero に答えると試合を保存する。
export const ASK_BEFORE_SAVE = ['memo', 'result', 'skillGap', 'map', 'hero'];

// 問いの順番。振り返りの問いはどの結果でも1問(設計書 F6)。
export function askSteps(result) {
  const review = {
    loss: LOSS_REVIEW_FIELDS.map((f) => f.key),
    win: WIN_REVIEW_FIELDS.map((f) => f.key),
    draw: DRAW_REVIEW_FIELDS.map((f) => f.key),
  }[result] ?? [];
  return [...ASK_BEFORE_SAVE, ...review];
}

// ---------- 入力途中の下書き(設計書「簡易入力の設計」) ----------

// 問いかけ入力の状態: answers = 保存する前の答え { memo, result, skillGap, mapId, heroId, otherHeroIds }(heroId は1人目)、
// step = いまの問い、matchId = 保存した試合(保存前は null)、text = 入力欄に打ちかけの文。
export function isAskEmpty(ask) {
  const a = ask.answers;
  return !ask.matchId && !filled(ask.text) && !filled(a.memo) && !a.result && !a.skillGap && !a.mapId && !a.heroId;
}

// 下書きとして保存する中身。何も入力されていなければ null(下書きを消す)。
export function buildDraft(ask, now = new Date()) {
  if (isAskEmpty(ask)) return null;
  const a = ask.answers;
  return {
    version: 2,
    savedAt: now.toISOString(),
    answers: { memo: a.memo ?? '', result: a.result ?? null, skillGap: a.skillGap ?? null, mapId: a.mapId ?? null, heroId: a.heroId ?? null, otherHeroIds: a.otherHeroIds ?? [] },
    step: ask.step,
    matchId: ask.matchId ?? null,
    text: ask.text ?? '',
  };
}

// 保存した下書きの文字列を、今のマスターに合わせて戻す。使えなければ null。
// 古い下書き(DRAFT_MAX_AGE_HOURS 時間より前)、2026-10-24 までの形式(version 1)、マスターにないマップ・ヒーローは戻さない。
// 保存した後の下書きは、その試合がまだ残っているときだけ戻す。
export function restoreDraft(text, { now = new Date(), mapIds, heroById, matchIds }) {
  let d;
  try {
    d = JSON.parse(text);
  } catch {
    return null;
  }
  if (d?.version !== 2 || typeof d.answers !== 'object' || d.answers === null) return null;
  const age = now.getTime() - new Date(d.savedAt).getTime();
  if (Number.isNaN(age) || age > DRAFT_MAX_AGE_HOURS * 3600000) return null;
  if (d.matchId != null && !matchIds.has(d.matchId)) return null;
  const a = d.answers;
  const result = ['win', 'draw', 'loss'].includes(a.result) ? a.result : null;
  const steps = askSteps(result);
  const ask = {
    answers: {
      memo: typeof a.memo === 'string' ? a.memo.slice(0, 200) : '',
      result,
      skillGap: SKILL_GAPS.some((g) => g.id === a.skillGap) ? a.skillGap : SKILL_GAP_ALIASES[a.skillGap] ?? null,
      mapId: mapIds.has(a.mapId) ? a.mapId : null,
      heroId: heroById.has(a.heroId) ? a.heroId : null,
      // 2人目からのヒーロー(2026-11-21 より前の下書きにはない)。1人目がなければ戻さない
      otherHeroIds: heroById.has(a.heroId) && Array.isArray(a.otherHeroIds) ? a.otherHeroIds.filter((x) => heroById.has(x)) : [],
    },
    matchId: d.matchId ?? null,
    text: typeof d.text === 'string' ? d.text.slice(0, 300) : '',
    step: null,
  };
  // 保存した後は振り返りの問いだけ、保存する前は保存より前の問いだけに戻す
  const allowed = ask.matchId ? steps.slice(ASK_BEFORE_SAVE.length) : ASK_BEFORE_SAVE;
  ask.step = allowed.includes(d.step) ? d.step : allowed[0] ?? null;
  if (ask.matchId && !ask.step) return null;
  if (isAskEmpty(ask)) return null;
  return ask;
}

// ---------- バックアップ(設計書 F8) ----------

// 書き出すJSONの中身。stores は { ストア名: 行の配列 }。BACKUP_STORES にあるものだけを入れる。
export function buildBackup(stores, now = new Date()) {
  return {
    app: 'recalm',
    version: 1,
    exportedAt: now.toISOString(),
    stores: Object.fromEntries(BACKUP_STORES.map((name) => [
      name,
      // この端末の状態(最後の書き出し日時・自動保存のフォルダ)は含めない
      (stores[name] ?? []).filter((r) => !(name === 'meta' && DEVICE_META_KEYS.includes(r.key))),
    ])),
  };
}

// IndexedDB のキーにできる値か(文字列か数値に限る)。キーが不正な行は put が例外を投げる。
const isKey = (v) => (typeof v === 'string' && v !== '') || Number.isFinite(v);
const isRow = (r) => typeof r === 'object' && r !== null && !Array.isArray(r);

// ストアごとの行の検証。不正な行が1つでもあれば取り込まない。
// slots・bans・compTypes の id は自動採番なので、ないものは許す。
const ROW_CHECKS = {
  matches: (r) => isKey(r.id) && typeof r.createdAt === 'string' && !Number.isNaN(new Date(r.createdAt).getTime())
    && ['win', 'loss', 'draw'].includes(r.result),
  slots: (r) => isKey(r.matchId) && (r.id === undefined || isKey(r.id)),
  bans: (r) => isKey(r.matchId) && (r.id === undefined || isKey(r.id)),
  compTypes: (r) => isKey(r.matchId) && (r.id === undefined || isKey(r.id)),
  reviews: (r) => isKey(r.matchId),
  days: (r) => isKey(r.date),
  meta: (r) => typeof r.key === 'string' && r.key !== '',
};
const ROW_ERRORS = {
  matches: '入力時刻か勝敗の正しくない試合が含まれています。',
};

// 読み込んだ文字列を調べ、{ ok: true, stores } か { ok: false, error } を返す。
// recalm のバックアップでなければ取り込まない。すべての行について、キーと試合の入力時刻・勝敗を確かめる。
export function parseBackup(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: 'JSONとして読めませんでした。' };
  }
  if (data?.app !== 'recalm' || typeof data.stores !== 'object' || data.stores === null) {
    return { ok: false, error: 'recalm のバックアップファイルではありません。' };
  }
  if (data.version !== 1) {
    return { ok: false, error: `対応していない版のバックアップです(version ${data.version})。` };
  }
  const stores = {};
  for (const name of BACKUP_STORES) {
    const rows = data.stores[name] ?? [];
    if (!Array.isArray(rows)) return { ok: false, error: `「${name}」の形式が正しくありません。` };
    if (!rows.every((r) => isRow(r) && ROW_CHECKS[name](r))) {
      return { ok: false, error: ROW_ERRORS[name] ?? `「${name}」に正しくない行が含まれています。` };
    }
    stores[name] = rows;
  }
  stores.meta = stores.meta.filter((r) => !DEVICE_META_KEYS.includes(r.key));
  return { ok: true, stores, exportedAt: data.exportedAt ?? null, matchCount: stores.matches.length };
}

// 書き出しを促すか。記録があり、一度も書き出していないか、BACKUP_STALE_DAYS 日以上たっているとき。
// 戻り値は { due: 促すか, lastAt: 最後の書き出し(ISO文字列)か null }。
export function backupStatus(matchCount, lastAt, now = new Date()) {
  if (!matchCount) return { due: false, lastAt: lastAt ?? null };
  if (!lastAt) return { due: true, lastAt: null };
  const days = (now.getTime() - new Date(lastAt).getTime()) / 86400000;
  return { due: days >= BACKUP_STALE_DAYS, lastAt };
}

// ---------- 集計(設計書「集計指標」) ----------

// 日付をまたぐ区分(例: 22時〜翌1時)は、start 以降または end 未満で判定する。
export function timeSlotOf(d) {
  const h = jstParts(d).hour;
  return TIME_SLOTS.find((s) =>
    s.start <= s.end ? h >= s.start && h < s.end : h >= s.start || h < s.end,
  );
}

export function timeSlotRangeText(slot) {
  const next = slot.end < slot.start ? '翌' : '';
  return `${slot.start}:00〜${next}${slot.end}:00`;
}

// ピークタイム(夜・ゴールデン)か。入力時刻から計算するので、区分の決まりを変えても保存済みの試合に合う。
export const isPeakTime = (d) => PEAK_SLOT_IDS.includes(timeSlotOf(d).id);

// 日付(YYYY-MM-DD)が土曜か日曜か。
export function isWeekendDay(dayKey) {
  const [y, m, d] = dayKey.split('-').map(Number);
  const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return w === 0 || w === 6;
}

// 画面に出す2つのタグ。peak: ピークタイムか、weekend: 日付が土日か(設計書 F3)。
export const matchTimeTags = (d) => ({ peak: isPeakTime(d), weekend: isWeekendDay(dayKeyOf(d)) });

// 集計の対象(設計書 F5)。全期間の試合数と、最初と最後の試合の日付(日本時間の jstParts)を返す。
// 記録がなければ null。入力時刻が読めない試合は数えない。
export function statsScope(matches) {
  const times = matches.map((m) => new Date(m.createdAt).getTime()).filter((t) => !Number.isNaN(t));
  if (!times.length) return null;
  return { total: times.length, from: jstParts(new Date(Math.min(...times))), to: jstParts(new Date(Math.max(...times))) };
}

// セッション開始からの経過時間で分けた勝敗(設計書「集計指標」)。入力時刻の順に並べ、前の試合から
// SESSION_GAP_MINUTES 分以上あいたら新しいセッションとし、その最初の試合からの経過時間を SESSION_ELAPSED_STEP_MINUTES 分ごとに分ける。
// 試合数が REFERENCE_MIN_GAMES 未満の区分が出たら、その区分から後ろを1つにまとめる。後ろに試合がない区分もまとめた扱いにする。
// 戻り値は行 { from, last, wins, losses, draws, total, rate, reference } の配列(from は区分の始まりの分。last の行は「from 分〜」)。
// 記録がなければ空の配列。勝率は 勝ち÷(勝ち+負け) で引き分けは入れず、試合数(total)には引き分けも含める。
export function sessionElapsedStats(matches) {
  const timed = matches
    .map((m) => ({ m, t: new Date(m.createdAt).getTime() }))
    .filter(({ t }) => !Number.isNaN(t))
    .sort((a, b) => a.t - b.t);
  const raw = [];
  let start = null;
  let prev = null;
  for (const { m, t } of timed) {
    if (prev === null || t - prev >= SESSION_GAP_MINUTES * 60000) start = t;
    prev = t;
    const k = Math.floor((t - start) / (SESSION_ELAPSED_STEP_MINUTES * 60000));
    while (raw.length <= k) raw.push({ wins: 0, losses: 0, draws: 0, total: 0 });
    countResult(raw[k], m);
    raw[k].total += 1;
  }
  const rows = [];
  for (let k = 0; k < raw.length; k++) {
    const r = raw[k];
    const last = k === raw.length - 1 || r.total < REFERENCE_MIN_GAMES || raw.slice(k + 1).every((x) => x.total === 0);
    const sum = last
      ? raw.slice(k).reduce((a, x) => ({ wins: a.wins + x.wins, losses: a.losses + x.losses, draws: a.draws + x.draws, total: a.total + x.total }))
      : r;
    rows.push({ from: k * SESSION_ELAPSED_STEP_MINUTES, last, ...sum });
    if (last) break;
  }
  return rows.map((r) => ({ ...r, rate: r.wins + r.losses ? r.wins / (r.wins + r.losses) : null, reference: r.total < REFERENCE_MIN_GAMES }));
}

// 勝率50%以上を保てた時間の目安(設計書 F5。2026-11-21 ユーザー指定の判定方法)。sessionElapsedStats の行を0分から順に見て、
// 参考値でなく勝率50%以上の区分が続く限り進む。参考値・勝率なし・50%未満の区分で止まる。
// 戻り値は { until: 保てた区分の終わりの分, toEnd: 最後の「N分〜」まで保てたか }。最初の区分で止まれば null(出さない)。
export function winRateHold(rows) {
  let hold = null;
  for (const r of rows) {
    if (r.reference || r.rate === null || r.rate < 0.5) break;
    if (r.last) return { until: r.from, toEnd: true };
    hold = { until: r.from + SESSION_ELAPSED_STEP_MINUTES, toEnd: false };
  }
  return hold;
}

// その日(YYYY-MM-DD)を含む週の月曜日を YYYY-MM-DD で返す(集計の「今週」と週ごとの積み上げ。設計書 F5)。
export function weekStartKey(dayKey) {
  const [y, m, d] = dayKey.split('-').map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return shiftDayKey(dayKey, -((weekday + 6) % 7));
}

// 前回の「次に試すこと」を、最後に保存した試合より後に「試した」と押しているか(設計書「簡易入力の設計」)。
// 押していれば、その押した日時(ISO)を返す。なければ null。
export function triedSinceLastMatch(tried, matches) {
  const last = matches.reduce((a, m) => (m.createdAt > a ? m.createdAt : a), '');
  return (tried ?? []).findLast((t) => t > last) ?? null;
}

// 「次に試したこと」の集計(設計書 F5)。reviews は Map<matchId, Review>、now は Date。
// 戻り値: { total: 全期間の回数, thisWeek: 今週(月曜0:00から)の回数,
//   weeks: 最初に押した週から今週までの [{ start: 週の月曜, total: その週までの累計 }],
//   recent: 最近試したこと [{ text, at: 最後に押した日時 }] を新しい順に3件(同じ文は1件にまとめる) }
export function triedStats(matches, reviews, now) {
  const taps = [];
  for (const m of matches) {
    const r = reviews.get(m.id);
    if (!r?.tried?.length) continue;
    // その試合の次に試すこと: 負けは improvement、勝ち・引き分けは nextMove(latestNextMove と同じ)
    const text = (m.result === 'loss' ? r.improvement : r.nextMove) ?? r.improvement ?? r.nextMove ?? '';
    for (const at of r.tried) taps.push({ at, text: text.trim() });
  }
  taps.sort((a, b) => a.at.localeCompare(b.at));
  const weekOf = (iso) => weekStartKey(dayKeyOf(new Date(iso)));
  const thisWeekStart = weekStartKey(dayKeyOf(now));
  const weeks = [];
  if (taps.length) {
    let count = 0;
    let i = 0;
    for (let w = weekOf(taps[0].at); w <= thisWeekStart; w = shiftDayKey(w, 7)) {
      while (i < taps.length && weekOf(taps[i].at) <= w) { count += 1; i += 1; }
      weeks.push({ start: w, total: count });
    }
  }
  const recent = [];
  for (const t of [...taps].reverse()) {
    if (recent.length >= 3) break;
    if (!t.text || recent.some((x) => x.text === t.text)) continue;
    recent.push(t);
  }
  return {
    total: taps.length,
    thisWeek: taps.filter((t) => weekOf(t.at) === thisWeekStart).length,
    weeks,
    recent,
  };
}

// 直近に選んだマップの id を新しい順に重複なしで返す。
export function recentMapIds(matches) {
  const seen = new Set();
  const out = [];
  const sorted = [...matches].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const m of sorted) {
    if (m.mapId && !seen.has(m.mapId)) {
      seen.add(m.mapId);
      out.push(m.mapId);
    }
  }
  return out;
}

// プレイしたヒーローの使用回数と、最近使った順の id 一覧。
export function heroUsage(matches, slots) {
  const createdAt = new Map(matches.map((m) => [m.id, m.createdAt]));
  const counts = new Map();
  const last = new Map();
  for (const s of slots) {
    if (!s.isSelf) continue;
    const t = createdAt.get(s.matchId);
    if (!t) continue;
    counts.set(s.heroId, (counts.get(s.heroId) ?? 0) + 1);
    if (!last.has(s.heroId) || last.get(s.heroId) < t) last.set(s.heroId, t);
  }
  const recent = [...last.entries()].sort((a, b) => b[1].localeCompare(a[1])).map(([id]) => id);
  return { counts, recent };
}

// お気に入りを登録順で先頭に、残りは回数の多い順。同数ならマスターの並び順を保つ。
export function orderHeroes(items, counts, favoriteIds = []) {
  const fav = new Map(favoriteIds.map((id, i) => [id, i]));
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) =>
      (fav.get(a.item.id) ?? Infinity) - (fav.get(b.item.id) ?? Infinity) ||
      (counts.get(b.item.id) ?? 0) - (counts.get(a.item.id) ?? 0) ||
      a.i - b.i)
    .map((x) => x.item);
}

// recentIds に含まれるものを新しい順に先頭へ。残りはマスターの並び順。
export function orderByRecent(items, recentIds) {
  const rank = new Map(recentIds.map((id, i) => [id, i]));
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => (rank.get(a.item.id) ?? Infinity) - (rank.get(b.item.id) ?? Infinity) || a.i - b.i)
    .map((x) => x.item);
}

// 比べるための形。全角の英数字は半角にし、大文字と小文字、アクセント記号(Grímsvötn の í・ö など)を区別しない。
const foldName = (s) => s.normalize('NFKC').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
// 記号と空白も除いた形(「dva」で D.Va に一致させる。設計書 F2)
const bareName = (s) => s.replace(/[^a-z0-9]/g, '');

// 読み(yomi)と比べるための形(設計書 F1)。カタカナはひらがなにし、中黒・空白を除き、「ゔぁ」と「ば」をそろえる。
// 長音は、除いた形と、直前の母音に置き換えた形(「あーとりす」→「ああとりす」)の2つを返す。
const VU = { 'ゔぁ': 'ば', 'ゔぃ': 'び', 'ゔぇ': 'べ', 'ゔぉ': 'ぼ', 'ゔ': 'ぶ' };
const VOWEL_ROWS = {
  'あ': 'あかがさざただなはばぱまやらわぁゃゎ', 'い': 'いきぎしじちぢにひびぴみりぃ', 'う': 'うくぐすずつづぬふぶぷむゆるぅゅ',
  'え': 'えけげせぜてでねへべぺめれぇ', 'お': 'おこごそぞとどのほぼぽもよろをぉょ',
};
const VOWEL_OF = new Map(Object.entries(VOWEL_ROWS).flatMap(([v, cs]) => [...cs].map((c) => [c, v])));
const foldKana = (s) => {
  const k = s.normalize('NFKC').toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/[・\s]/g, '')
    .replace(/ゔ[ぁぃぇぉ]?/g, (v) => VU[v]);
  return [k.replace(/ー/g, ''), k.replace(/(.)ー+/g, (_, c) => c + (VOWEL_OF.get(c) ?? '')).replace(/ー/g, '')];
};
const hasKana = (s) => /[ぁ-ゖァ-ヺ]/.test(s);

// ローマ字をひらがなにする(日本語入力の変換前の英字で、読みを引くため。設計書 F1)。打ちかけの子音は捨てる。
const ROMAJI = (() => {
  const t = { a: 'あ', i: 'い', u: 'う', e: 'え', o: 'お', '-': 'ー', nn: 'ん', "n'": 'ん' };
  const rows = { k: 'かきくけこ', g: 'がぎぐげご', s: 'さしすせそ', z: 'ざじずぜぞ', t: 'たちつてと', d: 'だぢづでど', n: 'なにぬねの',
    h: 'はひふへほ', b: 'ばびぶべぼ', p: 'ぱぴぷぺぽ', m: 'まみむめも', r: 'らりるれろ' };
  for (const [c, ks] of Object.entries(rows)) {
    [...'aiueo'].forEach((v, n) => { t[c + v] = ks[n]; });
    t[`${c}ya`] = `${ks[1]}ゃ`; t[`${c}yu`] = `${ks[1]}ゅ`; t[`${c}yo`] = `${ks[1]}ょ`;
  }
  Object.assign(t, {
    ya: 'や', yu: 'ゆ', yo: 'よ', wa: 'わ', wi: 'うぃ', we: 'うぇ', wo: 'を',
    shi: 'し', chi: 'ち', tsu: 'つ', fu: 'ふ', ji: 'じ', fa: 'ふぁ', fi: 'ふぃ', fe: 'ふぇ', fo: 'ふぉ',
    sha: 'しゃ', shu: 'しゅ', she: 'しぇ', sho: 'しょ', cha: 'ちゃ', chu: 'ちゅ', che: 'ちぇ', cho: 'ちょ',
    ja: 'じゃ', ju: 'じゅ', je: 'じぇ', jo: 'じょ', thi: 'てぃ', dhi: 'でぃ', dhu: 'でゅ',
    va: 'ゔぁ', vi: 'ゔぃ', vu: 'ゔ', ve: 'ゔぇ', vo: 'ゔぉ',
    xa: 'ぁ', xi: 'ぃ', xu: 'ぅ', xe: 'ぇ', xo: 'ぉ', xtu: 'っ', ltu: 'っ',
  });
  return t;
})();
export function romajiToKana(s) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === s[i + 1] && /[bcdfghjkmpqrstvwxyz]/.test(c)) { out += 'っ'; i += 1; continue; }
    if (c === 'n' && s[i + 1] && !/[aiueoyn']/.test(s[i + 1])) { out += 'ん'; i += 1; continue; }
    const len = [4, 3, 2, 1].find((n) => ROMAJI[s.slice(i, i + n)]);
    if (len) { out += ROMAJI[s.slice(i, i + len)]; i += len; continue; }
    if (/[a-z]/.test(c)) break;
    out += c;
    i += 1;
  }
  return out;
}

// 名前の一部が入力と一致するマップ・ヒーロー・結果(設計書 F1・F2・F3)。全モード・全ロールから探す。
// 入力にかなが入っていれば読み(yomi。文字列か配列)と、なければ英語の名前と比べる。
// 名前の先頭(または単語の先頭)で一致するものを前に、その中は最近選んだ順、残りはマスターの並び順。
export function searchByName(items, query, recentIds) {
  if (hasKana(query)) {
    const qs = foldKana(query);
    return rankedHits(items, recentIds, (m) => {
      const ys = [].concat(m.yomi ?? []).flatMap(foldKana);
      if (ys.some((y) => qs.some((q) => y.startsWith(q)))) return 0;
      return ys.some((y) => qs.some((q) => y.includes(q))) ? 2 : -1;
    });
  }
  const q = foldName(query.trim());
  if (!q) return [];
  // 英字は、名前のほか、ローマ字として読みとも比べる(「assyou」で圧勝、「toresa」で Tracer)。名前の一致を前にする
  const kana = /^[a-z'-]+$/.test(q) ? romajiToKana(q) : '';
  const ks = kana ? foldKana(kana) : [];
  return rankedHits(items, recentIds, (m) => {
    const name = foldName(m.name);
    if (name.startsWith(q) || (bareName(q) && bareName(name).startsWith(bareName(q)))) return 0;
    if (name.split(/[\s:'-]+/).some((w) => w.startsWith(q))) return 1;
    if (name.includes(q)) return 2;
    const ys = ks.length ? [].concat(m.yomi ?? []).flatMap(foldKana) : [];
    return ys.some((y) => ks.some((k) => k && y.startsWith(k))) ? 3 : -1;
  });
}

// ヒーローの問いの入力を、空白(、→ も)で区切った複数のヒーローに分ける(設計書 F2。2026-11-21 ユーザー指定)。
// 名前に空白を含むヒーロー(Junker Queen など)のため、続く語(3語まで)をつなげて一致を見る。最後の語は打ちかけとして query に返し、
// それより前の語は1人ずつ、一致した候補の先頭に決める(一致しない語は捨てる)。text が区切りで終われば query は空。
// 戻り値は { ids: 決まったヒーロー(重複なし・打った順), head: query より前の文, query }。
const HERO_SEP = /[\s,、→]+/;
export function splitHeroInput(items, text, recentIds = []) {
  const words = text.split(HERO_SEP).filter(Boolean);
  // 2語以上をつなげた一致は、名前に空白・記号を含むヒーローだけを採る(「tracer genji」を1人にしない)
  const spaced = (m) => /[\s:.]/.test(m.name);
  const multi = (k, hits) => k === 1 || hits.some(spaced);
  const hitOf = (ws) => {
    for (let k = Math.min(3, ws.length); k >= 1; k--) {
      const hits = searchByName(items, ws.slice(0, k).join(' '), recentIds);
      if (hits.length && multi(k, hits)) return { k, m: k === 1 ? hits[0] : hits.find(spaced) };
    }
    return null;
  };
  // 打ちかけの語: 末尾から3語までで、つなげて候補が出る最も長いもの
  let tail = 0;
  if (words.length && !/[\s,、→]$/.test(text)) {
    tail = 1;
    for (let k = Math.min(3, words.length); k > 1; k--) {
      const hits = searchByName(items, words.slice(-k).join(' '), recentIds);
      if (hits.length && multi(k, hits)) { tail = k; break; }
    }
  }
  const head = words.slice(0, words.length - tail);
  const ids = [];
  for (let i = 0; i < head.length;) {
    const hit = hitOf(head.slice(i));
    if (hit && !ids.includes(hit.m.id)) ids.push(hit.m.id);
    i += hit?.k ?? 1;
  }
  return { ids, head: head.join(' '), query: words.slice(words.length - tail).join(' ') };
}

function rankedHits(items, recentIds, rank) {
  const hits = items.map((m) =>({ m, r: rank(m) })).filter((x) => x.r >= 0);
  const ordered = orderByRecent(hits.map((x) => x.m), recentIds);
  const r = new Map(hits.map((x) => [x.m.id, x.r]));
  return ordered.map((m, i) => ({ m, i })).sort((a, b) => r.get(a.m.id) - r.get(b.m.id) || a.i - b.i).map((x) => x.m);
}

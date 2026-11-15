// 記録画面(F1〜F4、入力時間の自動計測)と設定画面(バックアップ)。
import * as db from './db.js';
import {
  RESULT_LABELS, ROLES,
  DELETED_LABELS, SKILL_GAPS, SKILL_GAP_ALIASES, TIME_SLOTS,
  BACKUP_STORES, BACKUP_META_KEY, BACKUP_STALE_DAYS, REFERENCE_MIN_GAMES, DRAFT_KEY, TOUR_KEY, FINISH_PAUSE_MS,
  AUTOSAVE_META_KEY, AUTOSAVE_FILE, AUTOSAVE_DELAY_MS, AUTODOWNLOAD_META_KEY, DEVICE_META_KEYS, DISPLAY_META_KEY, DISPLAY_DEFAULTS,
  IMPROVEMENT_TARGET_RATE, TRIAL_LOSS_GAMES, SESSION_GAP_MINUTES, SESSION_ELAPSED_STEP_MINUTES,
} from './config.js';
import {
  dayKeyOf, jstParts, timeSlotOf, timeSlotRangeText, matchTimeTags, matchesNeedingUpdate, recentMapIds,
  heroUsage, orderByRecent, searchByName, LOSS_REVIEW_FIELDS, WIN_REVIEW_FIELDS, DRAW_REVIEW_FIELDS, LEGACY_REVIEW_FIELDS, ASK_BEFORE_SAVE, askSteps,
  dailyTally, runningTallies, tallyText, winLossText, tallyLabel, shiftDayKey, roleRecords, reviewEntries, latestNextMove,
  buildBackup, parseBackup, backupStatus, timeTagStats, statsScope, sessionElapsedStats, trialProgress, reviewRates, isAskEmpty, buildDraft, restoreDraft,
} from './logic.js';

const $ = (sel) => document.querySelector(sel);

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...children.flat().filter((c) => c != null && c !== false));
  return el;
}

// replaceChildren は null を文字列 "null" として描くため、空の要素を除いてから渡す。
function fill(el, ...children) {
  el.replaceChildren(...children.flat().filter((c) => c != null && c !== false));
}

// 「?」の説明文を、改行ごとの段落に分ける(設計書 画面設計。段落の間と最初の段落の太字は css で付ける)。
function hintParas(text) {
  return text.split(/\n+/).map((t) => h('p', {}, t));
}

// 問いかけ入力の状態(設計書「簡易入力の設計」)。answers は保存する前の答え、step はいまの問い、
// matchId は保存した試合(保存前は null)、seen は保存する前に一度開いた問い(とばした任意の問いへ戻らないため)。
const emptyAsk = () => ({
  answers: { memo: '', result: null, skillGap: null, mapId: null, heroId: null },
  step: 'memo', matchId: null, seen: new Set(), reviewed: false,
});

const state = {
  baseMaster: null,     // data/master.json
  master: null,         // 上の2つを重ねたもの。画面はこれを使う
  mapById: new Map(),
  heroById: new Map(),
  matches: [],
  slots: [],
  bans: [],
  compTypes: [],
  reviews: new Map(),   // matchId -> Review(pickReason = ピックの理由、failure = うまくいかなかったこと、improvement = 改善点、memo = 自由メモ。以前の did・didNot も残す)
  ask: emptyAsk(),
  lastBackupAt: null,   // 最後にバックアップを書き出した日時(ISO文字列)。meta の lastBackupAt
  // フォルダへの自動保存(設計書 F8)。dir: 選んだフォルダ(なければ null)、granted: 書き込みの許可があるか
  autoSave: { dir: null, granted: false },
  // フォルダを選べないブラウザの、記録のたびの自動ダウンロード(設計書 F8)。lastAt: 最後にダウンロードした日時(ISO文字列)
  autoDownload: { enabled: false, lastAt: null },
  display: { ...DISPLAY_DEFAULTS }, // 表示の設定(config.js の DISPLAY_META_KEY)
  // listDay: 履歴で見ている1日(null は今日)。sel: 問いかけ入力で選んでいる候補・段階の位置(-1 は選んでいない)
  // historyMode: 履歴の表示('review' まとめ / 'games' 試合一覧。開いたときはまとめ)。reviewResult・reviewHero: 振り返りの絞り込み('all' はすべて)
  ui: { listDay: null, sel: -1, browseGroup: null, browseSel: 0, browseByInput: false, saving: false, typed: null, keysOpen: false, resumed: false, pausedUntil: 0, welcome: false, historyMode: 'review', reviewResult: 'all', reviewHero: 'all' },
  timer: { startedAt: null, clicks: 0, keys: 0 }, // clicks = 候補などを押した回数、keys = Enter・数字キーで決めた回数
};

// ---------- 起動 ----------

async function init() {
  try {
    const res = await fetch('data/master.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.baseMaster = await res.json();
  } catch (e) {
    return fatal(
      'マスターデータ(data/master.json)を読み込めませんでした。\n' +
      'index.html をファイルとして直接開くと読み込めません。フォルダで「python -m http.server 8000」を実行し、http://localhost:8000/ を開いてください。\n' +
      `(${e.message})`,
    );
  }
  try {
    await db.openDb();
  } catch (e) {
    return fatal(`ブラウザ内の保存領域(IndexedDB)を開けませんでした。プライベートウィンドウでは使えない場合があります。\n(${e?.message ?? e})`);
  }

  // 保存済みのデータが壊れていても、白画面のままにせず原因を出す。
  try {
    await start();
  } catch (e) {
    fatal(`保存済みの記録を読み込めませんでした。\n(${e?.message ?? e})`);
  }
}

async function start() {
  // マスターは data/master.json だけを正とする(設計書 F7)。
  // 以前ブラウザ内で行った編集(meta の masterEdits)は消さずに残すが、反映しない。
  applyMaster();
  // モードの値(matchMode と、さらに以前の ranked)は消す(設計書 F3、ユーザー指定)。
  // ロールはヒーローから決めるので、前回のロール(lastRole)も使わない(設計書 F3)。
  // お気に入り(favoriteHeroes)は廃止したので消す(設計書 F2)。
  for (const key of ['matchMode', 'ranked', 'lastRole', 'favoriteHeroes']) {
    if ((await db.get('meta', key)) !== undefined) await db.remove('meta', key);
  }
  state.lastBackupAt = (await db.get('meta', BACKUP_META_KEY))?.value ?? null;
  state.autoDownload = { ...state.autoDownload, ...(await db.get('meta', AUTODOWNLOAD_META_KEY))?.value };
  state.display = { ...DISPLAY_DEFAULTS, ...(await db.get('meta', DISPLAY_META_KEY))?.value };
  const dir = (await db.get('meta', AUTOSAVE_META_KEY))?.value ?? null;
  if (dir?.queryPermission) {
    state.autoSave = { dir, granted: (await dir.queryPermission({ mode: 'readwrite' }).catch(() => 'denied')) === 'granted' };
  }

  // 日付(0:00区切り)・時間帯の決まりやモードの持ち方が変わっても集計がずれないよう、
  // 保存済みの試合を入力時刻から計算し直す。
  const stale = matchesNeedingUpdate(await db.getAll('matches'));
  if (stale.length) await db.putAll('matches', stale);

  await reload();
  state.ui.welcome = state.matches.length === 0;
  loadDraft();

  // ブラウザが空き容量不足のときに記録を消さないよう、永続化を頼む(許可されなくても動作は同じ)。
  navigator.storage?.persist?.().catch(() => {});

  bindEvents();
  $('#footer').hidden = false;
  renderAll();
  showView();
  noticeImported();
  if (state.ui.welcome && !isTourDone() && (!location.hash || location.hash === '#home')) openTour();
  setInterval(tick, 1000);
}

function applyMaster() {
  state.master = state.baseMaster;
  state.mapById = new Map(state.master.maps.map((m) => [m.id, m]));
  state.heroById = new Map(state.master.heroes.map((x) => [x.id, x]));
}

function fatal(message) {
  const el = $('#fatal');
  el.textContent = message;
  el.hidden = false;
}

async function reload() {
  const [matches, slots, bans, compTypes, reviews] = await Promise.all([
    db.getAll('matches'),
    db.getAll('slots'),
    db.getAll('bans'),
    db.getAll('compTypes'),
    db.getAll('reviews'),
  ]);
  state.matches = matches;
  state.slots = slots;
  state.bans = bans;
  state.compTypes = compTypes;
  state.reviews = new Map(reviews.map((r) => [r.matchId, r]));
  updateBackupNudge();
}

function showView() {
  const view = { '#settings': 'settings', '#matches': 'matches', '#stats': 'stats' }[location.hash] ?? 'home';
  $('#view-home').hidden = view !== 'home';
  $('#view-matches').hidden = view !== 'matches';
  $('#view-stats').hidden = view !== 'stats';
  $('#view-settings').hidden = view !== 'settings';
  for (const a of document.querySelectorAll('.app-nav a, .app-settings')) {
    if (a.dataset.view === view) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  if (view === 'settings') {
    renderSettings();
  } else if (view === 'matches') {
    renderMatchesView();
  } else if (view === 'stats') {
    renderStats();
  } else {
    renderAsk();
  }
}

// ---------- イベント ----------

function bindEvents() {
  bindAsk();
  bindKeyboard();

  // 「?」の解説: 押すと出し、もう一度押すかほかを押すと消す(カーソルを合わせられないスマホでも見られる。設計書 画面設計)
  document.addEventListener('click', (e) => {
    const hint = e.target.closest?.('.hint-btn')?.parentElement;
    for (const el of document.querySelectorAll('.hint.open')) if (el !== hint) el.classList.remove('open');
    hint?.classList.toggle('open');
    if (!e.target.closest?.('.session-chart .hit')) closeChartTips();
  });

  $('#backup-export').addEventListener('click', exportBackup);
  $('#backup-import').addEventListener('click', () => $('#backup-file').click());
  $('#backup-file').addEventListener('change', (e) => importBackup(e.target));
  $('#autosave-pick').addEventListener('click', pickAutoSaveDir);
  $('#autosave-reconnect').addEventListener('click', reconnectAutoSave);
  $('#autosave-stop').addEventListener('click', stopAutoSave);
  $('#autodl-enabled').addEventListener('change', (e) => setAutoDownload(e.target.checked));
  for (const [name, key] of [['pref-today', 'today'], ['pref-stats', 'stats']]) {
    for (const r of document.querySelectorAll(`input[name="${name}"]`)) r.addEventListener('change', () => setDisplay(key, r.value));
  }

  window.addEventListener('hashchange', showView);

  // マップ・ヒーロー一覧オーバーレイ(設計書 F1・F2)
  $('#browse-backdrop').addEventListener('click', () => closeBrowse());
  $('#browse-close').addEventListener('click', () => closeBrowse());

  // 初回起動時の使い方ツアー(案B)
  $('#tour-backdrop').addEventListener('click', closeTour);
  $('#tour-close').addEventListener('click', closeTour);
  $('#tour-start').addEventListener('click', closeTour);
  $('#open-tour').addEventListener('click', () => {
    for (const el of document.querySelectorAll('.hint.open')) el.classList.remove('open');
    openTour();
  });
}

function isTourDone() {
  try { return localStorage.getItem(TOUR_KEY) === '1'; } catch { return false; }
}

function openTour() {
  $('#tour-overlay').hidden = false;
  $('#tour-start').focus();
}

function closeTour() {
  const el = $('#tour-overlay');
  if (el.hidden) return;
  el.hidden = true;
  try { localStorage.setItem(TOUR_KEY, '1'); } catch { /* プライベートモード等は無視 */ }
  if ($('#view-home').hidden === false) $('#ask-input').focus();
}

let tickDay = null;
function tick() {
  renderQualityTags();
  // 開いたまま 0:00 をまたいだら、今日の累計と履歴の「今日」を描き直す。
  const day = dayKeyOf(new Date());
  if (tickDay && day !== tickDay) {
    renderToday();
    renderMatchesView();
  }
  tickDay = day;
}

// 現在の時刻と、ピークタイム/オフピークの天秤。入力時刻から計算する(設計書 F3)。
// 時計のアイコン・時間帯のアイコンと名前は出さず、時間帯は時刻のツールチップに入れる。
function renderQualityTags() {
  const now = new Date();
  const { peak } = matchTimeTags(now);
  const slot = TIME_SLOTS.find((x) => x.id === timeSlotOf(now).id);
  // 1秒ごとに作り直す
  const nowChip = $('#now-chip');
  nowChip.title = `${slot.label}(${timeSlotRangeText(slot)}): ${slot.desc}`;
  fill(nowChip, h('span', { class: 'now-time' }, formatTime(now.toISOString())));
  const tagEl = $('#peak-tag');
  const peakName = peak ? 'ピークタイム' : 'オフピーク';
  fill(tagEl, slotIcon(peak ? 'peak' : 'offpeak', 16));
  tagEl.title = peakName;
  tagEl.setAttribute('role', 'img');
  tagEl.setAttribute('aria-label', peakName);
  tagEl.className = `fact ${peak ? 'fact-peak' : 'fact-offpeak'}`;
}

// ---------- 問いかけ入力(設計書「簡易入力の設計」) ----------
// 入力欄は1つ。気持ち → 結果 → マッチの質 → マップ → ヒーローの順に聞き、ヒーローに答えると試合を保存する。
// 保存した後は、結果ごとの振り返りの問いを続けて聞き、答えは1問ごとに保存する(設計書 F6)。

// 結果の候補。英語の名前のほか、読み(ひらがな)でも選べる(設計書 F3)
const RESULT_CHOICES = [
  { id: 'win', name: 'VICTORY', yomi: ['かち', 'しょうり', 'びくとりー'] },
  { id: 'draw', name: 'DRAW', yomi: ['ひきわけ', 'どろー'] },
  { id: 'loss', name: 'DEFEAT', yomi: ['まけ', 'はいぼく', 'でぃふぃーと', 'でぃふぇーと'] },
];
const RESULT_COLORS = { win: 'var(--win)', draw: 'var(--draw)', loss: 'var(--loss)' };
// 「最近」に出すマップ・ヒーローの数(設計書 F1・F2)
const RECENT_MAPS = 5;
const RECENT_HEROES = 5;
// マッチの質の候補。結果と同じく、名前のほか読みでも選べる(設計書 F3)
const GAP_CHOICES = SKILL_GAPS.map((g) => ({ id: g.id, name: g.label, yomi: g.yomi }));

// 振り返りの欄の定義。旧フィールドも含めて一覧・編集でラベルを引けるようにする
const ALL_LEGACY_FIELDS = [...LEGACY_REVIEW_FIELDS.loss, ...LEGACY_REVIEW_FIELDS.win, ...LEGACY_REVIEW_FIELDS.draw];
const REVIEW_FIELDS = [...new Set([...LOSS_REVIEW_FIELDS, ...WIN_REVIEW_FIELDS, ...DRAW_REVIEW_FIELDS, ...ALL_LEGACY_FIELDS])];
const fieldOf = (id, result) => {
  const byResult = { loss: LOSS_REVIEW_FIELDS, win: WIN_REVIEW_FIELDS, draw: DRAW_REVIEW_FIELDS }[result];
  return byResult?.find((f) => f.key === id) ?? REVIEW_FIELDS.find((f) => f.key === id);
};
const askHeroIds = () => (state.ask.answers.heroId ? [state.ask.answers.heroId] : []);

// タッチ端末(カーソルを合わせられない)では、キーの説明の代わりに「押して選ぶ」と伝える(設計書「簡易入力の設計」)
const isTouch = () => matchMedia('(hover: none)').matches;
const pickHow = () => (isTouch() ? '候補を押して選びます' : '途中まで打って Tab で変換、Enter で決めます');

// 問いの中身。kind で入力欄の動きが変わる(text・pick)
function stepDef(id) {
  if (id === 'memo') {
    return {
      kind: 'text', short: '気持ちの整理', q: 'いまの気持ちは?(任意)', sub: '先に書き出すと、落ち着いて振り返れます',
      example: '裏取りが全部読まれていてイライラした。でも最後の集団戦はうまく合わせられた。',
    };
  }
  if (id === 'result') {
    return {
      kind: 'pick', short: '結果', q: '結果は?',
      sub: `victory・defeat・draw のどれか。${pickHow()}\nかち・まけ・ひきわけ、びくとりー・でぃふぃーと・どろー(カタカナも)でも打てます`,
      example: 'victory / defeat / draw', items: RESULT_CHOICES, recent: () => RESULT_CHOICES, color: (x) => RESULT_COLORS[x.id], firstSelected: false,
    };
  }
  if (id === 'skillGap') {
    return {
      kind: 'pick', short: 'マッチの質', q: 'マッチの質は?',
      // 候補を絞らず、3つのボタンを味方(左)→相手(右)の1列で出す(scale。設計書「簡易入力の設計」)
      sub: '勝ち負けとは別に、両チームの実力差で選びます。',
      example: '圧勝 / 勝機あり / 格上', items: GAP_CHOICES, recent: () => GAP_CHOICES, color: (x) => `var(--gap-${x.id})`, firstSelected: false, scale: true,
    };
  }
  if (id === 'map') {
    return {
      kind: 'pick', short: 'マップ', q: 'マップは?', sub: `英語の名前のほか、いりおす・イリオス・iriosu でも打てます。${pickHow()}`,
      example: 'ilios', items: state.master.maps,
      browseKey: 'map', browseTitle: 'マップを選ぶ', browseOpenLabel: 'マップ一覧を開く', browseSwitchLabel: 'モード切替',
      // マップは連続で同じものが来にくいため「最近」は出さず、控えめなリンク・map入力・/ / Ctrl+Space で一覧オーバーレイを開く(設計書 F1)
      recent: () => [],
      groups: () => state.master.modes.map((m) => ({
        id: m.id,
        name: m.name,
        color: `var(--mc-${m.id})`,
        items: state.master.maps.filter((x) => x.mode === m.id),
      })).filter((g) => g.items.length),
      color: (x) => `var(--mc-${x.mode})`, firstSelected: true,
    };
  }
  if (id === 'hero') {
    return {
      kind: 'pick', short: 'ヒーロー', q: '使ったヒーローは?', sub: `ロールはヒーローから決まります。答えると試合を保存します。${pickHow()}`,
      example: 'tracer', items: state.master.heroes,
      browseKey: 'hero', browseTitle: 'ヒーローを選ぶ', browseOpenLabel: 'ヒーロー一覧を開く', browseSwitchLabel: 'ロール切替',
      // 空欄のときは「最近」を出し、その下の固定位置のリンク・hero入力・/ / Ctrl+Space で一覧オーバーレイを開く(設計書 F2)
      recent: () => heroUsage(state.matches, state.slots).recent.map((x) => state.heroById.get(x)).filter(Boolean).slice(0, RECENT_HEROES),
      groups: () => ROLES.map((r) => ({
        id: r.id,
        name: r.label,
        color: `var(--role-${r.id})`,
        items: state.master.heroes.filter((x) => x.role === r.id).sort((a, b) => a.name.localeCompare(b.name, 'en')),
      })).filter((g) => g.items.length),
      color: (x) => `var(--role-${x.role})`, firstSelected: true,
    };
  }
  const f = fieldOf(id, state.ask.answers.result);
  const sub = f.sub ?? '自分の行動で書くと?';
  return { kind: 'text', short: f.short(reviewHero(askHeroIds())), q: f.label(reviewHero(askHeroIds())), sub, example: f.example };
}

// いまの答え(id か文)。保存する前は state.ask.answers、保存した後は記録から読む
function askAnswer(id) {
  const a = state.ask.answers;
  if (id === 'map') return a.mapId;
  if (id === 'hero') return a.heroId;
  if (id in a) return a[id];
  return state.reviews.get(state.ask.matchId)?.[id] ?? '';
}

// 答えを画面に出す形
function answerLabel(id, v) {
  if (!v) return null;
  if (id === 'result') return RESULT_LABELS[v];
  if (id === 'skillGap') return skillGapLabel(v);
  if (id === 'map') return state.mapById.get(v)?.name ?? DELETED_LABELS.map;
  if (id === 'hero') return heroName(v);
  return v;
}
function answerColor(id, v) {
  if (id === 'result') return RESULT_COLORS[v];
  if (id === 'map') { const m = state.mapById.get(v); return m ? `var(--mc-${m.mode})` : null; }
  if (id === 'hero') { const x = state.heroById.get(v); return x ? `var(--role-${x.role})` : null; }
  if (id === 'skillGap') return v ? `var(--gap-${skillGapId(v)})` : null;
  return null;
}

const askStepsNow = () => askSteps(state.ask.answers.result);
const askInput = () => $('#ask-input');

// 候補(pick の問い)。空のときは「最近」、打ったら名前か読みの一致するもの
// Tab で候補の名前に変換した後も、変換前に打った文字(state.ui.typed)で絞ったままにする
function askCandidates(def) {
  const q = state.ui.typed ?? askInput().value;
  if (def.scale) return def.items;
  if (!q.trim()) return def.recent();
  const recent = def.items === state.master.heroes ? heroUsage(state.matches, state.slots).recent
    : def.items === state.master.maps ? recentMapIds(state.matches) : [];
  return searchByName(def.items, q, recent).slice(0, 8);
}

function resetAsk() {
  state.ask = emptyAsk();
  state.ui.resumed = false;
  closeBrowse({ restoreFocus: false });
  state.ui.sel = -1;
  state.ui.typed = null;
  state.timer = { startedAt: null, clicks: 0, keys: 0 };
  askInput().value = '';
  renderAsk();
  saveDraft();
}

// 「入力をリセット」。書いた気持ちまで消えるので、トーストの「元に戻す」で戻せるようにする(設計書 押し間違いへの備え)
function resetAskWithUndo() {
  const before = { ...state.ask, answers: { ...state.ask.answers }, seen: new Set(state.ask.seen) };
  const text = askInput().value;
  resetAsk();
  toast('入力をリセットしました', {
    ms: UNDO_MS,
    action: {
      label: '元に戻す',
      run: () => {
        // すでに次の入力を始めていたら、書き換えない
        if (!isAskEmpty({ ...state.ask, text: askInput().value })) return;
        state.ask = before;
        renderAsk();
        askInput().value = text;
        renderAskOpts();
        saveDraft();
      },
    },
  });
}

// 問いを開く。入力欄は空にし、候補の選択を初めの状態にする
function goAsk(id) {
  state.ask.step = id;
  state.ui.resumed = false;
  closeBrowse({ restoreFocus: false });
  askInput().value = '';
  state.ui.typed = null;
  // 空欄では候補を選んだ状態にしない(空の Enter で「最近」の先頭を黙って決めないため。↓ で選べば決められる)
  state.ui.sel = -1;
  renderAsk();
  saveDraft();
}

// 前の問いへ。保存した後は、保存より前の問いには戻らない(設計書「簡易入力の設計」)。
// 振り返りの1問目では、保存を取り消してヒーローの問いに戻る(押しっぱなしの繰り返しでは取り消さない)
function askBack({ repeat = false } = {}) {
  const steps = askStepsNow();
  const i = steps.indexOf(state.ask.step);
  const min = state.ask.matchId ? ASK_BEFORE_SAVE.length : 0;
  if (i > min) goAsk(steps[i - 1]);
  else if (state.ask.matchId && !repeat) undoAskSave();
}

// 振り返りを答えているあいだに、いまの試合の保存を取り消す(設計書 押し間違いへの備え)
// 振り返りを1問でも書いていたら、確かめてから取り消す(書いた文も消えるため)
function undoAskSave() {
  if (!state.ask.matchId) return;
  const r = state.reviews.get(state.ask.matchId);
  const written = REVIEW_FIELDS.some((f) => r?.[f.key]?.trim());
  if (written && !confirm('書いた振り返りも消えます。この試合の保存を取り消しますか?')) return;
  undoSave(state.ask.matchId, { ...state.ask.answers });
}

// 次の問いへ。保存する前は、まだ答えていない問いへ進み、必須の4つがそろったら保存する
async function askNext() {
  const steps = askStepsNow();
  const i = steps.indexOf(state.ask.step);
  if (state.ask.matchId) {
    if (i + 1 < steps.length) goAsk(steps[i + 1]);
    else finishAsk();
    return;
  }
  state.ask.seen.add(state.ask.step);
  const a = state.ask.answers;
  const missing = (id) => (id === 'memo' ? !state.ask.seen.has(id) : !askAnswer(id));
  // すぐ次の問いへ1問ずつ進む(答えてある問いもとばさない。戻って直したとき、直したい問いを通り過ぎないため)。
  // 最後の問いの後だけ、まだ答えていない問いへ戻る
  const next = ASK_BEFORE_SAVE[i + 1] ?? ASK_BEFORE_SAVE.find((id) => id !== 'memo' && missing(id));
  if (next) {
    goAsk(next);
    return;
  }
  if (a.result && a.skillGap && a.mapId && a.heroId) await saveAskMatch();
}

// 最後の問いを終えたら、次の試合の最初の問いに戻る
function finishAsk() {
  const saved = !!state.ask.matchId;
  const reviewed = !!(saved && state.ask.reviewed);
  // 振り返りを終えて次の試合に戻った直後は、Enter・「とばす」の連打で最初の問いまでとばさないよう、少しのあいだ決める操作を受けない
  if (state.ask.matchId) state.ui.pausedUntil = Date.now() + FINISH_PAUSE_MS;
  // 試合を保存していたら、最後の問いを終えたところでダウンロードもする(入力の途中でダウンロードの表示を出さない。設計書 F8)
  if (state.ask.matchId) queueAutoSave({ download: true });
  state.ask = emptyAsk();
  state.ui.resumed = false;
  state.ui.sel = -1;
  state.ui.typed = null;
  askInput().value = '';
  renderAsk();
  saveDraft();
  if (saved) showAskSaved(reviewed);
}

// 振り返りの最後の問いを終えたら、決める操作を受けない1秒のあいだ、問いの枠に保存の合図だけを出す(設計書「簡易入力の設計」)。
// 1つも書かなかったときは、とばしたことと、あとから書ける場所を伝える(叱らない)
function showAskSaved(reviewed) {
  const panel = $('#match-form');
  panel.classList.add('is-saved');
  const el = $('#ask-saved');
  el.textContent = reviewed ? '✓ 振り返りを保存しました' : '振り返りはとばしました(履歴から書けます)';
  el.classList.toggle('skipped', !reviewed);
  el.hidden = false;
  setTimeout(() => {
    panel.classList.remove('is-saved');
    $('#ask-saved').hidden = true;
    if (!$('#view-home').hidden && !$('#match-dialog').open) askInput().focus();
  }, FINISH_PAUSE_MS);
}

// 文の欄の残りの字数。残りが TEXT_COUNT_FROM 字以下になったら出し、上限に達したらそう伝える(設計書「簡易入力の設計」)
const TEXT_MAX = 300;
const TEXT_COUNT_FROM = 50;
function renderTextCount(el, len) {
  const rest = TEXT_MAX - len;
  el.hidden = rest > TEXT_COUNT_FROM;
  el.classList.toggle('over', rest <= 0);
  el.textContent = rest > 0 ? `あと ${rest}字` : `${TEXT_MAX}字までです`;
}

// 答えを決める。value は id(pick・key)か文(text)。空の文はとばす
async function setAnswer(id, value) {
  if (state.ask.matchId && !ASK_BEFORE_SAVE.includes(id)) {
    if ((askAnswer(id) ?? '') !== (value ?? '')) {
      try {
        await saveAskReview(id, value);
      } catch (e) {
        toast(`保存できませんでした: ${e?.message ?? e}`);
        return;
      }
    }
  } else {
    const key = { map: 'mapId', hero: 'heroId' }[id] ?? id;
    state.ask.answers[key] = value;
  }
  await askNext();
}

// 振り返りの答えを保存する
async function saveAskReview(id, value) {
  await saveReview(state.ask.matchId, { [id]: value });
  state.ask.reviewed = true;
}

// Enter・「次へ」。文はそのまま答えにし、候補・段階は選んでいるものに決める
async function askCommit({ byKey = false } = {}) {
  const id = state.ask.step;
  const def = stepDef(id);
  const text = askInput().value.trim();
  const has = !!askAnswer(id);
  if (Date.now() < (state.ui.pausedUntil ?? 0)) return;
  if (byKey) state.timer.keys += 1;
  if (def.kind === 'text') {
    if (!text && has) await askNext();
    else await setAnswer(id, text);
    return;
  }
  // 空欄の Enter は候補を決めない。打った文字があり候補が複数なら先頭を決める(結果だけは1つに絞れるまで決めない。設計書 F3)
  const list = askCandidates(def);
  const c = list[state.ui.sel] ?? (text && (def.firstSelected || list.length === 1) ? list[0] : null);
  if (c) await setAnswer(id, c.id);
  else if (!text && has) await askNext();
  else if (!text && def.optional) await setAnswer(id, null);
}

// ---------- 下書き(入力途中の保存。設計書「簡易入力の設計」) ----------
// ブラウザ内の localStorage だけに置く。記録(IndexedDB)にもバックアップにも入れない。

let draftTimer;

function saveDraft() {
  clearTimeout(draftTimer);
  const draft = buildDraft({ ...state.ask, text: askInput().value });
  try {
    if (draft) localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    else localStorage.removeItem(DRAFT_KEY);
  } catch {
    // 下書きを保存できなくても(容量・プライベートウィンドウなど)、入力そのものは続けられる
  }
}

function queueDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(saveDraft, 250);
}

// 起動時に、入力途中の内容があれば画面に戻す。使えない下書きは捨てる。
function loadDraft() {
  let text = null;
  try {
    text = localStorage.getItem(DRAFT_KEY);
  } catch {
    return;
  }
  if (!text) return;
  const draft = restoreDraft(text, {
    mapIds: new Set(state.mapById.keys()),
    heroById: state.heroById,
    matchIds: new Set(state.matches.map((m) => m.id)),
  });
  if (!draft) {
    try { localStorage.removeItem(DRAFT_KEY); } catch { /* 何もしない */ }
    return;
  }
  state.ask = { ...draft, seen: new Set(ASK_BEFORE_SAVE.slice(0, ASK_BEFORE_SAVE.indexOf(draft.step))) };
  askInput().value = draft.text;
  // どの問いから再開するかは、問いの上に出す(renderAsk)
  state.ui.resumed = true;
}

// ---------- 保存 ----------

// 削除の取り消しを出しておく時間(ミリ秒)
const UNDO_MS = 8000;

const newId = () =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

// 連打で同じ試合を二重に保存しないよう、保存が終わるまで次の呼び出しを無視する。
async function saveAskMatch() {
  if (state.ui.saving) return;
  state.ui.saving = true;
  try {
    await saveAskMatchNow();
  } finally {
    state.ui.saving = false;
  }
}

async function saveAskMatchNow() {
  const a = state.ask.answers;
  const hero = state.heroById.get(a.heroId);
  if (!a.result || !a.skillGap || !a.mapId || !hero) return;
  const now = new Date();
  const startedAt = state.timer.startedAt ?? now.getTime();
  const match = {
    id: newId(),
    createdAt: now.toISOString(),
    date: dayKeyOf(now),
    timeSlot: timeSlotOf(now).id,
    role: hero.role, // ロールは選んだヒーローのロール(設計書 F3)
    mapId: a.mapId,
    result: a.result,
    skillGap: a.skillGap,
    inputSeconds: Math.round((now.getTime() - startedAt) / 100) / 10,
    clickCount: state.timer.clicks,
    keyCount: state.timer.keys,
  };
  const memo = (a.memo ?? '').trim();
  try {
    await db.saveMatch({
      match,
      ...childRows(match.id, { heroIds: [hero.id], banned: false, bans: new Map(), allyComp: null, enemyComp: null }),
      review: memo ? { matchId: match.id, memo, updatedAt: now.toISOString() } : null,
    });
  } catch (e) {
    toast(`保存できませんでした: ${e?.message ?? e}`);
    return;
  }
  await reload();
  queueAutoSave();
  renderToday();
  bumpToday(a.result, hero.role);
  const snapshot = { ...a };
  state.ask.matchId = match.id;
  state.timer = { startedAt: null, clicks: 0, keys: 0 };
  // 振り返りの問いへ進む
  const next = askSteps(a.result)[ASK_BEFORE_SAVE.length];
  // ヒーローを Enter で決めたあとの連打・押しっぱなしで、振り返りが空のままとばされないよう、1問目に進んだ直後も少しのあいだ決める操作を受けない
  if (next) {
    state.ui.pausedUntil = Date.now() + FINISH_PAUSE_MS;
    goAsk(next);
  } else finishAsk();
  // 入力時間とクリック数・今日の勝敗は保存するが、ここには出さない(急かさない。設計書 敗北直後の見せ方)。
  // 押し間違いは「取り消す」で戻せる。トーストが消えた後も、振り返りのあいだは「保存を取り消す」と、1問目の空の ← で戻せる。
  toast(savedSign(a.result), {
    ms: SAVED_MS,
    action: { label: '保存を取り消す', run: () => undoSave(match.id, snapshot) },
  });
}

// 保存の合図(設計書「簡易入力の設計」)。保存直後のトーストに、結果のアイコンと結果名と一言を出す。
// 保存したことが分かるよう、結果名のあとに「を保存しました」を続ける(2026-11-10 専門家レビュー)。
const SAVED_SIGNS = {
  win: { icon: 'M3 8l4.5 4L12 5l4.5 7L21 8l-2 10H5z', text: 'ナイスゲーム!' }, // 王冠
  loss: { icon: 'M4 5v5h5M4.6 10A8 8 0 1 1 6 16.5M12 8v4l3 2', text: 'ひと息ついてから、振り返りましょう' }, // 巻き戻す矢印(recall)
  draw: { icon: 'M7 10h10M7 14h10', ring: true, text: '惜しかった!' }, // イコール
};
const SCORE_CLASS = { win: 'w', loss: 'l', draw: 'd' };
// 合図(保存直後のトースト)を出しておく時間(ミリ秒。仮置き)
const SAVED_MS = 3000;

function savedSign(result) {
  const s = SAVED_SIGNS[result];
  const icon = svg('svg', { viewBox: '0 0 24 24', width: 22, height: 22, 'aria-hidden': 'true', class: 'saved-icon', ...line, stroke: 'currentColor', 'stroke-width': 2.2 },
    ...(s.ring ? [svg('circle', { cx: 12, cy: 12, r: 10 })] : []), svg('path', { d: s.icon, class: 'saved-draw' }));
  return h('span', { class: `saved-sign saved-${result}` },
    // 「DEFEAT を保存しました」は途中で折り返さないよう1つにまとめ、一言は次の行に回ってよい
    h('span', { class: 'saved-head' }, icon, h('span', { class: 'saved-res' }, RESULT_LABELS[result]), h('span', { class: 'saved-done' }, 'を保存しました')),
    h('span', { class: 'saved-text' }, s.text));
}

// メニューバーの今日の勝敗で、保存した試合のロールの増えた数字を弾ませる
function bumpToday(result, role) {
  // 「試合数だけ」では試合数を弾ませる(設計書 F3)
  const cls = state.display.today === 'count' ? 'n' : SCORE_CLASS[result];
  $(`#today-chip .tally-role[data-role="${role ?? ''}"] .${cls}`)?.classList.add('bump');
}

// 保存の取り消し(設計書 押し間違いへの備え)。試合を消し、答えを問いかけ入力に戻してヒーローの問いを開く。
// すでに次の試合の入力を始めていたら、入力は書き換えず、削除だけを行う。
async function undoSave(matchId, snapshot) {
  try {
    await db.deleteMatch(matchId);
  } catch (e) {
    toast(`取り消せませんでした: ${e?.message ?? e}`);
    return;
  }
  await reload();
  queueAutoSave();
  const untouched = state.ask.matchId === matchId || isAskEmpty({ ...state.ask, text: askInput().value });
  if (untouched) {
    // ヒーローの答えもそのまま戻し、空 Enter で前のヒーローをそのまま入力し直せるようにする(設計書 押し間違いへの備え)
    state.ask = { ...emptyAsk(), answers: { ...snapshot }, seen: new Set(ASK_BEFORE_SAVE.slice(0, -1)) };
    state.ui.pausedUntil = 0;
    state.timer = { startedAt: null, clicks: 0, keys: 0 };
    goAsk('hero');
  }
  renderAll();
  saveDraft();
  toast('保存を取り消しました');
}

// 試合に属する行(自分のピック・Ban・構成タイプ)。問いかけ入力と編集ダイアログで同じ形を使う。
function childRows(matchId, f) {
  const compTypes = [];
  if (f.allyComp) compTypes.push({ matchId, team: 'ally', type: f.allyComp });
  if (f.enemyComp) compTypes.push({ matchId, team: 'enemy', type: f.enemyComp });
  return {
    slots: f.heroIds.map((heroId, order) => ({ matchId, team: 'self', heroId, isSelf: true, order })),
    // 設計書の Ban にはチーム項目があるが、入力画面ではまだ区別しない(null)。
    bans: f.banned ? [...f.bans].map(([heroId, b]) => ({ matchId, team: null, heroId, wanted: b.wanted })) : [],
    compTypes,
  };
}

async function deleteMatch(m) {
  if (!confirm(`${formatTime(m.createdAt)} の試合を削除しますか?`)) return;
  // 取り消せるよう、消す前の行を取っておく(保存の取り消しと同じく8秒。設計書 押し間違いへの備え)
  const rows = {
    match: m,
    slots: state.slots.filter((x) => x.matchId === m.id),
    bans: state.bans.filter((x) => x.matchId === m.id),
    compTypes: state.compTypes.filter((x) => x.matchId === m.id),
    review: state.reviews.get(m.id) ?? null,
  };
  try {
    await db.deleteMatch(m.id);
  } catch (e) {
    toast(`削除できませんでした: ${e?.message ?? e}`);
    return;
  }
  // 振り返りを聞いている途中の試合を消したら、次の試合の最初の問いに戻る。打ちかけの文も消す(次の試合の欄に残さない)
  if (state.ask.matchId === m.id) {
    state.ask = emptyAsk();
    state.ui.sel = -1;
    state.ui.typed = null;
    askInput().value = '';
  }
  await reload();
  queueAutoSave();
  renderAll();
  renderMatchesView();
  saveDraft();
  // フォーカスがページの外へ飛ばないよう、一覧の見出しに移す
  $('#matches-title')?.focus();
  toast('試合を削除しました', { ms: UNDO_MS, action: { label: '取り消す', run: () => undoDelete(rows) } });
}

// 削除の取り消し。消す前の行をそのまま入れ直す
async function undoDelete(rows) {
  try {
    await db.saveMatch(rows);
  } catch (e) {
    toast(`取り消せませんでした: ${e?.message ?? e}`);
    return;
  }
  await reload();
  queueAutoSave();
  renderAll();
  renderMatchesView();
  toast('削除を取り消しました');
}

// ---------- 振り返り(F6) ----------

const ACTION_HINT = 'ヒント: 自分の行動で書くと?(例:「〇〇した」「〇〇しなかった」)';

// 振り返りを部分的に書き換える。以前の項目(例: 次に試すこと)は消さずに残す。
async function saveReview(matchId, patch) {
  const prev = state.reviews.get(matchId) ?? { matchId };
  await db.put('reviews', { ...prev, ...patch, matchId, updatedAt: new Date().toISOString() });
  await reload();
  queueAutoSave();
}

// ---------- 描画: 問いかけ入力 ----------

// 次の試合で試すこと: 記録する枠の上に、いちばん新しい次の行動(負け=改善点、勝ち・引き分け=次はどう動く)を
// 1件だけ出す。1件もなければ出さない(設計書「簡易入力の設計」)
function renderPrevImprovement() {
  const entry = latestNextMove(state.matches, state.reviews);
  $('#prev-imp').hidden = !entry;
  if (!entry) return;
  const m = entry.match;
  const map = m.mapId ? state.mapById.get(m.mapId) : null;
  const heroId = selfHeroIds(m.id)[0] ?? null;
  // いつの試合か: 1分未満は「たった今」、60分未満は「N分前」、今日なら「今日 21:40」、それより前は「10月24日」
  const minutes = Math.floor((Date.now() - new Date(m.createdAt).getTime()) / 60000);
  const day = dayKeyOf(new Date(m.createdAt));
  const [, mo, d] = day.split('-').map(Number);
  const when = minutes < 1 ? 'たった今' : minutes < 60 ? `${minutes}分前` :day === dayKeyOf(new Date()) ? `今日 ${formatTime(m.createdAt)}` : `${mo}月${d}日`;
  // どこから来た文か: その試合のあとに記録した試合の数で「直前の」「3試合前の」と出す(いつも「前回の」だと、古い文でも直前の試合に見えるため)
  const later = state.matches.filter((x) => x.createdAt > m.createdAt).length;
  const ago = later ? `${later + 1}試合前の` : '直前の';
  const fromKind = entry.from ? { win: '危なかった場面', draw: '勝ち切れなかった場面' }[m.result] : { win: '勝ち', draw: '引き分け', loss: '負け' }[m.result];
  $('#prev-imp-text').textContent = entry.text;
  // 勝ち・引き分けは、元になった場面を補足の上に1行で出す
  const fromLabel = { winRisk: '危なかった場面', drawMiss: '勝ち切れなかった場面' }[entry.from?.key];
  $('#prev-imp-from').hidden = !fromLabel;
  $('#prev-imp-from').textContent = fromLabel ? `${fromLabel}: ${entry.from.text}` : '';
  // メタ情報はピル枠や強い色を付けず、落ち着いた1行のテキストで並べる
  $('#prev-imp-meta').textContent = [
    `${ago}${fromKind ?? '試合'}より`,
    heroId ? heroName(heroId) : null,
    m.mapId ? (map?.name ?? DELETED_LABELS.map) : null,
    RESULT_LABELS[m.result],
    when,
  ].filter(Boolean).join(' · ');
  $('#prev-imp-more').onclick = () => { state.ui.historyMode = 'review'; };
}

// 問いの進み: 「記録」(保存前の5問)と「振り返り」の段に分け、いまの段の点だけを出す。
// 段の中では分母が変わらない。振り返りの段では、記録を「✓ 記録」にたたむ(設計書「簡易入力の設計」)
function renderAskProgress(total, i) {
  const before = ASK_BEFORE_SAVE.length;
  const review = i >= before;
  const [name, count, at] = review ? ['振り返り', total - before, i - before] : ['記録', before, i];
  const dots = h('span', { class: 'step-dots' },
    Array.from({ length: count }, (_, k) => h('i', { class: k < at ? 'on' : k === at ? 'now' : '' })));
  const el = $('#ask-step');
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', `${name} ${count}問中${at + 1}問目`);
  fill(el,
    review ? [h('span', { class: 'step-group done' },
      svg('svg', { viewBox: '0 0 12 12', width: 12, height: 12, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
        svg('path', { d: 'M2.5 6.5l2.2 2.2L9.5 3.5' })),
      '記録'), h('span', { class: 'step-sep' })] : null,
    h('span', { class: 'step-group' }, name, dots));
}

function renderAsk({ focus = true } = {}) {
  // 「はじめての方へ」は、開いたときに記録が0件なら出す。保存しても消さず、次に開いたときから出さない(入力欄が跳ばないように。設計書 画面設計)
  $('#welcome').hidden = !state.ui.welcome;
  renderPrevImprovement();
  const steps = askStepsNow();
  const id = state.ask.step;
  const i = steps.indexOf(id);
  const def = stepDef(id);
  const locked = state.ask.matchId ? ASK_BEFORE_SAVE.length : 0;

  // 答えた問いの一覧。押すとその問いに戻る(保存した後は、保存より前の問いには戻らない)
  fill($('#ask-done'), steps.slice(0, i).map((sid, k) => {
    const v = askAnswer(sid);
    const label = answerLabel(sid, v);
    const color = answerColor(sid, v);
    // 1項目1行。文の答えは改行を空白にし、長ければ … で切る(全文は title に。設計書「簡易入力の設計」)
    const isText = stepDef(sid).kind === 'text' && !!label;
    return h('li', {},
      h('button', {
        type: 'button', class: 'done-item', tabindex: '-1', disabled: k < locked,
        title: `${isText ? `${label}\n\n` : ''}${k < locked ? '保存済みです。直すときは履歴の「直す・振り返り」で' : '押すと答え直せます'}`,
        onclick: () => { state.timer.clicks += 1; goAsk(sid); },
      },
      h('span', { class: 'done-q' }, stepDef(sid).short),
      h('span', { class: `done-a${label ? '' : ' skipped'}` },
        color ? h('span', { class: 'dot', style: `background: ${color}` }) : null,
        isText ? label.replace(/\s*\n\s*/g, ' ') : label ?? 'とばした')));
  }));

  // 下書きから戻したときは、どの問いから再開するかを問いの上に出す(設計書「入力途中の下書き」)
  const resumeEl = $('#ask-resume');
  resumeEl.hidden = !state.ui.resumed;
  fill(resumeEl, state.ui.resumed ? [`入力途中から再開しました(${def.short}の問い)`,
    state.ask.matchId ? null : h('button', { type: 'button', class: 'link', onclick: resetAsk }, '最初から')] : null);
  $('#ask-q').textContent = def.q;
  $('#ask-sub').textContent = def.sub ?? '';
  $('#ask-sub').hidden = !def.sub;
  renderAskProgress(steps.length, i);
  const input = askInput();
  input.placeholder = def.example ?? '';

  // 戻ってきた問いでは、いまの答えを出す
  const cur = answerLabel(id, askAnswer(id));
  const curEl = $('#ask-cur');
  curEl.hidden = !cur;
  fill(curEl, cur ? ['いまの答え: ', h('b', {}, cur), isTouch() ? '(空のまま決めるとそのまま)' : '(空のまま Enter でそのまま。Tab で書き直す)'] : null);

  renderAskOpts();
  renderAskKeys(def, !!cur);
  renderTextCount($('#ask-count'), def.kind === 'text' ? input.value.length : 0);
  $('#reset-form').hidden = !!state.ask.matchId;
  $('#undo-save').hidden = !state.ask.matchId;
  growAsk();
  if (focus && !$('#view-home').hidden && !$('#match-dialog').open) input.focus();
}

// 使えるキーの説明。主な3つを出し、残りは「ほかのキー操作」で開く(設計書「簡易入力の設計」)
function renderAskKeys(def, has) {
  const k = (t) => h('kbd', {}, t);
  // 振り返りの1問目では、← で保存を取り消してヒーローの問いに戻る
  const undo = !!state.ask.matchId && askStepsNow().indexOf(state.ask.step) === ASK_BEFORE_SAVE.length;
  const back = undo ? ' 保存を取り消す' : ' 前へ';
  const main = def.kind === 'text'
    ? [[k('Enter'), ' 次へ'], [k('Shift'), '+', k('Enter'), ' 改行'], ['空で ', k('←'), back]]
    : def.groups
      ? [[k('Tab'), ' 変換'], [k('Enter'), ' 決める'], [k('/'), ` ${def.browseOpenLabel}`], ['空で ', k('←'), back]]
      : [[k('Tab'), ' 変換'], [k('Enter'), ' 決める'], ['空で ', k('←'), back]];
  const all = [
    def.kind === 'text' ? [[k('Enter')], '次へ(空ならとばす)'] : [[k('Tab')], '選んでいる候補に変換(もう一度で次の候補)'],
    def.kind === 'text' ? [[k('Shift'), '+', k('Enter')], '改行'] : [[k('↓'), k('↑')], '候補を選ぶ'],
    def.kind === 'text' ? null : [[k('Enter')], `決める${def.optional ? '(空のままならとばす)' : ''}`],
    def.groups ? [[k('/'), ' / ', k('Ctrl'), '+', k('Space')], def.browseOpenLabel] : null,
    def.browseKey ? [[k(def.browseKey)], ` と打って${def.browseOpenLabel}`] : null,
    has ? [['空で ', k('Tab')], 'いまの答えを書き直す'] : null,
    [['空で ', k('←'), ' / ', k('Backspace')], undo ? '保存を取り消して、ヒーローの問いに戻る' : '前の問いへ'],
    [['空で ', k('→')], '次の問いへ'],
    [[k('Alt'), '+', k('1'), '〜', k('4')], '画面の切り替え'],
  ].filter(Boolean);
  const open = !!state.ui.keysOpen;
  fill($('#ask-keys'),
    h('div', { class: 'ask-keys-main' },
      main.map((x) => h('span', {}, ...x)),
      h('button', {
        type: 'button', class: 'link ask-keys-more', 'aria-expanded': String(open),
        onclick: () => { state.ui.keysOpen = !open; renderAskKeys(def, has); askInput().focus(); },
      }, open ? 'キー操作を閉じる' : 'ほかのキー操作')),
    open ? h('dl', { class: 'ask-keys-all' }, all.flatMap(([key, desc]) => [h('dt', {}, ...key), h('dd', {}, desc)])) : null);
}

// 段階の問い(scale)で、打った文字に合う段の位置。合わなければ -1
function scaleMatch(def, text) {
  const hit = text.trim() ? searchByName(def.items, text, [])[0] : null;
  return hit ? def.items.indexOf(hit) : -1;
}

// 段階の上の見出し。左端に「味方」、右端に「相手」を、向きの印つきで出す(設計書「簡易入力の設計」)
const chevron = (d) => svg('svg', { viewBox: '0 0 24 24', width: 14, height: 14, fill: 'none', stroke: 'currentColor', 'stroke-width': 2.4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' }, svg('path', { d }));
const scaleEnds = () => h('li', { class: 'scale-ends', role: 'presentation', 'aria-hidden': 'true' },
  h('span', { class: 'end-ally' }, chevron('M15 6l-6 6 6 6'), '味方'),
  h('span', { class: 'end-enemy' }, '相手', chevron('M9 6l6 6-6 6')));

// 候補。いま選んでいるものに aria-selected を付ける
function renderAskOpts() {
  const def = stepDef(state.ask.step);
  const typed = (state.ui.typed ?? askInput().value).trim();
  const hasRecent = def.kind === 'pick' && def.recent().length > 0;
  const opts = def.kind === 'pick' ? askCandidates(def).map((x) => ({ id: x.id, label: x.name, color: def.color(x) })) : [];
  if (state.ui.sel >= opts.length) state.ui.sel = opts.length ? 0 : -1;
  const box = $('#ask-opts');
  box.classList.toggle('gap-scale', !!def.scale);
  // マッチの質は、選んでいるあいだほかの2つを薄く出す(設計書「簡易入力の設計」)
  box.classList.toggle('has-sel', !!def.scale && state.ui.sel >= 0);
  const showRecent = def.kind === 'pick' && !!def.groups && !typed && hasRecent;
  fill(box, def.scale ? scaleEnds() : null,
  showRecent ? h('li', { class: 'opt-recent', role: 'presentation' }, '最近:') : null,
  opts.map((o, n) => h('li', {
    class: 'opt', role: 'option', id: `ask-opt-${n}`, 'aria-selected': String(n === state.ui.sel),
    onmousedown: (e) => { e.preventDefault(); state.ui.sel = n; state.timer.clicks += 1; askCommit(); },
  }, o.color ? h('span', { class: 'dot', style: `background: ${o.color}` }) : null, o.label)),
  def.kind === 'pick' && !opts.length && typed ? h('li', { class: 'opt-empty' }, '一致する候補がありません') : null,
  def.scale && typed && state.ui.sel < 0 ? h('li', { class: 'opt-empty scale-none' }, '一致する候補がありません') : null);
  const browseEl = $('#ask-browse');
  const showBrowse = def.kind === 'pick' && !!def.groups && !typed;
  browseEl.hidden = !showBrowse;
  fill(browseEl, showBrowse ? h('button', {
    type: 'button', class: 'link',
    onclick: () => { state.timer.clicks += 1; openBrowse(); },
  }, def.browseOpenLabel) : null);
  askInput().setAttribute('aria-activedescendant', state.ui.sel >= 0 ? `ask-opt-${state.ui.sel}` : '');
  // 「次へ」の文言: 文は 次へ/とばす、候補と段階は 決める/そのまま
  const empty = !askInput().value.trim();
  const has = !!askAnswer(state.ask.step);
  const send = $('#ask-send');
  if (def.kind === 'text') send.textContent = empty ? (has ? 'そのまま' : 'とばす') : '次へ';
  else send.textContent = state.ui.sel >= 0 && opts[state.ui.sel]?.id !== askAnswer(state.ask.step) ? '決める' : has ? 'そのまま' : def.optional ? 'とばす' : '決める';
  send.classList.toggle('skip', def.kind === 'text' ? empty : state.ui.sel < 0);
}

// ---------- マップ・ヒーロー一覧オーバーレイ(設計書 F1・F2) ----------

function browseContext() {
  const def = stepDef(state.ask.step);
  if (!def.groups) return null;
  const groups = def.groups();
  if (!groups.length) return null;
  const group = groups.find((g) => g.id === state.ui.browseGroup) ?? groups[0];
  return { def, groups, group };
}

function openBrowse({ byInput = false } = {}) {
  const ctx = browseContext();
  if (!ctx) return;
  state.ui.browseGroup = ctx.group.id;
  state.ui.browseSel = 0;
  state.ui.browseByInput = byInput;
  $('#browse-overlay').hidden = false;
  renderBrowse();
}

function closeBrowse({ restoreFocus = true } = {}) {
  const overlay = $('#browse-overlay');
  if (!overlay || overlay.hidden) return;
  overlay.hidden = true;
  if (state.ui.browseByInput) {
    askInput().value = '';
    state.ui.typed = null;
    state.ui.sel = -1;
    renderAskOpts();
  }
  state.ui.browseByInput = false;
  if (restoreFocus && !$('#view-home').hidden && !$('#match-dialog').open) askInput().focus();
}

function renderBrowse() {
  const ctx = browseContext();
  if (!ctx) return;
  const { def, groups, group } = ctx;
  const items = group.items;
  if (state.ui.browseSel >= items.length) state.ui.browseSel = items.length ? 0 : -1;
  $('#browse-title').textContent = def.browseTitle;
  fill($('#browse-tabs'), groups.map((g) => h('button', {
    type: 'button', class: 'browse-tab', role: 'tab', 'aria-selected': String(g.id === group.id),
    onclick: () => {
      state.ui.browseGroup = g.id;
      state.ui.browseSel = 0;
      renderBrowse();
    },
  }, h('span', { class: 'dot', style: `background: ${g.color}` }), g.name, ' ', h('span', { class: 'count' }, `(${g.items.length})`))));
  const grid = $('#browse-grid');
  grid.classList.toggle('is-map', state.ask.step === 'map');
  fill(grid, items.map((item, n) => h('li', {
    class: 'browse-item', role: 'option', 'aria-selected': String(n === state.ui.browseSel),
    onclick: () => { state.timer.clicks += 1; commitBrowseItem(item); },
  }, h('span', { class: 'dot', style: `background: ${def.color(item)}` }), item.name)));
  const k = (t) => h('kbd', {}, t);
  fill($('#browse-foot'),
    h('span', {}, k('←'), ' ', k('→'), ` ${def.browseSwitchLabel}　`, k('↑'), ' ', k('↓'), ' 選択　', k('Enter'), ' 決定'),
    h('span', {}, k('Esc'), ' で戻る'));
}

function moveBrowseGrid(deltaY) {
  const ctx = browseContext();
  if (!ctx || !ctx.group.items.length) return;
  const grid = $('#browse-grid');
  const cols = Math.max(1, getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length);
  const len = ctx.group.items.length;
  const cur = Math.max(0, state.ui.browseSel);
  const next = cur + deltaY * cols;
  if (next >= 0 && next < len) state.ui.browseSel = next;
  else state.ui.browseSel = (cur + deltaY + len) % len;
  renderBrowse();
  grid.children[state.ui.browseSel]?.scrollIntoView({ block: 'nearest' });
}

async function commitBrowseItem(item) {
  const step = state.ask.step;
  closeBrowse({ restoreFocus: false });
  await setAnswer(step, item.id);
}

// 文の長さに合わせて入力欄の高さを変える
function growAsk() {
  const input = askInput();
  input.style.height = 'auto';
  input.style.height = `${input.scrollHeight}px`;
}

function bindAsk() {
  const input = askInput();
  const form = $('#match-form');
  // 入力時間: 保存する前の問いに最初に触れた時点から数える
  const startTimer = () => { if (!state.ask.matchId) state.timer.startedAt ??= Date.now(); };
  form.addEventListener('keydown', startTimer, true);
  form.addEventListener('mousedown', startTimer, true);
  // 入力欄の外を押しても、入力欄にフォーカスを戻す(ボタン・リンクは除く)
  form.addEventListener('mousedown', (e) => {
    if (!e.target.closest('button, a, textarea, .opt')) { e.preventDefault(); input.focus(); }
  });

  input.addEventListener('input', () => {
    const def = stepDef(state.ask.step);
    // 打ち直したら、Tab で変換する前の文字ではなく、いまの文字で絞る
    state.ui.typed = null;
    if (def.browseKey && input.value.trim().toLowerCase() === def.browseKey) {
      renderAskOpts();
      openBrowse({ byInput: true });
      return;
    }
    // 結果などは、候補が1つに絞れるまで選ばない(d だけでは DRAW と DEFEAT を決めない。設計書 F3)
    if (def.scale) state.ui.sel = scaleMatch(def, input.value);
    else if (def.kind === 'pick') state.ui.sel = input.value.trim() && (def.firstSelected || askCandidates(def).length === 1) ? 0 : -1;
    renderAskOpts();
    renderTextCount($('#ask-count'), def.kind === 'text' ? input.value.length : 0);
    growAsk();
    queueDraft();
  });

  input.addEventListener('keydown', (e) => {
    const def = stepDef(state.ask.step);
    // 日本語の変換中(確定の Enter を含む)は何もしない
    if (e.isComposing || e.keyCode === 229 || e.altKey || e.metaKey) return;
    if (e.ctrlKey) {
      if ((e.code === 'Space' || e.key === ' ') && def.groups) {
        e.preventDefault();
        e.stopPropagation();
        openBrowse();
      }
      return;
    }
    const empty = input.value === '';
    if (e.key === '/' && empty && def.groups) {
      e.preventDefault();
      e.stopPropagation();
      openBrowse();
      return;
    }
    // Esc: 開いている「ほかのキー操作」を閉じる
    if (e.key === 'Escape' && state.ui.keysOpen) {
      e.preventDefault();
      state.ui.keysOpen = false;
      renderAskKeys(def, !!askAnswer(state.ask.step));
      return;
    }
    // 入力欄が空のときだけ、← と Backspace・Delete で前の問いへ、→ で次の問いへ(答えてある問いだけ)
    if (empty && ['ArrowLeft', 'Backspace', 'Delete'].includes(e.key)) {
      e.preventDefault();
      askBack({ repeat: e.repeat });
      return;
    }
    if (empty && e.key === 'ArrowRight') {
      e.preventDefault();
      if (askAnswer(state.ask.step) || def.kind === 'text' || def.optional) askNext();
      return;
    }
    // Tab(空のとき): いまの答えを入力欄に出して書き直す
    if (e.key === 'Tab' && !e.shiftKey && empty && askAnswer(state.ask.step)) {
      e.preventDefault();
      input.value = def.kind === 'pick' ? answerLabel(state.ask.step, askAnswer(state.ask.step)) : askAnswer(state.ask.step);
      input.dispatchEvent(new Event('input'));
      return;
    }
    // Tab(打った文字があるとき): 選んでいる候補の名前に変換する。変換済みなら次の候補へ(設計書 F3)
    if (e.key === 'Tab' && !e.shiftKey && def.kind === 'pick' && !empty) {
      e.preventDefault();
      const list = askCandidates(def);
      if (!list.length) return;
      const cur = state.ui.typed !== null ? list.findIndex((x) => x.name === input.value) : -1;
      state.ui.typed ??= input.value;
      state.ui.sel = cur >= 0 ? (cur + 1) % list.length : Math.max(state.ui.sel, 0);
      input.value = list[state.ui.sel].name;
      renderAskOpts();
      queueDraft();
      return;
    }
    const n = $('#ask-opts').querySelectorAll('.opt').length;
    if (def.kind !== 'text' && (e.key === 'ArrowDown' || e.key === 'ArrowUp') && n) {
      e.preventDefault();
      state.ui.sel = e.key === 'ArrowDown' ? (state.ui.sel + 1) % n : (state.ui.sel - 1 + n) % n;
      renderAskOpts();
      return;
    }
    if (e.key === 'Enter' && !(def.kind === 'text' && e.shiftKey)) {
      e.preventDefault();
      askCommit({ byKey: true });
    }
  });

  $('#ask-send').addEventListener('click', () => { state.timer.clicks += 1; askCommit(); input.focus(); });
  $('#reset-form').addEventListener('click', resetAskWithUndo);
  $('#undo-save').addEventListener('click', undoAskSave);
  window.addEventListener('pagehide', saveDraft);
}

// ---------- ロールのアイコン ----------
// Tank / DPS / Support を簡単な図形で示す(自作。Blizzard のアイコンは使わない。設計書 F3)。
// 名前は読み上げ用のラベルとツールチップに付ける。

const SVG_NS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.append(...children);
  return el;
}

const ROLE_SHAPES = {
  // 盾
  tank: () => [svg('path', { d: 'M12 2.5 20 5.5v6c0 4.9-3.3 8.6-8 10-4.7-1.4-8-5.1-8-10v-6z' })],
  // 弾丸3本と、その下に間を空けた薬莢の底(Wikimedia Commons の Damage_icon.svg を参考にした自作の図形)
  damage: () => [2, 9.5, 17].map((x) =>
    svg('path', { d: `M${x} 18.2V4.6c0-2.1 2-3.9 2.5-3.9s2.5 1.8 2.5 3.9v13.6zM${x} 19.6h5v3.8h-5z` })),
  // 十字
  support: () => [svg('path', { d: 'M9.5 3h5v6.5H21v5h-6.5V21h-5v-6.5H3v-5h6.5z' })],
};

function roleIcon(roleId, size = 20) {
  const shape = ROLE_SHAPES[roleId];
  if (!shape) return null;
  return svg('svg', {
    viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': 'true',
    class: `role-icon role-${roleId}`, fill: 'currentColor', stroke: 'currentColor', 'stroke-width': 0,
  }, ...shape());
}

// ---------- モード(Ranked・Quick とマップのモード)のアイコン ----------
// Overwatch のゲーム内の見た目を参考にした、自作の簡単な図形(Blizzard の画像は使わない。設計書 F1・F3)。色は css の --mc-<id>。
const GAME_ICON_SHAPES = {
  // ランク: ひし形の記章に星(星は穴)
  ranked: () => [svg('path', { d: 'M12 1.8 21 9.5 12 22.2 3 9.5zM12 6.6l1.5 3.1 3.4.5-2.5 2.4.6 3.4-3-1.6-3 1.6.6-3.4-2.5-2.4 3.4-.5z', 'fill-rule': 'evenodd' })],
  // クイック: 稲妻
  quick: () => [svg('path', { d: 'M13.6 1.8 5 13.4h5.6L9.4 22.2 19 10.2h-5.8z' })],
  // Control: 占領エリア(輪と中心)
  control: () => [svg('circle', { cx: 12, cy: 12, r: 8.5, fill: 'none', 'stroke-width': 2.4 }), svg('circle', { cx: 12, cy: 12, r: 3.4 })],
  // Escort: 荷台と、進む向きの矢印
  escort: () => [svg('rect', { x: 2.5, y: 8, width: 11, height: 7, rx: 1.5 }), svg('circle', { cx: 5.5, cy: 18, r: 2 }), svg('circle', { cx: 11, cy: 18, r: 2 }), svg('path', { d: 'M15.5 6.5 22 11.5l-6.5 5z' })],
  // Hybrid: 占領エリアと荷台
  hybrid: () => [svg('circle', { cx: 8.5, cy: 8.5, r: 5.5, fill: 'none', 'stroke-width': 2.2 }), svg('circle', { cx: 8.5, cy: 8.5, r: 2 }), svg('rect', { x: 10, y: 13, width: 11.5, height: 5.5, rx: 1.4 }), svg('circle', { cx: 13, cy: 20.5, r: 1.6 }), svg('circle', { cx: 18.5, cy: 20.5, r: 1.6 })],
  // Push: ロボットの頭(目は穴)と、左右に押す矢印
  push: () => [svg('path', { d: 'M9 2.5h6a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2zM9.5 6v2.4h2V6zM12.5 6v2.4h2V6z', 'fill-rule': 'evenodd' }), svg('path', { d: 'M2 18.5 6.5 15v7zM22 18.5 17.5 15v7zM8 17.5h8v2H8z' })],
  // Flashpoint: 炎
  flashpoint: () => [svg('path', { d: 'M12.5 1.8c.8 3.8 5.5 6 5.5 11.2a6 6 0 0 1-12 0c0-2.3.9-3.8 2.2-5.2.2 1.5.9 2.3 1.8 2.7C9.5 7.9 10.9 4.6 12.5 1.8z' })],
  // Clash: 向かい合う矢じり
  clash: () => [svg('path', { d: 'M2.5 5.5 10 12l-7.5 6.5zM21.5 5.5 14 12l7.5 6.5z' })],
};

function gameIcon(id, size = 16) {
  const shape = GAME_ICON_SHAPES[id];
  if (!shape) return null;
  return svg('svg', {
    viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': 'true',
    class: 'game-icon', fill: 'currentColor', stroke: 'currentColor', 'stroke-width': 0, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
  }, ...shape());
}

// 時計・天秤・曜日のアイコン(自作の簡単な図形。設計書 F3)。stroke で描く線と、fill で塗る面を混ぜる。
const line = { fill: 'none', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
const SLOT_SHAPES = {
  clock: () => [svg('circle', { cx: 12, cy: 12, r: 9, ...line }), svg('path', { d: 'M12 7v5l3 2', ...line })],
  // ピークタイム/オフピーク: マッチの質を表す天秤。水平=安定(ピークタイム)、傾き=不均等(オフピーク)
  peak: () => [svg('path', { d: 'M5 7h14M12 4v15M8 19h8M5 7l-2.5 6h5zM19 7l-2.5 6h5z', ...line })],
  offpeak: () => [svg('path', { d: 'M5 10 19 4M12 7v12M8 19h8M5 10l-2.5 6h5zM19 4l-2.5 6h5z', ...line })],
  weekday: () => [svg('rect', { x: 3.5, y: 5, width: 17, height: 15.5, rx: 2.5, ...line }), svg('path', { d: 'M3.5 10h17M8 3v4M16 3v4', ...line })],
  weekend: () => [svg('rect', { x: 3.5, y: 5, width: 17, height: 15.5, rx: 2.5, ...line }), svg('path', { d: 'M3.5 10h17M8 3v4M16 3v4', ...line }), svg('rect', { x: 12.5, y: 13, width: 4.5, height: 4, rx: 1, 'stroke-width': 0 })],
};


function slotIcon(id, size = 16) {
  return svg('svg', {
    viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': 'true',
    class: `slot-icon slot-${id}`, fill: 'currentColor', stroke: 'currentColor', 'stroke-width': 0,
  }, ...SLOT_SHAPES[id]());
}

// ---------- 描画: 記録画面 ----------

function renderAll() {
  renderToday();
  renderAsk({ focus: false });
  renderQualityTags();
  fill($('#peak-hint'), hintParas(
    'ピークタイム(19:00〜24:00): 最も人が多く、マッチングが早い。マッチの質が良い\nオフピーク(それ以外): 人が少なく、格差マッチが起きやすい。マッチの質が不安定になりがち\n土日: ピークタイムでも不安定になりがち\n\n入力した時刻で自動的に決まります(日本サーバー基準)。'));
}

// 指定した1日(0:00〜24:00)の試合。新しい順。
function matchesOfDay(dayKey) {
  return state.matches
    .filter((m) => dayKeyOf(new Date(m.createdAt)) === dayKey)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// 今日の累計: メニューバーの名前の右に出す。「今日」の文字は出さず、読み上げ用ラベルとツールチップに持たせる。
// 勝率と合計は出さず、記録のあるロールごとにアイコンと勝敗を並べる。記録がない日は枠ごと出さない(設計書 F3)。
// 設定の「今日の表示」が「試合数だけ」ならロールごとの試合数を、「出さない」なら枠ごと出さない。
function renderToday() {
  const tally = dailyTally(state.matches, dayKeyOf(new Date()));
  const mode = state.display.today;
  const count = (t) => t.wins + t.losses + t.draws;
  const jaText = (t) => (mode === 'count' ? `${count(t)}試合` : `${t.wins}勝${t.losses}敗${t.draws ? `${t.draws}分` : ''}`);
  const label = `今日 ${tally.map((t) => `${tallyLabel(t.key)} ${jaText(t)}`).join('、')}`;
  const chip = $('#today-chip');
  chip.hidden = !tally.length || mode === 'none';
  chip.title = label;
  chip.setAttribute('role', 'img');
  chip.setAttribute('aria-label', label);
  fill(chip, tally.map((t) => h('span', { class: 'tally-role', 'data-role': t.key },
    t.key ? roleIcon(t.key, 16) : h('span', { class: 'tally-label' }, tallyLabel(t.key)),
    mode === 'count' ? h('span', { class: 'tally-score' }, h('span', { class: 'n' }, String(count(t)))) : h('span', { class: 'tally-score' },
      h('span', { class: 'w' }, String(t.wins)), h('span', { class: 'sep' }, '-'), h('span', { class: 'l' }, String(t.losses)),
      // 引き分けは、あるロールだけ3つ目に出す(設計書 F3)
      t.draws ? [h('span', { class: 'sep' }, '-'), h('span', { class: 'd' }, String(t.draws))] : null))));
}

function tabs(items, current, onSelect, label) {
  return h('div', { class: 'tabs', role: 'tablist', 'aria-label': label },
    items.map((it) => h('button', {
      type: 'button',
      role: 'tab',
      class: `tab${it.mc ? ` mc mc-${it.mc}` : ''}`,
      'aria-selected': String(it.id === current),
      'aria-label': it.ariaLabel,
      onclick: () => onSelect(it.id),
    }, it.mc ? gameIcon(it.mc, 16) : null, it.label)));
}

// F3: 実力差。以前の段階の値(gg)は、いまの段階として表示する
const skillGapId = (id) => SKILL_GAP_ALIASES[id] ?? id;
const skillGapLabel = (id) => SKILL_GAPS.find((g) => g.id === skillGapId(id))?.label ?? '';

// 履歴の編集画面のマッチの質。記録画面と同じ3つのボタンで、枠の色で段階を示す(設計書 F3)。
function skillGapButtons(value, onChange) {
  const buttons = SKILL_GAPS.map((g) => h('button', {
    type: 'button', class: `gap-choice gap-${g.id}`, 'aria-pressed': String(g.id === skillGapId(value)),
    onclick: () => {
      for (const b of buttons) b.setAttribute('aria-pressed', String(b === buttons[SKILL_GAPS.indexOf(g)]));
      onChange(g.id);
    },
  }, g.label));
  return h('div', { class: 'gap-choices', role: 'group', 'aria-label': 'マッチの質' }, buttons);
}

// ---------- キーボード操作(設計書「簡易入力の設計」) ----------

// Alt+1〜4: 画面の切り替え(記録・履歴・集計・設定)。入力中でも効く。編集画面を開いている間は効かない
const VIEW_KEYS = ['#home', '#matches', '#stats', '#settings'];

function bindKeyboard() {
  document.addEventListener('keydown', (e) => {
    if (!$('#tour-overlay').hidden) {
      if (e.key === 'Escape' || (e.key === 'Enter' && !e.isComposing && !e.altKey && !e.ctrlKey && !e.metaKey)) {
        e.preventDefault();
        closeTour();
      }
      return;
    }
    if (!$('#browse-overlay').hidden) {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape' || e.key === '/' || (e.ctrlKey && (e.code === 'Space' || e.key === ' '))) {
        e.preventDefault();
        closeBrowse();
        return;
      }
      const ctx = browseContext();
      if (!ctx) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const i = ctx.groups.indexOf(ctx.group);
        const dir = e.key === 'ArrowRight' ? 1 : -1;
        state.ui.browseGroup = ctx.groups[(i + dir + ctx.groups.length) % ctx.groups.length].id;
        state.ui.browseSel = 0;
        renderBrowse();
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        moveBrowseGrid(e.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const item = ctx.group.items[state.ui.browseSel];
        if (item) { state.timer.keys += 1; commitBrowseItem(item); }
      }
      return;
    }
    if (!e.altKey || e.ctrlKey || e.metaKey || e.repeat || $('#match-dialog').open) return;
    const n = /^(?:Digit|Numpad)([1-4])$/.exec(e.code)?.[1];
    if (!n) return;
    e.preventDefault();
    location.hash = VIEW_KEYS[n - 1];
  });
}

// 時刻は日本時間で出す(設計書 F3)。
function formatTime(iso) {
  const { hour, minute } = jstParts(new Date(iso));
  return `${hour}:${String(minute).padStart(2, '0')}`;
}

// 自分のピックを選んだ順に。order のない以前の記録は保存順のまま。
function selfHeroIds(matchId) {
  return state.slots
    .filter((s) => s.matchId === matchId && s.isSelf)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((s) => s.heroId);
}

const heroName = (id) => state.heroById.get(id)?.name ?? DELETED_LABELS.hero;
// 振り返りの問いに入れるヒーロー名(設計書 F6)。プレイしたヒーローがなければ「そのヒーロー」。
const reviewHero = (heroIds) => (heroIds.length ? heroName(heroIds[0]) : 'そのヒーロー');
// 振り返り欄の見出し。補足の問いがあれば2行目に出す。
const reviewLabel = (f, heroIds, attrs) => h('label', attrs, f.label(reviewHero(heroIds)), f.sub ? [h('br'), f.sub] : null);
const roleName = (id) => ROLES.find((r) => r.id === id)?.label ?? '';

// 試合の一覧(履歴の画面)。1試合1枚のカードにし、左端の帯で勝敗を示す。
// 「改善点」が未記入の負け試合には印を付ける(成功の判定に沿う。設計書 画面設計)。
// 並びは 勝敗 → 実力差 → 気持ちの整理 → マップ → ヒーロー(主観から客観へ。設計書 簡易入力の設計)。
function renderMatchList(el, list) {
  const running = runningTallies(state.matches);
  const line = (label, text) => (text ? h('div', { class: 'review-line' }, h('span', { class: 'muted' }, `${label}: `), text) : null);
  const tag = (text, cls = '') => h('span', { class: `tag${cls ? ` ${cls}` : ''}` }, text);
  fill(el,
    ...(list.length
      ? list.map((m) => {
        const r = state.reviews.get(m.id) ?? {};
        const heroes = selfHeroIds(m.id).map(heroName);
        const needsImprovement = m.result === 'loss' && !r.improvement?.trim();
        // ピークタイム/オフピークと土日のタグは入力時刻から計算する(設計書 F3)。5区分の名前は出さない。
        const when = matchTimeTags(new Date(m.createdAt));
        return h('li', { class: `match-card ${m.result}` },
          h('div', { class: 'mc-head' },
            h('span', { class: `res ${m.result}` }, RESULT_LABELS[m.result]),
            h('span', { class: 'tally-chip' }, tallyText(running.get(m.id), ':')),
            h('span', { class: 'muted mc-time' }, formatTime(m.createdAt)),
            needsImprovement ? h('span', { class: 'flag' }, '次に試すことを書く') : null),
          h('div', { class: 'mc-tags' },
            m.skillGap ? tag(skillGapLabel(m.skillGap), `gap-badge gap-${skillGapId(m.skillGap)}`) : tag('実力差未入力', 'empty'),
            h('span', {
              class: `tag time-tag ${when.peak ? 'time-peak' : 'time-offpeak'}`,
              title: when.peak ? 'マッチの質が良い' : 'マッチの質が不安定になりがち',
            }, when.peak ? 'ピークタイム' : 'オフピーク'),
            when.weekend ? h('span', { class: 'tag time-tag time-weekend', title: 'マッチの質が不安定になりがち' }, '土日') : null),
          // 気持ちの整理(自由メモ)を先に、続けて負けた試合の事実と改善点。以前の「成長したこと」「反省点」は読み取り専用で残す。
          // 以前の「次に試すこと」(r.next)は消さずに残し、画面には出さない(設計書 F6)。
          (r.memo || REVIEW_FIELDS.some((f) => r[f.key]) || r.did || r.didNot)
            ? h('div', { class: 'review-lines' },
              line('気持ちの整理', r.memo),
              ...REVIEW_FIELDS.map((f) => line(f.short(reviewHero(selfHeroIds(m.id))), r[f.key])),
              line('成長したこと(以前の記録)', r.did), line('反省点(以前の記録)', r.didNot))
            : null,
          h('div', { class: 'mc-tags' },
            tag(m.mapId ? state.mapById.get(m.mapId)?.name ?? DELETED_LABELS.map : 'マップ未入力', m.mapId ? '' : 'empty'),
            heroes.length ? tag(heroes.join(' → ')) : tag('ヒーロー未入力', 'empty')),
          // 入力時間・クリック数は計測と保存を続けるが、画面には出さない(何の数字か分かりにくいため。2026-11-09 ユーザー指定)
          h('div', { class: 'mc-foot' },
            h('span', { class: 'actions' },
              // 「改善点を書く」の印と重ねて催促しないよう、ボタンは強調しない(2026-11-09 ユーザー指定)
              h('button', { type: 'button', onclick: () => openEditor(m) }, '直す・振り返り'),
              h('button', { type: 'button', class: 'ghost del', onclick: () => deleteMatch(m) }, '削除'))),
        );
      })
      : [h('li', { class: 'empty-state' }, 'この日の記録はありません。')]),
  );
}

// 履歴の画面。見出しの左右の矢印で1日ずつ移動する。
function renderMatchesView() {
  const mode = state.ui.historyMode;
  for (const b of document.querySelectorAll('.history-mode button')) {
    b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
    b.onclick = () => { state.ui.historyMode = b.dataset.mode; renderMatchesView(); };
  }
  $('#games-panel').hidden = mode !== 'games';
  $('#review-panel').hidden = mode !== 'review';
  if (mode === 'review') renderReviewView();
  else renderGamesView();
}

// 「振り返り」: 上にロール別の勝敗(全期間)、下に振り返りを日をまたいで新しい順に並べる(設計書 画面設計 履歴)
function renderReviewView() {
  const records = roleRecords(state.matches);
  // 試合数が少ないうちは勝率を出さず「参考値」にする(1試合で「勝率 0%」と大きく出さないため)
  // 基準は集計の参考値と同じ(設計書 画面設計 履歴)
  const rate = (t) => (t.total < REFERENCE_MIN_GAMES
    ? h('span', { class: 'tag empty', title: `試合数が${REFERENCE_MIN_GAMES}未満のため、勝率は出さず参考値にしています` }, '参考値')
    : t.wins + t.losses ? `勝率 ${Math.round((t.wins / (t.wins + t.losses)) * 100)}%` : '勝率 —');
  const score = (t) => [h('span', { class: 'w' }, String(t.wins)), ' - ', h('span', { class: 'l' }, String(t.losses)),
    t.draws ? [' - ', h('span', { class: 'd' }, String(t.draws))] : null];
  const roleName = (t) => [t.key ? roleIcon(t.key, 20) : null, tallyLabel(t.key)];
  const [top, ...rest] = records;
  fill($('#role-records'),
    top ? h('div', { class: 'role-top' },
      h('span', { class: 'role-name' }, ...roleName(top)),
      h('span', { class: 'role-score' }, ...score(top)),
      h('span', { class: 'role-rate' }, rate(top)),
      h('span', { class: 'role-count' }, `${top.total}試合`)) : h('p', { class: 'muted' }, 'まだ記録がありません。'),
    rest.length ? h('div', { class: 'role-rest' }, rest.map((t) => h('span', { class: 'role-chip' },
      ...roleName(t), ' ', ...score(t), h('span', { class: 'muted' }, `(${t.total}試合)`)))) : null);

  const entries = reviewEntries(state.matches, state.reviews);
  const heroOf = (m) => selfHeroIds(m.id)[0] ?? null;
  const heroIds = [...new Set(entries.map((e) => heroOf(e.match)).filter(Boolean))];
  if (state.ui.reviewHero !== 'all' && !heroIds.includes(state.ui.reviewHero)) state.ui.reviewHero = 'all';
  const chip = (key, value, label) => h('button', {
    type: 'button', 'aria-pressed': String(state.ui[key] === value),
    onclick: () => { state.ui[key] = value; renderReviewView(); },
  }, label);
  // 絞り込みの表記は英語にそろえる(設計書 画面設計 履歴)
  fill($('#review-filters'),
    chip('reviewResult', 'all', 'All'), chip('reviewResult', 'win', 'Victory'), chip('reviewResult', 'loss', 'Defeat'), chip('reviewResult', 'draw', 'Draw'),
    h('span', { class: 'sep', 'aria-hidden': 'true' }),
    chip('reviewHero', 'all', 'All Heroes'), heroIds.map((id) => chip('reviewHero', id, heroName(id))));

  const shown = entries.filter((e) => (state.ui.reviewResult === 'all' || e.match.result === state.ui.reviewResult)
    && (state.ui.reviewHero === 'all' || heroOf(e.match) === state.ui.reviewHero));
  const today = dayKeyOf(new Date());
  const labelOf = Object.fromEntries(REVIEW_FIELDS.map((f) => [f.key, f.short()]));
  let lastDay = null;
  fill($('#review-list'), shown.length ? shown.flatMap(({ match: m, main, sub, next }) => {
    const day = dayKeyOf(new Date(m.createdAt));
    const [, mo, d] = day.split('-').map(Number);
    const sep = day !== lastDay ? h('li', { class: 'review-day' }, `${mo}月${d}日${day === today ? '(今日)' : ''}`) : null;
    lastDay = day;
    const map = m.mapId ? state.mapById.get(m.mapId) : null;
    const heroId = heroOf(m);
    const hero = heroId ? state.heroById.get(heroId) : null;
    return [sep, h('li', { class: 'review-item' },
      h('div', { class: 'review-meta' },
        h('span', { class: `res ${m.result}` }, RESULT_LABELS[m.result]),
        h('span', { class: 'mc-time' }, formatTime(m.createdAt)),
        m.mapId ? h('span', { class: 'tag' }, map ? h('span', { class: 'dot', style: `background: var(--mc-${map.mode})` }) : null, map?.name ?? DELETED_LABELS.map) : null,
        heroId ? h('span', { class: 'tag' }, hero ? roleIcon(hero.role, 14) : null, heroName(heroId)) : null),
      // 負けた試合・新しい1問形式は「次に試すこと」を大きく出す(過去の記録に旧項目がある試合は併せて表示)
      m.result === 'loss'
        ? [sub, main].filter(Boolean).flatMap((b) => [h('div', { class: 'review-key' }, labelOf[b.key]), h('div', { class: 'review-main' }, b.text)])
        : !main && !sub && next
          ? [h('div', { class: 'review-key' }, labelOf[next.key]), h('div', { class: 'review-main' }, next.text)]
          : [...(main ? [h('div', { class: 'review-key' }, labelOf[main.key]), h('div', { class: 'review-main' }, main.text)] : []),
            sub ? h('div', { class: 'review-sub' }, `${labelOf[sub.key]}: ${sub.text}`) : null,
            next ? h('div', { class: 'review-sub' }, `${labelOf[next.key]}: ${next.text}`) : null])];
  }) : h('li', { class: 'muted' }, entries.length ? 'この条件の振り返りはまだありません。' : '振り返りを書いた試合が、ここに新しい順に並びます。'));
  // 一覧に出ない試合が消えたように見えないよう、数と「履歴」への行き方を添える(設計書 画面設計 履歴)
  const missing = state.matches.length - entries.length;
  const missingEl = $('#review-missing');
  missingEl.hidden = missing <= 0;
  fill(missingEl, missing > 0 ? [`振り返りのない試合など、ここに出ていない試合が ${missing}件あります。`,
    h('button', { type: 'button', class: 'link', onclick: () => { state.ui.historyMode = 'games'; renderMatchesView(); } }, '試合一覧で見る')] : null);
}

// 「履歴」: 1日ずつ前後に移動する試合の一覧
function renderGamesView() {
  const today = dayKeyOf(new Date());
  const day = state.ui.listDay ?? today;
  const [, mo, d] = day.split('-').map(Number);
  const list = matchesOfDay(day);
  const tally = dailyTally(state.matches, day);
  $('#matches-title').textContent = `${mo}月${d}日${day === today ? '(今日)' : ''}`;
  const go = (n) => {
    const next = shiftDayKey(day, n);
    state.ui.listDay = next >= today ? null : next;
    renderMatchesView();
  };
  $('#day-prev').onclick = () => go(-1);
  $('#day-next').onclick = () => go(1);
  $('#day-next').disabled = day >= today;
  fill($('#matches-sub'),
    tally.length ? h('ul', { class: 'tally' }, tally.map((t) => h('li', {}, tallyText(t)))) : null,
    day !== today ? h('button', { type: 'button', class: 'link', onclick: () => { state.ui.listDay = null; renderMatchesView(); } }, '今日へ戻る') : null,
  );
  renderMatchList($('#matches-list'), list);
}

// ---------- 後からの追記(試合の編集) ----------

const option = (value, label, selected = false) => h('option', { value, selected }, label);

// ロール別にまとめたヒーローの選択欄。exclude にあるヒーローは出さない。
function heroSelect(label, exclude, onPick, role) {
  // 選んだロールのヒーローだけを出す(設計書 F2)
  const sel = h('select', { 'aria-label': label, 'data-focus-key': `hero-${label}` },
    option('', role ? `${label}を選ぶ…` : 'ロールを選んでください', true),
    state.master.heroes.filter((x) => x.role === role && !exclude.has(x.id)).map((x) => option(x.id, x.name)));
  sel.addEventListener('change', () => { if (sel.value) onPick(sel.value); });
  return sel;
}

function openEditor(m) {
  const review = state.reviews.get(m.id) ?? {};
  const comp = (team) => state.compTypes.find((c) => c.matchId === m.id && c.team === team)?.type ?? null;
  const model = {
    result: m.result,
    role: m.role ?? null,
    mapId: m.mapId ?? null,
    heroIds: selfHeroIds(m.id),
    // Ban の記録は廃止した。画面には出さないが、以前に保存した Ban は保存し直しても消さない(設計書 F2)
    bans: new Map(state.bans.filter((b) => b.matchId === m.id).map((b) => [b.heroId, { wanted: !!b.wanted }])),
    banned: state.bans.some((b) => b.matchId === m.id),
    // 構成タイプの記録は廃止した。画面には出さないが、以前に保存した構成タイプは保存し直しても消さない(設計書 F2)
    allyComp: comp('ally'),
    enemyComp: comp('enemy'),
    skillGap: m.skillGap ?? null, // 以前の記録で空のものは、スライダーを動かすまで空のまま
    // 振り返りの欄は REVIEW_FIELDS から導く(問いを足したときに、ここを直し忘れないように)
    ...Object.fromEntries(REVIEW_FIELDS.map((f) => [f.key, review[f.key] ?? ''])),
    memo: review.memo ?? '',
  };
  const dialog = $('#match-dialog');
  // 閉じるときに、変えた内容があるかを比べるための元の形
  const original = editorSnapshot(model);
  dialog.oncancel = (e) => { if (!confirmDiscard(model, original)) e.preventDefault(); };
  renderEditor(m, model, original);
  if (!dialog.open) dialog.showModal();
  // 開いた直後は最初の文の欄にフォーカスを置く(勝敗のボタンに置くと、Enter 1回で勝敗が変わるため)
  dialog.querySelector('textarea')?.focus();
}

const editorSnapshot = (model) => JSON.stringify({ ...model, bans: [...model.bans] });
// 変えた内容があれば、閉じる前に確かめる(Esc・キャンセルで書いた文を黙って捨てない)
const confirmDiscard = (model, original) => editorSnapshot(model) === original || confirm('変えた内容を保存せずに閉じますか?');

function renderEditor(m, model, original) {
  const dialog = $('#match-dialog');
  const originalReview = state.reviews.get(m.id) ?? {};
  // 描き直しても、押したボタンや選んだ欄からフォーカスが外れないようにする
  const rerender = () => {
    const key = document.activeElement?.dataset?.focusKey;
    renderEditor(m, model, original);
    if (key) dialog.querySelector(`[data-focus-key="${key}"]`)?.focus();
  };
  // label は文字列か、振り返り欄の定義(LOSS_REVIEW_FIELDS・WIN_REVIEW_FIELDS・DRAW_REVIEW_FIELDS の1つ)
  const text = (key, label, hint) => {
    const id = `edit-${key}`;
    const area = h('textarea', { id, rows: '2', maxlength: String(TEXT_MAX), placeholder: label.example ?? null, 'aria-describedby': hint ? `${id}-hint` : null });
    area.value = model[key];
    const count = h('p', { class: 'text-count muted' });
    renderTextCount(count, area.value.length);
    area.addEventListener('input', () => { model[key] = area.value; renderTextCount(count, area.value.length); });
    return h('div', { class: 'field' },
      typeof label === 'string' ? h('label', { for: id }, label) : reviewLabel(label, model.heroIds, { for: id }), area, count,
      hint ? h('p', { class: 'muted hint-text', id: `${id}-hint` }, ACTION_HINT) : null);
  };
  const select = (label, value, options, onChange) => {
    const sel = h('select', { 'aria-label': label, 'data-focus-key': label }, options);
    sel.value = value ?? '';
    sel.addEventListener('change', () => onChange(sel.value || null));
    return h('label', { class: 'inline' }, `${label} `, sel);
  };

  const roleSel = select('ロール(必須)', model.role,
    [option('', '未選択'), ...ROLES.map((r) => option(r.id, r.label))], (v) => { model.role = v; model.heroIds = model.heroIds.filter((id) => state.heroById.get(id)?.role === v); rerender(); });
  const mapSel = select('マップ(必須)', model.mapId, [
    option('', '未選択'),
    // 削除したマップを使っている試合は、選び直すまでそのまま残す。
    model.mapId && !state.mapById.has(model.mapId) ? option(model.mapId, DELETED_LABELS.map) : null,
    ...state.master.modes.map((md) => {
      const maps = state.master.maps.filter((x) => x.mode === md.id);
      return maps.length ? h('optgroup', { label: md.name }, maps.map((x) => option(x.id, x.name))) : null;
    }),
  ], (v) => { model.mapId = v; });

  const heroChips = h('ol', { class: 'chips' }, model.heroIds.map((id, i) => h('li', {},
    heroName(id),
    h('button', { type: 'button', class: 'link', 'aria-label': `${heroName(id)}を外す`, onclick: () => { model.heroIds.splice(i, 1); rerender(); } }, '外す'))));
  const gapNote = h('span', { class: 'muted' }, model.skillGap ? '' : '(未記録。選ぶまで保存できません)');
  const gap = skillGapButtons(model.skillGap, (id) => { model.skillGap = id; gapNote.textContent = ''; });

  const save = async () => {
    if (!model.role) {
      toast('ロールを選んでください');
      return;
    }
    if (!model.skillGap) {
      toast('マッチの質(実力差)を選んでください');
      return;
    }
    if (!model.mapId) {
      toast('マップを選んでください');
      return;
    }
    if (!model.heroIds.length) {
      toast('ヒーローを選んでください');
      return;
    }
    const match = {
      ...m,
      result: model.result,
      role: model.role,
      mapId: model.mapId,
      skillGap: model.skillGap,
      updatedAt: new Date().toISOString(),
    };
    try {
      await db.updateMatch({ match, ...childRows(m.id, model) });
      // 現在の結果の振り返り欄と、元の試合に入っていた旧欄を保存する(設計書 F6)。
      // 以前の did・didNot や他の結果の旧欄は saveReview が消さずに残す。
      const patch = { memo: model.memo.trim() };
      const fields = { loss: LOSS_REVIEW_FIELDS, win: WIN_REVIEW_FIELDS, draw: DRAW_REVIEW_FIELDS }[model.result] ?? [];
      const legacy = (LEGACY_REVIEW_FIELDS[model.result] ?? []).filter((f) => originalReview[f.key]?.trim());
      for (const f of [...legacy, ...fields]) patch[f.key] = model[f.key].trim();
      // 何も書いていない試合には、空の振り返りを作らない。
      if (state.reviews.has(m.id) || Object.values(patch).some(Boolean)) await saveReview(m.id, patch);
      else await reload();
      queueAutoSave();
    } catch (e) {
      toast(`保存できませんでした: ${e?.message ?? e}`);
      return;
    }
    dialog.close();
    renderAll();
    renderMatchesView();
    toast('試合を更新しました');
  };

  const date = jstParts(new Date(m.createdAt));
  fill(dialog,
    h('h2', { id: 'match-dialog-title' },
      `${date.month}月${date.day}日 ${formatTime(m.createdAt)}の試合`),
    // いまの試合の内容を一番上に出し、マップ・ヒーローも直せると分かるようにする(設計書「簡易入力の設計」 編集画面)
    h('div', { class: 'edit-summary' },
      h('span', { class: 'tag' }, model.mapId ? state.mapById.get(model.mapId)?.name ?? DELETED_LABELS.map : 'マップ未選択'),
      model.heroIds.length
        ? model.heroIds.map((id) => h('span', { class: 'tag' }, heroName(id), model.role ? `(${tallyLabel(model.role)})` : ''))
        : h('span', { class: 'tag' }, 'ヒーロー未選択'),
      model.skillGap ? h('span', { class: 'tag' }, skillGapLabel(model.skillGap)) : null,
      h('button', {
        type: 'button', class: 'link',
        onclick: () => {
          const el = dialog.querySelector('[data-focus-key="マップ(必須)"]');
          el?.scrollIntoView({ block: 'center' });
          el?.focus();
        },
      }, 'マップ・ヒーローを直す')),
    // 勝敗の修正(設計書 押し間違いへの備え)。切り替えても、書いた振り返りは消さない。
    h('div', { class: 'seg', role: 'group', 'aria-label': '勝敗' },
      Object.entries(RESULT_LABELS).map(([id, label]) => h('button', {
        type: 'button',
        'aria-pressed': String(model.result === id),
        'data-focus-key': `result-${id}`,
        onclick: () => { model.result = id; rerender(); },
      }, label))),
    h('h3', {}, '振り返り'),
    // 現在の1問 + 過去の記録に値が入っていた旧欄だけ表示する(設計書 F6)。
    ...(LEGACY_REVIEW_FIELDS[model.result] ?? []).filter((f) => originalReview[f.key]?.trim()).map((f) => text(f.key, f, true)),
    ...({ loss: LOSS_REVIEW_FIELDS, win: WIN_REVIEW_FIELDS, draw: DRAW_REVIEW_FIELDS }[model.result] ?? []).map((f) => text(f.key, f, true)),
    text('memo', '気持ちの整理(敗因・気持ちなど。書いたかどうかだけを集計します)', false),
    h('h3', {}, '試合の内容'),
    h('div', { class: 'row' }, roleSel),
    h('div', { class: 'row' }, mapSel),
    h('div', { class: 'field' },
      h('div', {}, 'プレイしたヒーロー(必須・1人)'),
      heroChips,
      heroSelect('ヒーロー', new Set(), (id) => { model.heroIds = [id]; rerender(); }, model.role)),
    h('div', { class: 'field' }, h('div', {}, 'マッチの質(実力差) ', gapNote), gap),
    h('div', { class: 'row dialog-actions' },
      h('button', { type: 'button', class: 'primary', onclick: save }, '保存'),
      h('button', { type: 'button', onclick: () => { if (confirmDiscard(model, original)) dialog.close(); } }, 'キャンセル')),
  );
}

// ---------- 描画: 設定画面 ----------

function renderSettings() {
  for (const [name, key] of [['pref-today', 'today'], ['pref-stats', 'stats']]) {
    for (const r of document.querySelectorAll(`input[name="${name}"]`)) r.checked = r.value === state.display[key];
  }
  renderBackup();
  renderAutoSave();
}

// ---------- バックアップ(F8) ----------

const formatDateTime = (iso) => {
  const d = jstParts(new Date(iso));
  return `${d.month}月${d.day}日 ${formatTime(iso)}`;
};

function renderBackup() {
  const { due, lastAt } = backupStatus(state.matches.length, state.lastBackupAt);
  $('#backup-status').textContent = lastAt
    ? `最後に書き出した日時: ${formatDateTime(lastAt)}${due ? `(${BACKUP_STALE_DAYS}日以上たっています)` : ''}`
    : state.matches.length ? 'まだ書き出していません。' : '';
  $('#backup-status').classList.toggle('warn-text', due);
}

// フッターの促し。記録があり、書き出していないか古いときだけ出す(設計書 F8)。
function updateBackupNudge() {
  const { due, lastAt } = backupStatus(state.matches.length, state.lastBackupAt);
  const el = $('#backup-nudge');
  el.hidden = !due;
  el.textContent = due
    ? `バックアップを${lastAt ? `${BACKUP_STALE_DAYS}日以上取っていません` : 'まだ取っていません'}。設定画面から書き出せます。`
    : '';
}

const pad2 = (n) => String(n).padStart(2, '0');

async function exportBackup() {
  try {
    const now = new Date();
    const backup = buildBackup(await db.exportAll(BACKUP_STORES), now);
    const t = jstParts(now);
    downloadJson(backup, `recalm-backup-${t.year}${pad2(t.month)}${pad2(t.day)}-${pad2(t.hour)}${pad2(t.minute)}.json`);
    await markBackedUp(now);
    toast(`${backup.stores.matches.length}試合をファイルに書き出しました`);
  } catch (e) {
    toast(`書き出せませんでした: ${e?.message ?? e}`);
  }
}

function downloadJson(data, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function markBackedUp(now) {
  state.lastBackupAt = now.toISOString();
  await db.put('meta', { key: BACKUP_META_KEY, value: state.lastBackupAt });
  renderBackup();
  updateBackupNudge();
}

// ---------- フォルダへの自動保存(F8) ----------
// アプリは選んだフォルダにファイルを書くだけで、外部とは通信しない。クラウドへの同期は、同期ソフト(Google Drive for desktop など)が行う。

const autoSaveSupported = () => typeof window.showDirectoryPicker === 'function';

function renderAutoSave() {
  // フォルダを選べないブラウザでは、記録のたびの自動ダウンロードを出す(設計書 F8)
  $('#autosave-folder').hidden = !autoSaveSupported();
  $('#autodl').hidden = autoSaveSupported();
  if (!autoSaveSupported()) {
    const { enabled, lastAt } = state.autoDownload;
    $('#autodl-enabled').checked = enabled;
    $('#autodl-status').textContent = !enabled ? ''
      : lastAt ? `最後の保存: ${formatDateTime(lastAt)}(${autoDownloadName(new Date(lastAt))})`
        : 'まだ保存していません。試合か振り返りを記録すると保存します。';
    return;
  }
  const { dir, granted } = state.autoSave;
  const status = $('#autosave-status');
  status.textContent = !dir ? '保存先: 未設定'
    : granted ? `保存先: ${dir.name}(自動保存中)`
    : `保存先: ${dir.name}(書き込みの許可が切れています。「再接続」を押すと再開します)`;
  status.classList.toggle('warn-text', !!dir && !granted);
  $('#autosave-pick').textContent = dir ? 'フォルダを変える…' : 'フォルダを選ぶ…';
  $('#autosave-reconnect').hidden = !dir || granted;
  $('#autosave-stop').hidden = !dir;
}

async function pickAutoSaveDir() {
  let dir;
  try {
    dir = await window.showDirectoryPicker({ id: 'recalm-autosave', mode: 'readwrite' });
  } catch (e) {
    if (e?.name !== 'AbortError') toast(`フォルダを選べませんでした: ${e?.message ?? e}`);
    return;
  }
  await db.put('meta', { key: AUTOSAVE_META_KEY, value: dir });
  state.autoSave = { dir, granted: true };
  renderAutoSave();
  await writeAutoSave();
}

async function reconnectAutoSave() {
  const { dir } = state.autoSave;
  if (!dir) return;
  state.autoSave.granted = (await dir.requestPermission({ mode: 'readwrite' })) === 'granted';
  renderAutoSave();
  if (state.autoSave.granted) await writeAutoSave();
}

async function stopAutoSave() {
  clearTimeout(autoSaveTimer);
  await db.remove('meta', AUTOSAVE_META_KEY);
  state.autoSave = { dir: null, granted: false };
  renderAutoSave();
  toast('自動保存をやめました。フォルダのファイルは消していません');
}

let autoSaveTimer;
// 記録を変えたら呼ぶ。続けて変えたときは、AUTOSAVE_DELAY_MS 待ってまとめて1回書く。
// フォルダを選べないブラウザでは、download のとき(問いかけ入力を最後まで終えたとき)だけダウンロードする。
function queueAutoSave({ download = false } = {}) {
  if (!autoSaveSupported()) {
    if (download) queueAutoDownload();
    return;
  }
  if (!state.autoSave.dir || !state.autoSave.granted) return;
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(writeAutoSave, AUTOSAVE_DELAY_MS);
}

async function writeAutoSave() {
  const { dir } = state.autoSave;
  if (!dir) return;
  try {
    if ((await dir.queryPermission({ mode: 'readwrite' })) !== 'granted') {
      state.autoSave.granted = false;
      renderAutoSave();
      return;
    }
    const now = new Date();
    const backup = buildBackup(await db.exportAll(BACKUP_STORES), now);
    const writable = await (await dir.getFileHandle(AUTOSAVE_FILE, { create: true })).createWritable();
    await writable.write(JSON.stringify(backup, null, 2));
    await writable.close();
    await markBackedUp(now);
    noticeAutoSaved(`フォルダの ${AUTOSAVE_FILE} に`);
  } catch (e) {
    toast(`自動保存できませんでした: ${e?.message ?? e}`);
  }
}

// 表示の設定(設計書 画面設計 設定)。記録と一緒にバックアップに含めるので、自動保存も走らせる
async function setDisplay(key, value) {
  state.display = { ...state.display, [key]: value };
  try {
    await db.put('meta', { key: DISPLAY_META_KEY, value: state.display });
  } catch (e) {
    toast(`設定を保存できませんでした: ${e?.message ?? e}`);
  }
  renderToday();
  queueAutoSave();
}

// ---------- 記録のたびの自動ダウンロード(F8。フォルダを選べないブラウザ) ----------

const autoDownloadName = (d) => {
  const t = jstParts(d);
  return `recalm-backup-${t.year}${pad2(t.month)}${pad2(t.day)}-${pad2(t.hour)}${pad2(t.minute)}${pad2(d.getSeconds())}.json`;
};

async function setAutoDownload(enabled) {
  state.autoDownload = { ...state.autoDownload, enabled };
  await db.put('meta', { key: AUTODOWNLOAD_META_KEY, value: state.autoDownload });
  renderAutoSave();
}

function queueAutoDownload() {
  if (!state.autoDownload.enabled) return;
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(writeAutoDownload, AUTOSAVE_DELAY_MS);
}

async function writeAutoDownload() {
  try {
    const now = new Date();
    const name = autoDownloadName(now);
    downloadJson(buildBackup(await db.exportAll(BACKUP_STORES), now), name);
    state.autoDownload = { ...state.autoDownload, lastAt: now.toISOString() };
    await db.put('meta', { key: AUTODOWNLOAD_META_KEY, value: state.autoDownload });
    await markBackedUp(now);
    renderAutoSave();
    noticeAutoSaved(`ダウンロードに ${name}`);
  } catch (e) {
    toast(`自動保存できませんでした: ${e?.message ?? e}`);
  }
}

// 取り消しボタン付きの通知が出ているあいだは、その文に付け足す(ボタンを消さない。設計書 F8)。
// where は保存先とファイル名(「ダウンロードに recalm-backup-….json」)。どこに保存されたか分かるように添える
function noticeAutoSaved(where) {
  const text = `データが保存されました(${where})`;
  const el = $('#toast');
  if (el.classList.contains('show') && el.classList.contains('has-action')) {
    el.firstChild.textContent += `。${text}`;
  } else {
    toast(text, { ms: 5000 });
  }
}

const IMPORTED_KEY = 'recalm:imported';

// 読み込み直した後に、読み込んだ件数を出し、フォーカスを読み込みのボタンに置く
function noticeImported() {
  let n = null;
  try {
    n = sessionStorage.getItem(IMPORTED_KEY);
    sessionStorage.removeItem(IMPORTED_KEY);
  } catch {
    return;
  }
  if (n === null) return;
  toast(`${n}試合を読み込みました`, { ms: 5000 });
  if (location.hash === '#settings') $('#backup-import').focus();
}

// 読み込むと、いまの記録をすべて置き換える。実行前に確認する。
async function importBackup(input) {
  const file = input.files[0];
  input.value = ''; // 同じファイルをもう一度選べるようにする
  if (!file) return;
  const parsed = parseBackup(await file.text());
  if (!parsed.ok) {
    toast(`読み込めませんでした: ${parsed.error}`);
    return;
  }
  const when = parsed.exportedAt ? `(${formatDateTime(parsed.exportedAt)}に書き出し)` : '';
  if (!confirm(`${parsed.matchCount}試合のバックアップ${when}を読み込みます。\nいまの記録(${state.matches.length}試合)はすべて置き換わります。よろしいですか?`)) return;
  try {
    await db.replaceAll(parsed.stores, DEVICE_META_KEYS);
  } catch (e) {
    toast(`読み込めませんでした。記録は変わっていません: ${e?.message ?? e}`);
    return;
  }
  // 起動時の処理(日付・時間帯の計算し直し、廃止した値の削除)を通すため、読み込み直す。
  // 読み込み直した後に「N試合を読み込みました」と出すため、件数をこのタブの sessionStorage に一時的に置く
  try { sessionStorage.setItem(IMPORTED_KEY, String(parsed.matchCount)); } catch { /* 出せなくても読み込みは済んでいる */ }
  location.reload();
}

// ---------- 集計(F5) ----------

const percent = (num, den) => (den ? `${Math.round((num / den) * 100)}%` : '—');
const refTag = (total) => (total < REFERENCE_MIN_GAMES
  ? h('span', { class: 'tag empty', title: `試合数が${REFERENCE_MIN_GAMES}未満のため、参考値です` }, '参考値')
  : null);

function renderStats() {
  const matches = state.matches;
  // 一番上に集計の対象(全期間の試合数と期間)を出す。今日の分だけと誤解しないように(設計書 F5)
  const scope = statsScope(matches);
  const scopeEl = $('#stats-scope');
  scopeEl.hidden = !scope;
  if (scope) {
    const { from, to } = scope;
    const span = from.year !== to.year;
    const day = (d) => `${span ? `${d.year}年` : ''}${d.month}月${d.day}日`;
    const sameDay = !span && from.month === to.month && from.day === to.day;
    scopeEl.textContent = `全期間 ${scope.total}試合(${sameDay ? day(from) : `${day(from)}〜${day(to)}`})`;
  }
  // 今日の試合があれば、今日の試合数と勝敗を添える。グラフは全期間のまま(設計書 F5)
  const today = dailyTally(matches, dayKeyOf(new Date()))
    .reduce((a, t) => ({ wins: a.wins + t.wins, losses: a.losses + t.losses, draws: a.draws + t.draws }), { wins: 0, losses: 0, draws: 0 });
  const todayTotal = today.wins + today.losses + today.draws;
  const todayEl = $('#stats-today');
  // 設定の「今日の表示」に従う。「試合数だけ」では勝敗を省き、「出さない」では行ごと出さない(設計書 F5)
  const todayMode = state.display.today;
  todayEl.hidden = !todayTotal || todayMode === 'none';
  fill(todayEl, todayTotal ? [h('span', {}, '今日 ', h('b', {}, `${todayTotal}試合`)),
    todayMode === 'record' ? h('span', {}, h('span', { class: 'w' }, `${today.wins}勝`), h('span', { class: 'l' }, `${today.losses}敗`),
      today.draws ? h('span', { class: 'd' }, `${today.draws}分`) : null) : null,
    h('span', { class: 'muted' }, 'グラフは全期間で集計しています')] : null);
  // 試合数が参考値の基準に届かないうちは、あと何試合で分析できるかを出す(設計書 F5)
  const fewEl = $('#stats-few');
  fewEl.hidden = matches.length >= REFERENCE_MIN_GAMES;
  // 見落とさないよう、進み具合の棒つきの枠で目立たせる
  const got = Math.min(matches.length, REFERENCE_MIN_GAMES);
  fill(fewEl,
    h('p', { class: 'few-text' }, `あと${REFERENCE_MIN_GAMES - got}試合たまると、傾向を分析できます`),
    h('div', { class: 'few-bar', role: 'img', 'aria-label': `${REFERENCE_MIN_GAMES}試合中${got}試合` },
      h('span', { style: `width: ${(got / REFERENCE_MIN_GAMES) * 100}%` })),
    h('span', { class: 'few-count' }, `${got} / ${REFERENCE_MIN_GAMES}試合`));
  // はじめは上から、次に試すことの記入率、気持ちの記入率、経過時間別の勝率、時間帯別の勝率。
  // 設定の「集計の並び順」が「勝率を先に」なら、勝率の2つを先にする(設計書 F5)。注意書きは見出し横の「?」に入れる
  const habit = [$('#stats-impr-panel'), $('#stats-feel-panel')];
  const rates = [$('#stats-session-panel'), $('#stats-time-panel')];
  fewEl.after(...(state.display.stats === 'winrate' ? [...rates, ...habit] : [...habit, ...rates]));
  fill($('#stats-session-hint'), hintParas(
    `点の高さが勝率です。50%を下回った点と線は青灰で示します。点を押すと、勝-敗と試合数が出ます。白抜きの点は試合数が${REFERENCE_MIN_GAMES}未満の参考値です。\n横軸は${SESSION_ELAPSED_STEP_MINUTES}分ごとで、${REFERENCE_MIN_GAMES}試合以上たまった区切りまで並べ、残りは最後の「〜」にまとめます。遊ぶ時間が長くなると、横軸も自動で伸びます。\n時間は、セッションの最初の記録からの経過時間です。最初の試合の長さは入らないため、実際に遊んだ時間より15〜20分ほど短く出ます。\n前の記録から${SESSION_GAP_MINUTES}分以上あいたら、新しいセッションとして0分から数えます。疲れのほかに、時間帯や相手の違いも混ざるため、集中力そのものとは言い切れません。`));
  fill($('#stats-session'),
    matches.length
      ? sessionChart(sessionElapsedStats(matches))
      : h('p', { class: 'muted' }, 'まだ記録がありません。'));

  // 時間帯別: ピークタイム/オフピークと、土日/平日を別々に並べる(掛け合わせない)。勝-敗は棒の「?」と同じ仕組みで出す
  fill($('#stats-time-hint'), hintParas(
    'ピークタイムは19:00〜24:00、土日は日付(0:00区切り)で判定します。\n疲労や対戦相手の違いは分離できないため、時間帯そのものの影響とは言い切れません。'));
  const time = timeTagStats(matches);
  const timeBars = (title, icon, rows, labels) => h('div', { class: 'stat-bars' },
    h('p', { class: 'stat-sub' }, slotIcon(icon, 14), title),
    rows.map((s) => {
      const id = `stat-bar-${s.key}`;
      const record = `${s.draws ? '勝-敗-分' : '勝-敗'} ${winLossText(s)}`;
      return h('div', { class: 'bar-row' },
        h('span', { class: 'bar-label' }, slotIcon(s.key, 16), labels[s.key], ' ', s.total ? refTag(s.total) : null),
        h('span', { class: 'hint bar-hint' },
          h('button', { type: 'button', class: s.reference ? 'hint-btn bar ref' : 'hint-btn bar', 'aria-describedby': id, 'aria-label': `${labels[s.key]}の勝-敗` },
            s.rate === null ? null : h('span', { class: 'bar-fill', style: `width: ${Math.round(s.rate * 100)}%` })),
          h('span', { role: 'tooltip', id, class: 'hint-body' }, hintParas(record))),
        h('span', { class: 'bar-rate' }, percent(s.wins, s.wins + s.losses)),
        h('span', { class: 'bar-games muted' }, `${s.total}試合`));
    }));
  fill($('#stats-time'),
    matches.length
      ? [
        timeBars('時間帯', 'clock', time.peak, { peak: 'ピークタイム', offpeak: 'オフピーク' }),
        timeBars('曜日', 'weekday', time.weekend, { weekend: '土日', weekday: '平日' }),
      ]
      : h('p', { class: 'muted' }, 'まだ記録がありません。'));

  // 成功の判定: 負けた試合のうち、次に試すことを書けた割合(全試合で1つ。設計書「成功の判定」)。目標は常に出す
  const { improvementOnLoss: imp, feeling } = reviewRates(matches, state.reviews);
  const trial = trialProgress(imp.den);
  fill($('#stats-impr-hint'), hintParas('1試合ごとの揺れで判断せず、まとめて見てください。'));
  // 負けた試合が試用の数にたまるまでは割合を出さず、たまった数だけを出す(連敗の夜に「0%」を何度も見せないため。設計書 F5)
  fill($('#stats-impr'),
    imp.den && !trial.done
      ? [h('p', { class: 'stat-big' }, `${imp.num}`, h('span', { class: 'muted' }, ` / ${imp.den} 試合で書けた(負けた試合)`)),
        h('p', { class: 'muted' }, `割合は、負けた試合が${TRIAL_LOSS_GAMES}試合たまったら出します。`)]
      : imp.den
      ? h('p', { class: 'stat-big' }, percent(imp.num, imp.den),
        h('span', { class: 'muted' }, ` ${imp.num} / ${imp.den} 試合`), ' ', refTag(imp.den))
      : h('p', { class: 'muted' }, '負けた試合がまだありません。'),
    // 「あと N試合」は出さない(負けるほど進む表示になるため。2026-11-10 専門家レビュー)
    h('p', { class: 'muted small-note' }, `目標: ${Math.round(IMPROVEMENT_TARGET_RATE * 100)}%以上。`));

  // 気持ちの記入率: 「いまの気持ちは?」(自由メモ)を書いた試合の割合。中身は数えず、目標は置かない(設計書 F5)
  fill($('#stats-feel-hint'), hintParas('記録のはじめの「いまの気持ちは?」(履歴の「気持ちの整理」)を書いた試合の割合です。\n書いたかどうかだけを数え、中身は集計しません。目標はありません。'));
  fill($('#stats-feel'),
    feeling.den
      ? h('p', { class: 'stat-big' }, percent(feeling.num, feeling.den),
        h('span', { class: 'muted' }, ` ${feeling.num} / ${feeling.den} 試合`), ' ', refTag(feeling.den))
      : h('p', { class: 'muted' }, 'まだ記録がありません。'));
}

// セッション開始からの経過時間別の勝率の折れ線グラフ(設計書 F5)。縦軸は0〜100%で、勝ち・負けのない区分には点を打たない。
// 50%未満の点・線・数字は DEFEAT と同じ青灰にする。点を押すと、グラフの上の余白に勝-敗と試合数を出す。
function sessionChart(rows) {
  const W = 360, left = 36, right = 350, top = 34, bottom = 160;
  const step = (right - left) / rows.length;
  const x = (i) => left + step * (i + 0.5);
  const y = (rate) => bottom - (bottom - top) * rate;
  const text = (attrs, s) => svg('text', { 'text-anchor': 'middle', ...attrs }, s);
  const name = (r) => (r.last ? `${r.from}分〜` : `${r.from}〜${r.from + SESSION_ELAPSED_STEP_MINUTES}分`);
  const points = rows.map((r, i) => ({ r, i })).filter(({ r }) => r.rate !== null);
  const label = rows.map((r) => `${name(r)} ${r.rate === null ? '—' : `${Math.round(r.rate * 100)}%`}(${r.total}試合${r.total && r.reference ? '・参考値' : ''}${r.rate !== null && r.rate < 0.5 ? '・50%未満' : ''})`).join('、');
  const line = points.map(({ r, i }) => `${x(i).toFixed(1)} ${y(r.rate).toFixed(1)}`);
  const tip = h('div', { class: 'chart-tip', hidden: true });
  const chart = svg('svg', { class: 'session-chart', viewBox: `0 0 ${W} 186`, role: 'img', 'aria-label': `セッション開始からの経過時間ごとの勝率。${label}` },
    svg('defs', {}, svg('clipPath', { id: 'session-low-clip' }, svg('rect', { x: 0, y: y(0.5), width: W, height: bottom - y(0.5) + 8 }))),
    ...[top, bottom].map((v) => svg('line', { class: 'grid', x1: left, x2: right, y1: v, y2: v })),
    svg('line', { class: 'half', x1: left, x2: right, y1: y(0.5), y2: y(0.5) }),
    ...[[1, '100%'], [0.5, '50%'], [0, '0%']].map(([v, s]) => text({ x: left - 6, y: y(v) + 4, 'text-anchor': 'end' }, s)),
    ...(points.length > 1
      ? [svg('path', { class: 'area', d: `M${line.join(' L')} L${x(points.at(-1).i).toFixed(1)} ${bottom} L${x(points[0].i).toFixed(1)} ${bottom} Z` })]
      : []),
    ...(points.length > 1
      ? [
        svg('path', { class: 'line', d: `M${line.join(' L')}` }),
        svg('path', { class: 'line low', d: `M${line.join(' L')}`, 'clip-path': 'url(#session-low-clip)' }),
      ]
      : []),
    ...points.map(({ r, i }) => svg('circle', { class: ['pt', r.reference && 'ref', r.rate < 0.5 && 'low'].filter(Boolean).join(' '), cx: x(i), cy: y(r.rate), r: 4 })),
    ...points.map(({ r, i }) => text({ class: r.rate < 0.5 ? 'val low' : 'val', x: x(i), y: y(r.rate) - 9 }, `${Math.round(r.rate * 100)}%`)),
    ...rows.map((r, i) => text({ x: x(i), y: 180 }, r.last ? `${r.from}〜` : `${r.from}〜${r.from + SESSION_ELAPSED_STEP_MINUTES}`)),
    text({ class: 'axis-name', x: left - 6, y: 180, 'text-anchor': 'end' }, '分'));
  // 同じ点をもう一度押すと閉じる。吹き出しはグラフの幅からはみ出さない位置に寄せる
  const select = ({ r, i }, hit) => {
    const same = hit.classList.contains('sel');
    closeChartTips();
    if (same) return;
    hit.classList.add('sel');
    tip.textContent = `${name(r)}  ${r.wins}勝${r.losses}敗${r.draws ? `${r.draws}分` : ''}・${r.total}試合${r.reference ? '(参考値)' : ''}`;
    tip.hidden = false;
    const width = chart.getBoundingClientRect().width;
    const half = tip.offsetWidth / 2;
    tip.style.left = `${Math.min(Math.max(x(i) * (width / W), half), width - half)}px`;
  };
  for (const pt of points) {
    const hit = svg('circle', { class: 'hit', cx: x(pt.i), cy: y(pt.r.rate), r: 16, tabindex: 0, role: 'button', 'aria-label': `${name(pt.r)}の勝-敗と試合数` });
    hit.addEventListener('click', () => select(pt, hit));
    hit.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      select(pt, hit);
    });
    chart.append(hit);
  }
  return h('div', { class: 'chart-box' }, chart, tip);
}

// グラフの点を押して出した勝-敗を閉じる。
function closeChartTips() {
  for (const el of document.querySelectorAll('.chart-tip')) el.hidden = true;
  for (const el of document.querySelectorAll('.session-chart .hit.sel')) el.classList.remove('sel');
}

let toastTimer;
// action: { label, run } を渡すと、メッセージの横に押せるボタンを出す。
function toast(message, { action = null, ms = 3000 } = {}) {
  const el = $('#toast');
  el.replaceChildren(message, ...(action
    ? [h('button', { type: 'button', class: 'toast-action', onclick: () => { el.classList.remove('show'); action.run(); } }, action.label)]
    : []));
  el.classList.toggle('has-action', !!action);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

init();

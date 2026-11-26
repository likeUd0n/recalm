// 設定値。「仮置き」と書いたもの(下書きの24時間など)は docs/design.md で確定していない値なので、
// 変更・確定する前にユーザーに確認すること(CLAUDE.md ルール4)。

// 時間帯の5区分(ユーザー指定、日本サーバー基準。2026-10-19 に6区分から変更)。start <= 時 < end。end < start のものは日付をまたぐ。
// desc は区分名にカーソルを合わせたときに出す特徴(設計書 F3)。
// 変えた場合も、起動時に既存の試合の時間帯を入力時刻から計算し直す。
export const TIME_SLOTS = [
  { id: 'morning', label: '朝', start: 6, end: 11, desc: '極端なオフピーク。プレイヤーが最も少なく、格差マッチが起きやすい' },
  { id: 'daytime', label: '昼', start: 11, end: 16, desc: 'ややオフピーク。平日は主婦・夜勤明け・休みの人が中心で、落ち着いている' },
  { id: 'evening', label: '夕方', start: 16, end: 19, desc: 'アクティブ上昇期。学校終わりの学生やライト層が増え、クイックプレイが賑わう' },
  { id: 'golden', label: 'ピークタイム', start: 19, end: 24, desc: '最大のピークタイム。最も人が多く、マッチングが最短で、実力が拮抗して試合が激化する' },
  { id: 'late-night', label: '深夜', start: 0, end: 6, desc: '深いオフピーク。2時を過ぎると日本人が減り、韓国・台湾・東南アジアのプレイヤーとのマッチが増える。猛者が残りやすい' },
];

// ピークタイムにあたる区分(ユーザー指定、設計書 F3)。時間帯「ピークタイム」(内部の id は golden。19:00〜24:00)。それ以外はオフピーク。
// 5区分の名前は入力画面に出し、履歴には出さない。保存と計算にも使う。
export const PEAK_SLOT_IDS = ['golden'];

// 入力途中の下書き(設計書「簡易入力の設計」)。localStorage のキーと、有効な時間(時間)。24時間は仮置き。
export const DRAFT_KEY = 'recalm:draft';
export const DRAFT_MAX_AGE_HOURS = 24;
// 初回起動時の使い方ツアーを閉じた印(localStorage)。
export const TOUR_KEY = 'recalm:tourDone';
// 振り返りを終えて次の試合に戻った直後、決める操作を受けない時間(ミリ秒)。連打で次の試合の最初の問いまでとばさないため。
// 1秒は仮置き(2026-11-09 ペルソナレビュー。設計書「簡易入力の設計」)
export const FINISH_PAUSE_MS = 1000;

// 勝敗の表示名。保存する値は 'win' / 'loss' のまま。
export const RESULT_LABELS = { win: 'VICTORY', draw: 'DRAW', loss: 'DEFEAT' };

// ロールの表示名は英語(ユーザー指定)。保存する値は id のまま。
export const ROLES = [
  { id: 'tank', label: 'Tank' },
  { id: 'damage', label: 'DPS' },
  { id: 'support', label: 'Support' },
];

// ロールの中の分類(設計書 F2)。ヒーローの subrole(data/master.json)で決める。subrole のないヒーローは「未分類」。
export const SUBROLES = {
  tank: [
    { id: 'maintank', label: 'Main Tank', desc: 'エリアを一気に切り開くヒーロー(Reinhardt、Winston、Wrecking Ball、Mauga)' },
    { id: 'flextank', label: 'Flex Tank', desc: 'じわじわとエリアをとるヒーロー(Sigma、Zarya)' },
  ],
  damage: [
    { id: 'maindps', label: 'Main DPS', desc: 'ダメージを出して相手のリソースを削る(Cassidy、Ashe)' },
    { id: 'flexdps', label: 'Flex DPS', desc: '柔軟にゲームに対応できるヒーロー(Tracer、Genji、Mei)' },
  ],
  support: [
    { id: 'mainsupport', label: 'Main Support', desc: 'Lucio・Brigitte・Mercy など' },
    { id: 'flexsupport', label: 'Flex Support', desc: 'エイムでキャリーするヒーロー(Ana、Baptiste、Kiriko)' },
  ],
};
// 分類の解説に添える注意(ユーザー指定)
export const SUBROLE_NOTE = '厳密な区別ではなく、見やすさをよくするために分類しているだけです。';
export const SUBROLE_OTHER = { id: 'other', label: '未分類' };

// 試合のモード(Ranked・Quick)は記録しない(2026-10-19 に廃止、設計書 F3)。累計勝敗はロール別に出す。
// ロールを記録しない勝利(簡易入力の勝ち記録など)をまとめる区分と、ロールのない負け・引き分けをまとめる区分の名前。
export const WIN_TALLY_LABEL = '勝利';
export const UNKNOWN_ROLE_LABEL = 'ロール不明';

// 1日の区切り(時)。0:00〜24:00 を1日とする(暦の日付と同じ。2026-10-19 に4:00区切りから変更、設計書 F3)。
export const DAY_START_HOUR = 0;


// 削除したマップ・ヒーローを、保存済みの試合で表示するときの名前(設計書 F7)。
export const DELETED_LABELS = { map: '削除したマップ', hero: '削除したヒーロー' };

// バックアップ(設計書 F8)。書き出すストア。画像(images)は含めない。
export const BACKUP_STORES = ['matches', 'slots', 'bans', 'compTypes', 'reviews', 'days', 'meta'];
// 最後の書き出しからこの日数がたったら促す。2026-10-19 にユーザーが確定(設計書 F8)。
export const BACKUP_STALE_DAYS = 7;
// 書き出し日時を持つ meta のキー。書き出しにも取り込みにも含めない(この端末の状態なので)。
export const BACKUP_META_KEY = 'lastBackupAt';
// フォルダへの自動保存(設計書 F8)。選んだフォルダ(FileSystemDirectoryHandle)を持つ meta のキー。これもこの端末の状態。
export const AUTOSAVE_META_KEY = 'autoSaveDir';
export const AUTOSAVE_FILE = 'recalm-backup.json';
// 記録を変えてから書くまで待つ時間。続けて変えたときは、まとめて1回書く。
export const AUTOSAVE_DELAY_MS = 2000;
// フォルダを選べないブラウザ(Firefox など)の、記録のたびの自動ダウンロード。{ enabled, lastAt } を持つ meta のキー
export const AUTODOWNLOAD_META_KEY = 'autoDownload';
// 表示の設定(設計書 画面設計 設定)。{ today } を持つ meta のキー。記録と一緒にバックアップに含める。
// today: メニューバーと集計の今日の表示('count' 試合数だけ / 'record' 勝敗 / 'none' 出さない)。
// 初期値は目的(感情的にならずに楽しむ)に合わせる(2026-11-09)。以前の stats(集計の並び順)は 2026-11-21 に外した。
export const DISPLAY_META_KEY = 'display';
export const DISPLAY_DEFAULTS = { today: 'count' };
// 書き出しにも取り込みにも含めない meta のキー
export const DEVICE_META_KEYS = [BACKUP_META_KEY, AUTOSAVE_META_KEY, AUTODOWNLOAD_META_KEY];

// 勝率に「参考値」を付ける試合数のしきい値。2026-10-19 にユーザーが確定(設計書「集計指標」)。
export const REFERENCE_MIN_GAMES = 10;

// セッションの区切り。前の試合の入力時刻からこの分数以上あいたら、新しいセッションとして数える(設計書「集計指標」)。
// 60分は仮置き(2026-10-24。長いキュー約15分+長い試合約35分に10分を足した、ユーザーの示した決め方)。
export const SESSION_GAP_MINUTES = 60;
// セッション開始からの経過時間の区分の幅(分)。30分は仮置き(2026-10-24。1区分に1〜2試合が入る幅)。
// 試合数が REFERENCE_MIN_GAMES 未満の区分が出たら、その区分から後ろを「N分〜」にまとめる(設計書「集計指標」)。
export const SESSION_ELAPSED_STEP_MINUTES = 30;

// 実力差=マッチの質の3段階(ユーザー指定、設計書 F3)。左(味方が上)から右(相手が上)へ並べ、色は暖色→寒色(css の --gap-<id>)。保存する値は id。
// 初期値は置かない。記録のたびに必ず選ぶ。yomi は問いかけ入力で読みでも選べるようにするための読み。
// 2026-11-13 に4段階(味方が格上・互角・相手がやや格上・相手が格上)から変更。id は保存済みの値との対応のため変えない
export const SKILL_GAPS = [
  { id: 'ez', label: '圧勝', yomi: ['あっしょう'] },
  { id: 'even', label: '勝機あり', yomi: ['しょうきあり'] },
  { id: 'mismatch', label: '格上', yomi: ['かくうえ'] },
];
// 以前の段階の値を、いまの段階として表示する(保存した値は書き換えない)。gg=相手がやや格上 → 勝機あり
export const SKILL_GAP_ALIASES = { gg: 'even' };

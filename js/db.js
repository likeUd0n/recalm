// IndexedDB の薄いラッパー。ストア構成は docs/design.md「データモデル」に対応する。
const DB_NAME = 'recalm';
const DB_VERSION = 1;
const MATCH_CHILD_STORES = ['slots', 'bans', 'compTypes'];

let dbPromise;

export function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // 版を上げてストアを足したときに、すでにあるストアを作り直そうとして開けなくならないよう、ないものだけ作る
      const create = (name, opts) => (db.objectStoreNames.contains(name) ? null : db.createObjectStore(name, opts));
      create('matches', { keyPath: 'id' })?.createIndex('date', 'date');
      for (const name of MATCH_CHILD_STORES) {
        create(name, { keyPath: 'id', autoIncrement: true })?.createIndex('matchId', 'matchId');
      }
      create('reviews', { keyPath: 'matchId' });
      create('days', { keyPath: 'date' });
      create('images', { keyPath: 'key' });
      create('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function getAll(store) {
  const db = await openDb();
  return request(db.transaction(store).objectStore(store).getAll());
}

export async function get(store, key) {
  const db = await openDb();
  return request(db.transaction(store).objectStore(store).get(key));
}

export async function put(store, value) {
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(value);
  await done(tx);
}

export async function putAll(store, values) {
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  for (const v of values) tx.objectStore(store).put(v);
  await done(tx);
}

export async function remove(store, key) {
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  await done(tx);
}

// バックアップ用(設計書 F8)。names のストアの全行を { ストア名: 行の配列 } で返す。
export async function exportAll(names) {
  const entries = await Promise.all(names.map(async (name) => [name, await getAll(name)]));
  return Object.fromEntries(entries);
}

// バックアップの取り込み。stores の各ストアを、行をすべて消してから入れ直す。1つのトランザクションなので、途中で失敗すれば元に戻る。
// meta のうち keepMetaKeys の行は、この端末の状態なので消さずに残す。
export async function replaceAll(stores, keepMetaKeys) {
  const names = Object.keys(stores);
  const db = await openDb();
  const tx = db.transaction(names, 'readwrite');
  const finished = done(tx);
  try {
    for (const name of names) {
      const store = tx.objectStore(name);
      if (name === 'meta') {
        // 入れ直した行を消さないよう、カーソルで消し終えてから入れる。
        store.openCursor().onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor) {
            if (!keepMetaKeys.includes(cursor.key)) cursor.delete();
            cursor.continue();
          } else {
            for (const row of stores.meta) store.put(row);
          }
        };
      } else {
        store.clear();
        for (const row of stores[name]) store.put(row);
      }
    }
  } catch (e) {
    // put が同期的に例外を投げても、トランザクションは自動では取り消されない。消した分まで元に戻す。
    finished.catch(() => {});
    tx.abort();
    throw e;
  }
  await finished;
}

// 試合と、その試合に属する行(と、あれば振り返り)を1つのトランザクションで保存する。
export async function saveMatch({ match, slots, bans, compTypes, review = null }) {
  const db = await openDb();
  const tx = db.transaction(['matches', 'reviews', ...MATCH_CHILD_STORES], 'readwrite');
  tx.objectStore('matches').add(match);
  if (review) tx.objectStore('reviews').put(review);
  for (const row of slots) tx.objectStore('slots').add(row);
  for (const row of bans) tx.objectStore('bans').add(row);
  for (const row of compTypes) tx.objectStore('compTypes').add(row);
  await done(tx);
}

// 保存済みの試合を直す(後からの追記)。試合に属する行は、いったん消して入れ直す。
export async function updateMatch({ match, slots, bans, compTypes }) {
  const db = await openDb();
  const tx = db.transaction(['matches', ...MATCH_CHILD_STORES], 'readwrite');
  tx.objectStore('matches').put(match);
  const rows = { slots, bans, compTypes };
  for (const name of MATCH_CHILD_STORES) {
    const store = tx.objectStore(name);
    // 先にキーを集めてから消すので、入れ直した行を消してしまうことはない。
    store.index('matchId').getAllKeys(IDBKeyRange.only(match.id)).onsuccess = (e) => {
      for (const key of e.target.result) store.delete(key);
      for (const row of rows[name]) store.add(row);
    };
  }
  await done(tx);
}

export async function deleteMatch(matchId) {
  const db = await openDb();
  const tx = db.transaction(['matches', 'reviews', ...MATCH_CHILD_STORES], 'readwrite');
  tx.objectStore('matches').delete(matchId);
  tx.objectStore('reviews').delete(matchId);
  for (const name of MATCH_CHILD_STORES) {
    const store = tx.objectStore(name);
    store.index('matchId').openKeyCursor(IDBKeyRange.only(matchId)).onsuccess = (e) => {
      const cursor = e.target.result;
      if (!cursor) return;
      store.delete(cursor.primaryKey);
      cursor.continue();
    };
  }
  await done(tx);
}

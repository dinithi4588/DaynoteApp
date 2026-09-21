/* ============================================================
   DayNote — Data layer
   ------------------------------------------------------------
   Everything reads/writes through the DB object below.

   Storage backend: IndexedDB, not localStorage. localStorage caps
   out around 5-10MB total per origin, which is tight once journal
   photos/drawings are involved; IndexedDB's limit is a large share
   of free disk space instead, so that ceiling is effectively gone.

   To keep every existing call site in the app unchanged (calendar,
   tasks, finance, journal, the today-summary widget, onboarding,
   accounts, app lock — all of it calls things like DB.events.list()
   or DB.getProfile() and expect a plain value back, not a Promise),
   this layer keeps a full in-memory cache of every record. Reads are
   served instantly from that cache — still fully synchronous. Writes
   update the cache immediately AND persist to IndexedDB in the
   background.

   Anything that runs before the cache is populated (i.e. before the
   page has painted anything) should `await DB.ready` first — every
   page's bootstrap script does this once, up front, so nothing else
   needs to worry about it.

   One-time migration: if IndexedDB is empty but the old localStorage
   keys (daynote.events, daynote.accounts, daynote.finance.transactions,
   etc.) still have data from before this update, that data is imported
   into IndexedDB automatically on first load, then the old keys are
   cleared so the freed space goes back to the browser's small
   localStorage quota.
   ============================================================ */

const DB = (() => {
  const IDB_NAME = 'daynote-db';
  const IDB_VERSION = 1;
  const STORES = ['events', 'tasks', 'transactions', 'notes', 'kv', 'financeTxns'];

  async function sha256Hex(str) {
    const enc = new TextEncoder().encode(str);
    const buf = await crypto.subtle.digest('SHA-256', enc);
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  // ---------------- IndexedDB plumbing ----------------
  let idbPromise = null;
  function openIDB() {
    if (idbPromise) return idbPromise;
    idbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        STORES.forEach((name) => {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
        });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return idbPromise;
  }

  function idbGetAll(storeName) {
    return openIDB().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    }));
  }

  function idbPut(storeName, record) {
    return openIDB().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    })).catch((e) => console.error('DayNote: IndexedDB write failed', storeName, e));
  }

  function idbDelete(storeName, id) {
    return openIDB().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    })).catch((e) => console.error('DayNote: IndexedDB delete failed', storeName, e));
  }

  function idbClear(storeName) {
    return openIDB().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    }));
  }

  // ---------------- one-time migration from localStorage ----------------
  const OLD_KEYS = {
    events: 'daynote.events',
    tasks: 'daynote.tasks',
    transactions: 'daynote.transactions',
    notes: 'daynote.notes',
    theme: 'daynote.theme',
    profile: 'daynote.profile',
    lockPin: 'daynote.lockpin',
    accounts: 'daynote.accounts',
    activeAccountId: 'daynote.activeAccountId',
    onboarded: 'daynote.onboarded',
    financeTxns: 'daynote.finance.transactions',
    financeBudget: 'daynote.finance.budget',
    financeBudgetHistory: 'daynote.finance.budgetHistory',
    financeCategorizeEnabled: 'daynote.finance.categorizeEnabled',
  };

  function readOldJSON(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function migrateIfNeeded() {
    return Promise.all(STORES.map((s) => idbGetAll(s))).then((results) => {
      const allEmpty = results.every((list) => list.length === 0);
      const hasOldData = Object.values(OLD_KEYS).some((k) => localStorage.getItem(k) !== null);
      if (!allEmpty || !hasOldData) return;

      const jobs = [];
      const putAllIfArray = (storeName, raw) => {
        if (Array.isArray(raw)) raw.forEach((r) => { if (r && r.id) jobs.push(idbPut(storeName, r)); });
      };
      putAllIfArray('events', readOldJSON(OLD_KEYS.events));
      putAllIfArray('tasks', readOldJSON(OLD_KEYS.tasks));
      putAllIfArray('transactions', readOldJSON(OLD_KEYS.transactions));
      putAllIfArray('notes', readOldJSON(OLD_KEYS.notes));
      putAllIfArray('financeTxns', readOldJSON(OLD_KEYS.financeTxns));

      const putKV = (id, value) => { if (value !== null && value !== undefined) jobs.push(idbPut('kv', { id, value })); };
      putKV('theme', readOldJSON(OLD_KEYS.theme));
      putKV('profile', readOldJSON(OLD_KEYS.profile));
      putKV('lockPin', localStorage.getItem(OLD_KEYS.lockPin)); // stored as a raw hash string, not JSON
      putKV('accounts', readOldJSON(OLD_KEYS.accounts));
      putKV('activeAccountId', readOldJSON(OLD_KEYS.activeAccountId));
      putKV('onboarded', readOldJSON(OLD_KEYS.onboarded));
      putKV('financeBudget', readOldJSON(OLD_KEYS.financeBudget));
      putKV('financeBudgetHistory', readOldJSON(OLD_KEYS.financeBudgetHistory));
      const oldCategorize = localStorage.getItem(OLD_KEYS.financeCategorizeEnabled);
      if (oldCategorize !== null) jobs.push(idbPut('kv', { id: 'financeCategorizeEnabled', value: oldCategorize === 'true' }));

      return Promise.all(jobs).then(() => {
        // Free up the old localStorage quota now that data lives in IndexedDB.
        Object.values(OLD_KEYS).forEach((k) => localStorage.removeItem(k));
      });
    });
  }

  // ---------------- in-memory cache ----------------
  const cache = {
    events: [], tasks: [], transactions: [], notes: [], financeTxns: [],
    kv: {}, // theme, profile, lockPin, biometricCredId, accounts, activeAccountId,
            // onboarded, financeBudget, financeBudgetHistory, financeCategorizeEnabled
  };

  function loadCacheFromIDB() {
    return Promise.all([
      idbGetAll('events'), idbGetAll('tasks'), idbGetAll('transactions'),
      idbGetAll('notes'), idbGetAll('financeTxns'), idbGetAll('kv'),
    ]).then(([events, tasks, transactions, notes, financeTxns, kvRows]) => {
      cache.events = events;
      cache.tasks = tasks;
      cache.transactions = transactions;
      cache.notes = notes;
      cache.financeTxns = financeTxns;
      cache.kv = {};
      kvRows.forEach((row) => { cache.kv[row.id] = row.value; });
    });
  }

  const ready = migrateIfNeeded().then(loadCacheFromIDB).catch((e) => {
    console.error('DayNote: storage init failed', e);
  });

  // ---------------- generic CRUD over a cached collection ----------------
  function collection(storeName) {
    return {
      list() { return cache[storeName]; },
      get(id) { return cache[storeName].find((x) => x.id === id) || null; },
      create(item) {
        const record = { id: uid(), createdAt: Date.now(), ...item };
        cache[storeName].push(record);
        idbPut(storeName, record);
        return record;
      },
      update(id, patch) {
        const items = cache[storeName];
        const idx = items.findIndex((x) => x.id === id);
        if (idx === -1) return null;
        items[idx] = { ...items[idx], ...patch, updatedAt: Date.now() };
        idbPut(storeName, items[idx]);
        return items[idx];
      },
      remove(id) {
        cache[storeName] = cache[storeName].filter((x) => x.id !== id);
        idbDelete(storeName, id);
      },
      clear() {
        cache[storeName] = [];
        return idbClear(storeName); // promise, so a caller can wait until the wipe has really finished
      },
    };
  }

  function kvGet(key, fallback) {
    return key in cache.kv ? cache.kv[key] : fallback;
  }
  function kvSet(key, value) {
    cache.kv[key] = value;
    idbPut('kv', { id: key, value });
  }
  function kvDelete(key) {
    delete cache.kv[key];
    idbDelete('kv', key);
  }

  // Firebase restores a saved sign-in asynchronously after page load, so
  // auth().currentUser is often still null for the first moment. Reading it
  // straight away made "Delete account" think nobody was signed in and skip
  // deleting the Firebase user -- leaving the email fully able to sign in.
  // This waits for Firebase's first answer (max ~4s) before deciding.
  function firebaseUserReady(timeoutMs) {
    if (typeof firebase === 'undefined' || !firebase.auth) return Promise.resolve(null);
    const auth = firebase.auth();
    if (auth.currentUser) return Promise.resolve(auth.currentUser);
    return new Promise((resolve) => {
      let done = false, unsub = null, timer = null;
      const finish = (u) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (unsub) unsub();
        resolve(u || auth.currentUser || null);
      };
      timer = setTimeout(() => finish(null), timeoutMs || 4000);
      unsub = auth.onAuthStateChanged((u) => finish(u), () => finish(null));
      if (done && unsub) unsub();
    });
  }

  function friendlyAuthError(e) {
    const code = (e && e.code) || '';
    if (['auth/wrong-password', 'auth/invalid-credential', 'auth/invalid-login-credentials'].includes(code)) return 'Incorrect password.';
    if (code === 'auth/too-many-requests') return 'Too many attempts. Wait a few minutes and try again.';
    if (code === 'auth/network-request-failed') return 'No internet connection. Your account was NOT deleted.';
    return (e && e.message) || 'Something went wrong. Your account was NOT deleted.';
  }

  function getStorageEstimate() {
    if (!(navigator.storage && navigator.storage.estimate)) return Promise.resolve(null);
    return navigator.storage.estimate().then((est) => {
      if (!est.quota) return null;
      return {
        usageMB: est.usage / (1024 * 1024),
        quotaMB: est.quota / (1024 * 1024),
        percent: (est.usage / est.quota) * 100,
      };
    }).catch(() => null);
  }

  // ---------------- Backup validation ----------------
  // A parsed JSON file must really look like a DayNote backup before
  // anything on the device is cleared or overwritten. Returns
  // { shape: 'current' | 'old', counts: { items, journal, finance } }, or
  // throws a readable Error for anything that isn't a DayNote backup.
  const BACKUP_STORES = ['events', 'tasks', 'transactions', 'notes', 'financeTxns'];
  const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  function analyzeBackup(payload) {
    const notABackup = () => new Error('That file doesn\u2019t look like a DayNote backup.');
    if (!isPlainObject(payload) || !isPlainObject(payload.data)) throw notABackup();
    const d = payload.data;
    const len = (v) => (Array.isArray(v) ? v.length : 0);
    if (BACKUP_STORES.some((s) => Array.isArray(d[s])) || isPlainObject(d.kv)) {
      return {
        shape: 'current',
        counts: {
          items: len(d.events) + len(d.tasks),
          journal: len(d.notes),
          finance: len(d.financeTxns) + len(d.transactions),
        },
      };
    }
    if (Object.values(OLD_KEYS).some((k) => k in d)) {
      // Old localStorage-era backup: a flat map of "daynote.xxx" -> JSON string.
      const arr = (k) => { try { return len(JSON.parse(d[k])); } catch (e) { return 0; } };
      return {
        shape: 'old',
        counts: {
          items: arr(OLD_KEYS.events) + arr(OLD_KEYS.tasks),
          journal: arr(OLD_KEYS.notes),
          finance: arr(OLD_KEYS.financeTxns) + arr(OLD_KEYS.transactions),
        },
      };
    }
    throw notABackup();
  }

  return {
    ready, // await this before the first read, e.g. `await DB.ready` in each page's bootstrap script

    events: collection('events'),
    tasks: collection('tasks'),
    transactions: collection('transactions'),
    notes: collection('notes'),

    getTheme() { return kvGet('theme', 'parchment'); },
    setTheme(id) { kvSet('theme', id); },

    getProfile() { return kvGet('profile', { name: 'You', email: 'you@example.com' }); },
    setProfile(patch) { kvSet('profile', { ...kvGet('profile', {}), ...patch }); },

    // ---- Onboarding / local "accounts" ----
    // "Signing in" personalizes the local profile shown around the app;
    // Firebase (wired in app.js) is what makes it a real, verified sign-in
    // now. "Accounts" are still a small saved list you can switch between
    // on this device — switching swaps the displayed name/email/initial,
    // it does NOT separate your calendar/tasks/finance/journal data per
    // account, that all stays shared on this device either way.
    isOnboarded() { return !!kvGet('onboarded', false); },
    completeOnboarding({ name, email }) {
      kvSet('onboarded', true);
      // Signing back in with an email that's already on this device reuses
      // that saved account instead of adding a duplicate to the list.
      const existing = email ? kvGet('accounts', []).find((a) => (a.email || '').toLowerCase() === email.trim().toLowerCase()) : null;
      if (existing) return this.switchAccount(existing.id);
      return this.addAccount({ name, email });
    },
    listAccounts() { return kvGet('accounts', []); },
    getActiveAccountId() { return kvGet('activeAccountId', null); },
    addAccount({ name, email }) {
      const accounts = kvGet('accounts', []);
      const account = { id: uid(), name: (name || 'You').trim(), email: (email || '').trim() };
      accounts.push(account);
      kvSet('accounts', accounts);
      kvSet('activeAccountId', account.id);
      kvSet('profile', { name: account.name, email: account.email });
      return account;
    },
    switchAccount(id) {
      const accounts = kvGet('accounts', []);
      const account = accounts.find((a) => a.id === id);
      if (!account) return null;
      kvSet('activeAccountId', account.id);
      kvSet('profile', { name: account.name, email: account.email });
      return account;
    },
    removeAccount(id) {
      const accounts = kvGet('accounts', []).filter((a) => a.id !== id);
      kvSet('accounts', accounts);
      if (kvGet('activeAccountId', null) === id) {
        const next = accounts[0];
        if (next) { kvSet('activeAccountId', next.id); kvSet('profile', { name: next.name, email: next.email }); }
        else kvSet('activeAccountId', null);
      }
    },

    // Signs out for real: ends the Firebase session (and, in the Android
    // app, the native Google session, so Google's account chooser shows
    // again next time), locks the app, and clears the "onboarded" flag so
    // the next page load shows the sign-in screen. The person's calendar,
    // tasks, finance and journal data are NOT deleted -- they stay on this
    // device (Delete account is the action that wipes them).
    async signOut() {
      if (typeof firebase !== 'undefined' && firebase.auth) {
        try { await firebase.auth().signOut(); } catch (e) { /* already signed out */ }
      }
      const nativeAuth = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.FirebaseAuthentication;
      if (nativeAuth && nativeAuth.signOut) {
        try { await nativeAuth.signOut(); } catch (e) { /* not signed in natively */ }
      }
      sessionStorage.removeItem('daynote.unlocked');
      kvSet('onboarded', false);
      return true;
    },
    // Permanently deletes the account: FIRST the real Firebase user (so the
    // email/password can never sign in again), and only when that has
    // actually succeeded, the data on this device.
    //
    // Before, a Firebase failure (most often auth/requires-recent-login) was
    // swallowed, and the local data was wiped anyway -- so it LOOKED deleted
    // while the account still existed and could sign back in.
    //
    // Returns one of:
    //   { ok: true }
    //   { ok: false, needsReauth: true, email, providers }  -> ask the person to
    //        confirm (password or Google) then call again with { password }
    //        or { freshUser } (the Firebase user Google sign-in just returned)
    //   { ok: false, error }  -> nothing was deleted
    async deleteAccount(opts) {
      const { password, freshUser } = opts || {};
      const norm = (s) => (s || '').trim().toLowerCase();
      const savedEmail = norm((kvGet('profile', {}) || {}).email);
      const hasFirebase = typeof firebase !== 'undefined' && firebase.auth;

      if (hasFirebase) {
        const auth = firebase.auth();
        let user = await firebaseUserReady();
        const expectedEmail = norm(user && user.email) || savedEmail;

        // The saved session is gone but this device still knows an email:
        // that account still exists in Firebase, so it has to be signed
        // into again to be deleted.
        if (!user && expectedEmail) {
          if (freshUser) user = freshUser;
          else if (password) {
            try { user = (await auth.signInWithEmailAndPassword(expectedEmail, password)).user; }
            catch (e) { return { ok: false, error: friendlyAuthError(e) }; }
          } else {
            return { ok: false, needsReauth: true, email: expectedEmail, providers: [] };
          }
        }

        if (user) {
          // Guard against deleting the WRONG account (e.g. a different
          // Google account picked in the chooser).
          if (freshUser && expectedEmail && norm(freshUser.email) !== expectedEmail) {
            try { await auth.signOut(); } catch (e) { /* ignore */ }
            return { ok: false, error: 'That is a different account (' + freshUser.email + '). Use ' + expectedEmail + '.' };
          }
          if (password && user.email && !freshUser) {
            try {
              await user.reauthenticateWithCredential(firebase.auth.EmailAuthProvider.credential(user.email, password));
            } catch (e) { return { ok: false, error: friendlyAuthError(e) }; }
          }
          try {
            await user.delete();
          } catch (e) {
            const code = (e && e.code) || '';
            if (code === 'auth/requires-recent-login' || code === 'auth/user-token-expired') {
              return {
                ok: false, needsReauth: true, email: user.email || expectedEmail,
                providers: (user.providerData || []).map((p) => p.providerId),
              };
            }
            // already gone on the server -> that's the outcome we want
            if (code !== 'auth/user-not-found') return { ok: false, error: friendlyAuthError(e) };
          }
        }

        // The native Google session on Android outlives the Firebase user;
        // clear it so the next "Continue with Google" shows the chooser.
        const nativeAuth = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.FirebaseAuthentication;
        if (nativeAuth && nativeAuth.signOut) {
          try { await nativeAuth.signOut(); } catch (e) { /* not signed in natively */ }
        }
        try { await auth.signOut(); } catch (e) { /* already signed out */ }
      }

      // Only reached once the Firebase account is really gone (or this
      // device never had one). Now wipe the on-device data, and wait for it.
      await Promise.all(
        ['events', 'tasks', 'transactions', 'notes', 'financeTxns']
          .map((s) => Promise.resolve().then(() => collection(s).clear()).catch(() => {}))
      );
      await idbClear('kv');
      cache.kv = {};
      // Leave nothing behind, so the next launch is exactly like a new user.
      try {
        Object.keys(localStorage).filter((k) => k.indexOf('daynote') === 0).forEach((k) => localStorage.removeItem(k));
        Object.keys(sessionStorage).filter((k) => k.indexOf('daynote') === 0).forEach((k) => sessionStorage.removeItem(k));
      } catch (e) { /* storage unavailable */ }
      return { ok: true };
    },

    // ---- Backup / restore ----
    // Exports/imports everything in the cache — the collections plus the
    // kv store (theme, profile, accounts, lock/biometric, finance budget).
    // importAll also accepts a backup file made by the old localStorage
    // version of the app (a flat "daynote.xxx" key -> JSON string map), so
    // older exports still restore correctly after this update.
    exportAll() {
      return {
        app: 'DayNote',
        version: 2,
        exportedAt: new Date().toISOString(),
        data: {
          events: cache.events, tasks: cache.tasks, transactions: cache.transactions,
          notes: cache.notes, financeTxns: cache.financeTxns, kv: cache.kv,
        },
      };
    },
    // One-line summary of what a backup file contains, for the "Import this
    // backup?" box. Throws the same readable error as importAll for files
    // that aren't DayNote backups.
    describeBackup(payload) {
      const { counts } = analyzeBackup(payload);
      const parts = [];
      if (counts.items) parts.push(`${counts.items} calendar/task item${counts.items === 1 ? '' : 's'}`);
      if (counts.journal) parts.push(`${counts.journal} journal page${counts.journal === 1 ? '' : 's'}`);
      if (counts.finance) parts.push(`${counts.finance} finance entr${counts.finance === 1 ? 'y' : 'ies'}`);
      const what = parts.length ? parts.join(', ') : 'no calendar, journal or finance entries';
      const when = payload.exportedAt && !isNaN(Date.parse(payload.exportedAt))
        ? ` from ${new Date(payload.exportedAt).toLocaleDateString()}` : '';
      return `a backup${when} with ${what}`;
    },
    async importAll(payload) {
      // Validate FIRST: nothing on the device is cleared or overwritten
      // unless this passes (it throws for anything that isn't a backup).
      const { shape } = analyzeBackup(payload);
      const d = payload.data;
      const writes = [];        // every write, so we can wait for all of them
      const expected = {};      // store -> how many records should end up saved

      // Replaces one store with the backup's records. Stores the backup
      // doesn't contain are left exactly as they are.
      const restoreStore = async (storeName, records) => {
        await collection(storeName).clear();
        const valid = records.filter((r) => r && r.id);
        valid.forEach((r) => writes.push(idbPut(storeName, r)));
        expected[storeName] = new Set(valid.map((r) => r.id)).size;
      };

      if (shape === 'old') {
        // Old backup: flat map of localStorage-style keys to JSON strings.
        const get = (k) => { try { return JSON.parse(d[k]); } catch (e) { return null; } };
        for (const s of BACKUP_STORES) {
          const key = OLD_KEYS[s];
          if (key in d && Array.isArray(get(key))) await restoreStore(s, get(key));
        }
        const putKV = (id, value) => { if (value !== null && value !== undefined) writes.push(idbPut('kv', { id, value })); };
        putKV('theme', get(OLD_KEYS.theme));
        putKV('profile', get(OLD_KEYS.profile));
        if (d[OLD_KEYS.lockPin]) putKV('lockPin', d[OLD_KEYS.lockPin]);
        putKV('accounts', get(OLD_KEYS.accounts));
        putKV('activeAccountId', get(OLD_KEYS.activeAccountId));
        putKV('onboarded', get(OLD_KEYS.onboarded));
        putKV('financeBudget', get(OLD_KEYS.financeBudget));
        putKV('financeBudgetHistory', get(OLD_KEYS.financeBudgetHistory));
      } else {
        // Current shape: { events:[], tasks:[], transactions:[], notes:[], financeTxns:[], kv:{} }
        for (const s of BACKUP_STORES) {
          if (Array.isArray(d[s])) await restoreStore(s, d[s]);
        }
        // Saved settings (theme, profile, PIN, sign-in state...) are only
        // replaced when the backup actually carries them.
        if (isPlainObject(d.kv)) {
          await idbClear('kv');
          Object.entries(d.kv).forEach(([id, value]) => writes.push(idbPut('kv', { id, value })));
        }
      }

      await Promise.all(writes);
      await loadCacheFromIDB();

      // Confirm the data really landed (idbPut only logs its own failures).
      for (const [storeName, count] of Object.entries(expected)) {
        if (cache[storeName].length !== count) {
          throw new Error('Some of the backup couldn\u2019t be saved on this device. Free up some storage and try again.');
        }
      }
      return true;
    },

    // ---- App lock (device-only PIN, not a real auth system) ----
    // Stored as a SHA-256 hash rather than plain text so a casual glance
    // at devtools storage doesn't reveal the PIN — this is meant to keep
    // the app off someone idly picking up the phone, not to withstand a
    // determined attacker with device access.
    hasLockPin() { return !!kvGet('lockPin', null); },
    async setLockPin(pin) { kvSet('lockPin', await sha256Hex(String(pin))); },
    async checkLockPin(pin) {
      const stored = kvGet('lockPin', null);
      if (!stored) return true;
      return (await sha256Hex(String(pin))) === stored;
    },
    clearLockPin() { kvDelete('lockPin'); },

    // ---- Biometric unlock (WebAuthn, on top of the PIN above) ----
    // This uses the phone/laptop's own fingerprint or face unlock via the
    // browser's WebAuthn API. There's no server to verify a signature
    // against (this app has none), so the security model here is simply
    // "did the OS's platform authenticator confirm it's you" — that's
    // appropriate for an on-device app lock, the same trust level as the
    // PIN above, not for anything that needs to prove identity to a server.
    hasBiometric() { return !!kvGet('biometricCredId', null); },
    async isBiometricAvailable() {
      if (!window.PublicKeyCredential || !PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable) return false;
      try { return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(); }
      catch (e) { return false; }
    },
    async registerBiometric() {
      const challenge = crypto.getRandomValues(new Uint8Array(32));
      const userId = crypto.getRandomValues(new Uint8Array(16));
      const cred = await navigator.credentials.create({
        publicKey: {
          challenge,
          rp: { name: 'DayNote' },
          user: { id: userId, name: 'daynote-local-user', displayName: 'DayNote' },
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
          authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required' },
          timeout: 60000,
        },
      });
      if (!cred) throw new Error('Biometric setup was cancelled.');
      kvSet('biometricCredId', btoa(String.fromCharCode(...new Uint8Array(cred.rawId))));
      return true;
    },
    async verifyBiometric() {
      const storedId = kvGet('biometricCredId', null);
      if (!storedId) return false;
      const rawId = Uint8Array.from(atob(storedId), (c) => c.charCodeAt(0));
      const challenge = crypto.getRandomValues(new Uint8Array(32));
      try {
        const assertion = await navigator.credentials.get({
          publicKey: {
            challenge,
            allowCredentials: [{ id: rawId, type: 'public-key' }],
            userVerification: 'required',
            timeout: 60000,
          },
        });
        return !!assertion;
      } catch (e) {
        return false; // cancelled, failed match, or no matching authenticator
      }
    },
    clearBiometric() { kvDelete('biometricCredId'); },

    // Finance page's own ledger + budget (kept as a separate store, same
    // as it was a separate localStorage key before — this only swaps the
    // backend, it doesn't change what data lives where).
    finance: {
      transactions: collection('financeTxns'),
      getBudget(fallback) { return kvGet('financeBudget', fallback); },
      setBudget(value) { kvSet('financeBudget', value); },
      getBudgetHistory(fallback) { return kvGet('financeBudgetHistory', fallback); },
      setBudgetHistory(value) { kvSet('financeBudgetHistory', value); },
      getCategorizeEnabled(fallback) { return kvGet('financeCategorizeEnabled', fallback); },
      setCategorizeEnabled(value) { kvSet('financeCategorizeEnabled', value); },
    },

    getStorageEstimate,

    uid,
  };
})();

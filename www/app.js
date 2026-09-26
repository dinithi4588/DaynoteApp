/* ============================================================
   DayNote — App shell (navigation, theme picker, popovers, toasts)
   Shared by every page (index.html, calendar.html, tasks.html,
   finance.html, journal.html). Each page includes this file and
   calls UI.init('<page-id>') on load — pass null on index.html
   since it isn't one of the four sections.
   ============================================================ */

const THEMES = [
  { id: "light", name: "Light", swatch: ["#FFFFFF", "#1A1A1A", "#111111"] },
  { id: "dark", name: "Dark", swatch: ["#000000", "#FFFFFF", "#F2F2F2"] },
  { id: "maroon", name: "Maroon", swatch: ["#F7ECEA", "#7A2E2E", "#2E1918"] },
  { id: "coffee", name: "Coffee", swatch: ["#EFE4D8", "#5C3A22", "#2C1D12"] },
  { id: "sage", name: "Sage", swatch: ["#F1F2EC", "#7C7248", "#2A2E27"] },
];

// Each item is one of the four real pages. `href` is the actual
// file the browser navigates to now that every section is its
// own page instead of a JS-swapped panel.
const CAL_ICON_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15" rx="2"/><line x1="3.5" y1="9.5" x2="20.5" y2="9.5"/><line x1="8" y1="3" x2="8" y2="6.5"/><line x1="16" y1="3" x2="16" y2="6.5"/></svg>';
const BOOK_ICON_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 6.5c-1.8-1.3-4-2-6.5-2-.6 0-1 .45-1 1v11c0 .55.4 1 1 1 2.5 0 4.7.7 6.5 2 1.8-1.3 4-2 6.5-2 .6 0 1-.45 1-1v-11c0-.55-.4-1-1-1-2.5 0-4.7.7-6.5 2z"/><line x1="12" y1="6.5" x2="12" y2="19.5"/></svg>';

const NAV_ITEMS = [
  { id: "calendar", label: "Calendar", icon: CAL_ICON_SVG, color: "--calendar", soft: "--calendar-soft", href: "calendar.html", desc: "Month view, events & dated notes" },
  { id: "tasks", label: "Tasks", icon: "\u2713", color: "--tasks", soft: "--tasks-soft", href: "tasks.html", desc: "Today, upcoming, all & done" },
  { id: "finance", label: "Finance", icon: "\u20A8", color: "--finance", soft: "--finance-soft", href: "finance.html", desc: "Income, expenses & monthly totals" },
  { id: "journal", label: "Journal", icon: BOOK_ICON_SVG, color: "--notes", soft: "--notes-soft", href: "journal.html", desc: "Freeform notepad" },
];

const Pages = {}; // each page module registers itself here: Pages.calendar = { render(container) {...} }

const UI = (() => {
  let currentPage = null;

  function $(sel, root = document) { return root.querySelector(sel); }

  function init(pageId) {
    currentPage = pageId || null;
    guardOnboarding(() => {
      guardAppLock();
      wireTopbar(); // refresh in case onboarding just set the profile
      injectAccountsMenu(); // ...and refresh the popover's account/email list too
      buildTodaySummary();
    });
    document.documentElement.setAttribute('data-theme', DB.getTheme());
    buildDrawer();
    buildBottomNav();
    buildTodaySummary();
    buildProfilePopover();
    buildSharePopover();
    buildThemeModal();
    wireTopbar();
    wireModalDismissal();
    highlightNav(currentPage);
    if (typeof Reminders !== 'undefined') Reminders.start();
    if (typeof DB.workspaces?.startSharedSync === 'function') DB.workspaces.startSharedSync();
    registerServiceWorker();
    wireInstallPrompt();
    checkForAppUpdate();
  }

  // ---------------- PWA: service worker + install prompt ----------------
  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    // file:// (opening the HTML directly instead of through a server)
    // can't register a service worker — silently skip rather than
    // throwing a console error for that case.
    if (location.protocol === 'file:') return;
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  function isStandalone() {
    // True for an installed PWA (browsers set this media feature), and
    // also true inside the installed native Capacitor app -- which never
    // sets display-mode: standalone, so without this check the install
    // banner would keep popping up on every page even after the user
    // already has the real app installed.
    const isNativeApp = typeof window.Capacitor !== 'undefined' && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform();
    return isNativeApp || window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  }

  // Android gets a banner whose button downloads the DayNote APK directly
  // (no PWA install-prompt flow). iOS Safari has no APK equivalent, so it
  // still gets the short "how to" banner pointing at the Share sheet.
  // Nothing shows once the app is already running installed (standalone).
  // This is a multi-page site — each page load re-runs init() — and
  // dismissing the banner doesn't persist across pages, so it reappears
  // every time the user navigates to a new page.

  // Path to the built APK — served from the GitHub Release asset.
  const APK_URL = 'https://github.com/dinithi4588/DaynoteApp/releases/download/latest/app-debug.apk';

  // Chrome (and other Chromium browsers) treat this site as an installable
  // PWA on its own — because of manifest.json + a registered service
  // worker — and will offer ITS OWN "Install app" / "Add to Home screen"
  // prompt (an address-bar icon and/or an automatic mini-infobar),
  // completely separate from the custom banner below. If someone taps
  // THAT browser-native prompt instead of DayNote's own "Install" button,
  // they get a plain home-screen shortcut to the website — not the real
  // Capacitor app — which looks like installing worked but can never get
  // background notifications. Capturing and cancelling the event here
  // stops Chrome from offering that competing path, so the only "Install"
  // affordance left on Android is DayNote's own button, which downloads
  // the actual APK.
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
  });

  function wireInstallPrompt() {
    if (isStandalone()) return;

    const ua = navigator.userAgent;
    const isIOS = /iphone|ipad|ipod/i.test(ua) && !window.MSStream;
    const isAndroid = /android/i.test(ua);

    if (isAndroid) showInstallBanner('android');
    else if (isIOS) showInstallBanner('ios');
  }

  function downloadApk() {
    const a = document.createElement('a');
    a.href = APK_URL;
    a.download = 'DayNote.apk';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function showInstallBanner(kind) {
    if ($('#install-banner')) return;
    const banner = document.createElement('div');
    banner.id = 'install-banner';
    banner.className = 'install-banner';
    banner.innerHTML = kind === 'ios'
      ? `<span class="install-banner-icon">&#128241;</span>
         <span class="install-banner-text">Install DayNote: tap <b>Share</b> <span style="font-size:1.1em;">&#8593;</span> then <b>Add to Home Screen</b>.</span>
         <button type="button" class="install-banner-close" aria-label="Dismiss">&#10005;</button>`
      : `<span class="install-banner-icon">&#128241;</span>
         <span class="install-banner-text">Install DayNote on this phone for quick access, even offline.</span>
         <button type="button" class="install-banner-install">Install</button>
         <button type="button" class="install-banner-close" aria-label="Dismiss">&#10005;</button>`;
    document.body.appendChild(banner);

    const dismiss = () => { banner.remove(); };
    banner.querySelector('.install-banner-close').onclick = dismiss;
    const installBtn = banner.querySelector('.install-banner-install');
    if (installBtn) {
      installBtn.onclick = () => {
        downloadApk();
        banner.remove();
        showToast('Downloading DayNote', 'Open the downloaded APK to install. You may need to allow installs from this source.');
      };
    }
  }

  // ---------------- In-app update check (installed Android app only) ----------------
  // The GitHub Actions build writes www/build-info.json ({"build": N}) into
  // the APK and names the "latest" GitHub Release "Build N". Each time the
  // installed app opens, it asks GitHub which build is newest; if that is
  // newer than this one, a banner offers the download. Opening the new APK
  // over the old app is an UPDATE (same signing key, higher versionCode), so
  // nothing is uninstalled and the data on the phone is kept. Sideloaded apps
  // cannot update silently, so the person still taps the downloaded file once.
  async function checkForAppUpdate() {
    const isNativeApp = typeof window.Capacitor !== 'undefined' && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform();
    if (!isNativeApp) return; // the website updates itself on every deploy
    try {
      const infoRes = await fetch('build-info.json', { cache: 'no-store' });
      if (!infoRes.ok) return;
      const mine = Number((await infoRes.json()).build);
      if (!mine) return;

      const m = APK_URL.match(/github\.com\/([^/]+)\/([^/]+)\/releases\//);
      if (!m) return;
      const relRes = await fetch('https://api.github.com/repos/' + m[1] + '/' + m[2] + '/releases/tags/latest', {
        headers: { Accept: 'application/vnd.github+json' },
      });
      if (!relRes.ok) return;
      const rel = await relRes.json();
      const latest = Number(((rel.name || '').match(/(\d+)/) || [])[1]);
      if (!latest || latest <= mine) return;

      // If the person dismissed this exact update, don't nag again for it.
      let dismissed = 0;
      try { dismissed = Number(localStorage.getItem('daynote_update_dismissed') || 0); } catch (e) {}
      if (dismissed >= latest) return;

      showUpdateBanner(latest);
    } catch (e) { /* offline or rate-limited: just try again next launch */ }
  }

  function showUpdateBanner(latest) {
    if ($('#update-banner')) return;
    const banner = document.createElement('div');
    banner.id = 'update-banner';
    banner.className = 'install-banner';
    banner.innerHTML = `<span class="install-banner-icon">&#8635;</span>
      <span class="install-banner-text">A new version of DayNote is available. Download it, open the file, and tap <b>Update</b>. Your data is kept.</span>
      <button type="button" class="install-banner-install">Update</button>
      <button type="button" class="install-banner-close" aria-label="Dismiss">&#10005;</button>`;
    document.body.appendChild(banner);

    banner.querySelector('.install-banner-close').onclick = () => {
      try { localStorage.setItem('daynote_update_dismissed', String(latest)); } catch (e) {}
      banner.remove();
    };
    banner.querySelector('.install-banner-install').onclick = () => {
      // Capacitor hands external links to the system browser, which
      // downloads the APK; the person then opens it to install the update.
      window.open(APK_URL, '_blank');
      banner.remove();
      showToast('Downloading update', 'When it finishes, open the APK and tap Update. Your data is kept.');
    };
  }

  // ---------------- Modal dismissal (click outside / Escape) ----------------
  function wireModalDismissal() {
    document.querySelectorAll('.modal-scrim').forEach(scrim => {
      scrim.addEventListener('click', (e) => {
        if (e.target === scrim) scrim.classList.remove('open');
      });
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      document.querySelectorAll('.modal-scrim.open').forEach(s => s.classList.remove('open'));
      closeDrawer();
      closeAllPopovers();
    });
  }

  // ---------------- Drawer (hamburger menu) ----------------
  function buildDrawer() {
    const nav = $('#drawer-nav');
    if (!nav) return;
    nav.innerHTML = '';
    NAV_ITEMS.forEach(item => {
      const a = document.createElement('a');
      a.className = 'drawer-item';
      a.dataset.page = item.id;
      a.href = item.href;
      a.style.setProperty('--item-color', `var(${item.color})`);
      a.style.setProperty('--item-soft', `var(${item.soft})`);
      a.innerHTML = `<span class="dot">${item.icon}</span><span>${item.label}</span>`;
      nav.appendChild(a);
    });
    $('#hamburger-btn')?.addEventListener('click', openDrawer);
    $('#scrim')?.addEventListener('click', closeDrawer);
  }
  function openDrawer() { $('#drawer')?.classList.add('open'); $('#scrim')?.classList.add('open'); }
  function closeDrawer() { $('#drawer')?.classList.remove('open'); $('#scrim')?.classList.remove('open'); }

  function highlightNav(page) {
    document.querySelectorAll('.drawer-item').forEach(b => b.classList.toggle('active', b.dataset.page === page));
    document.querySelectorAll('.bottom-nav-item').forEach(b => b.classList.toggle('active', b.dataset.page === page));
    const item = NAV_ITEMS.find(n => n.id === page);
    if (item) document.documentElement.style.setProperty('--active', `var(${item.color})`);
  }

  // ---------------- Bottom tab bar (small screens) ----------------
  function buildBottomNav() {
    const nav = $('#bottom-nav');
    if (!nav) return;
    nav.innerHTML = '';
    NAV_ITEMS.forEach(item => {
      const a = document.createElement('a');
      a.className = 'bottom-nav-item';
      a.dataset.page = item.id;
      a.href = item.href;
      a.style.setProperty('--item-color', `var(${item.color})`);
      a.innerHTML = `<span class="bn-icon">${item.icon}</span><span class="bn-label">${item.label}</span>`;
      nav.appendChild(a);
    });
  }

  // ---------------- Today summary (home page only) ----------------
  // Pulls one glance's worth from Calendar, Tasks, and Finance so the home
  // page shows what's actually due today instead of just four link tiles.
  function todayStrLocal() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function addDaysLocal(dateStr, n) {
    const d = new Date(dateStr + 'T00:00:00');
    d.setDate(d.getDate() + n);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  // Same daily/weekly semantics as the Tasks page: a one-off task uses its
  // own done flag/date; a daily task is active every day in its window; a
  // weekly task only on the same weekday its window started on.
  function taskActiveAndUndoneToday(t, today) {
    const isRecurring = t.repeat === 'daily' || t.repeat === 'weekly';
    if (!isRecurring) return t.date === today && !t.done;
    const weeks = t.dailyWeeks || 1;
    const end = addDaysLocal(t.date, weeks * 7 - 1);
    if (today < t.date || today > end) return false;
    if (t.repeat === 'weekly') {
      const startDow = new Date(t.date + 'T00:00:00').getDay();
      const todayDow = new Date(today + 'T00:00:00').getDay();
      if (startDow !== todayDow) return false;
    }
    return !(t.doneDates || []).includes(today);
  }
  function todaySpend(today) {
    try {
      const list = DB.finance.transactions.list() || [];
      return list
        .filter(t => t.date === today && t.type !== 'income')
        .reduce((sum, t) => sum + (parseFloat(t.amount) || 0), 0);
    } catch (e) { return 0; }
  }
  function buildTodaySummary() {
    const mount = $('#today-summary');
    if (!mount) return; // only the home page has this container
    const today = todayStrLocal();
    const allEvents = DB.events.list();
    const events = allEvents.filter(e => e.type === 'event' && e.date === today)
      .sort((a, b) => (a.time || '').localeCompare(b.time || ''));
    const tasks = allEvents.filter(e => e.type === 'task' && taskActiveAndUndoneToday(e, today))
      .sort((a, b) => (a.time || '').localeCompare(b.time || ''));
    const spend = todaySpend(today);
    const profile = DB.getProfile();
    const firstName = (profile?.name || '').split(' ')[0];

    function rows(items, emptyLabel, renderRow) {
      if (!items.length) return `<div class="today-empty">${emptyLabel}</div>`;
      return items.slice(0, 3).map(renderRow).join('') +
        (items.length > 3 ? `<div class="today-more">+${items.length - 3} more</div>` : '');
    }

    mount.innerHTML = `
      <div class="today-card">
        <div class="today-card-head">
          <span class="font-display today-card-title">Today${firstName ? `, ${escapeHtml(firstName)}` : ''}</span>
          <span class="today-card-date">${new Date(today + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}</span>
        </div>
        <div class="today-sections">
          <div class="today-section">
            <a class="today-section-head" href="calendar.html">
              <span>Events</span><span class="today-section-count">${events.length}</span>
            </a>
            ${rows(events, 'Nothing on the calendar today', e => `
              <div class="today-row"><span class="today-row-dot" style="background:var(--calendar);"></span>
                <span class="today-row-title">${escapeHtml(e.title || 'Untitled')}</span>
                <span class="today-row-time">${e.time ? escapeHtml(e.time) : ''}</span>
              </div>`)}
          </div>
          <div class="today-section">
            <a class="today-section-head" href="tasks.html">
              <span>Tasks due</span><span class="today-section-count">${tasks.length}</span>
            </a>
            ${rows(tasks, 'Nothing due today', t => `
              <div class="today-row"><span class="today-row-dot" style="background:var(--tasks);"></span>
                <span class="today-row-title">${escapeHtml(t.title || 'Untitled')}</span>
              </div>`)}
          </div>
          <div class="today-section">
            <a class="today-section-head" href="finance.html">
              <span>Spent today</span><span class="today-section-count">Rs ${spend.toLocaleString()}</span>
            </a>
          </div>
        </div>
      </div>
    `;
  }

  // ---------------- Profile popover ----------------
  function buildProfilePopover() {
    const profileBtn = $('#profile-btn');
    if (!profileBtn) return;
    profileBtn.onclick = (e) => {
      e.stopPropagation();
      togglePopover('#profile-popover');
    };
    $('#signout-item').onclick = () => {
      closeAllPopovers();
      showConfirm({
        title: 'Sign out of DayNote?', body: 'You can sign back in any time.', confirmLabel: 'Sign out',
        onConfirm: async () => {
          await DB.signOut();
          showToast('Signed out', 'Your data stays on this device. Sign in again to continue.');
          setTimeout(() => location.reload(), 600); // reload shows the sign-in screen
        },
      });
    };
    $('#delete-account-item').onclick = () => {
      closeAllPopovers();
      showConfirm({
        title: 'Delete your account?', body: 'This removes all local DayNote data on this device \u2014 calendar, tasks, finance, journal, everything. This can\u2019t be undone.',
        confirmLabel: 'Delete everything', danger: true,
        onConfirm: () => runAccountDeletion(),
      });
    };
    injectAccountsMenu();
    injectDataAndLockMenu();
    injectUsernameMenu();
    // NOT closeAllPopovers directly -- that unconditionally strips 'open'
    // off every .popover on any click at all, including a click that
    // lands INSIDE one (e.g. the journal editor's colour-swatch picker,
    // which shares this same .popover class and is deliberately supposed
    // to stay open while picking several colors in a row -- see the
    // comment above its preset-click handler in pages.notes.js). Only
    // close a popover here when the click actually lands outside it.
    document.addEventListener('click', (e) => {
      document.querySelectorAll('.popover.open').forEach(p => { if (!p.contains(e.target)) p.classList.remove('open'); });
    });
  }

  // ---------------- Task sharing popover (tasks page only) ----------------
  // The share-btn/share-popover markup only exists in tasks.html, so this
  // is a no-op on every other page.
  function buildSharePopover() {
    const btn = $('#share-btn');
    if (!btn) return;
    btn.onclick = async (e) => {
      e.stopPropagation();
      renderSharePopoverList(); // show the cached list instantly...
      renderMyUsername();
      togglePopover('#share-popover');
      await DB.workspaces.refreshShared(); // ...then refresh in case another person added you
      if ($('#share-popover').classList.contains('open')) renderSharePopoverList();
    };
    $('#share-add-item').onclick = () => {
      openAddPersonModal(async (identifier) => {
        const person = await DB.workspaces.addPerson(identifier);
        DB.workspaces.setActive(person.id);
        closeAllPopovers();
        Pages.tasks?.refresh?.();
        showToast('Task list shared', `You and ${person.name} now share this list.`);
      });
    };
  }
  function renderMyUsername() {
    const row = $('#share-my-username');
    if (!row) return;
    const username = DB.workspaces.getUsername();
    // Just a reminder of your own handle so you know what to give someone
    // else to invite you — changing it happens from the account popover.
    row.textContent = username ? `You: @${username}` : 'Set a username in your account menu to be added by it';
  }
  function renderSharePopoverList() {
    const wrap = $('#share-popover-list');
    if (!wrap) return;
    const active = DB.workspaces.getActive();
    const rows = [{ id: 'personal', name: 'Personal' }, ...DB.workspaces.list()];
    wrap.innerHTML = rows.map(p => `
      <button class="popover-item share-person-item" data-id="${p.id}" style="${p.id === active ? 'font-weight:700;' : ''}">
        <span class="checkbox ${p.id === active ? 'checked' : ''}" style="pointer-events:none;">${p.id === active ? '\u2713' : ''}</span><span>${UI.escapeHtml(p.name)}</span>
      </button>
    `).join('');
    wrap.querySelectorAll('.share-person-item').forEach(b => {
      b.onclick = () => {
        DB.workspaces.setActive(b.dataset.id);
        closeAllPopovers();
        Pages.tasks?.refresh?.();
      };
    });
  }

  // ---------------- Account deletion ----------------
  // Waits for the REAL result. It used to fire DB.deleteAccount() without
  // waiting, show "Account deleted" straight away and reload after 500ms --
  // which could cut the Firebase request off mid-flight and hid every
  // failure. Now the success message only appears once the account is
  // really gone, and if Firebase wants a fresh sign-in first (the usual
  // reason it refuses) the person is asked to confirm instead.
  let deletingAccount = false;
  async function runAccountDeletion(opts) {
    if (deletingAccount) return;
    deletingAccount = true;
    showToast('Deleting account\u2026', 'Please keep the app open.');
    let result;
    try { result = await DB.deleteAccount(opts); }
    catch (e) { result = { ok: false, error: (e && e.message) || 'Something went wrong.' }; }
    deletingAccount = false;

    if (result && result.ok) {
      closeModal('#deleteauth-modal-scrim');
      showToast('Account deleted', 'Your account and all data on this device were removed.');
      // Land on Home for the next sign-in/sign-up, not wherever the person
      // happened to be (e.g. deep in Journal) -- a fresh account should
      // start fresh, not resume mid-page-of-a-now-deleted-account.
      setTimeout(() => { location.href = 'index.html'; }, 900);
      return;
    }
    if (result && result.needsReauth) { showDeleteReauthModal(result); return; }
    const msg = (result && result.error) || 'Please try again.';
    const errEl = $('#deleteauth-error');
    if (errEl && $('#deleteauth-modal-scrim')?.classList.contains('open')) { errEl.textContent = msg; errEl.style.display = 'block'; return; }
    showToast('Account NOT deleted', msg);
  }

  function buildDeleteReauthModalOnce() {
    if ($('#deleteauth-modal-scrim')) return;
    const scrim = document.createElement('div');
    scrim.className = 'modal-scrim';
    scrim.id = 'deleteauth-modal-scrim';
    scrim.innerHTML = `
      <div class="modal" id="deleteauth-modal">
        <div class="modal-head">
          <h2 class="font-display">Confirm it\u2019s you</h2>
          <button class="icon-btn" id="deleteauth-close" aria-label="Close">&#10005;</button>
        </div>
        <p style="color:var(--ink-soft);font-size:.85rem;line-height:1.5;margin:0 0 16px;">
          To permanently delete <b id="deleteauth-email"></b>, sign in once more. This can\u2019t be undone.
        </p>
        <div id="deleteauth-google-wrap">
          <button type="button" class="btn" id="deleteauth-google-btn" style="width:100%;background:#fff;color:#1f1f1f;border:1px solid #dadce0;margin-bottom:14px;">Continue with Google</button>
          <div class="onboard-divider" id="deleteauth-divider"><span>or</span></div>
        </div>
        <form id="deleteauth-form">
          <div class="field" id="deleteauth-password-field"><label for="deleteauth-password">Password</label><input type="password" id="deleteauth-password" autocomplete="current-password" /></div>
          <div class="applock-error" id="deleteauth-error" style="display:none;"></div>
          <div class="btn-row">
            <button type="button" class="btn ghost" id="deleteauth-cancel">Cancel</button>
            <button type="submit" class="btn danger" id="deleteauth-submit">Delete account</button>
          </div>
        </form>
      </div>`;
    document.body.appendChild(scrim);
    $('#deleteauth-close').onclick = () => closeModal('#deleteauth-modal-scrim');
    $('#deleteauth-cancel').onclick = () => closeModal('#deleteauth-modal-scrim');
    $('#deleteauth-form').onsubmit = (e) => {
      e.preventDefault();
      const pw = $('#deleteauth-password').value;
      if (!pw) { const el = $('#deleteauth-error'); el.textContent = 'Enter your password.'; el.style.display = 'block'; return; }
      $('#deleteauth-error').style.display = 'none';
      runAccountDeletion({ password: pw });
    };
    $('#deleteauth-google-btn').onclick = async () => {
      $('#deleteauth-error').style.display = 'none';
      try {
        const user = await googleSignIn('reauth');
        if (user) await runAccountDeletion({ freshUser: user });
      } catch (err) {
        const el = $('#deleteauth-error'); el.textContent = (err && err.message) || 'Google sign-in failed.'; el.style.display = 'block';
      }
    };
  }
  function showDeleteReauthModal(info) {
    buildDeleteReauthModalOnce();
    const providers = (info && info.providers) || [];
    const known = providers.length > 0;
    $('#deleteauth-email').textContent = (info && info.email) || 'your account';
    $('#deleteauth-google-wrap').style.display = (!known || providers.includes('google.com')) ? '' : 'none';
    $('#deleteauth-divider').style.display = (!known || (providers.includes('google.com') && providers.includes('password'))) ? '' : 'none';
    $('#deleteauth-password-field').style.display = (!known || providers.includes('password')) ? '' : 'none';
    $('#deleteauth-submit').style.display = (!known || providers.includes('password')) ? '' : 'none';
    $('#deleteauth-password').value = '';
    $('#deleteauth-error').style.display = 'none';
    openModal('#deleteauth-modal-scrim');
    setTimeout(() => $('#deleteauth-password')?.focus(), 50);
  }

  // ---------------- Generic confirm modal ----------------
  // Used instead of window.confirm()/alert() for destructive actions —
  // those dialogs are frequently blocked or silently no-op in installed
  // PWAs and embedded webviews, which made "Delete account" look broken
  // even though DB.deleteAccount() itself worked fine.
  function buildConfirmModalOnce() {
    if ($('#confirm-modal-scrim')) return;
    const scrim = document.createElement('div');
    scrim.className = 'modal-scrim';
    scrim.id = 'confirm-modal-scrim';
    scrim.innerHTML = `
      <div class="modal" id="confirm-modal">
        <div class="modal-head">
          <h2 class="font-display" id="confirm-modal-title">Are you sure?</h2>
          <button class="icon-btn" id="confirm-modal-close" aria-label="Close">&#10005;</button>
        </div>
        <p id="confirm-modal-body" style="color:var(--ink-soft);font-size:.88rem;line-height:1.5;margin:0 0 18px;"></p>
        <div class="btn-row">
          <button type="button" class="btn ghost" id="confirm-modal-cancel">Cancel</button>
          <button type="button" class="btn" id="confirm-modal-ok">Confirm</button>
        </div>
      </div>`;
    document.body.appendChild(scrim);
    $('#confirm-modal-close').onclick = () => closeModal('#confirm-modal-scrim');
    $('#confirm-modal-cancel').onclick = () => closeModal('#confirm-modal-scrim');
  }
  function showConfirm({ title, body, confirmLabel, danger, onConfirm }) {
    buildConfirmModalOnce();
    $('#confirm-modal-title').textContent = title || 'Are you sure?';
    $('#confirm-modal-body').textContent = body || '';
    const okBtn = $('#confirm-modal-ok');
    okBtn.textContent = confirmLabel || 'Confirm';
    okBtn.className = 'btn' + (danger ? ' danger' : '');
    okBtn.style.background = danger ? '' : 'var(--calendar)';
    okBtn.onclick = () => { closeModal('#confirm-modal-scrim'); onConfirm && onConfirm(); };
    openModal('#confirm-modal-scrim');
  }

  // ---------------- Accounts: switcher + "Add account" ----------------
  // Called once from buildProfilePopover() (at init, before onboarding/
  // sign-in has necessarily finished) AND again right after a first-time
  // Google sign-in completes (see guardOnboarding's onDone in init()) --
  // that second call is what makes the just-signed-in email show up
  // without needing a page reload. The wrap/button are only created once
  // (guarded below); the account list itself is re-rendered every call
  // so it always reflects whatever DB.listAccounts() has right now.
  function injectAccountsMenu() {
    const popover = $('#profile-popover');
    const accountLabel = popover?.querySelector('.popover-label');
    if (!popover || !accountLabel) return;

    let wrap = $('#accounts-list-wrap');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = 'accounts-list-wrap';
      accountLabel.insertAdjacentElement('afterend', wrap);

      const addBtn = document.createElement('button');
      addBtn.className = 'popover-item';
      addBtn.id = 'add-account-item';
      addBtn.innerHTML = '<span>&#10133;</span><span>Add account</span>';
      wrap.insertAdjacentElement('afterend', addBtn);
      addBtn.onclick = () => {
        closeAllPopovers();
        openAddAccountForm(() => { renderAccounts(); wireTopbar(); });
      };
    }

    function renderAccounts() {
      const accounts = DB.listAccounts();
      const activeId = DB.getActiveAccountId();
      wrap.innerHTML = accounts.map(a => `
        <button class="popover-item" data-account-id="${a.id}">
          <span>${a.id === activeId ? '&#10003;' : ''}</span>
          <span>${escapeHtml(a.name)}${a.email ? ` <span style="color:var(--ink-faint);font-weight:400;">(${escapeHtml(a.email)})</span>` : ''}</span>
        </button>`).join('');
      wrap.querySelectorAll('[data-account-id]').forEach(btn => {
        btn.onclick = () => {
          closeAllPopovers();
          DB.switchAccount(btn.dataset.accountId);
          wireTopbar();
          showToast('Switched account', escapeHtml(DB.getProfile()?.name || ''));
        };
      });
    }
    renderAccounts();
  }

  function buildAddAccountModalOnce() {
    if ($('#addaccount-modal-scrim')) return;
    const scrim = document.createElement('div');
    scrim.className = 'modal-scrim';
    scrim.id = 'addaccount-modal-scrim';
    scrim.innerHTML = `
      <div class="modal" id="addaccount-modal">
        <div class="modal-head">
          <h2 class="font-display">Add account</h2>
          <button class="icon-btn" id="addaccount-modal-close" aria-label="Close">&#10005;</button>
        </div>
        <p style="color:var(--ink-soft);font-size:.82rem;line-height:1.5;margin:0 0 16px;">
          Sign in with a real account to switch to it \u2014 your calendar, tasks, finance and journal entries stay shared on this device across accounts.
        </p>
        <button type="button" class="btn" id="addaccount-google-btn" style="width:100%;background:#fff;color:#1f1f1f;border:1px solid #dadce0;display:flex;align-items:center;justify-content:center;gap:10px;margin-bottom:14px;">
          <svg width="18" height="18" viewBox="0 0 18 18"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84c-.21 1.13-.84 2.08-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.87 2.68-6.62z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.97v2.33C2.45 15.98 5.48 18 9 18z"/><path fill="#FBBC05" d="M3.97 10.72c-.18-.54-.28-1.12-.28-1.72s.1-1.18.28-1.72V4.95H.97C.35 6.18 0 7.55 0 9s.35 2.82.97 4.05l3-2.33z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.51.46 3.44 1.35l2.59-2.59C13.46.89 11.43 0 9 0 5.48 0 2.45 2.02.97 4.95l3 2.33C4.68 5.16 6.66 3.58 9 3.58z"/></svg>
          Continue with Google
        </button>
        <div class="onboard-divider"><span>or</span></div>
        <form id="addaccount-form">
          <div class="field"><label for="addaccount-email">Email</label><input type="email" id="addaccount-email" required /></div>
          <div class="field"><label for="addaccount-password">Password</label><input type="password" id="addaccount-password" required minlength="6" /></div>
          <div class="applock-error" id="addaccount-error" style="display:none;"></div>
          <div class="btn-row">
            <button type="button" class="btn ghost" id="addaccount-cancel">Cancel</button>
            <button type="submit" class="btn" style="background:var(--calendar);" id="addaccount-submit-btn">Sign in</button>
          </div>
        </form>
        <button type="button" class="onboard-skip" id="addaccount-toggle-mode">Don\u2019t have an account? Create one</button>
      </div>`;
    document.body.appendChild(scrim);
    $('#addaccount-modal-close').onclick = () => closeModal('#addaccount-modal-scrim');
    $('#addaccount-cancel').onclick = () => closeModal('#addaccount-modal-scrim');
  }
  function openAddAccountForm(onAdded) {
    buildAddAccountModalOnce();

    let mode = 'signin'; // or 'signup'
    const errEl = $('#addaccount-error');
    const showError = (msg) => { errEl.textContent = msg; errEl.style.display = 'block'; };
    errEl.style.display = 'none';
    $('#addaccount-email').value = '';
    $('#addaccount-password').value = '';
    $('#addaccount-submit-btn').textContent = 'Sign in';
    $('#addaccount-toggle-mode').textContent = 'Don\u2019t have an account? Create one';

    // This really signs in/creates a Firebase user (same as the onboarding
    // screen) instead of just saving a name/email locally, so "Add account"
    // switches Firebase's active session too, not just the display name.
    const finishWithFirebaseUser = (user) => {
      DB.completeOnboarding({ name: user.displayName || (user.email ? user.email.split('@')[0] : 'You'), email: user.email || '' });
      DB.workspaces.ensureEmailIndex(); // lets others find this account by email to share tasks with it
      closeModal('#addaccount-modal-scrim');
      showToast('Account added', 'Switched to the new account.');
      onAdded && onAdded();
    };

    $('#addaccount-toggle-mode').onclick = () => {
      mode = mode === 'signin' ? 'signup' : 'signin';
      $('#addaccount-submit-btn').textContent = mode === 'signin' ? 'Sign in' : 'Create account';
      $('#addaccount-toggle-mode').textContent = mode === 'signin' ? 'Don\u2019t have an account? Create one' : 'Already have an account? Sign in';
      errEl.style.display = 'none';
    };

    $('#addaccount-google-btn').onclick = async () => {
      try {
        const user = await googleSignIn(mode);
        if (user) finishWithFirebaseUser(user);
      } catch (e) {
        showError(e.message || 'Google sign-in failed.');
      }
    };

    $('#addaccount-form').onsubmit = async (e) => {
      e.preventDefault();
      errEl.style.display = 'none';
      const email = $('#addaccount-email').value.trim();
      const password = $('#addaccount-password').value;
      if (typeof firebase === 'undefined') { showError('Firebase isn\u2019t configured yet \u2014 see firebase-config.js.'); return; }
      try {
        const cred = mode === 'signin'
          ? await firebase.auth().signInWithEmailAndPassword(email, password)
          : await firebase.auth().createUserWithEmailAndPassword(email, password);
        finishWithFirebaseUser(cred.user);
      } catch (e) {
        showError(friendlyAuthMessage(e, mode));
      }
    };

    openModal('#addaccount-modal-scrim');
    setTimeout(() => $('#addaccount-email')?.focus(), 50);
  }

  // ---------------- Backup / restore + App lock menu items ----------------
  // Injected via JS (rather than duplicated in every .html file) since the
  // profile popover markup is repeated across 5 pages already.
  function injectDataAndLockMenu() {
    const popover = $('#profile-popover');
    const divider = popover.querySelector('.popover-divider');
    if (!popover || !divider || popover.querySelector('#backup-export-item')) return;

    const dataSection = document.createElement('div');
    dataSection.innerHTML = `
      <div class="popover-label">Data</div>
      <button class="popover-item" id="backup-export-item"><span>&#11015;&#65039;</span><span>Export backup</span></button>
      <button class="popover-item" id="backup-import-item"><span>&#11014;&#65039;</span><span>Import backup</span></button>
      <input type="file" id="backup-import-input" accept="application/json" style="display:none;" />
      <div class="popover-divider"></div>
      <div class="popover-label">Privacy</div>
      <button class="popover-item" id="app-lock-item"><span>&#128274;</span><span id="app-lock-item-label">Set app lock</span></button>
    `;
    popover.insertBefore(dataSection, divider);

    $('#backup-export-item').onclick = () => {
      closeAllPopovers();
      const payload = DB.exportAll();
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const stamp = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `daynote-backup-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      showToast('Backup exported', 'Saved as a .json file \u2014 keep it somewhere safe.');
    };

    const importInput = $('#backup-import-input');
    $('#backup-import-item').onclick = () => { closeAllPopovers(); importInput.click(); };
    importInput.onchange = () => {
      const file = importInput.files[0];
      importInput.value = '';
      if (!file) return;
      const reader = new FileReader();
      reader.onerror = () => showToast('Import failed', 'That file couldn\u2019t be read.');
      reader.onload = () => {
        // 1) Check the file BEFORE asking anything or touching any data.
        let payload, summary;
        try {
          payload = JSON.parse(reader.result);
        } catch (e) {
          showToast('Import failed', 'That file isn\u2019t a DayNote backup (it isn\u2019t valid JSON).');
          return;
        }
        try {
          summary = DB.describeBackup(payload);
        } catch (e) {
          showToast('Import failed', e.message || 'That file doesn\u2019t look like a DayNote backup.');
          return;
        }
        // 2) Only then ask -- saying what was found -- and wait for the
        //    restore to really finish before reporting success. (Uses the
        //    in-app confirm box; window.confirm() is unreliable in webviews.)
        showConfirm({
          title: 'Import this backup?',
          body: `Found ${summary}. Importing replaces the DayNote data on this device with it.`,
          confirmLabel: 'Import',
          danger: true,
          onConfirm: async () => {
            try {
              await DB.importAll(payload);
              showToast('Backup restored', 'Reloading\u2026');
              setTimeout(() => location.reload(), 600);
            } catch (e) {
              showToast('Import failed', e.message || 'The backup couldn\u2019t be restored.');
            }
          },
        });
      };
      reader.readAsText(file);
    };

    const lockLabel = $('#app-lock-item-label');
    lockLabel.textContent = DB.hasLockPin() ? 'Change or remove app lock' : 'Set app lock';
    $('#app-lock-item').onclick = () => {
      closeAllPopovers();
      openAppLockSetup();
    };
  }

  // ---------------- Sharing: pick a username (account popover) ----------------
  // Adds a "Sharing" section to the account popover with a row for
  // claiming/changing your @username — the identifier other people can
  // use to add you to a shared task list instead of your email (see
  // DB.workspaces.setUsername / addPerson in data.js).
  function injectUsernameMenu() {
    const popover = $('#profile-popover');
    if (!popover || popover.querySelector('#username-item')) return;

    const section = document.createElement('div');
    section.innerHTML = `
      <div class="popover-divider"></div>
      <div class="popover-label">Username</div>
      <button class="popover-item" id="username-item"><span>&#64;</span><span id="username-item-label"></span></button>
    `;
    popover.appendChild(section);

    const label = $('#username-item-label');
    const renderLabel = () => {
      const username = DB.workspaces.getUsername();
      label.textContent = username ? `Your username: @${username} (tap to change)` : 'Set a username';
    };
    renderLabel();

    $('#username-item').onclick = () => {
      closeAllPopovers();
      openUsernameModal(renderLabel);
    };
  }

  // Styled replacement for the old window.prompt() username dialog, built
  // once and reused (same pattern as buildAddAccountModalOnce /
  // buildLockModalOnce). The "@" is shown as a fixed prefix on the input
  // itself, so it's visually clear you never type it yourself — typing
  // one anyway still works fine since setUsername() strips a leading "@".
  function buildUsernameModalOnce() {
    if ($('#username-modal-scrim')) return;
    const scrim = document.createElement('div');
    scrim.className = 'modal-scrim';
    scrim.id = 'username-modal-scrim';
    scrim.innerHTML = `
      <div class="modal" id="username-modal">
        <div class="modal-head">
          <h2 class="font-display">Set a username</h2>
          <button class="icon-btn" id="username-modal-close" aria-label="Close">&#10005;</button>
        </div>
        <form id="username-form">
          <div class="field">
            <label for="username-input">Username</label>
            <div class="field-prefixed">
              <span class="field-prefix">&#64;</span>
              <input type="text" id="username-input" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="yourname" />
            </div>
            <div class="field-hint">3\u201320 characters: lowercase letters, numbers, underscore. Others can use this instead of your email to share a task list with you.</div>
          </div>
          <div class="applock-error" id="username-error" style="display:none;"></div>
          <div class="btn-row">
            <button type="button" class="btn ghost" id="username-cancel">Cancel</button>
            <button type="submit" class="btn" style="background:var(--calendar);" id="username-submit-btn">Save</button>
          </div>
        </form>
      </div>`;
    document.body.appendChild(scrim);
    $('#username-modal-close').onclick = () => closeModal('#username-modal-scrim');
    $('#username-cancel').onclick = () => closeModal('#username-modal-scrim');
  }

  function openUsernameModal(onSaved) {
    buildUsernameModalOnce();
    const input = $('#username-input');
    const errEl = $('#username-error');
    const submitBtn = $('#username-submit-btn');
    errEl.style.display = 'none';
    // Prefill with the current username (without its "@") so changing it
    // starts from what's already set, same as the old prompt() did.
    input.value = DB.workspaces.getUsername() || '';

    $('#username-form').onsubmit = async (e) => {
      e.preventDefault();
      const raw = input.value.trim();
      if (!raw) { errEl.textContent = 'Enter a username.'; errEl.style.display = 'block'; return; }
      errEl.style.display = 'none';
      submitBtn.disabled = true;
      submitBtn.textContent = 'Saving\u2026';
      try {
        const clean = await DB.workspaces.setUsername(raw);
        closeModal('#username-modal-scrim');
        showToast('Username set', `You're now @${clean}.`);
        onSaved && onSaved();
      } catch (err) {
        errEl.textContent = err.message || 'Please try again.';
        errEl.style.display = 'block';
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Save';
      }
    };

    openModal('#username-modal-scrim');
    setTimeout(() => input.focus(), 50);
  }

  // ---------------- Sharing: add a person by email or @username ----------------
  // Styled replacement for the old window.prompt() call in
  // buildSharePopover(). onSubmit is the actual DB.workspaces.addPerson
  // call (plus whatever the caller wants to do once it succeeds) --
  // passed in so this modal stays generic and doesn't know about tasks
  // pages, toasts for that flow, etc.
  function buildAddPersonModalOnce() {
    if ($('#addperson-modal-scrim')) return;
    const scrim = document.createElement('div');
    scrim.className = 'modal-scrim';
    scrim.id = 'addperson-modal-scrim';
    scrim.innerHTML = `
      <div class="modal" id="addperson-modal">
        <div class="modal-head">
          <h2 class="font-display">Share this task list</h2>
          <button class="icon-btn" id="addperson-modal-close" aria-label="Close">&#10005;</button>
        </div>
        <form id="addperson-form">
          <div class="field">
            <label for="addperson-input">Email or @username</label>
            <input type="text" id="addperson-input" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="name@example.com or @username" />
            <div class="field-hint">They\u2019ll see the same tasks as you from now on.</div>
          </div>
          <div class="applock-error" id="addperson-error" style="display:none;"></div>
          <div class="btn-row">
            <button type="button" class="btn ghost" id="addperson-cancel">Cancel</button>
            <button type="submit" class="btn" style="background:var(--calendar);" id="addperson-submit-btn">Add</button>
          </div>
        </form>
      </div>`;
    document.body.appendChild(scrim);
    $('#addperson-modal-close').onclick = () => closeModal('#addperson-modal-scrim');
    $('#addperson-cancel').onclick = () => closeModal('#addperson-modal-scrim');
  }

  function openAddPersonModal(onSubmit) {
    buildAddPersonModalOnce();
    const input = $('#addperson-input');
    const errEl = $('#addperson-error');
    const submitBtn = $('#addperson-submit-btn');
    errEl.style.display = 'none';
    input.value = '';

    $('#addperson-form').onsubmit = async (e) => {
      e.preventDefault();
      const identifier = input.value.trim();
      if (!identifier) { errEl.textContent = 'Enter an email or username.'; errEl.style.display = 'block'; return; }
      errEl.style.display = 'none';
      submitBtn.disabled = true;
      submitBtn.textContent = 'Adding\u2026';
      try {
        await onSubmit(identifier);
        closeModal('#addperson-modal-scrim');
      } catch (err) {
        errEl.textContent = err.message || 'Please try again.';
        errEl.style.display = 'block';
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Add';
      }
    };

    openModal('#addperson-modal-scrim');
    setTimeout(() => input.focus(), 50);
  }

  // ---------------- App lock: setup modal + unlock overlay ----------------
  function buildLockModalOnce() {
    if ($('#applock-modal-scrim')) return;
    const scrim = document.createElement('div');
    scrim.className = 'modal-scrim';
    scrim.id = 'applock-modal-scrim';
    scrim.innerHTML = `
      <div class="modal" id="applock-modal">
        <div class="modal-head">
          <h2 class="font-display">App lock</h2>
          <button class="icon-btn" id="applock-modal-close" aria-label="Close">&#10005;</button>
        </div>
        <form id="applock-form">
          <div class="section-title" id="applock-hint">Set a 4+ digit PIN required to open DayNote on this device.</div>
          <div class="field">
            <label for="applock-pin" class="visually-hidden">PIN</label>
            <input type="password" inputmode="numeric" pattern="[0-9]*" id="applock-pin" placeholder="New PIN" minlength="4" autocomplete="off" />
          </div>
          <div class="field">
            <label for="applock-pin-confirm" class="visually-hidden">Confirm PIN</label>
            <input type="password" inputmode="numeric" pattern="[0-9]*" id="applock-pin-confirm" placeholder="Confirm PIN" minlength="4" autocomplete="off" />
          </div>
          <div class="btn-row">
            <button type="button" class="btn danger" id="applock-remove-btn" style="display:none;margin-right:auto;">Remove lock</button>
            <button type="submit" class="btn" style="background:var(--notes);">Save</button>
          </div>
        </form>
        <div class="popover-divider" style="margin:16px 0;"></div>
        <div class="section-title" id="biometric-row-label">Fingerprint / Face unlock</div>
        <div class="btn-row">
          <button type="button" class="btn" id="biometric-toggle-btn" style="width:100%;"></button>
        </div>
      </div>`;
    document.body.appendChild(scrim);
    $('#applock-modal-close').onclick = () => closeModal('#applock-modal-scrim');
    $('#applock-remove-btn').onclick = () => {
      DB.clearLockPin();
      sessionStorage.removeItem('daynote.unlocked');
      showToast('App lock removed', '');
      closeModal('#applock-modal-scrim');
      const label = $('#app-lock-item-label');
      if (label) label.textContent = 'Set app lock';
    };
    $('#applock-form').onsubmit = async (e) => {
      e.preventDefault();
      const pin = $('#applock-pin').value.trim();
      const confirmPin = $('#applock-pin-confirm').value.trim();
      if (pin.length < 4) { showToast('PIN too short', 'Use at least 4 digits.'); return; }
      if (pin !== confirmPin) { showToast('PINs don\u2019t match', 'Try again.'); return; }
      await DB.setLockPin(pin);
      showToast('App lock set', 'You\u2019ll need this PIN to open DayNote on this device.');
      closeModal('#applock-modal-scrim');
      const label = $('#app-lock-item-label');
      if (label) label.textContent = 'Change or remove app lock';
    };

    $('#biometric-toggle-btn').onclick = async () => {
      const btn = $('#biometric-toggle-btn');
      if (DB.hasBiometric()) {
        DB.clearBiometric();
        showToast('Fingerprint unlock turned off', '');
        refreshBiometricButton();
        return;
      }
      try {
        await DB.registerBiometric();
        showToast('Fingerprint unlock enabled', 'You can now unlock DayNote with your fingerprint or face.');
      } catch (e) {
        showToast('Couldn\u2019t set up fingerprint unlock', e.message || 'Try again.');
      }
      refreshBiometricButton();
    };
  }

  async function refreshBiometricButton() {
    const btn = $('#biometric-toggle-btn');
    const label = $('#biometric-row-label');
    if (!btn || !label) return;
    const available = await DB.isBiometricAvailable();
    if (!available) {
      label.textContent = 'Fingerprint / Face unlock (not available on this device)';
      btn.style.display = 'none';
      return;
    }
    btn.style.display = '';
    btn.disabled = false;
    btn.classList.remove('ghost');
    if (DB.hasBiometric()) {
      label.textContent = 'Fingerprint / Face unlock is on';
      btn.textContent = 'Turn off fingerprint unlock';
      btn.classList.add('danger');
    } else {
      label.textContent = 'Fingerprint / Face unlock';
      btn.textContent = 'Enable fingerprint unlock';
      btn.classList.remove('danger');
    }
  }



  function openAppLockSetup() {
    buildLockModalOnce();
    $('#applock-pin').value = '';
    $('#applock-pin-confirm').value = '';
    $('#applock-remove-btn').style.display = DB.hasLockPin() ? 'inline-flex' : 'none';
    openModal('#applock-modal-scrim');
    refreshBiometricButton();
    setTimeout(() => $('#applock-pin')?.focus(), 50);
  }

  // Blocks the page behind a full-screen PIN prompt until the correct PIN
  // is entered. Runs once per browser tab session (sessionStorage), not
  // once per app-open, since this is a multi-page site and re-prompting
  // on every single navigation would be unusable.
  // ---------------- First-launch sign-in (real Firebase Auth) ----------------
  // Real email/password + Google sign-in via Firebase — see
  // firebase-config.js for the one-time project setup this needs.
  // "Continue without an account" stays available since DayNote's actual
  // data lives on-device either way; signing in only personalizes the
  // profile shown around the app (name/photo) and identifies the person
  // for any future cross-device sync.
  // Turns Firebase's raw error codes into something a person can act on.
  // Most important case: after an account has been deleted, signing in with
  // its email fails -- the message says so and points at "Create one", so a
  // deleted account can only come back by making a brand-new account.
  function friendlyAuthMessage(e, mode) {
    const code = (e && e.code) || '';
    if (['auth/user-not-found', 'auth/invalid-credential', 'auth/invalid-login-credentials'].includes(code)) {
      return mode === 'signup'
        ? 'Could not create the account. Please try again.'
        : 'No account found for this email, or the password is wrong. If you deleted your account, tap \u201CCreate one\u201D below to make a new account.';
    }
    if (code === 'auth/wrong-password') return 'Incorrect password.';
    if (code === 'auth/email-already-in-use') return 'An account with this email already exists. Tap \u201CAlready have an account? Sign in\u201D below.';
    if (code === 'auth/weak-password') return 'Password must be at least 6 characters.';
    if (code === 'auth/invalid-email') return 'That email address doesn\u2019t look right.';
    if (code === 'auth/user-disabled') return 'This account has been disabled.';
    if (code === 'auth/too-many-requests') return 'Too many attempts. Wait a few minutes and try again.';
    if (code === 'auth/network-request-failed') return 'No internet connection. Please try again.';
    return (e && e.message) || 'Sign-in failed.';
  }

  // If the account was deleted (e.g. from another device), this device can
  // still be holding an old saved sign-in and would keep letting the person
  // in. Ask Firebase whether the user still exists; if not, sign out so the
  // sign-in screen appears and a new account has to be created. Offline /
  // network errors are ignored -- never lock anyone out just for being offline.
  async function verifyAccountStillExists() {
    if (typeof firebase === 'undefined' || !firebase.auth) return;
    try {
      const auth = firebase.auth();
      const user = auth.currentUser || await new Promise((resolve) => {
        let unsub = null, done = false;
        const finish = (u) => { if (done) return; done = true; clearTimeout(t); if (unsub) unsub(); resolve(u); };
        const t = setTimeout(() => finish(null), 4000);
        unsub = auth.onAuthStateChanged(finish, () => finish(null));
        if (done && unsub) unsub();
      });
      if (!user) return;
      await user.reload();
    } catch (e) {
      const code = (e && e.code) || '';
      if (['auth/user-not-found', 'auth/user-token-expired', 'auth/user-disabled', 'auth/invalid-user-token'].includes(code)) {
        try { await DB.signOut(); } catch (err) { /* ignore */ }
        showToast('Account no longer exists', 'Please sign in or create a new account.');
        setTimeout(() => location.reload(), 900);
      }
    }
  }

  function guardOnboarding(onDone) {
    if (DB.isOnboarded()) { onDone(); verifyAccountStillExists(); return; }
    // First finish off any half-done "no account found" attempt from last time.
    cleanupPendingDiscard().then(() => showSignInFlow(onDone), () => showSignInFlow(onDone));
  }

  function showSignInFlow(onDone) {

    const completeFromUser = (user) => {
      DB.completeOnboarding({ name: user.displayName || (user.email ? user.email.split('@')[0] : 'You'), email: user.email || '' });
      DB.workspaces.ensureEmailIndex(); // lets others find this account by email to share tasks with it
      onDone();
    };

    // If we just came back from signInWithRedirect (mobile Google
    // sign-in), Firebase resolves the pending user here. Check this
    // before building the overlay so a returning mobile user doesn't
    // see the sign-in screen flash before it's dismissed.
    if (typeof firebase !== 'undefined' && firebase.auth) {
      firebase.auth().getRedirectResult().then((result) => {
        if (result && result.user) { completeFromUser(result.user); return; }
        buildOnboardingOverlay(onDone);
      }).catch((e) => {
        buildOnboardingOverlay(onDone);
        // Show the real reason the redirect sign-in failed, instead of
        // silently dropping back to the sign-in screen with no clue.
        console.error('Google redirect sign-in failed:', e);
        setTimeout(() => {
          const errEl = document.getElementById('onboard-error');
          if (errEl) { errEl.textContent = e.message || 'Google sign-in failed.'; errEl.style.display = 'block'; }
        }, 0);
      });
    } else {
      buildOnboardingOverlay(onDone);
    }
  }

  // Shared Google sign-in flow, used by both the onboarding screen and
  // "Add account" in Settings so a real Firebase account can be created
  // from either place. Returns the Firebase user on success, or null if
  // sign-in was cancelled or handed off to a redirect (which navigates
  // away and resolves later via getRedirectResult in guardOnboarding).
  // Throws an Error with a user-facing .message on real failures.
  async function googleSignIn(intent) {
    if (typeof firebase === 'undefined') throw new Error('Firebase isn\u2019t configured yet \u2014 see firebase-config.js.');

    const isNativeApp = typeof window.Capacitor !== 'undefined' && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform();

    if (isNativeApp) {
      // Native Android app: a WebView can't complete Google's OAuth
      // flow (Google blocks embedded webviews outright), and Capacitor
      // hands off any external navigation to the system browser instead
      // \u2014 which then has no way to relay the result back into this
      // app's own isolated WebView. So instead we go through the native
      // Google Sign-In SDK (via the Capacitor Firebase plugin), which
      // returns an ID token straight to this JS code with no browser
      // involved at all, then hand that token to the Firebase JS SDK.
      const plugin = window.Capacitor.Plugins && window.Capacitor.Plugins.FirebaseAuthentication;
      if (!plugin) throw new Error('Native Google sign-in isn\u2019t set up yet.');
      // Clear any cached native Google session first so Google's account
      // chooser ALWAYS appears -- the person picks an account themselves,
      // like a brand-new user, instead of being silently signed in.
      if (plugin.signOut) { try { await plugin.signOut(); } catch (e) { /* not signed in natively */ } }
      const result = await plugin.signInWithGoogle();
      const idToken = result.credential && result.credential.idToken;
      if (!idToken) throw new Error('Google sign-in didn\u2019t return a token.');
      const credential = firebase.auth.GoogleAuthProvider.credential(idToken);
      const userCred = await firebase.auth().signInWithCredential(credential);
      return await finishGoogleSignIn(userCred, intent);
    }

    // Browser / PWA: popup with redirect fallback works fine here.
    const provider = new firebase.auth.GoogleAuthProvider();
    // Always show Google's account chooser instead of reusing the last
    // account automatically.
    provider.setCustomParameters({ prompt: 'select_account' });
    try {
      // Try a popup first on every device. Redirect-based sign-in relies
      // on a background connection to the Firebase authDomain to relay
      // the result back, which modern mobile browsers (Safari's "Prevent
      // Cross-Site Tracking", Chrome's privacy sandbox) increasingly
      // block outright \u2014 it fails silently with no error and no user.
      // Popups avoid that relay and are reliable as long as they're
      // triggered directly from this click handler, which this is.
      const result = await firebase.auth().signInWithPopup(provider);
      return await finishGoogleSignIn(result, intent);
    } catch (e) {
      if (e && (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment')) {
        // Genuine popup block (rare, but happens in some in-app browsers)
        // \u2014 fall back to redirect as a last resort.
        await firebase.auth().signInWithRedirect(provider);
        return null;
      }
      if (e && (e.code === 'auth/cancelled-popup-request' || e.code === 'auth/popup-closed-by-user')) return null; // user closed/re-opened it; no error needed
      throw e;
    }
  }

  // Google has no separate "sign in" and "sign up": Firebase silently creates
  // an account the first time any Google account signs in. That is how a
  // DELETED account came back as a fresh empty one with no warning. Firebase
  // does tell us when it just created a brand-new user (isNewUser), so:
  //   - intent 'signup' (person chose "Create account")   -> fine, keep it
  //   - intent 'signin' (person chose "Sign in")          -> ask first; if they
  //        say no, delete the just-created user again so nothing is left over
  //   - intent 'reauth' (confirming a deletion)           -> never allowed to
  //        create anything; discard it and report the wrong-account problem
  // A tiny note on this device: "this Google account was created by a
  // sign-in attempt the person then declined / interrupted -- remove it".
  // It exists from the moment such an account is detected until its
  // deletion is CONFIRMED, so a dropped connection or a closed app can't
  // leave the unused account forgotten.
  const PENDING_DISCARD_KEY = 'daynote.pendingDiscard';
  function readPendingDiscard() {
    try { return JSON.parse(localStorage.getItem(PENDING_DISCARD_KEY) || 'null'); } catch (e) { return null; }
  }
  function setPendingDiscard(user) {
    try { localStorage.setItem(PENDING_DISCARD_KEY, JSON.stringify({ uid: user.uid, email: user.email || '', at: Date.now() })); } catch (e) { /* storage unavailable */ }
  }
  function clearPendingDiscard() {
    try { localStorage.removeItem(PENDING_DISCARD_KEY); } catch (e) { /* ignore */ }
  }

  // Deletes the just-created Firebase user, retrying a few times if the
  // connection is flaky, then signs out. Returns true once it is really gone.
  // If it still can't be deleted, the note above stays so it is finished
  // later (next launch, or the next time this Google account signs in).
  async function discardNewGoogleUser(user) {
    setPendingDiscard(user);
    let deleted = false;
    for (let attempt = 0; attempt < 3 && !deleted; attempt++) {
      try { await user.delete(); deleted = true; }
      catch (e) {
        const code = (e && e.code) || '';
        if (code === 'auth/user-not-found') { deleted = true; break; }      // already gone
        if (code === 'auth/requires-recent-login') break;                   // retrying can't help
        await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));       // brief pause, then retry
      }
    }
    if (deleted) clearPendingDiscard();
    // Never leave the person signed in as an account they just declined.
    const nativeAuth = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.FirebaseAuthentication;
    if (nativeAuth && nativeAuth.signOut) { try { await nativeAuth.signOut(); } catch (e) { /* ignore */ } }
    try { await firebase.auth().signOut(); } catch (e) { /* ignore */ }
    return deleted;
  }

  // Runs at launch (before the sign-in screen): if a previous attempt was
  // interrupted while its account was still signed in, finish removing it.
  async function cleanupPendingDiscard() {
    const pending = readPendingDiscard();
    if (!pending || typeof firebase === 'undefined' || !firebase.auth) return;
    try {
      const auth = firebase.auth();
      const user = auth.currentUser || await new Promise((resolve) => {
        let unsub = null, done = false;
        const finish = (u) => { if (done) return; done = true; clearTimeout(t); if (unsub) unsub(); resolve(u); };
        const t = setTimeout(() => finish(null), 4000);
        unsub = auth.onAuthStateChanged(finish, () => finish(null));
        if (done && unsub) unsub();
      });
      if (user && user.uid === pending.uid) await discardNewGoogleUser(user);
    } catch (e) { /* try again next launch */ }
  }

  function askCreateGoogleAccount(email) {
    return new Promise((resolve) => {
      const old = $('#googlenew-modal-scrim');
      if (old) old.remove();
      const scrim = document.createElement('div');
      scrim.className = 'modal-scrim';
      scrim.id = 'googlenew-modal-scrim';
      scrim.style.zIndex = '1000'; // above the full-screen sign-in overlay
      scrim.innerHTML = `
        <div class="modal">
          <div class="modal-head"><h2 class="font-display">No account found</h2></div>
          <p style="color:var(--ink-soft);font-size:.88rem;line-height:1.5;margin:0 0 18px;">
            There is no DayNote account for <b id="googlenew-email"></b> \u2014 it may have been deleted. Do you want to create a new account with it?
          </p>
          <div class="btn-row">
            <button type="button" class="btn ghost" id="googlenew-cancel">Cancel</button>
            <button type="button" class="btn" style="background:var(--calendar);" id="googlenew-create">Create new account</button>
          </div>
        </div>`;
      document.body.appendChild(scrim);
      $('#googlenew-email').textContent = email || 'this Google account';
      let settled = false;
      const settle = (v) => { if (settled) return; settled = true; obs.disconnect(); scrim.remove(); resolve(v); };
      // Escape closes every open modal without calling us -- treat that as Cancel.
      const obs = new MutationObserver(() => { if (!scrim.classList.contains('open')) settle(false); });
      obs.observe(scrim, { attributes: true, attributeFilter: ['class'] });
      $('#googlenew-cancel').onclick = () => settle(false);
      $('#googlenew-create').onclick = () => settle(true);
      openModal('#googlenew-modal-scrim');
    });
  }

  async function finishGoogleSignIn(cred, intent) {
    const user = cred.user;
    // "New" = Firebase just created it, OR it is the unused account left
    // behind by an earlier declined attempt whose deletion never finished.
    const pending = readPendingDiscard();
    const isLeftover = !!(pending && pending.uid === user.uid);
    const isNew = !!(cred.additionalUserInfo && cred.additionalUserInfo.isNewUser) || isLeftover;
    if (!isNew) return user;
    if (intent === 'signup') { clearPendingDiscard(); return user; }
    if (intent === 'reauth') {
      await discardNewGoogleUser(user);
      throw new Error('That Google account isn\u2019t the one you\u2019re deleting. Pick the same account you signed up with.');
    }
    setPendingDiscard(user); // stays until the choice below is settled
    if (await askCreateGoogleAccount(user.email)) { clearPendingDiscard(); return user; }
    const deleted = await discardNewGoogleUser(user);
    if (!deleted) showToast('Almost done', 'We\u2019ll finish removing that unused account the next time you open DayNote.');
    return null; // declined: stay on the sign-in screen
  }

  function buildOnboardingOverlay(onDone) {
    const overlay = document.createElement('div');
    overlay.className = 'applock-overlay';
    overlay.innerHTML = `
      <div class="applock-box">
        <div class="brand-mark" style="margin:0 auto 14px;">D</div>
        <div class="font-display applock-title">Welcome to DayNote</div>
        <p class="onboard-sub">Sign in to personalize your journal.</p>
        <button type="button" class="btn" id="onboard-google-btn" style="width:100%;background:#fff;color:#1f1f1f;border:1px solid #dadce0;display:flex;align-items:center;justify-content:center;gap:10px;">
          <svg width="18" height="18" viewBox="0 0 18 18"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84c-.21 1.13-.84 2.08-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.87 2.68-6.62z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.97v2.33C2.45 15.98 5.48 18 9 18z"/><path fill="#FBBC05" d="M3.97 10.72c-.18-.54-.28-1.12-.28-1.72s.1-1.18.28-1.72V4.95H.97C.35 6.18 0 7.55 0 9s.35 2.82.97 4.05l3-2.33z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.51.46 3.44 1.35l2.59-2.59C13.46.89 11.43 0 9 0 5.48 0 2.45 2.02.97 4.95l3 2.33C4.68 5.16 6.66 3.58 9 3.58z"/></svg>
          Continue with Google
        </button>
        <div class="onboard-divider"><span>or</span></div>
        <form id="onboard-form">
          <input type="email" id="onboard-email" placeholder="Email" autocomplete="email" required />
          <input type="password" id="onboard-password" placeholder="Password" autocomplete="current-password" required minlength="6" />
          <div class="applock-error" id="onboard-error" style="display:none;"></div>
          <button type="submit" class="btn" style="background:var(--calendar);width:100%;" id="onboard-submit-btn">Sign in</button>
        </form>
        <button type="button" class="onboard-skip" id="onboard-toggle-mode">Don\u2019t have an account? Create one</button>
      </div>`;
    document.body.appendChild(overlay);

    let mode = 'signin'; // or 'signup'
    const errEl = $('#onboard-error', overlay);
    const showError = (msg) => { errEl.textContent = msg; errEl.style.display = 'block'; };

    const finishWithFirebaseUser = (user) => {
      DB.completeOnboarding({ name: user.displayName || (user.email ? user.email.split('@')[0] : 'You'), email: user.email || '' });
      DB.workspaces.ensureEmailIndex(); // lets others find this account by email to share tasks with it
      overlay.remove();
      onDone();
    };

    $('#onboard-toggle-mode', overlay).onclick = () => {
      mode = mode === 'signin' ? 'signup' : 'signin';
      $('#onboard-submit-btn', overlay).textContent = mode === 'signin' ? 'Sign in' : 'Create account';
      $('#onboard-toggle-mode', overlay).textContent = mode === 'signin' ? 'Don\u2019t have an account? Create one' : 'Already have an account? Sign in';
      errEl.style.display = 'none';
    };

    $('#onboard-google-btn', overlay).onclick = async () => {
      try {
        const user = await googleSignIn(mode);
        if (user) finishWithFirebaseUser(user);
      } catch (e) {
        showError(e.message || 'Google sign-in failed.');
      }
    };

    $('#onboard-form', overlay).onsubmit = async (e) => {
      e.preventDefault();
      errEl.style.display = 'none';
      const email = $('#onboard-email', overlay).value.trim();
      const password = $('#onboard-password', overlay).value;
      if (typeof firebase === 'undefined') { showError('Firebase isn\u2019t configured yet \u2014 see firebase-config.js.'); return; }
      try {
        const cred = mode === 'signin'
          ? await firebase.auth().signInWithEmailAndPassword(email, password)
          : await firebase.auth().createUserWithEmailAndPassword(email, password);
        finishWithFirebaseUser(cred.user);
      } catch (e) {
        showError(friendlyAuthMessage(e, mode));
      }
    };

    setTimeout(() => $('#onboard-email', overlay)?.focus(), 50);
  }

  function guardAppLock() {
    if ((!DB.hasLockPin() && !DB.hasBiometric()) || sessionStorage.getItem('daynote.unlocked') === '1') return;
    const pinSet = DB.hasLockPin();
    const overlay = document.createElement('div');
    overlay.className = 'applock-overlay';
    overlay.innerHTML = `
      <div class="applock-box">
        <div class="applock-icon">&#128274;</div>
        <div class="font-display applock-title">DayNote is locked</div>
        <form id="applock-unlock-form" style="${pinSet ? '' : 'display:none;'}">
          <input type="password" inputmode="numeric" pattern="[0-9]*" id="applock-unlock-pin" placeholder="Enter PIN" autocomplete="off" ${pinSet ? 'autofocus' : ''} />
          <div class="applock-error" id="applock-unlock-error" style="display:none;">Wrong PIN \u2014 try again.</div>
          <button type="submit" class="btn" style="background:var(--notes);width:100%;">Unlock</button>
        </form>
        <button type="button" class="onboard-skip" id="applock-biometric-btn" style="display:none;">Use fingerprint instead</button>
      </div>`;
    document.body.appendChild(overlay);
    const input = $('#applock-unlock-pin', overlay);
    const err = $('#applock-unlock-error', overlay);
    const unlock = () => { sessionStorage.setItem('daynote.unlocked', '1'); overlay.remove(); };

    if (pinSet) {
      $('#applock-unlock-form', overlay).onsubmit = async (e) => {
        e.preventDefault();
        const ok = await DB.checkLockPin(input.value.trim());
        if (ok) {
          unlock();
        } else {
          err.style.display = 'block';
          input.value = '';
          input.focus();
        }
      };
    }

    const bioBtn = $('#applock-biometric-btn', overlay);
    const tryBiometric = async () => {
      if (!DB.hasBiometric()) return;
      const ok = await DB.verifyBiometric();
      if (ok && document.body.contains(overlay)) unlock();
    };
    if (DB.hasBiometric()) {
      // Biometric-only (no PIN set): there's no PIN form to fall back to,
      // so this is the only way in -- keep the retry button visible and
      // labeled for that instead of the "...instead" wording that assumes
      // a PIN form is sitting right above it.
      bioBtn.style.display = 'block';
      bioBtn.textContent = pinSet ? 'Use fingerprint instead' : 'Try fingerprint / face again';
      bioBtn.onclick = tryBiometric;
      tryBiometric(); // prompt automatically; PIN stays available as a fallback if it's cancelled or fails
    }

    setTimeout(() => input?.focus(), 50);
  }

  function togglePopover(sel) {
    const el = $(sel);
    const willOpen = !el.classList.contains('open');
    closeAllPopovers();
    if (willOpen) el.classList.add('open');
  }
  function closeAllPopovers() { document.querySelectorAll('.popover').forEach(p => p.classList.remove('open')); }

  // ---------------- Theme picker modal ----------------
  function buildThemeModal() {
    const grid = $('#theme-grid');
    if (!grid) return;
    grid.innerHTML = '';

    function makeSwatch(t) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'swatch-btn';
      btn.dataset.id = t.id;
      btn.innerHTML = `<div class="dots">${t.swatch.map(c => `<span style="background:${c}"></span>`).join('')}</div><div class="swatch-name">${t.name}</div>`;
      btn.onclick = () => {
        document.documentElement.setAttribute('data-theme', t.id);
        DB.setTheme(t.id);
        document.querySelectorAll('.swatch-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      };
      return btn;
    }
    THEMES.forEach(t => grid.appendChild(makeSwatch(t)));

    $('#theme-btn')?.addEventListener('click', () => {
      const active = DB.getTheme();
      document.querySelectorAll('.swatch-btn').forEach(b => b.classList.toggle('active', b.dataset.id === active));
      openModal('#theme-modal-scrim');
    });
    $('#theme-modal-close')?.addEventListener('click', () => closeModal('#theme-modal-scrim'));
  }

  // ---------------- Topbar ----------------
  function wireTopbar() {
    const profile = DB.getProfile();
    const initialEl = $('#profile-initial');
    if (initialEl) initialEl.textContent = (profile?.name || 'U').charAt(0).toUpperCase();
  }

  // ---------------- Generic modal helpers ----------------
  function openModal(sel) { $(sel)?.classList.add('open'); }
  function closeModal(sel) { $(sel)?.classList.remove('open'); }

  // ---------------- Toasts ----------------
  function showToast(title, body) {
    const stack = $('#toast-stack');
    if (!stack) return;
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = `<div class="t-title">${escapeHtml(title)}</div>${body ? `<div class="t-body">${escapeHtml(body)}</div>` : ''}`;
    stack.appendChild(el);
    setTimeout(() => { el.remove(); }, 5000);
  }

  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  return { init, openModal, closeModal, showToast, escapeHtml, closeAllPopovers, get currentPage() { return currentPage; } };
})();

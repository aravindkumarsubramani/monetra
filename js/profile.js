window.Monetra = window.Monetra || {};

// Profile tab. Everything here is genuinely wired up (no fake "Verified"
// badges, no 2FA controls Monetra can't actually provide) — see the
// Security section for what's real: a login/logout against the Monetra
// server (server/server.js), which is what keeps the two stock-price API
// keys private per account. Everything else (accounts, transactions,
// budgets…) still lives only in this browser's local storage regardless of
// login state. Name/username/email/mobile batch-save via the top "Save
// changes" button; Default currency and Date format apply immediately
// (matching the existing Settings tab pattern) and Date format actually
// changes how dates render across Transactions and Debts.
(function () {
  function escape(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

  function computeInitials(name) {
    const parts = (name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  function formatMemberSince(iso) {
    const d = iso ? new Date(iso) : null;
    if (!d || isNaN(d.getTime())) return 'recently';
    return 'Member since ' + d.toLocaleString('en-US', { month: 'long', year: 'numeric' });
  }

  function formatLastActivity(iso) {
    const d = iso ? new Date(iso) : null;
    if (!d || isNaN(d.getTime())) return 'Last activity: no activity yet';
    const now = new Date();
    const yest = new Date(now); yest.setDate(yest.getDate() - 1);
    const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    let when;
    if (d.toDateString() === now.toDateString()) when = 'Today, ' + time;
    else if (d.toDateString() === yest.toDateString()) when = 'Yesterday, ' + time;
    else when = Monetra.storage.formatDate(d.toISOString().slice(0, 10)) + ', ' + time;
    return 'Last activity: ' + when;
  }

  function detectTimezoneLabel() {
    try {
      const offsetMin = -new Date().getTimezoneOffset();
      const sign = offsetMin >= 0 ? '+' : '-';
      const abs = Math.abs(offsetMin);
      const hh = String(Math.floor(abs / 60)).padStart(2, '0');
      const mm = String(abs % 60).padStart(2, '0');
      const zone = (Intl.DateTimeFormat().resolvedOptions().timeZone || '').replace(/_/g, ' ');
      return `(GMT${sign}${hh}:${mm})${zone ? ' ' + zone : ''}`;
    } catch (e) {
      return 'Unknown';
    }
  }

  const ICONS = {
    user: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
    mail: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M2 7l10 6 10-6"/></svg>',
    phone: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16.5v3a2 2 0 0 1-2.2 2 19 19 0 0 1-8.3-3 18.7 18.7 0 0 1-5.7-5.7 19 19 0 0 1-3-8.3A2 2 0 0 1 3.8 2.5h3a2 2 0 0 1 2 1.7c.13.9.36 1.8.68 2.7a2 2 0 0 1-.45 2.1L7.9 10.1a15.2 15.2 0 0 0 5.7 5.7l1.1-1.13a2 2 0 0 1 2.1-.45c.87.32 1.78.55 2.7.68a2 2 0 0 1 1.7 2.03z"/></svg>',
    coin: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v10M9 9.3c0-1.3 1.4-1.8 3-1.8s3 .7 3 1.8-1.3 1.6-3 1.8-3 .6-3 1.8 1.4 1.9 3 1.9 3-.5 3-1.9"/></svg>',
    calendar: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18"/><path d="M8 3v4M16 3v4"/></svg>',
    globe: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 3a14.5 14.5 0 0 0 0 18M12 3a14.5 14.5 0 0 1 0 18M3 12h18"/></svg>',
    moon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
    clock: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>',
    shield: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l8 4v5c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V6l8-4z"/></svg>',
    lock: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
    trash: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>',
    sliders: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>',
    alertTriangle: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    camera: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>',
    pencil: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
    check: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'
  };

  const DATE_FORMATS = ['DD MMM YYYY', 'DD.MM.YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD'];

  // Common calling codes. Not tied to Monetra's CURRENCIES list (a currency
  // like EUR spans many dial codes), just a practical standalone set.
  const COUNTRY_CODES = [
    { code: '+91', label: 'India (+91)' },
    { code: '+1', label: 'US / Canada (+1)' },
    { code: '+44', label: 'UK (+44)' },
    { code: '+61', label: 'Australia (+61)' },
    { code: '+49', label: 'Germany (+49)' },
    { code: '+33', label: 'France (+33)' },
    { code: '+81', label: 'Japan (+81)' },
    { code: '+86', label: 'China (+86)' },
    { code: '+65', label: 'Singapore (+65)' },
    { code: '+971', label: 'UAE (+971)' },
    { code: '+27', label: 'South Africa (+27)' },
    { code: '+34', label: 'Spain (+34)' },
    { code: '+39', label: 'Italy (+39)' },
    { code: '+31', label: 'Netherlands (+31)' },
    { code: '+41', label: 'Switzerland (+41)' },
    { code: '+46', label: 'Sweden (+46)' },
    { code: '+82', label: 'South Korea (+82)' },
    { code: '+64', label: 'New Zealand (+64)' },
    { code: '+852', label: 'Hong Kong (+852)' },
    { code: '+60', label: 'Malaysia (+60)' },
    { code: '+66', label: 'Thailand (+66)' },
    { code: '+62', label: 'Indonesia (+62)' },
    { code: '+92', label: 'Pakistan (+92)' },
    { code: '+880', label: 'Bangladesh (+880)' },
    { code: '+94', label: 'Sri Lanka (+94)' },
    { code: '+20', label: 'Egypt (+20)' },
    { code: '+55', label: 'Brazil (+55)' },
    { code: '+52', label: 'Mexico (+52)' }
  ];

  // "Verify" has no real backend to send an email/SMS through, so it's a
  // local-only marker the user sets for their own record — not a claim that
  // Monetra actually confirmed anything. Editing the value invalidates it,
  // same as a real verified-email flow would.
  function verifyControlHtml(field, verified) {
    if (verified) return `<span class="pill pill-paid">${ICONS.check} Verified</span>`;
    return `<button type="button" class="btn btn-ghost btn-sm" data-verify="${field}">Verify</button>`;
  }

  function render() {
    const el = document.getElementById('tab-profile');
    if (!el) return;
    const state = Monetra.storage.getState();
    const p = state.profile;
    const today = Monetra.storage.todayISO();
    const isLoggedIn = !!(Monetra.auth && Monetra.auth.isLoggedIn());
    const loggedInUser = isLoggedIn ? Monetra.auth.getUser() : null;

    el.innerHTML = `
      <div class="profile-page-head">
        <p class="profile-page-sub">Manage your account and preferences</p>
        <button class="btn btn-primary" id="profileSaveBtn">Save changes</button>
      </div>

      <div class="card profile-id-card">
        <div class="profile-avatar-wrap">
          <div class="profile-avatar" id="profileAvatar">${p.photo ? `<img src="${p.photo}" alt="">` : escape(computeInitials(p.fullName))}</div>
          <button type="button" class="profile-avatar-upload" id="profileAvatarBtn" title="Change photo">${ICONS.camera}</button>
          <input type="file" id="profileAvatarInput" accept="image/*" style="display:none;">
        </div>
        <div>
          <div class="profile-id-name">${escape(p.fullName) || 'Your name'}</div>
          <div class="profile-id-username">@${escape(p.username) || 'username'}</div>
          <div class="profile-id-meta">${formatMemberSince(state.meta.createdAt)}<br>${formatLastActivity(state.meta.lastActivity)}</div>
        </div>
      </div>

      <div class="card profile-section-card">
        <div class="profile-section-head">
          <div class="profile-section-icon">${ICONS.user}</div>
          <div><div class="profile-section-title">Account information</div><div class="profile-section-sub">Your basic account details</div></div>
        </div>
        <div class="profile-row">
          <div class="profile-row-icon">${ICONS.user}</div>
          <div class="profile-row-label">Full name</div>
          <div class="profile-row-value"><input id="profileFullName" type="text" value="${escape(p.fullName)}" placeholder="Add your name"></div>
          <button type="button" class="profile-row-edit" data-focus="profileFullName" title="Edit">${ICONS.pencil}</button>
        </div>
        <div class="profile-row">
          <div class="profile-row-icon" style="font-weight:700; font-size:15px;">@</div>
          <div class="profile-row-label">Username</div>
          <div class="profile-row-value" style="font-weight:600;">${escape(p.username) || 'Not set'}</div>
          <span class="profile-row-hint">Can't be changed</span>
        </div>
        <div class="profile-row">
          <div class="profile-row-icon">${ICONS.mail}</div>
          <div class="profile-row-label">Email address</div>
          <div class="profile-row-value"><input id="profileEmail" type="email" value="${escape(p.email)}" placeholder="Add your email"></div>
          <div class="profile-row-controls">
            ${verifyControlHtml('email', p.emailVerified)}
            <button type="button" class="profile-row-edit" data-focus="profileEmail" title="Edit">${ICONS.pencil}</button>
          </div>
        </div>
        <div class="profile-row">
          <div class="profile-row-icon">${ICONS.phone}</div>
          <div class="profile-row-label">Mobile number</div>
          <div class="profile-row-value" style="display:flex; gap:6px;">
            <select id="profileMobileCode" style="flex:0 0 108px;">${COUNTRY_CODES.map((c) => `<option value="${c.code}" ${p.mobileCountryCode === c.code ? 'selected' : ''}>${c.label}</option>`).join('')}</select>
            <input id="profileMobile" type="tel" value="${escape(p.mobile)}" placeholder="e.g. 98765 43210" style="flex:1;">
          </div>
          <div class="profile-row-controls">
            ${verifyControlHtml('mobile', p.mobileVerified)}
            <button type="button" class="profile-row-edit" data-focus="profileMobile" title="Edit">${ICONS.pencil}</button>
          </div>
        </div>
      </div>

      <div class="card profile-section-card">
        <div class="profile-section-head">
          <div class="profile-section-icon">${ICONS.sliders}</div>
          <div><div class="profile-section-title">Preferences</div><div class="profile-section-sub">Customize your Monetra experience</div></div>
        </div>
        <div class="profile-row">
          <div class="profile-row-icon">${ICONS.coin}</div>
          <div class="profile-row-label">Default currency</div>
          <div class="profile-row-value">
            <select id="profileCurrency">${Monetra.storage.CURRENCIES.map((c) => `<option value="${c}" ${state.settings.displayCurrency === c ? 'selected' : ''}>${c}</option>`).join('')}</select>
          </div>
        </div>
        <div class="profile-row">
          <div class="profile-row-icon">${ICONS.calendar}</div>
          <div class="profile-row-label">Date format</div>
          <div class="profile-row-value">
            <select id="profileDateFormat">${DATE_FORMATS.map((f) => `<option value="${f}" ${p.dateFormat === f ? 'selected' : ''}>${f}</option>`).join('')}</select>
          </div>
          <span class="profile-row-hint" id="profileDateFormatPreview">${Monetra.storage.formatDate(today)}</span>
        </div>
        <div class="profile-row">
          <div class="profile-row-icon">${ICONS.globe}</div>
          <div class="profile-row-label">Language</div>
          <div class="profile-row-value"><select disabled><option>English</option></select></div>
          <span class="profile-row-hint">More soon</span>
        </div>
        <div class="profile-row">
          <div class="profile-row-icon">${ICONS.moon}</div>
          <div class="profile-row-label">Theme</div>
          <div class="profile-row-value"><select disabled><option>Light</option></select></div>
          <span class="profile-row-hint">More soon</span>
        </div>
        <div class="profile-row">
          <div class="profile-row-icon">${ICONS.clock}</div>
          <div class="profile-row-label">Timezone</div>
          <div class="profile-row-value"><select disabled><option>${escape(detectTimezoneLabel())}</option></select></div>
          <span class="profile-row-hint">Detected</span>
        </div>
      </div>

      <div class="card profile-section-card">
        <div class="profile-section-head">
          <div class="profile-section-icon">${ICONS.shield}</div>
          <div><div class="profile-section-title">Security</div><div class="profile-section-sub">Manage your account security</div></div>
        </div>
        <div class="profile-row">
          <div class="profile-row-icon">${ICONS.shield}</div>
          <div class="profile-row-label">${isLoggedIn ? 'Signed in' : 'Not signed in'}</div>
          <div class="profile-row-info">${isLoggedIn
            ? 'Signed in as ' + escape(loggedInUser && loggedInUser.email || '') + '. Your two stock-price API keys (Settings tab) are tied to this account and stay private to it. Everything else you see here is still stored only in this browser.'
            : 'You\'re not logged in to a Monetra account, so the two stock-price API keys on the Settings tab are only saved in this browser. Log in to keep them private to your account.'}</div>
          ${isLoggedIn ? '<button type="button" class="btn btn-ghost btn-sm" id="profileLogoutBtn">Log out</button>' : ''}
        </div>
        <div class="profile-row">
          <div class="profile-row-icon">${ICONS.lock}</div>
          <div class="profile-row-label">Backup your data</div>
          <div class="profile-row-info">Download a full copy of everything you've entered, so you're never dependent on this one browser.</div>
          <button type="button" class="btn btn-ghost btn-sm" id="profileExportBtn">Export</button>
        </div>
      </div>

      <div class="card profile-section-card danger">
        <div class="profile-section-head">
          <div class="profile-section-icon">${ICONS.alertTriangle}</div>
          <div><div class="profile-section-title">Danger zone</div><div class="profile-section-sub">Irreversible and destructive actions</div></div>
        </div>
        <div class="profile-row">
          <div class="profile-row-icon">${ICONS.trash}</div>
          <div class="profile-row-label">Delete account</div>
          <div class="profile-row-info">Permanently deletes every account, transaction, and setting stored in this browser. This can't be undone.</div>
          <button type="button" class="btn btn-danger btn-sm" id="profileDeleteBtn">Delete account</button>
        </div>
      </div>

      <div class="profile-page-footer">${ICONS.lock} ${isLoggedIn ? 'Signed in — your two stock-price API keys sync to your account; everything else here stays in this browser.' : 'Stored only in this browser — nothing is sent to a server unless you log in.'}</div>
    `;

    // ---- Avatar upload: real photo, resized/cropped to a square locally ----
    document.getElementById('profileAvatarBtn').onclick = () => document.getElementById('profileAvatarInput').click();
    document.getElementById('profileAvatarInput').onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (!file.type.startsWith('image/')) { alert('Please choose an image file.'); return; }
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          const size = 240;
          const canvas = document.createElement('canvas');
          canvas.width = size; canvas.height = size;
          const ctx = canvas.getContext('2d');
          const scale = Math.max(size / img.width, size / img.height);
          const w = img.width * scale, h = img.height * scale;
          ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
          state.profile.photo = canvas.toDataURL('image/jpeg', 0.86);
          Monetra.storage.save();
          render();
        };
        img.onerror = () => alert('Could not read that image.');
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    };

    // ---- Pencil buttons just focus the matching field ----
    el.querySelectorAll('.profile-row-edit[data-focus]').forEach((btn) => {
      btn.onclick = () => {
        const input = document.getElementById(btn.dataset.focus);
        if (!input) return;
        input.focus();
        if (input.select) input.select();
      };
    });

    // ---- Default currency: applies immediately, same field used app-wide ----
    document.getElementById('profileCurrency').onchange = (e) => {
      state.settings.displayCurrency = e.target.value;
      Monetra.storage.save();
      Monetra.app.renderAll();
    };

    // ---- Date format: applies immediately and re-renders so Transactions/Debts pick it up ----
    document.getElementById('profileDateFormat').onchange = (e) => {
      state.profile.dateFormat = e.target.value;
      Monetra.storage.save();
      document.getElementById('profileDateFormatPreview').textContent = Monetra.storage.formatDate(today);
      Monetra.app.renderAll();
    };

    // ---- Verify: local-only marker (no backend to actually send an email/SMS) ----
    el.querySelectorAll('[data-verify]').forEach((btn) => {
      btn.onclick = () => {
        const field = btn.dataset.verify;
        const label = field === 'email' ? 'this email address' : 'this mobile number';
        if (!confirm(`Mark ${label} as verified?\n\nMonetra has no server, so no real email or SMS is sent — this just marks it verified for your own record.`)) return;
        state.profile[field === 'email' ? 'emailVerified' : 'mobileVerified'] = true;
        Monetra.storage.save();
        render();
      };
    });

    // ---- Full name/email/mobile: batched, committed on Save changes.
    // Username is fixed and has no input to read. Editing a verified email
    // or mobile invalidates that verification, same as a real app would. ----
    document.getElementById('profileSaveBtn').onclick = () => {
      const newEmail = document.getElementById('profileEmail').value.trim();
      const newCode = document.getElementById('profileMobileCode').value;
      const newMobile = document.getElementById('profileMobile').value.trim();
      if (newEmail !== state.profile.email) state.profile.emailVerified = false;
      if (newCode !== state.profile.mobileCountryCode || newMobile !== state.profile.mobile) state.profile.mobileVerified = false;

      state.profile.fullName = document.getElementById('profileFullName').value.trim();
      state.profile.email = newEmail;
      state.profile.mobileCountryCode = newCode;
      state.profile.mobile = newMobile;
      Monetra.storage.save();
      render();
      alert('Profile updated.');
    };

    // ---- Security & danger zone: real actions, shared with the Settings tab ----
    document.getElementById('profileExportBtn').onclick = () => Monetra.settings.exportData();
    document.getElementById('profileDeleteBtn').onclick = () => Monetra.settings.resetAllData({ redirectTo: 'index.html' });
    const logoutBtn = document.getElementById('profileLogoutBtn');
    if (logoutBtn) logoutBtn.onclick = logout;
  }

  // The one real way to log out — used by both this tab's own "Log out"
  // button and the sidebar's "Log out" button (see js/app.js). Keeping this
  // in one place matters: it's the full list of every account-bound local
  // *cache* that must be wiped so a second account signing in on this same
  // browser never sees the first account's data (the same class of bug
  // already fixed once for the Settings API keys) — anything added to the
  // database in the future needs its cache added here too.
  function logout() {
    const state = Monetra.storage.getState();
    // Wipe this browser's local *cache* of everything account-bound — the
    // two API keys, PayLater, Accounts, Cards, Wallets, the Monthly
    // Planner, Transactions/Templates, Debts, and Investments (not the
    // server copies; those stay saved on your account for next time you log
    // in). Without this, whoever logs in next on this same browser (or just
    // browses logged out) would still see this account's data in things
    // like the Dashboard's net worth total, since it's cached in the same
    // shared local storage this app uses for everything else.
    state.settings.twelveDataApiKey = '';
    state.settings.alphaVantageApiKey = '';
    state.paylaters = [];
    state.accounts = [];
    state.cards = [];
    state.wallets = [];
    state.planner = { months: {} };
    state.transactions = [];
    state.transactionTemplates = [];
    state.debts = [];
    state.investments = [];
    Monetra.storage.save();
    // Only clears the login token/account — the rest of what Monetra stores
    // locally (budgets…) stays in this browser, same as before. Lets a
    // second account sign in afterwards without seeing this account's data.
    Monetra.auth.clearSession();
    // Back to the landing page (which will now show Log in / Sign up again,
    // see index.html), not the login form directly — logging out isn't the
    // same as being asked to log back in.
    window.location.href = 'index.html';
  }

  Monetra.profile = { render, logout };
})();

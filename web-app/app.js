/**
 * Lumina Horizon – Cosplay/Party AI Kiosk
 * app.js  –  Full SPA client logic
 *
 * Pages:  home → setup → capture (×N loop) → lineup → background → transform → result → gallery
 * Admin:  modal login → admin session stored in sessionStorage
 */

'use strict';

// ══════════════════════════════════════════════════════════════════
// 1.  CONSTANTS & STATE
// ══════════════════════════════════════════════════════════════════

const POLL_INTERVAL_MS = 2500;
const ADMIN_TOKEN_KEY  = 'lh_admin_token';
const USER_KEY         = 'lh_user';        // { name, replicateKey, expiresAt } stored in localStorage
const USER_SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours in ms

/** Singleton app state */
const AppState = {
  currentPage:        'home',
  cameraStream:       null,
  capturedImageBlob:  null,   // Blob from canvas
  capturedDataUrl:    null,   // Data URL preview

  cosplayConfig:      null,   // Loaded from /config — { themes, theme_order, characters, backgrounds, max_persons }

  selectedTheme:       null,  // Theme object { key, display_name, mode, icon, ... }
  groupSize:           null,  // 1..max_persons
  persons:             [],    // [{ uploadId, dataUrl, genderPromise, gender, character }] — one per group member
  currentCaptureIndex: 0,     // which person we're currently capturing

  selectedBackground: null,   // relative path e.g. 'backgrounds/palace1.jpg'

  groupId:            null,
  resultToken:        null,
  resultImageUrl:     null,
  resultOrigUrl:       null,
  resultQrCode:        null,   // data-URI returned by server
  resultQrUrl:          null,  // URL encoded in QR

  isAdmin:            false,
  adminToken:         null,

  pollTimer:          null,

  // True when the active camera stream arrives portrait-shaped due to a
  // driver-level CW 90° rotation (e.g. Android kiosk + USB webcam).
  cameraPortraitRotated: false,

  // Camera rotation override: 'auto' | 'force_off' | 'force_ccw'
  // Persisted in localStorage under 'lh_cam_rot'.
  cameraRotationMode: 'force_ccw',

  // Public app settings (from /settings)
  galleryPublic:       true,   // whether non-admin users may access gallery
  replicateConfigured: false, // whether API key is configured on server
};

// Journey step definitions
const JOURNEY_STEPS = [
  { key: 'setup',      num: '01', label: 'setup',      icon: '/icons/destination.svg' },
  { key: 'capture',    num: '02', label: 'capture',    icon: '/icons/capture.svg'     },
  { key: 'lineup',     num: '03', label: 'lineup',     icon: '/icons/styles.svg'      },
  { key: 'background', num: '04', label: 'background', icon: '/icons/countries.svg'   },
  { key: 'transform',  num: '05', label: 'transform',  icon: '/icons/transform.svg'   },
  { key: 'result',     num: '06', label: 'result',     icon: '/icons/result.svg'      },
];

function isStepUnlocked(stepKey) {
  switch (stepKey) {
    case 'setup':      return true;
    case 'capture':    return !!AppState.selectedTheme && !!AppState.groupSize;
    case 'lineup':     return AppState.persons.length > 0 && AppState.persons.every(p => !!p.uploadId);
    case 'background': return AppState.persons.length > 0 && AppState.persons.every(p => !!p.character);
    case 'transform':  return !!AppState.selectedBackground;
    case 'result':     return !!AppState.resultImageUrl;
    default:           return false;
  }
}

function renderJourneyNav(activePage) {
  const nav = document.getElementById('journey-nav');
  if (!nav) return;
  const current = activePage || AppState.currentPage;
  if (current === 'home' || current === 'gallery') {
    // Home / Gallery: hide breadcrumb nav
    nav.style.display = 'none';
    return;
  }
  // Journey page: show step indicators
  nav.style.display = '';
  nav.innerHTML = '';
  JOURNEY_STEPS.forEach(step => {
    const isActive   = step.key === current;
    const isUnlocked = isStepUnlocked(step.key);
    const state      = isActive ? 'active' : (isUnlocked ? 'done' : 'locked');
    const li = document.createElement('li');
    li.className = `journey-step-${state}`;
    li.innerHTML = `
      <span class="step-inner">
        <span class="step-icon"><img src="${step.icon}" alt="${step.label}"/></span>
        <span class="step-dot"></span>
        <span class="step-label">${step.label}</span>
      </span>`;
    nav.appendChild(li);
  });
}

function shakeLockFeedback(stepKey) {
  const nav = document.getElementById('journey-nav');
  if (!nav) return;
  const idx = JOURNEY_STEPS.findIndex(s => s.key === stepKey);
  const items = nav.querySelectorAll('li');
  if (idx >= 0 && items[idx]) {
    items[idx].style.animation = 'none';
    items[idx].offsetHeight;  // force reflow
    items[idx].style.animation = 'journey-lock-shake 0.35s ease';
  }
}

// ══════════════════════════════════════════════════════════════════
// 2.  INITIALISATION
// ══════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', async () => {
  // Restore camera rotation mode
  AppState.cameraRotationMode = localStorage.getItem(CAM_ROT_KEY) || 'force_ccw';

  // Restore admin session if any
  const savedToken = sessionStorage.getItem(ADMIN_TOKEN_KEY);
  if (savedToken) {
    AppState.adminToken = savedToken;
    AppState.isAdmin    = true;
    updateAdminUI();
  }

  // Show home page immediately — never block UI on network calls.
  showPage('home');

  // Start background cycling of home hero image
  startHeroCycle();

  // Check user login — show modal if first visit
  checkUserLogin();

  // Load network-dependent resources after UI is already visible
  await fetchPublicSettings();
  await fetchCosplayConfig();

  // Populate gallery filter now that cosplay config is loaded
  populateGalleryFilter();

  // Load gallery stats for home widget
  loadHomeStats();
});

async function fetchCosplayConfig() {
  try {
    const res = await fetch('/config');
    if (res.ok) {
      AppState.cosplayConfig = await res.json();
      console.info(
        '[LH] Cosplay config loaded:',
        Object.keys(AppState.cosplayConfig.themes || {}).length, 'themes,',
        Object.keys(AppState.cosplayConfig.characters || {}).length, 'characters'
      );
    } else {
      console.warn('[LH] /config returned', res.status);
    }
  } catch (err) {
    console.warn('[LH] Could not load cosplay config:', err.message);
  }
}

// ══════════════════════════════════════════════════════════════════
// 2b.  PUBLIC SETTINGS
// ══════════════════════════════════════════════════════════════════

async function fetchPublicSettings() {
  try {
    const res = await fetch('/settings');
    if (res.ok) {
      const data = await res.json();
      AppState.galleryPublic       = data.gallery_public !== false;
      AppState.replicateConfigured = !!data.replicate_configured;
    }
  } catch {/* best-effort */}
  updateGalleryVisibility();
}

function updateGalleryVisibility() {
  const canSeeGallery = AppState.isAdmin || AppState.galleryPublic;
  ['nav-gallery-link', 'sidebar-gallery-btn', 'home-gallery-btn'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = canSeeGallery ? '' : 'none';
  });
}

// ══════════════════════════════════════════════════════════════════
// 2c.  USER LOGIN  (first-visit, browser cache)
// ══════════════════════════════════════════════════════════════════

function checkUserLogin() {
  const user = getUserFromStorage();
  if (user && user.name) {
    applyUserDisplay(user.name);
  } else {
    // Show first-visit modal (also fires when session has expired)
    document.getElementById('modal-user-login').classList.add('open');
    setTimeout(() => document.getElementById('user-name-input')?.focus(), 150);
  }
}

function getUserFromStorage() {
  try {
    const data = JSON.parse(localStorage.getItem(USER_KEY));
    if (!data) return null;
    // Expire after 24 hours
    if (data.expiresAt && Date.now() > data.expiresAt) {
      localStorage.removeItem(USER_KEY);
      return null;
    }
    return data;
  } catch { return null; }
}

/** Returns the user's saved Replicate key, or null if not set. */
function getUserReplicateKey() {
  const user = getUserFromStorage();
  return (user && user.replicateKey) ? user.replicateKey : null;
}

function applyUserDisplay(name) {
  const display = document.getElementById('user-display');
  const nameEl  = document.getElementById('user-name-display');
  if (display) display.classList.remove('hidden');
  if (nameEl)  nameEl.textContent = name;
}

function saveUserLogin() {
  const nameInput = document.getElementById('user-name-input');
  const pwInput   = document.getElementById('user-password-input');
  const keyInput  = document.getElementById('user-replicate-key-input');
  const errEl     = document.getElementById('user-login-error');
  const name      = nameInput?.value.trim();
  const password  = pwInput?.value;
  const apiKey    = keyInput?.value.trim();
  if (!name) {
    errEl.textContent = 'Please enter your name to continue.';
    errEl.classList.remove('hidden');
    nameInput?.focus();
    return;
  }
  if (!password || password !== 'user') {
    errEl.textContent = 'Incorrect password. Please try again.';
    errEl.classList.remove('hidden');
    pwInput?.select();
    return;
  }
  errEl.classList.add('hidden');
  localStorage.setItem(USER_KEY, JSON.stringify({
    name,
    replicateKey: apiKey,
    expiresAt:    Date.now() + USER_SESSION_TTL,
  }));
  document.getElementById('modal-user-login').classList.remove('open');
  applyUserDisplay(name);
}

function clearUserLogin() {
  localStorage.removeItem(USER_KEY);
  const display = document.getElementById('user-display');
  if (display) display.classList.add('hidden');
  const nameInput = document.getElementById('user-name-input');
  const pwInput   = document.getElementById('user-password-input');
  const keyInput  = document.getElementById('user-replicate-key-input');
  if (nameInput) nameInput.value = '';
  if (pwInput)   pwInput.value   = '';
  if (keyInput)  keyInput.value  = '';
  document.getElementById('user-login-error')?.classList.add('hidden');
  document.getElementById('modal-user-login').classList.add('open');
  setTimeout(() => nameInput?.focus(), 150);
}

// ══════════════════════════════════════════════════════════════════
// 2d.  ADMIN SETTINGS MODAL
// ══════════════════════════════════════════════════════════════════

const CAM_ROT_KEY = 'lh_cam_rot';
let _pendingGalleryPublic = true;
let _pendingCamRot = 'auto';

function setCameraRotationMode(mode) {
  _pendingCamRot = mode;
  // Persist and apply immediately — this is a local-only setting, no server needed.
  AppState.cameraRotationMode = mode;
  localStorage.setItem(CAM_ROT_KEY, mode);
  _syncCamRotButtons(mode);
}

const CAM_ORIENT_KEY = 'lh_cam_orient';

function setCameraOrient(orient) {
  AppState.cameraOrient = orient;
  localStorage.setItem(CAM_ORIENT_KEY, orient);
  _syncCamOrientButtons(orient);
}

function _syncCamOrientButtons(orient) {
  ['portrait', 'landscape'].forEach(o => {
    const btn = document.getElementById('cam-orient-' + o);
    if (!btn) return;
    const active = o === orient;
    btn.classList.toggle('border-cyan-400', active);
    btn.classList.toggle('bg-cyan-400/10',  active);
  });
}

function _syncCamRotButtons(mode) {
  ['auto', 'force_off', 'force_ccw'].forEach(m => {
    const btn = document.getElementById('cam-rot-' + (m === 'force_off' ? 'off' : m === 'force_ccw' ? 'ccw' : 'auto'));
    if (!btn) return;
    const active = m === mode;
    btn.classList.toggle('border-cyan-400', active);
    btn.classList.toggle('bg-cyan-400/10',  active);
  });
}

async function openSettingsModal() {
  if (!AppState.isAdmin) return;
  // Load current settings from server
  try {
    const res = await fetch(`/admin/settings?admin_token=${AppState.adminToken}`);
    if (res.status === 401) {
      _handleStaleAdminToken();
      return;
    }
    if (res.ok) {
      const data = await res.json();
      AppState.galleryPublic        = data.gallery_public !== false;
      AppState.replicateConfigured  = !!data.replicate_configured;
    }
  } catch {/* use existing state */}

  _pendingGalleryPublic = AppState.galleryPublic;
  _syncGalleryPublicButtons(_pendingGalleryPublic);

  // Restore saved rotation mode
  _pendingCamRot = localStorage.getItem(CAM_ROT_KEY) || 'force_ccw';
  _syncCamRotButtons(_pendingCamRot);

  // Restore saved camera orientation
  const _camOrient = localStorage.getItem(CAM_ORIENT_KEY) || 'portrait';
  _syncCamOrientButtons(_camOrient);

  // Show replicate status
  const statusEl = document.getElementById('settings-replicate-status');
  if (statusEl) {
    statusEl.textContent = AppState.replicateConfigured
      ? '✓ API key is configured'
      : '⚠ No API key set – transforms will fail';
    statusEl.className = `text-[10px] font-label mt-1 ${AppState.replicateConfigured ? 'text-primary-container' : 'text-error'}`;
  }
  document.getElementById('settings-replicate-key').value = '';
  document.getElementById('settings-msg')?.classList.add('hidden');
  document.getElementById('modal-settings').classList.add('open');
}

function closeSettingsModal() {
  document.getElementById('modal-settings').classList.remove('open');
}

function setGalleryPublic(val) {
  _pendingGalleryPublic = val;
  _syncGalleryPublicButtons(val);
}

function _syncGalleryPublicButtons(val) {
  const onBtn  = document.getElementById('settings-gallery-on');
  const offBtn = document.getElementById('settings-gallery-off');
  if (onBtn) {
    onBtn.classList.toggle('border-cyan-400', val);
    onBtn.classList.toggle('bg-cyan-400/10',  val);
  }
  if (offBtn) {
    offBtn.classList.toggle('border-error/70',   !val);
    offBtn.classList.toggle('bg-error/10',        !val);
  }
}

function toggleReplicateKeyVisibility() {
  const input = document.getElementById('settings-replicate-key');
  const icon  = document.getElementById('replicate-key-eye');
  if (!input) return;
  if (input.type === 'password') {
    input.type = 'text';
    if (icon) icon.textContent = 'visibility_off';
  } else {
    input.type = 'password';
    if (icon) icon.textContent = 'visibility';
  }
}

async function saveAdminSettings() {
  const msgEl     = document.getElementById('settings-msg');
  const keyVal    = document.getElementById('settings-replicate-key')?.value.trim() || null;
  const payload   = { gallery_public: _pendingGalleryPublic };
  if (keyVal !== null && keyVal !== '') payload.replicate_token = keyVal;

  try {
    const res = await fetch(`/admin/settings?admin_token=${AppState.adminToken}`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    if (res.status === 401) {
      _handleStaleAdminToken();
      return;
    }
    if (!res.ok) throw new Error((await res.json().catch(()=>({}))).detail || 'Save failed');
    const data = await res.json();
    AppState.galleryPublic       = data.settings.gallery_public;
    AppState.replicateConfigured = data.settings.replicate_configured;
    updateGalleryVisibility();
    if (msgEl) {
      msgEl.textContent = '✓ Settings saved successfully.';
      msgEl.className   = 'mb-4 text-xs font-label px-4 py-2 rounded text-primary-container bg-primary-container/10';
      msgEl.classList.remove('hidden');
    }
    // Update status line
    const statusEl = document.getElementById('settings-replicate-status');
    if (statusEl) {
      statusEl.textContent = AppState.replicateConfigured ? '✓ API key is configured' : '⚠ No API key set';
      statusEl.className   = `text-[10px] font-label mt-1 ${AppState.replicateConfigured ? 'text-primary-container' : 'text-error'}`;
    }
    document.getElementById('settings-replicate-key').value = '';
    setTimeout(() => closeSettingsModal(), 1200);
  } catch (err) {
    if (msgEl) {
      msgEl.textContent = `Error: ${err.message}`;
      msgEl.className   = 'mb-4 text-xs font-label px-4 py-2 rounded text-error bg-error-container/20';
      msgEl.classList.remove('hidden');
    }
  }
}

function downloadRetrievalLog() {
  if (!AppState.adminToken) return;
  const url = `/admin/retrieval-log?admin_token=${encodeURIComponent(AppState.adminToken)}`;
  const a = document.createElement('a');
  a.href = url;
  a.download = 'retrieval-log.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

async function resetRetrievalLog() {
  if (!AppState.adminToken) return;
  if (!window.confirm('Delete the entire retrieval log? This cannot be undone.')) return;
  try {
    const res = await fetch(`/admin/retrieval-log?admin_token=${encodeURIComponent(AppState.adminToken)}`, {
      method: 'DELETE',
    });
    if (res.status === 401) { _handleStaleAdminToken(); return; }
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || 'Reset failed');
    const msgEl = document.getElementById('settings-msg');
    if (msgEl) {
      msgEl.textContent = '✓ Retrieval log cleared.';
      msgEl.className = 'mb-4 text-xs font-label px-4 py-2 rounded text-primary-container bg-primary-container/10';
      msgEl.classList.remove('hidden');
      setTimeout(() => msgEl.classList.add('hidden'), 3000);
    }
  } catch (err) {
    alert('Reset failed: ' + err.message);
  }
}

// ══════════════════════════════════════════════════════════════════
// 3.  PAGE NAVIGATION
// ══════════════════════════════════════════════════════════════════

function startNewJourney() {
  // Clear all journey-progress state so breadcrumb locks reset
  AppState.capturedImageBlob   = null;
  AppState.capturedDataUrl     = null;
  AppState.selectedTheme       = null;
  AppState.groupSize           = null;
  AppState.persons             = [];
  AppState.currentCaptureIndex = 0;
  AppState.selectedBackground  = null;
  AppState.groupId             = null;
  AppState.resultToken         = null;
  AppState.resultImageUrl      = null;
  AppState.resultOrigUrl       = null;
  AppState.resultQrCode        = null;
  AppState.resultQrUrl         = null;
  if (AppState.pollTimer) {
    clearInterval(AppState.pollTimer);
    AppState.pollTimer = null;
  }
  const badge = document.getElementById('theme-selected-badge');
  if (badge) badge.style.display = 'none';
  const hcSection = document.getElementById('headcount-section');
  if (hcSection) hcSection.style.display = 'none';
  const nextBtn = document.getElementById('btn-setup-next');
  if (nextBtn) nextBtn.disabled = true;
  navigateTo('setup');
}

function navigateTo(page) {
  // Guard gallery access for non-admin users when gallery is private
  if (page === 'gallery' && !AppState.isAdmin && !AppState.galleryPublic) {
    console.warn('[LH] Gallery is restricted to admin only.');
    return;
  }

  // Guard journey steps — block forward navigation to locked steps
  const journeyKeys = JOURNEY_STEPS.map(s => s.key);
  if (journeyKeys.includes(page) && !isStepUnlocked(page)) {
    shakeLockFeedback(page);
    return;
  }

  const prev = AppState.currentPage;
  AppState.currentPage = page;

  showPage(page);

  // Side effects per page
  if (page === 'setup') {
    renderThemeGrid();
  }

  if (page === 'capture') {
    // Revisiting capture after already finishing the whole group — start over.
    if (AppState.currentCaptureIndex >= (AppState.groupSize || 1)) {
      AppState.currentCaptureIndex = 0;
    }
    startCamera();
    updateCaptureUIForCurrentPerson();
  } else {
    stopCamera();
  }

  if (page === 'lineup' && prev !== 'lineup') {
    renderLineupPage();
  }

  if (page === 'background') {
    renderBackgroundGrid();
  }

  if (page === 'transform' && prev !== 'transform') {
    startTransform();
  }

  if (page === 'gallery') {
    loadGallery();
    startGalleryPoll();
  } else {
    stopGalleryPoll();
  }

  if (page === 'result') {
    renderResultPage();
  }
}

function showPage(pageId) {
  // Use inline style.display — beats Tailwind CDN utility class specificity
  document.querySelectorAll('.app-page').forEach(el => {
    el.style.display = 'none';
  });
  const target = document.getElementById(`page-${pageId}`);
  if (target) target.style.display = 'flex';

  // Render journey breadcrumb
  renderJourneyNav(pageId);

  // Update gallery nav link active state
  const galleryLink = document.getElementById('nav-gallery-link');
  if (galleryLink && galleryLink.style.display !== 'none') {
    galleryLink.className = galleryLink.className
      .replace(/text-cyan-400|text-slate-400|active-nav-glow/g, '')
      .trim();
    galleryLink.className += pageId === 'gallery'
      ? ' text-cyan-400 active-nav-glow'
      : ' text-slate-400 hover:text-white transition-colors';
  }

  // Update sidebar active state
  document.querySelectorAll('.sidebar-item[data-sb]').forEach(el => {
    el.classList.toggle('active', el.dataset.sb === pageId);
  });
}

// ══════════════════════════════════════════════════════════════════
// 4.  HOME PAGE
// ══════════════════════════════════════════════════════════════════

const HOME_BG_IMAGES = [
  '/imgs/cosplay/backgroundpicts-hallo/232458704_m.png',
  '/imgs/cosplay/backgroundpicts-hallo/248025286_m.png',
  '/imgs/cosplay/backgroundpicts-hallo/248973310_m.png',
  '/imgs/cosplay/backgroundpicts-hallo/259633178_m.png',
  '/imgs/cosplay/backgroundpicts-hallo/275588347_m.png',
  '/imgs/cosplay/backgroundpicts-hallo/276301964_m.png',
  '/imgs/cosplay/backgroundpicts-hallo/306105556_m.png',
  '/imgs/cosplay/backgroundpicts-hallo/318676790_m.png',
  '/imgs/cosplay/backgroundpicts-hallo/318678010_m.png',
];
let heroCycleIdx = 0;

function startHeroCycle() {
  const el = document.getElementById('home-bg-img');
  if (!el) return;
  setInterval(() => {
    heroCycleIdx = (heroCycleIdx + 1) % HOME_BG_IMAGES.length;
    el.style.backgroundImage = `url('${HOME_BG_IMAGES[heroCycleIdx]}')`;
  }, 5000);
}

async function loadHomeStats() {
  try {
    const [galleryRes, configRes] = await Promise.all([
      fetch('/gallery?limit=1'),
      fetch('/config'),
    ]);
    const galleryData = await galleryRes.json();
    const configData  = await configRes.json();

    const totalEl = document.getElementById('stat-transformations');
    if (totalEl) totalEl.textContent = galleryData.total > 0 ? galleryData.total.toLocaleString() : '0';

    const themeCount = Object.keys(configData.themes     || {}).length;
    const charCount  = Object.keys(configData.characters || {}).length;

    const destEl   = document.getElementById('stat-destinations');
    const stylesEl = document.getElementById('stat-styles');
    if (destEl)   destEl.textContent   = themeCount > 0 ? themeCount : '0';
    if (stylesEl) stylesEl.textContent = charCount  > 0 ? charCount  : '0';
  } catch {
    const totalEl = document.getElementById('stat-transformations');
    if (totalEl) totalEl.textContent = '0';
  }
}

// ══════════════════════════════════════════════════════════════════
// 5.  SETUP PAGE  (theme + headcount)
// ══════════════════════════════════════════════════════════════════

function renderThemeGrid() {
  const grid = document.getElementById('theme-grid');
  if (!grid) return;

  if (!AppState.cosplayConfig) {
    grid.innerHTML = `<div style="grid-column:1/-1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:60px;gap:10px;opacity:0.5">
      <span class="material-symbols-outlined text-4xl animate-spin">autorenew</span>
      <p style="font-family:'Mulish',sans-serif;font-size:13px">Loading themes…</p>
    </div>`;
    fetchCosplayConfig().then(() => renderThemeGrid());
    return;
  }

  const { themes, theme_order } = AppState.cosplayConfig;
  const order = theme_order || Object.keys(themes);
  grid.innerHTML = '';

  order.forEach(key => {
    const theme = themes[key];
    if (!theme) return;
    const isSelected = AppState.selectedTheme?.key === key;
    const card = document.createElement('div');
    card.className = `dest-card group relative overflow-hidden rounded-xl cursor-pointer
      transition-all duration-500 hover:shadow-[0_4px_30px_rgba(0,229,255,0.12)]
      ${isSelected ? 'border-4 border-[#00e5ff]' : 'border-0'}`;
    card.style.cssText += 'background:#0a0a0a;min-height:260px;display:flex;flex-direction:column;justify-content:center;align-items: center;padding:28px';
    card.onclick = () => selectTheme(key);
    card.innerHTML = `
      <div style="font-size:44px;margin-bottom:10px">${theme.icon || '🎭'}</div>
      <h3 style="font-family:'Mulish',sans-serif;font-size:26px;font-weight:700;color:#fff;margin-bottom:6px">${theme.display_name}</h3>
      <p style="font-family:'Mulish',sans-serif;font-size:12px;color:rgba(255,255,255,0.5);text-align: center;">${theme.tagline || theme.description || ''}</p>
      ${isSelected ? `<div style="position:absolute;top:16px;right:16px;width:32px;height:32px;background:#00e5ff;border-radius:50%;display:flex;align-items:center;justify-content:center"><svg viewBox="0 0 24 24" style="width:16px;height:16px;fill:#000"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg></div>` : ''}
    `;
    grid.appendChild(card);
  });
}

function selectTheme(key) {
  const theme = AppState.cosplayConfig?.themes?.[key];
  if (!theme) return;
  AppState.selectedTheme = theme;

  const badge = document.getElementById('theme-selected-badge');
  if (badge) badge.style.display = '';
  const nameEl = document.getElementById('theme-sel-name');
  if (nameEl) nameEl.textContent = theme.display_name;

  const hcSection = document.getElementById('headcount-section');
  if (hcSection) hcSection.style.display = '';

  renderHeadcountGrid();
  renderThemeGrid();
  updateSetupNextBtn();
}

function renderHeadcountGrid() {
  const grid = document.getElementById('headcount-grid');
  if (!grid) return;
  const max = AppState.cosplayConfig?.max_persons || 4;
  grid.innerHTML = '';
  for (let n = 1; n <= max; n++) {
    const isSelected = AppState.groupSize === n;
    const btn = document.createElement('button');
    btn.textContent = String(n);
    btn.onclick = () => selectHeadcount(n);
    btn.style.cssText = `width:64px;height:64px;border-radius:50%;font-family:'Mulish',sans-serif;font-weight:700;font-size:22px;cursor:pointer;transition:all 0.2s;background:${isSelected ? '#00e5ff' : 'rgba(255,255,255,0.05)'};color:${isSelected ? '#000' : '#fff'};border:1px solid ${isSelected ? '#00e5ff' : 'rgba(255,255,255,0.15)'}`;
    grid.appendChild(btn);
  }
}

function selectHeadcount(n) {
  AppState.groupSize = n;
  renderHeadcountGrid();
  updateSetupNextBtn();
}

function updateSetupNextBtn() {
  const btn = document.getElementById('btn-setup-next');
  if (btn) btn.disabled = !(AppState.selectedTheme && AppState.groupSize);
}

function proceedFromSetup() {
  if (!AppState.selectedTheme || !AppState.groupSize) return;
  AppState.persons = Array.from({ length: AppState.groupSize }, () => ({
    uploadId: null, dataUrl: null, genderPromise: null, gender: null, character: null,
  }));
  AppState.currentCaptureIndex = 0;
  navigateTo('capture');
}

// ══════════════════════════════════════════════════════════════════
// 6.  CAPTURE PAGE
// ══════════════════════════════════════════════════════════════════

function updateCaptureUIForCurrentPerson() {
  const n   = AppState.groupSize || 1;
  const idx = AppState.currentCaptureIndex;
  const subtitle = document.getElementById('capture-page-subtitle');
  if (subtitle) {
    subtitle.textContent = n > 1
      ? `Person ${idx + 1} of ${n} — position yourself in frame`
      : 'Position yourself in frame';
  }
  renderCaptureProgressRow();
  setCaptureHint('live');
  resetContinueButton();
}

/**
 * Drives the #cam-person-hint instruction line under the camera frame.
 * 'live'     — camera is showing, nobody captured yet: tell them to frame up.
 * 'captured' — a photo was just taken: tell them explicitly what Continue
 *              does next (capture the next person, or move on to lineup) —
 *              this is the step that was previously silent and confusing
 *              once a group had more than one person left to capture.
 */
function setCaptureHint(state) {
  const hintEl = document.getElementById('cam-person-hint');
  if (!hintEl) return;
  const n   = AppState.groupSize || 1;
  const idx = AppState.currentCaptureIndex;

  let text, isAction;
  if (state === 'captured') {
    const nextIdx = idx + 1;
    isAction = true;
    text = nextIdx < n
      ? `Nice! Tap Continue to capture Person ${nextIdx + 1} of ${n} →`
      : 'Nice! Tap Continue to see your cast →';
  } else {
    isAction = false;
    text = n > 1
      ? `Position Person ${idx + 1} of ${n} in frame, then tap Capture`
      : 'Position yourself in frame, then tap Capture';
  }

  hintEl.textContent = text;
  hintEl.classList.toggle('hint-action', isAction);
  // Re-trigger the entrance animation on every change so a returning
  // player's eye is drawn to the instruction even if the text is the same.
  hintEl.classList.remove('hint-pop');
  void hintEl.offsetWidth;
  hintEl.classList.add('hint-pop');
}

/** Continue starts disabled/still each visit; capturePhoto()/loadImageFromFile() arm it. */
function resetContinueButton() {
  const btn = document.getElementById('btn-continue-capture');
  if (!btn) return;
  btn.disabled = true;
  btn.classList.remove('btn-ready');
}

function armContinueButton() {
  const btn = document.getElementById('btn-continue-capture');
  if (!btn) return;
  btn.disabled = false;
  btn.classList.add('btn-ready');
}

function renderCaptureProgressRow() {
  const row = document.getElementById('capture-progress-row');
  if (!row) return;
  const n = AppState.groupSize || 1;
  if (n <= 1) { row.innerHTML = ''; return; }
  row.innerHTML = '';
  for (let i = 0; i < n; i++) {
    const done   = i < AppState.currentCaptureIndex;
    const active = i === AppState.currentCaptureIndex;
    const dot = document.createElement('div');
    dot.style.cssText = `width:${active ? 12 : 9}px;height:${active ? 12 : 9}px;border-radius:50%;transition:all 0.2s;background:${done ? '#00e5ff' : active ? 'rgba(0,229,255,0.5)' : 'rgba(255,255,255,0.15)'};border:1px solid ${active ? '#00e5ff' : 'transparent'}`;
    row.appendChild(dot);
  }
}

async function startCamera() {
  document.getElementById('capture-preview').style.display = 'none';
  document.getElementById('camera-video').style.display    = 'block';
  document.getElementById('post-capture-bar').classList.add('hidden');
  document.getElementById('capture-btn-group').style.display = 'flex';
  document.getElementById('cam-status-live').style.display   = 'flex';
  const retakeBtn = document.getElementById('btn-retake');
  if (retakeBtn) retakeBtn.style.display = 'none';

  if (AppState.cameraStream) return; // already running

  try {
    // Step 1: Get permission first so enumerateDevices returns real labels.
    const camOrient = localStorage.getItem('lh_cam_orient') || 'portrait';
    const baseConstraints = camOrient === 'landscape'
      ? { width: { ideal: 1280 }, height: { ideal: 720 } }
      : { width: { ideal: 720 }, height: { ideal: 1280 } };
    let stream = await navigator.mediaDevices.getUserMedia({ video: baseConstraints, audio: false });

    // Step 2: Enumerate devices with populated labels and fill the <select>.
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoDevices = devices.filter(d => d.kind === 'videoinput');
      console.log('[LH] Video devices found:', videoDevices.map(d => `${d.label || d.deviceId}`));

      populateCameraSelect(videoDevices);

      // Current active device
      const currentId = stream.getVideoTracks()[0]?.getSettings()?.deviceId;

      // Check if user previously saved a preferred device
      const savedId = localStorage.getItem('lh_camera_device_id');
      const targetId = savedId || currentId;
      const target = videoDevices.find(d => d.deviceId === targetId);

      if (target && target.deviceId !== currentId) {
        console.log('[LH] Switching to saved/preferred camera:', target.label);
        stream.getTracks().forEach(t => t.stop());
        stream = await navigator.mediaDevices.getUserMedia({
          video: { ...baseConstraints, deviceId: { exact: target.deviceId } },
          audio: false,
        });
      }

      // Sync select to active device
      const activeId = stream.getVideoTracks()[0]?.getSettings()?.deviceId;
      const sel = document.getElementById('camera-select');
      if (sel) sel.value = activeId || '';
      console.log('[LH] Active camera:', stream.getVideoTracks()[0]?.label || 'default');
    } catch (enumErr) {
      console.warn('[LH] Camera enumeration failed:', enumErr.message);
    }

    AppState.cameraStream = stream;
    const video = document.getElementById('camera-video');
    video.srcObject = stream;
    document.getElementById('camera-placeholder')?.classList.add('hidden');

    video.onloadedmetadata = () => applyCameraRotationIfNeeded(video);
  } catch (err) {
    console.error('[LH] Camera init failed:', err);
    const errDiv = document.getElementById('capture-error');
    if (errDiv) {
      errDiv.querySelector('p').textContent = `Camera error: ${err.message}`;
      errDiv.classList.remove('hidden');
    }
  }
}

function populateCameraSelect(videoDevices) {
  const sel = document.getElementById('camera-select');
  if (!sel) return;
  sel.innerHTML = '';
  videoDevices.forEach((d, i) => {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || `Camera ${i + 1}`;
    sel.appendChild(opt);
  });
}

async function switchCamera(deviceId) {
  if (!deviceId) return;
  localStorage.setItem('lh_camera_device_id', deviceId);
  if (AppState.cameraStream) {
    AppState.cameraStream.getTracks().forEach(t => t.stop());
    AppState.cameraStream = null;
  }
  const camOrient = localStorage.getItem('lh_cam_orient') || 'portrait';
  const baseConstraints = camOrient === 'landscape'
    ? { width: { ideal: 1280 }, height: { ideal: 720 } }
    : { width: { ideal: 720 }, height: { ideal: 1280 } };
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { ...baseConstraints, deviceId: { exact: deviceId } },
      audio: false,
    });
    AppState.cameraStream = stream;
    const video = document.getElementById('camera-video');
    video.srcObject = stream;
    video.onloadedmetadata = () => applyCameraRotationIfNeeded(video);
  } catch (err) {
    console.error('[LH] switchCamera failed:', err);
  }
}

function applyCameraRotationIfNeeded(vid) {
  const mode = AppState.cameraRotationMode;
  const camOrient = localStorage.getItem('lh_cam_orient') || 'portrait';
  let shouldRotate;
  if (mode === 'force_ccw') shouldRotate = true;
  else if (mode === 'force_off') shouldRotate = false;
  else shouldRotate = camOrient !== 'portrait' && vid.videoWidth < vid.videoHeight;
  AppState.cameraPortraitRotated = shouldRotate;
  vid.style.transform = shouldRotate ? 'rotate(-90deg)' : '';
  if (shouldRotate) {
    const frame = document.getElementById('camera-frame');
    if (frame) {
      const guardExisting = document.getElementById('camera-crop-guide');
      if (!guardExisting && frame) {
        frame.style.overflow = 'hidden';
      }
    }
  }
}

function stopCamera() {
  if (AppState.cameraStream) {
    AppState.cameraStream.getTracks().forEach(t => t.stop());
    AppState.cameraStream = null;
  }
}

function capturePhoto() {
  const video  = document.getElementById('camera-video');
  const canvas = document.getElementById('capture-canvas');

  const TARGET_SQ = 1024;
  const srcW = video.videoWidth  || TARGET_SQ;
  const srcH = video.videoHeight || TARGET_SQ;
  console.info('[LH] Capture: video dims', srcW, '×', srcH, AppState.cameraPortraitRotated ? '(portrait-rotated)' : '');

  canvas.width  = TARGET_SQ;
  canvas.height = TARGET_SQ;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, TARGET_SQ, TARGET_SQ);

  if (AppState.cameraPortraitRotated) {
    // Camera content needs CCW rotation to look correct.
    const cropSide = Math.min(srcW, srcH);
    const sx = Math.round((srcW - cropSide) / 2);
    const sy = Math.round((srcH - cropSide) / 2);
    ctx.save();
    ctx.translate(TARGET_SQ / 2, TARGET_SQ / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.drawImage(video, sx, sy, cropSide, cropSide, -TARGET_SQ / 2, -TARGET_SQ / 2, TARGET_SQ, TARGET_SQ);
    ctx.restore();
  } else {
    // Normal orientation — centre-crop to square, scale to 1024.
    const cropSide = Math.min(srcW, srcH);
    const sx = Math.round((srcW - cropSide) / 2);
    const sy = Math.round((srcH - cropSide) / 2);
    ctx.drawImage(video, sx, sy, cropSide, cropSide, 0, 0, TARGET_SQ, TARGET_SQ);
  }

  const dataUrl = canvas.toDataURL('image/jpeg', 0.88);
  AppState.capturedDataUrl  = dataUrl;
  AppState.capturedImageBlob = null; // reset; toBlob callback fills it

  // Convert to Blob asynchronously (used by proceedFromCapture)
  canvas.toBlob(blob => {
    if (blob) {
      AppState.capturedImageBlob = blob;
      console.info('[LH] Capture: blob ready', blob.size, 'bytes');
    } else {
      console.warn('[LH] Capture: toBlob returned null – will fall back to dataUrl');
    }
  }, 'image/jpeg', 0.88);

  // Show preview
  const preview = document.getElementById('capture-preview');
  preview.src            = dataUrl;
  preview.style.display  = 'block';
  document.getElementById('camera-video').style.display  = 'none';
  document.getElementById('post-capture-bar').classList.remove('hidden');
  document.getElementById('capture-btn-group').style.display = 'none';
  document.getElementById('cam-status-live').style.display    = 'none';
  const retakeBtnC = document.getElementById('btn-retake');
  if (retakeBtnC) retakeBtnC.style.display = 'flex';
  armContinueButton();
  setCaptureHint('captured');
}

function retakePhoto() {
  AppState.capturedDataUrl  = null;
  AppState.capturedImageBlob = null;
  document.getElementById('capture-preview').style.display = 'none';
  document.getElementById('camera-video').style.display    = 'block';
  document.getElementById('post-capture-bar').classList.add('hidden');
  document.getElementById('capture-btn-group').style.display = 'flex';
  document.getElementById('cam-status-live').style.display    = 'flex';
  const retakeBtnR = document.getElementById('btn-retake');
  if (retakeBtnR) retakeBtnR.style.display = 'none';
  resetContinueButton();
  setCaptureHint('live');
}

function cropImageToSquare(dataUrl, callback) {
  const img = new window.Image();
  img.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 1024;
    const ctx = canvas.getContext('2d');
    const cropSide = Math.min(img.naturalWidth, img.naturalHeight);
    const sx = Math.round((img.naturalWidth  - cropSide) / 2);
    const sy = Math.round((img.naturalHeight - cropSide) / 2);
    ctx.drawImage(img, sx, sy, cropSide, cropSide, 0, 0, 1024, 1024);
    canvas.toBlob(blob => {
      callback(canvas.toDataURL('image/jpeg', 0.88), blob);
    }, 'image/jpeg', 0.88);
  };
  img.src = dataUrl;
}

function loadImageFromFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    cropImageToSquare(e.target.result, (dataUrl, blob) => {
      AppState.capturedDataUrl  = dataUrl;
      AppState.capturedImageBlob = blob;
      const preview = document.getElementById('capture-preview');
      preview.src           = dataUrl;
      preview.style.display = 'block';
      document.getElementById('camera-video').style.display    = 'none';
      document.getElementById('post-capture-bar').classList.remove('hidden');
      document.getElementById('capture-btn-group').style.display = 'none';
      document.getElementById('cam-status-live').style.display    = 'none';
      const retakeBtnF = document.getElementById('btn-retake');
      if (retakeBtnF) retakeBtnF.style.display = 'flex';
      armContinueButton();
      setCaptureHint('captured');
    });
  };
  reader.readAsDataURL(file);
}

async function proceedFromCapture() {
  console.info('[LH] proceedFromCapture: starting, person', AppState.currentCaptureIndex + 1, 'of', AppState.groupSize);

  if (!AppState.capturedDataUrl) {
    alert('Please capture a photo first!');
    return;
  }

  const btn = document.getElementById('btn-continue-capture');
  const origLabel = btn?.innerHTML;
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="material-symbols-outlined text-base animate-spin mr-1" style="display:inline-block">autorenew</span> Uploading…';
  }

  try {
    // Prefer the Blob from toBlob(); fall back to converting the data URL
    let blob = AppState.capturedImageBlob;
    if (!blob) {
      console.info('[LH] Using dataUrl fallback to create blob');
      blob = await dataUrlToBlob(AppState.capturedDataUrl);
    }
    console.info('[LH] Blob ready:', blob.size, 'bytes, type:', blob.type);

    const formData = new FormData();
    formData.append('image', blob, 'capture.jpg');

    console.info('[LH] Sending POST /upload ...');
    const res = await fetch('/upload', { method: 'POST', body: formData });
    console.info('[LH] /upload response status:', res.status);

    if (!res.ok) {
      const errText = await res.text().catch(() => res.statusText);
      throw new Error(`Server ${res.status}: ${errText}`);
    }
    const data = await res.json();
    console.info('[LH] Upload OK – upload_id:', data.upload_id);

    const idx = AppState.currentCaptureIndex;
    AppState.persons[idx].uploadId = data.upload_id;
    AppState.persons[idx].dataUrl  = AppState.capturedDataUrl;

    // Fire gender analysis in background — resolved before the lineup page needs it.
    const analyzeToken = getUserReplicateKey() || '';
    const analyzeUrl = `/analyze-person?upload_id=${data.upload_id}` +
      (analyzeToken ? `&user_replicate_token=${encodeURIComponent(analyzeToken)}` : '');
    AppState.persons[idx].genderPromise = fetch(analyzeUrl, { method: 'POST' })
      .then(r => r.json())
      .then(d => {
        AppState.persons[idx].gender = d.gender;
        console.info('[LH] Gender analysis for person', idx + 1, '—', d.gender, `(${d.status})`);
        return d;
      })
      .catch(e => {
        console.warn('[LH] Gender analysis failed:', e.message);
        AppState.persons[idx].gender = Math.random() < 0.5 ? 'male' : 'female';
        return null;
      });

  } catch (err) {
    console.error('[LH] Upload failed:', err);
    if (btn) { btn.disabled = false; btn.innerHTML = origLabel; }
    const errDiv = document.getElementById('capture-error');
    if (errDiv) {
      errDiv.textContent = `Upload failed: ${err.message}`;
      errDiv.classList.remove('hidden');
      setTimeout(() => errDiv.classList.add('hidden'), 6000);
    } else {
      alert(`Upload failed: ${err.message}`);
    }
    return;
  }

  if (btn) { btn.disabled = false; btn.innerHTML = origLabel; }

  AppState.currentCaptureIndex++;
  if (AppState.currentCaptureIndex < AppState.groupSize) {
    console.info('[LH] Advancing to next person:', AppState.currentCaptureIndex + 1);
    retakePhoto();
    updateCaptureUIForCurrentPerson();
  } else {
    console.info('[LH] All persons captured — navigating to lineup');
    navigateTo('lineup');
  }
}

function dataUrlToBlob(dataUrl) {
  return new Promise(resolve => {
    const [header, b64] = dataUrl.split(',');
    const mime  = header.match(/:(.*?);/)[1];
    const bytes = atob(b64);
    const arr   = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
    resolve(new Blob([arr], { type: mime }));
  });
}

// ══════════════════════════════════════════════════════════════════
// 7.  LINEUP PAGE  (character assignment + reroll)
// ══════════════════════════════════════════════════════════════════

async function renderLineupPage() {
  const grid = document.getElementById('lineup-grid');
  const btn  = document.getElementById('btn-lineup-next');
  if (!grid) return;
  if (btn) btn.disabled = true;

  grid.innerHTML = `<div style="grid-column:1/-1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:60px;gap:10px;opacity:0.5">
    <span class="material-symbols-outlined text-4xl animate-spin">autorenew</span>
    <p style="font-family:'Mulish',sans-serif;font-size:13px">Casting your group…</p>
  </div>`;

  const theme = AppState.selectedTheme;
  for (const person of AppState.persons) {
    if (person.character) continue;
    await (person.genderPromise || Promise.resolve());
    if (!person.gender) person.gender = Math.random() < 0.5 ? 'male' : 'female';
    try {
      const res = await fetch('/assign-character', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ theme_key: theme.key, gender: person.gender }),
      });
      const data = await res.json();
      person.character = data.character;
    } catch (err) {
      console.warn('[LH] assign-character failed:', err.message);
    }
  }

  buildLineupGrid();
  if (btn) btn.disabled = !AppState.persons.every(p => !!p.character);
}

function buildLineupGrid() {
  const grid = document.getElementById('lineup-grid');
  if (!grid) return;
  const theme = AppState.selectedTheme;
  grid.innerHTML = '';

  AppState.persons.forEach((person, idx) => {
    const character = person.character;
    const refThumb = character?.reference_image
      ? `/imgs/cosplay/${character.reference_image.split('/').map(encodeURIComponent).join('/')}`
      : null;

    const card = document.createElement('div');
    card.style.cssText = 'width:46%;min-width:280px;max-width:440px;box-sizing:border-box;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.12);border-radius:14px;padding:14px 12px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;text-align:center;box-shadow:0 6px 20px rgba(0,0,0,0.35);backdrop-filter:blur(6px)';
    card.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:center;gap:14px;width:100%">
        <!-- Captured photo preview -->
        <div style="display:flex;flex-direction:column;align-items:center;gap:4px">
          <div style="width:64px;height:64px;border-radius:10px;overflow:hidden;border:2px solid rgba(255,255,255,0.2);box-shadow:0 4px 12px rgba(0,0,0,0.4);background:#111">
            <img src="${person.dataUrl}" style="width:100%;height:100%;object-fit:cover" alt="Person ${idx + 1}"/>
          </div>
          <span style="font-family:'Mulish',sans-serif;font-size:12px;font-weight:600;color:rgba(255,255,255,0.6);text-transform:uppercase;letter-spacing:0.5px">You</span>
        </div>

        <span style="color:rgba(255,255,255,0.3);font-size:20px;font-weight:bold;user-select:none">→</span>

        <!-- Costume example preview (100x100px) -->
        <div style="display:flex;flex-direction:column;align-items:center;gap:4px">
          ${refThumb
            ? `<div style="width:100px;height:100px;border-radius:10px;overflow:hidden;background:rgba(0,0,0,0.45);border:2px solid var(--accent, #00e5ff);box-shadow:0 4px 16px rgba(0,229,255,0.2);display:flex;align-items:center;justify-content:center">
                 <img src="${refThumb}" style="width:100%;height:100%;object-fit:contain;display:block" alt="${character?.name || 'Costume'}"/>
               </div>`
            : `<div style="width:100px;height:100px;border-radius:10px;background:rgba(0,229,255,0.08);border:2px solid rgba(0,229,255,0.25);display:flex;align-items:center;justify-content:center;font-size:38px;box-shadow:0 4px 16px rgba(0,0,0,0.3)">
                 ${theme?.icon || '🎭'}
               </div>`
          }
          <span style="font-family:'Mulish',sans-serif;font-size:12px;font-weight:700;color:var(--accent, #00e5ff);text-transform:uppercase;letter-spacing:0.5px">Costume Example</span>
        </div>
      </div>

      <div style="margin-top:2px;max-width:92%">
        <p style="font-family:'Mulish',sans-serif;font-weight:700;font-size:22px;color:#fff;margin:0 0 2px;line-height:1.2">${character?.name || '…'}</p>
        <p style="font-family:'Mulish',sans-serif;font-size:14px;color:rgba(255,255,255,0.7);margin:0;line-height:1.3">${character?.source || character?.description || ''}</p>
      </div>

      <button style="display:inline-flex;align-items:center;gap:6px;padding:7px 18px;margin-top:4px;background:rgba(255,255,255,0.08);border:2px solid rgba(255,255,255,0.25);border-radius:20px;font-family:'Mulish',sans-serif;font-weight:600;font-size:16px;color:#fff;cursor:pointer;transition:all 0.15s ease" onmouseover="this.style.background='rgba(0,229,255,0.18)';this.style.borderColor='var(--accent)'" onmouseout="this.style.background='rgba(255,255,255,0.08)';this.style.borderColor='rgba(255,255,255,0.25)'">
        <span>🔀</span> Shuffle
      </button>
    `;
    card.querySelector('button').onclick = () => shuffleCharacter(idx);
    grid.appendChild(card);
  });
}

async function shuffleCharacter(idx) {
  const person = AppState.persons[idx];
  const theme  = AppState.selectedTheme;
  if (!person || !theme) return;
  try {
    const res = await fetch('/assign-character', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        theme_key:     theme.key,
        gender:        person.gender,
        exclude_keys:  person.character ? [person.character.key] : [],
      }),
    });
    const data = await res.json();
    person.character = data.character;
    buildLineupGrid();
  } catch (err) {
    console.warn('[LH] shuffle failed:', err.message);
  }
}

// ══════════════════════════════════════════════════════════════════
// 8.  BACKGROUND PAGE  (scene / location picker)
// ══════════════════════════════════════════════════════════════════

function renderBackgroundGrid() {
  const grid = document.getElementById('background-grid');
  if (!grid) return;
  const theme = AppState.selectedTheme;
  const pool  = AppState.cosplayConfig?.backgrounds?.[theme?.key] || [];
  grid.innerHTML = '';

  pool.forEach(path => {
    const isSelected = AppState.selectedBackground === path;
    const url = `/imgs/cosplay/${path.split('/').map(encodeURIComponent).join('/')}`;
    const tile = document.createElement('div');
    tile.className = 'cursor-pointer relative';
    // Seamless zero-gap mosaic — selection shown via an inset ring (doesn't add
    // to the box size, so it never breaks the flush edge-to-edge tiling).
    tile.style.cssText = `aspect-ratio:1/1;box-shadow:${isSelected ? 'inset 0 0 0 4px #00e5ff' : 'inset 0 0 0 1px rgba(255,255,255,0.08)'};transition:box-shadow 0.2s`;
    tile.onclick = () => selectBackgroundImage(path);
    tile.innerHTML = `
      <img src="${url}" alt="${path}" style="width:100%;height:100%;object-fit:cover;display:block" loading="lazy"/>
      ${isSelected ? `<div style="position:absolute;top:8px;right:8px;width:26px;height:26px;background:#00e5ff;border-radius:50%;display:flex;align-items:center;justify-content:center"><svg viewBox="0 0 24 24" style="width:14px;height:14px;fill:#000"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg></div>` : ''}
    `;
    grid.appendChild(tile);
  });
}

function selectBackgroundImage(path) {
  AppState.selectedBackground = path;
  const btn = document.getElementById('btn-background-next');
  if (btn) btn.disabled = false;
  renderBackgroundGrid();
}

// ══════════════════════════════════════════════════════════════════
// 9.  TRANSFORM PAGE
// ══════════════════════════════════════════════════════════════════

// ── Generic error popup helpers ────────────────────────────────
function showAnalysisPopup(icon, title, body, buttons) {
  document.getElementById('analysis-error-icon').textContent  = icon;
  document.getElementById('analysis-error-title').textContent = title;
  document.getElementById('analysis-error-body').textContent  = body;

  const actionsEl = document.getElementById('analysis-error-actions');
  actionsEl.innerHTML = '';
  buttons.forEach(({ label, primary, onClick }) => {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.className = primary
      ? 'w-full py-3 bg-primary-container text-on-primary-fixed font-headline font-bold uppercase tracking-widest text-sm rounded-lg hover:brightness-110 active:scale-95 transition-all'
      : 'w-full py-3 border border-outline-variant text-on-surface font-headline font-bold text-xs uppercase tracking-widest rounded-lg hover:bg-surface-container-high transition-all';
    btn.addEventListener('click', onClick);
    actionsEl.appendChild(btn);
  });

  document.getElementById('modal-analysis-error').classList.add('open');
}

function hideAnalysisPopup() {
  document.getElementById('modal-analysis-error').classList.remove('open');
}

function renderTransformPersonList() {
  const el = document.getElementById('transform-person-list');
  if (!el) return;
  el.innerHTML = '';
  AppState.persons.forEach((p) => {
    const label = p.character?.name || '…';
    const chip = document.createElement('div');
    chip.id = `transform-person-chip-${p.uploadId}`;
    chip.style.cssText = "display:flex;align-items:center;gap:6px;padding:5px 12px;border-radius:20px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);font-family:'Mulish',sans-serif;font-size:11px;color:rgba(255,255,255,0.6)";
    chip.innerHTML = `<span class="chip-dot" style="width:6px;height:6px;border-radius:50%;background:rgba(255,255,255,0.3);display:inline-block"></span> ${label}`;
    el.appendChild(chip);
  });
}

function updateTransformPersonStatuses(personsStatus) {
  if (!personsStatus) return;
  const colors = { queued: 'rgba(255,255,255,0.3)', processing: '#ffcc66', done: '#00e5ff', error: '#ff6b6b' };
  personsStatus.forEach((ps, i) => {
    const p = AppState.persons[i];
    if (!p) return;
    const chip = document.getElementById(`transform-person-chip-${p.uploadId}`);
    if (!chip) return;
    const dot = chip.querySelector('.chip-dot');
    if (dot) dot.style.background = colors[ps.sub_status] || colors.queued;
  });
}

async function startTransform() {
  // Guard
  if (!AppState.persons.length || !AppState.persons.every(p => p.uploadId)) {
    setTransformError('No photos captured. Please go back to Capture.');
    return;
  }
  if (!AppState.persons.every(p => p.character)) {
    setTransformError('Not everyone has a character yet. Please go back to Lineup.');
    return;
  }

  // Reset UI
  setProgress(5, 'Initialising…', 'Preparing your group…');
  document.getElementById('transform-error-area').classList.add('hidden');
  document.getElementById('transform-result-img').classList.add('hidden');
  document.getElementById('transform-shimmer').classList.remove('hidden');
  document.getElementById('transform-scene-info').textContent = '';

  // Set source preview — first captured person, as a representative thumbnail
  const firstPerson = AppState.persons[0];
  if (firstPerson?.dataUrl) {
    document.getElementById('transform-source-img').src = firstPerson.dataUrl;
  }

  // Set theme + cast label
  const themeName = AppState.selectedTheme?.display_name || 'your theme';
  const castNames = AppState.persons.map(p => p.character?.name).filter(Boolean).join(', ');
  document.getElementById('transform-dest-label').textContent = `${themeName} — ${castNames}`;

  renderTransformPersonList();

  // Call /group-transform
  try {
    setProgress(12, 'Sending to AI…', 'Uploading your group to the transformation engine…');
    const body = {
      theme_key: AppState.selectedTheme.key,
      persons: AppState.persons.map(p => ({
        upload_id:      p.uploadId,
        gender:         p.gender || 'male',
        character_key:  p.character.key,
      })),
      background_image:      AppState.selectedBackground || null,
      session_id:            getSessionId(),
      user_replicate_token:  getUserReplicateKey() || undefined,
    };
    const res = await fetch('/group-transform', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      const detail = err.detail || 'Server error';
      if (res.status === 404 || res.status === 422) {
        showAnalysisPopup(
          '🔄',
          'Recapture Needed',
          detail,
          [{ label: 'Start Over', primary: true, onClick: () => { hideAnalysisPopup(); startNewJourney(); } }],
        );
        return;
      }
      throw new Error(detail);
    }
    const data = await res.json();
    AppState.groupId = data.group_id;
    setProgress(20, 'AI Processing…', 'The AI is casting your group…');
    beginGroupPolling(AppState.groupId);
  } catch (err) {
    setTransformError(`Failed to start transformation: ${err.message}`);
  }
}

function beginGroupPolling(groupId) {
  if (AppState.pollTimer) clearInterval(AppState.pollTimer);

  AppState.pollTimer = setInterval(async () => {
    try {
      const res = await fetch(`/group-status/${groupId}`);
      if (!res.ok) return;
      const job = await res.json();

      setProgress(
        job.progress,
        getPhaseLabel(job.progress),
        getPhaseDetail(job.progress),
      );
      updateTransformPersonStatuses(job.persons);

      if (job.status === 'completed') {
        clearInterval(AppState.pollTimer);
        onGroupTransformComplete(job);
      } else if (job.status === 'error') {
        clearInterval(AppState.pollTimer);
        setTransformError(job.error || 'Transformation failed.');
      }
    } catch (err) {
      console.warn('[LH] Poll error:', err);
    }
  }, POLL_INTERVAL_MS);
}

function getPhaseLabel(pct) {
  if (pct < 15)  return 'Initialising…';
  if (pct < 30)  return 'Connecting to AI…';
  if (pct < 62)  return 'Transforming each person…';
  if (pct < 70)  return 'Building your scene…';
  if (pct < 85)  return 'Blending the group together…';
  if (pct < 100) return 'Saving memory…';
  return 'Done!';
}

function getPhaseDetail(pct) {
  if (pct < 15)  return 'Preparing your photos…';
  if (pct < 30)  return 'Sending your group to the AI…';
  if (pct < 62)  return 'Costuming each person in your cast…';
  if (pct < 70)  return 'Compositing everyone onto the scene…';
  if (pct < 85)  return 'Unifying lighting across the group…';
  if (pct < 100) return 'Generating your QR code…';
  return 'Your transformation is ready!';
}

function setProgress(pct, phase, detail) {
  document.getElementById('transform-pct').textContent          = `${pct}%`;
  document.getElementById('transform-phase').textContent        = phase;
  document.getElementById('transform-detail').textContent       = detail;
  document.getElementById('progress-bar').style.width           = `${pct}%`;
  document.getElementById('transform-status-label').textContent = pct >= 100 ? 'COMPLETE' : 'LIVE PROCESSING';
}

function onGroupTransformComplete(job) {
  AppState.resultToken    = job.token;
  AppState.resultImageUrl = job.result_url;
  AppState.resultOrigUrl  = job.original_url;
  AppState.resultQrCode   = job.qr_code;
  AppState.resultQrUrl    = job.qr_url || `${window.location.origin}/mobile.html?token=${job.token}`;

  setProgress(100, 'Done!', 'Your transformation is ready!');

  // Show result in transform page briefly
  const resultImg = document.getElementById('transform-result-img');
  resultImg.src = job.result_url;
  resultImg.classList.remove('hidden');
  document.getElementById('transform-shimmer').classList.add('hidden');

  // Navigate to result after short delay
  setTimeout(() => navigateTo('result'), 2200);
}

function setTransformError(msg) {
  setProgress(0, 'Error', msg);
  document.getElementById('pulse-ring').classList.remove('animate-ping');
  document.getElementById('transform-status-label').textContent = 'FAILED';
  document.getElementById('transform-error-area').classList.remove('hidden');
  document.getElementById('transform-error-msg').textContent = msg;
}

// ══════════════════════════════════════════════════════════════════
// 10.  RESULT PAGE
// ══════════════════════════════════════════════════════════════════

function renderResultPage() {
  if (!AppState.resultImageUrl) return;

  // AI result image (right panel)
  document.getElementById('result-img').src = AppState.resultImageUrl;

  // Original capture (left panel) — first captured person as representative
  const origImg = document.getElementById('result-orig-img');
  if (origImg) origImg.src = AppState.persons[0]?.dataUrl || AppState.resultOrigUrl || '';

  // Theme + cast label
  const themeName = AppState.selectedTheme?.display_name || '';
  const castNames = AppState.persons.map(p => p.character?.name).filter(Boolean).join(', ');
  document.getElementById('result-dest-label').textContent = [themeName, castNames].filter(Boolean).join(' · ');

  // Token label
  if (AppState.resultToken) {
    document.getElementById('result-token-label').textContent =
      `Token: ${AppState.resultToken.slice(0, 8).toUpperCase()}`;
  }

  // QR Code
  const qrContainer = document.getElementById('qr-code-display');
  qrContainer.innerHTML = '';

  const qrUrl = AppState.resultQrUrl
    || `${window.location.origin}/mobile.html?token=${AppState.resultToken}`;

  try {
    new QRCode(qrContainer, {
      text:         qrUrl,
      width:        160,
      height:       160,
      colorDark:    '#001f24',
      colorLight:   '#ffffff',
      correctLevel: QRCode.CorrectLevel.M,
    });
  } catch (e) {
    // Fallback: use server-provided QR image
    if (AppState.resultQrCode) {
      qrContainer.innerHTML = `<img src="${AppState.resultQrCode}" class="w-40 h-40"/>`;
    }
  }

  // Recent thumbnails
  loadRecentThumbnails();
}

async function loadRecentThumbnails() {
  try {
    const res  = await fetch('/gallery?limit=6');
    const data = await res.json();
    const grid = document.getElementById('result-recent-grid');
    if (!grid) return;
    grid.innerHTML = '';
    (data.items || []).slice(0, 6).forEach(item => {
      const src = `/gallery-files/${item.transformed_file}`;
      const el  = document.createElement('div');
      el.className = 'aspect-square rounded overflow-hidden bg-surface-container-high opacity-60 hover:opacity-100 transition-opacity cursor-pointer';
      el.onclick = () => navigateTo('gallery');
      el.innerHTML = `<img src="${src}" class="w-full h-full object-cover" style="object-position:top" loading="lazy"
                           onerror="this.parentElement.classList.add('hidden')"/>`;
      grid.appendChild(el);
    });
  } catch {/* silent */}
}

function downloadResult() {
  if (!AppState.resultImageUrl) return;
  const a = document.createElement('a');
  a.href     = AppState.resultImageUrl;
  a.download = `lumina-horizon-${AppState.resultToken?.slice(0,8) || 'photo'}.jpg`;
  a.click();
}

function printResult() {
  if (!AppState.resultImageUrl) return;
  printImage(AppState.resultImageUrl);
}

/**
 * Open a minimal print window to print a single image URL.
 */
function printImage(url) {
  const win = window.open('', '_blank', 'width=900,height=700');
  if (!win) return;
  win.document.write(
    '<!DOCTYPE html><html><head><style>' +
    'body{margin:0;padding:0;background:#fff;}' +
    'img{display:block;max-width:100%;max-height:100vh;margin:auto;object-fit:contain;}' +
    '</style></head><body>' +
    `<img src="${url.replace(/"/g, '&quot;')}" onload="window.print();setTimeout(()=>window.close(),600);"/>` +
    '</body></html>'
  );
  win.document.close();
}

// ══════════════════════════════════════════════════════════════════
// 11.  GALLERY PAGE
// ══════════════════════════════════════════════════════════════════

function populateGalleryFilter() {
  if (!AppState.cosplayConfig) return;
  const el = document.getElementById('gallery-filter');
  if (!el) return;
  const { themes, theme_order } = AppState.cosplayConfig;
  const order = theme_order || Object.keys(themes);
  el.innerHTML = '';
  el.dataset.value = '';

  _buildFilterChip('All', '', el);
  order.forEach(key => {
    const t = themes[key];
    if (!t) return;
    _buildFilterChip(`${t.icon || ''} ${t.display_name}`, key, el);
  });
  _syncFilterChips(el, '');
}

function _buildFilterChip(label, value, container) {
  const chip = document.createElement('button');
  chip.textContent = label;
  chip.dataset.filterValue = value;
  chip.style.cssText = "padding:6px 16px;border-radius:20px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.12);font-family:'Mulish',sans-serif;font-size:12px;color:rgba(255,255,255,0.6);cursor:pointer;transition:all 0.2s";
  chip.onclick = () => {
    container.dataset.value = value;
    _syncFilterChips(container, value);
    loadGallery();
  };
  container.appendChild(chip);
  return chip;
}

function _syncFilterChips(container, value) {
  container.querySelectorAll('button').forEach(b => {
    const active = b.dataset.filterValue === value;
    b.style.background   = active ? '#00e5ff' : 'rgba(255,255,255,0.05)';
    b.style.color        = active ? '#000'    : 'rgba(255,255,255,0.6)';
    b.style.borderColor  = active ? '#00e5ff' : 'rgba(255,255,255,0.12)';
  });
}

// ── Gallery auto-poll ────────────────────────────────────────────
let _galleryPollTimer  = null;
let _galleryKnownTotal = -1;

function startGalleryPoll() {
  stopGalleryPoll();
  _galleryPollTimer = setInterval(async () => {
    if (AppState.currentPage !== 'gallery') { stopGalleryPoll(); return; }
    try {
      const theme = document.getElementById('gallery-filter')?.dataset.value || '';
      const res   = await fetch(`/gallery/count?theme=${theme}`);
      const { total } = await res.json();
      if (_galleryKnownTotal >= 0 && total !== _galleryKnownTotal) {
        loadGallery(); // new item arrived — silently refresh
      }
      _galleryKnownTotal = total;
    } catch {/* silent */}
  }, 8000); // poll every 8 s
}

function stopGalleryPoll() {
  if (_galleryPollTimer) { clearInterval(_galleryPollTimer); _galleryPollTimer = null; }
  _galleryKnownTotal = -1;
}

async function loadGallery() {
  const grid          = document.getElementById('gallery-items');
  const emptyEl       = document.getElementById('gallery-empty');
  const loadingEl     = document.getElementById('gallery-loading');
  const adminBar      = document.getElementById('gallery-admin-bar');
  const bulkActions   = document.getElementById('gallery-bulk-actions');
  if (!grid) return;

  loadingEl.classList.remove('hidden');
  grid.innerHTML = '';
  emptyEl.classList.add('hidden');

  const theme = document.getElementById('gallery-filter')?.dataset.value || '';
  const token = AppState.adminToken || '';
  const url  = `/gallery?page=1&limit=30&theme=${theme}&admin_token=${token}`;

  try {
    const res  = await fetch(url);
    const data = await res.json();
    loadingEl.classList.add('hidden');

    // Seed the poll baseline so it only re-renders on genuine new arrivals
    _galleryKnownTotal = data.total ?? _galleryKnownTotal;

    if (data.is_admin) {
      adminBar.classList.remove('hidden');
      if (bulkActions) bulkActions.classList.remove('hidden');
      loadAdminStats();
    } else {
      adminBar.classList.add('hidden');
      if (bulkActions) bulkActions.classList.add('hidden');
    }

    if (!data.items?.length) {
      emptyEl.classList.remove('hidden');
      return;
    }

    data.items.forEach(item => {
      const card = buildGalleryCard(item, data.is_admin);
      grid.appendChild(card);
    });
  } catch {
    loadingEl.classList.add('hidden');
    grid.innerHTML = '<p class="text-outline font-label text-sm col-span-3 text-center py-8">Failed to load gallery.</p>';
  }
}

function buildGalleryCard(item, isAdmin) {
  const src           = `/gallery-files/${item.transformed_file}`;
  const themeName      = item.theme_name || item.destination_name || 'photo';
  const characterNames = (item.characters || []).map(c => c.name).join(', ');
  const filename = `lumina-${themeName}-${(item.token || '').slice(0,8)}.jpg`
    .toLowerCase().replace(/\s+/g, '-');
  const date = item.timestamp
    ? new Date(item.timestamp).toLocaleDateString('en-SG', { month: 'short', day: 'numeric', year: 'numeric' })
    : '';

  const adminBtns = isAdmin
    ? `<div class="relative z-20 mt-2 flex gap-1.5">
        <button class="px-3 py-1.5 bg-surface-container/90 backdrop-blur-sm border border-outline-variant/40 text-on-surface font-headline font-bold text-[10px] uppercase tracking-widest rounded hover:bg-surface-variant transition-all"
          onclick="event.stopPropagation(); downloadGalleryItem('${src}','${filename}')">DOWNLOAD</button>
        <button class="px-3 py-1.5 bg-surface-container/90 backdrop-blur-sm border border-outline-variant/40 text-on-surface font-headline font-bold text-[10px] uppercase tracking-widest rounded hover:bg-surface-variant transition-all"
          onclick="event.stopPropagation(); printImage('${src}')">PRINT</button>
        <button class="px-3 py-1.5 bg-error-container/80 backdrop-blur-sm border border-error/40 text-on-error-container font-headline font-bold text-[10px] uppercase tracking-widest rounded hover:bg-error/30 transition-all"
          onclick="event.stopPropagation(); deleteGalleryItem('${item.id}')">DELETE</button>
      </div>`
    : '';

  const el = document.createElement('div');
  el.className = 'group relative aspect-[1/1] overflow-hidden rounded-xl bg-surface-container-low flex flex-col justify-end p-5 border border-white/5 hover:border-cyan-400/30 transition-all duration-500';
  el.style.cursor = 'pointer';
  el.onclick = () => openGalleryDetail(item, isAdmin);
  el.innerHTML = `
    <img class="absolute inset-0 w-full h-full object-cover opacity-60 group-hover:opacity-85 group-hover:scale-105 transition-all duration-700"
         style="object-position:top" src="${src}" loading="lazy" onerror="this.parentElement.classList.add('hidden')"/>
    <div class="absolute inset-0 bg-gradient-to-t from-black via-transparent to-transparent opacity-85"></div>
    <div class="relative z-10">
      <div class="flex items-center gap-2 mb-1">
        <span class="w-2 h-2 rounded-full bg-cyan-400 ${isAdmin ? 'animate-pulse' : ''}"></span>
        <span class="text-[10px] font-headline font-bold tracking-widest text-cyan-400 uppercase">${themeName}</span>
      </div>
      <p class="text-base font-headline font-bold text-white tracking-tight">${characterNames || '–'}</p>
      <p class="text-[10px] text-slate-400 mt-0.5 uppercase tracking-widest font-label">${date}</p>
      ${isAdmin && item.token ? `<p class="text-[9px] text-outline font-label mt-0.5">Token: ${item.token.slice(0,8).toUpperCase()}</p>` : ''}
      ${adminBtns}
    </div>`;
  return el;
}

async function loadAdminStats() {
  try {
    const res  = await fetch(`/admin/stats?admin_token=${AppState.adminToken}`);
    const data = await res.json();
    const el = document.getElementById('admin-stat-total');
    if (el) el.textContent = `${data.total_transformations} total`;
    const bar = document.getElementById('admin-stat-bar');
    if (bar && data.by_theme) {
      bar.innerHTML = Object.entries(data.by_theme)
        .sort(([,a],[,b]) => b - a)
        .map(([k,v]) => {
          const t = AppState.cosplayConfig?.themes?.[k];
          return `<span class="inline-flex items-center gap-1 text-[10px] font-label text-on-surface-variant mr-3">${t ? t.icon : ''} ${t?.display_name || k}: <strong class="text-white">${v}</strong></span>`;
        }).join('');
    }
  } catch {/* silent */}
}

// ══════════════════════════════════════════════════════════════════
// GALLERY DETAIL POPUP
// ══════════════════════════════════════════════════════════════════

function openGalleryDetail(item, isAdmin) {
  const src = `/gallery-files/${item.transformed_file}`;
  const themeName      = item.theme_name || item.destination_name || 'photo';
  const characterNames = (item.characters || []).map(c => c.name).join(', ');
  const filename = `lumina-${themeName}-${(item.token || '').slice(0,8)}.jpg`
    .toLowerCase().replace(/\s+/g, '-');
  const date = item.timestamp
    ? new Date(item.timestamp).toLocaleDateString('en-SG', { month: 'short', day: 'numeric', year: 'numeric' })
    : '';

  document.getElementById('gallery-detail-img').src           = src;
  document.getElementById('gallery-detail-dest').textContent  = themeName;
  document.getElementById('gallery-detail-style').textContent = characterNames || '–';
  document.getElementById('gallery-detail-date').textContent  = date;

  const tokenEl = document.getElementById('gallery-detail-token');
  tokenEl.textContent = item.token ? `Token: ${item.token.slice(0,8).toUpperCase()}` : '';
  tokenEl.style.display = isAdmin && item.token ? 'block' : 'none';

  // Reset the QR panel — it applies to whichever item was open last.
  document.getElementById('gallery-detail-qr-panel')?.classList.add('hidden');

  const actionsEl = document.getElementById('gallery-detail-actions');
  actionsEl.innerHTML = '';
  if (isAdmin) {
    const btnStyle = `padding:9px 16px;background:none;border:1px solid rgba(255,255,255,0.12);border-radius:5px;font-family:'Mulish',sans-serif;font-weight:500;font-size:11px;color:#fff;cursor:pointer;transition:background 0.2s`;
    const dlBtn = document.createElement('button');
    dlBtn.textContent = '↓ Download';
    dlBtn.setAttribute('style', btnStyle);
    dlBtn.onclick = (e) => { e.stopPropagation(); downloadGalleryItem(src, filename); };
    dlBtn.onmouseover = () => dlBtn.style.background = 'rgba(255,255,255,0.07)';
    dlBtn.onmouseout  = () => dlBtn.style.background = 'none';

    const printBtn = document.createElement('button');
    printBtn.textContent = '⎙ Print';
    printBtn.setAttribute('style', btnStyle);
    printBtn.onclick = (e) => { e.stopPropagation(); printImage(src); };
    printBtn.onmouseover = () => printBtn.style.background = 'rgba(255,255,255,0.07)';
    printBtn.onmouseout  = () => printBtn.style.background = 'none';

    const delBtn = document.createElement('button');
    delBtn.textContent = 'Delete';
    delBtn.setAttribute('style', btnStyle.replace('color:#fff', 'color:#ffb4ab') + ';border-color:rgba(255,100,100,0.25)');
    delBtn.onclick = (e) => { e.stopPropagation(); closeGalleryDetail(); deleteGalleryItem(item.id); };
    delBtn.onmouseover = () => delBtn.style.background = 'rgba(255,100,100,0.10)';
    delBtn.onmouseout  = () => delBtn.style.background = 'none';

    actionsEl.append(dlBtn, printBtn, delBtn);

    if (item.token) {
      const qrBtn = document.createElement('button');
      qrBtn.textContent = '⌸ QR Code';
      qrBtn.setAttribute('style', btnStyle);
      qrBtn.onclick = (e) => { e.stopPropagation(); toggleGalleryQr(item); };
      qrBtn.onmouseover = () => qrBtn.style.background = 'rgba(255,255,255,0.07)';
      qrBtn.onmouseout  = () => qrBtn.style.background = 'none';
      actionsEl.append(qrBtn);
    }
  }

  const modal = document.getElementById('modal-gallery-detail');
  modal.style.display = 'flex';
  // Close on backdrop click
  modal.onclick = (e) => { if (e.target === modal) closeGalleryDetail(); };
}

/**
 * Regenerate the mobile-retrieval QR for a past gallery item so staff can
 * hand it to a guest who missed scanning it right after their transform —
 * same token, same /mobile.html?token= link the result page originally showed.
 */
function toggleGalleryQr(item) {
  const panel = document.getElementById('gallery-detail-qr-panel');
  if (!panel || !item.token) return;

  if (!panel.classList.contains('hidden')) {
    panel.classList.add('hidden');
    return;
  }

  const qrContainer = document.getElementById('gallery-detail-qr-display');
  qrContainer.innerHTML = '';
  const qrUrl = `${window.location.origin}/mobile.html?token=${item.token}`;
  try {
    new QRCode(qrContainer, {
      text:         qrUrl,
      width:        160,
      height:       160,
      colorDark:    '#001f24',
      colorLight:   '#ffffff',
      correctLevel: QRCode.CorrectLevel.M,
    });
  } catch (e) {
    qrContainer.textContent = qrUrl;
  }
  panel.classList.remove('hidden');
}

function closeGalleryDetail() {
  const modal = document.getElementById('modal-gallery-detail');
  if (modal) modal.style.display = 'none';
  document.getElementById('gallery-detail-qr-panel')?.classList.add('hidden');
}

function downloadGalleryItem(url, filename) {
  const a = document.createElement('a');
  a.href     = url;
  a.download = filename || 'lumina-photo.jpg';
  a.click();
}

async function deleteGalleryItem(itemId) {
  if (!AppState.isAdmin) return;
  if (!window.confirm('Delete this image? This cannot be undone.')) return;
  try {
    const res = await fetch(`/admin/gallery/${itemId}?admin_token=${AppState.adminToken}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(await res.text());
    loadGallery();
  } catch (err) {
    alert('Delete failed: ' + err.message);
  }
}

async function downloadAllGallery() {
  if (!AppState.isAdmin) return;
  const a = document.createElement('a');
  a.href     = `/admin/gallery/download-all?admin_token=${AppState.adminToken}`;
  a.download = 'lumina-gallery.zip';
  a.click();
}

async function deleteAllGallery() {
  if (!AppState.isAdmin) return;
  const confirmed = window.confirm(
    'Delete ALL gallery images and entries?\nThis cannot be undone.'
  );
  if (!confirmed) return;
  try {
    const res = await fetch(`/admin/gallery/all?admin_token=${AppState.adminToken}`, {
      method: 'DELETE',
    });
    if (!res.ok) throw new Error((await res.json().catch(()=>({}))).detail || 'Delete failed');
    const data = await res.json();
    alert(`Deleted ${data.deleted_entries} entries and ${data.deleted_files} files.`);
    loadGallery();
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
}

// ══════════════════════════════════════════════════════════════════
// 12.  ADMIN AUTH
// ══════════════════════════════════════════════════════════════════

function _handleStaleAdminToken() {
  // Session expired on the server (e.g. after a redeploy). Clear local state
  // and re-open the admin login modal so the user can log back in.
  AppState.adminToken = null;
  AppState.isAdmin    = false;
  sessionStorage.removeItem(ADMIN_TOKEN_KEY);
  updateAdminUI();
  closeSettingsModal();
  openAdminModal();
  const errEl = document.getElementById('admin-error');
  if (errEl) {
    errEl.textContent = 'Your session has expired. Please log in again.';
    errEl.classList.remove('hidden');
  }
}

function openAdminModal() {
  const loginPanel    = document.getElementById('admin-login-panel');
  const loggedinPanel = document.getElementById('admin-loggedin-panel');
  if (AppState.isAdmin) {
    loginPanel?.classList.add('hidden');
    loggedinPanel?.classList.remove('hidden');
  } else {
    loginPanel?.classList.remove('hidden');
    loggedinPanel?.classList.add('hidden');
    document.getElementById('admin-error').classList.add('hidden');
    setTimeout(() => document.getElementById('admin-username').focus(), 100);
  }
  document.getElementById('modal-admin').classList.add('open');
}

function closeAdminModal() {
  document.getElementById('modal-admin').classList.remove('open');
}

async function doAdminLogin() {
  const username = document.getElementById('admin-username').value.trim();
  const password = document.getElementById('admin-password').value.trim();
  const errEl    = document.getElementById('admin-error');
  errEl.classList.add('hidden');

  if (!username || !password) {
    errEl.textContent = 'Please enter both username and password.';
    errEl.classList.remove('hidden');
    return;
  }

  try {
    const res = await fetch('/admin/login', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ username, password }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || 'Invalid credentials');
    }
    const data = await res.json();
    AppState.adminToken = data.token;
    AppState.isAdmin    = true;
    sessionStorage.setItem(ADMIN_TOKEN_KEY, data.token);
    updateAdminUI();
    closeAdminModal();
    document.getElementById('admin-username').value = '';
    document.getElementById('admin-password').value = '';
    // Refresh gallery visibility and settings with admin view
    await fetchPublicSettings();
    // If on gallery, reload to show admin view
    if (AppState.currentPage === 'gallery') loadGallery();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
}

async function doAdminLogout() {
  if (AppState.adminToken) {
    await fetch(`/admin/logout?admin_token=${AppState.adminToken}`).catch(() => {});
    AppState.adminToken = null;
    AppState.isAdmin    = false;
    sessionStorage.removeItem(ADMIN_TOKEN_KEY);
    updateAdminUI();
    closeAdminModal();
    if (AppState.currentPage === 'gallery') loadGallery();
  }
}

function updateAdminUI() {
  const badge       = document.getElementById('admin-badge');
  const icon        = document.getElementById('profile-icon');
  const settingsBtn = document.getElementById('btn-admin-settings');
  if (AppState.isAdmin) {
    badge?.classList.remove('hidden');
    if (icon) { const img = icon.querySelector('img'); if (img) { img.style.opacity = '1'; img.style.filter = 'invert(1) sepia(1) saturate(5) hue-rotate(155deg)'; } }
    if (settingsBtn) settingsBtn.classList.remove('hidden');
    // Reload gallery visibility — admin override may have changed
    updateGalleryVisibility();
  } else {
    badge?.classList.add('hidden');
    if (icon) { const img = icon.querySelector('img'); if (img) { img.style.opacity = '0.5'; img.style.filter = ''; } }
    if (settingsBtn) settingsBtn.classList.add('hidden');
    updateGalleryVisibility();
  }
}

// Allow pressing Enter in the password field
document.addEventListener('DOMContentLoaded', () => {
  const pwEl = document.getElementById('admin-password');
  if (pwEl) pwEl.addEventListener('keydown', e => { if (e.key === 'Enter') doAdminLogin(); });
  const unEl = document.getElementById('admin-username');
  if (unEl) unEl.addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('admin-password').focus(); });
  // User login modal Enter key — chain: name → password → api key → submit
  const nameEl   = document.getElementById('user-name-input');
  if (nameEl)   nameEl.addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('user-password-input')?.focus(); });
  const userPwEl = document.getElementById('user-password-input');
  if (userPwEl) userPwEl.addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('user-replicate-key-input')?.focus(); });
  const keyEl   = document.getElementById('user-replicate-key-input');
  if (keyEl)    keyEl.addEventListener('keydown', e => { if (e.key === 'Enter') saveUserLogin(); });
});

// ══════════════════════════════════════════════════════════════════
// 13.  UTILITIES
// ══════════════════════════════════════════════════════════════════

function getSessionId() {
  let id = sessionStorage.getItem('lh_session_id');
  if (!id) {
    id = crypto.randomUUID ? crypto.randomUUID()
       : Math.random().toString(36).slice(2) + Date.now().toString(36);
    sessionStorage.setItem('lh_session_id', id);
  }
  return id;
}

function showHelp() {
  alert(
    'Lumina Horizon – How it works:\n\n' +
    '1. SETUP → Pick a theme (Singapore Ghost, Fantasy Halloween, Fries) and how many people are in your group.\n' +
    '2. CAPTURE → Take a photo of each person, one at a time.\n' +
    '3. LINEUP → See who everyone becomes — shuffle for a different character.\n' +
    '4. BACKGROUND → Pick the scene for your group photo.\n' +
    '5. TRANSFORM → Our AI transforms everyone and blends the group into one scene.\n' +
    '6. RESULT → Scan the QR code with your phone to download your personal memory!'
  );
}

// Close modals on outside click
document.getElementById('modal-admin')?.addEventListener('click', e => {
  if (e.target === document.getElementById('modal-admin')) closeAdminModal();
});
document.getElementById('modal-settings')?.addEventListener('click', e => {
  if (e.target === document.getElementById('modal-settings')) closeSettingsModal();
});

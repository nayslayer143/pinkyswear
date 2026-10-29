import {
  debounce,
  formatDateTime,
  getInitials,
  normalizeName,
  safeJsonParse,
  sanitizeRichText,
  stripHtml,
  validateBackup
} from './core.js';
import { documentDB } from './db.js';
import { OfflineSyncService, SyncNotConfiguredError } from './offlineSync.js';
import { seedDefaultTemplates } from './populateTemplates.js';
import { buildTemplateImagePrompt, createWireframeThumbnail, templateThumbnailFingerprint, templateThumbnailSeed } from './templateThumbnails.js';
import { applyTemplateSchemaValues, templateContentToText } from './templateSchema.js';

const PROFILE_KEY = 'pinkyswear.profile.v2';
const SIGNED_OUT_KEY = 'pinkyswear.signed-out';
const SIGNED_OUT_OWNER_KEY = 'pinkyswear.signed-out-owner';
// Shown beside both Google buttons and recorded verbatim with the sign-up (functions/_lib/registry.js).
const SIGNUP_NOTICE = 'Signing in also adds your name and email to the Omega MegaCorp sign-up list, so we may email you about PinkySwear and related Omega products. To be removed, email jordan@asdfghjk.lol.';
const byId = (id) => document.getElementById(id);

class PinkySwearApp {
  constructor() {
    this.currentUser = null;
    this.currentDocumentId = null;
    this.editorSnapshot = '';
    this.photos = [];
    this.photoViewerIndex = null;
    this.cameraStream = null;
    this.facingMode = 'environment';
    this.signaturePad = null;
    this.documentSignatureMode = 'drawn';
    this.pendingSignerName = '';
    this.profileSignaturePad = null;
    this.profileSignatureMode = 'drawn';
    this.platformSession = { authenticated: false, account: null, profile: null };
    this.googleClientId = '';
    this.googleScriptPromise = null;
    this.templateEditor = null;
    this.editingTemplateId = null;
    this.configuredTemplate = null;
    this.generatingTemplateThumbnails = new Set();
    this.currentBrandProfile = null;
    this.currentDocumentBrand = null;
    this.syncService = new OfflineSyncService(documentDB);
  }

  async init() {
    this.bindGlobalEvents();
    this.initializeSignaturePad();
    this.initializeProfileSignaturePad();

    try {
      await documentDB.ready();
      await seedDefaultTemplates();
      await this.loadPlatformSession();
      this.initializeProfile();
      if (this.currentUser?.storageKey) await documentDB.activateOwnerKey(this.currentUser.storageKey);
      this.syncService.endpoint = this.currentUser?.cloud && this.platformSession.authenticated ? '/api/sync' : '';
      if (this.syncService.configured) {
        try { await this.pullRemoteDocuments(); }
        catch (error) { console.warn('Initial cloud sync failed', error); }
      }
      this.syncService.addEventListener('statechange', (event) => this.renderSyncState(event.detail));
      await this.syncService.start();
      await Promise.all([this.renderDocuments(), this.renderTemplates(), this.renderQueue(), this.populateTemplateSelector()]);
      this.registerServiceWorker();
    } catch (error) {
      console.error('Application initialization failed', error);
      this.showToast('The local workspace could not be opened. Check browser storage permissions.', 'error', 7000);
    } finally {
      byId('loading-screen').hidden = true;
    }
  }

  bindGlobalEvents() {
    document.querySelectorAll('[data-view]').forEach((control) => {
      control.addEventListener('click', (event) => {
        event.preventDefault();
        this.navigate(control.dataset.view);
      });
    });

    byId('menu-button').addEventListener('click', () => this.toggleMenu(true));
    byId('close-menu').addEventListener('click', () => this.toggleMenu(false));
    byId('new-document').addEventListener('click', () => this.openDocumentEditor());
    byId('quick-new').addEventListener('click', () => this.openDocumentEditor());
    byId('back-to-documents').addEventListener('click', () => this.closeDocumentEditor());
    byId('save-document').addEventListener('click', () => this.saveDocument(false));
    byId('sign-document').addEventListener('click', () => this.saveDocument(true));
    byId('amend-document').addEventListener('click', () => this.createAmendment());
    byId('document-search').addEventListener('input', debounce((event) => this.renderDocuments(event.target.value)));
    byId('template-category').addEventListener('change', (event) => this.renderTemplates(event.target.value));
    byId('brand-analyze-form').addEventListener('submit', (event) => this.analyzeBrand(event));
    byId('brand-saved-profile').addEventListener('change', (event) => this.loadSavedBrandProfile(event.target.value));
    byId('brand-logo-file').addEventListener('change', (event) => this.handleBrandLogoUpload(event));
    byId('brand-logo-url').addEventListener('input', (event) => this.setBrandLogo(event.target.value));
    byId('brand-template-category').addEventListener('change', () => this.renderBrandTemplateChoices());
    byId('save-brand-profile').addEventListener('click', () => this.saveCurrentBrandProfile());
    byId('generate-brand-batch').addEventListener('click', () => this.generateBrandedBatch());
    byId('template-selector').addEventListener('change', (event) => this.loadTemplateIntoEditor(event.target.value));
    byId('new-template').addEventListener('click', () => this.openTemplateEditor());

    byId('capture-location').addEventListener('click', () => this.captureLocation());
    byId('add-photo').addEventListener('click', () => this.openCamera());
    byId('upload-photo').addEventListener('click', () => byId('photo-file-input').click());
    byId('photo-file-input').addEventListener('change', (event) => this.addPhotoFiles(event));
    byId('close-camera').addEventListener('click', () => this.closeCamera());
    byId('take-photo').addEventListener('click', () => this.capturePhoto());
    byId('switch-camera').addEventListener('click', () => this.switchCamera());
    byId('close-viewer').addEventListener('click', () => this.closeDialog(byId('photo-viewer')));
    byId('delete-photo').addEventListener('click', () => this.deleteViewedPhoto());

    byId('signature-field').addEventListener('click', () => this.openSignaturePad());
    byId('cancel-signature').addEventListener('click', () => this.closeDialog(byId('signature-modal')));
    byId('clear-signature').addEventListener('click', () => this.signaturePad.clear());
    byId('save-signature').addEventListener('click', () => this.saveSignature());
    document.querySelectorAll('[data-document-signature-mode]').forEach((tab) => tab.addEventListener('click', () => this.selectDocumentSignatureMode(tab.dataset.documentSignatureMode)));
    byId('document-signature-text').addEventListener('input', () => {
      byId('document-signature-preview').textContent = byId('document-signature-text').value || 'Your signature';
    });

    byId('export-pdf').addEventListener('click', () => this.exportPdf());
    byId('generate-qr').addEventListener('click', () => this.generateQrCode());
    byId('close-qr').addEventListener('click', () => this.closeDialog(byId('qr-modal')));
    byId('export-backup').addEventListener('click', () => this.exportBackup());
    byId('import-backup').addEventListener('click', () => byId('backup-file-input').click());
    byId('backup-file-input').addEventListener('change', (event) => this.importBackup(event));
    byId('export-spreadsheet').addEventListener('click', () => this.exportSpreadsheet());

    byId('auth-card-trigger').addEventListener('click', () => this.openAccountModal());
    byId('sidebar-profile-trigger').addEventListener('click', () => this.openAccountModal('profile'));
    byId('close-account-modal').addEventListener('click', () => this.closeDialog(byId('account-modal')));
    byId('device-login-form').addEventListener('submit', (event) => this.login(event));
    byId('platform-signin').addEventListener('click', () => this.continueWithPlatformAccount());
    ['google-setup-landing', 'google-setup-modal'].forEach((id) => byId(id).addEventListener('click', () => this.startGoogleSignIn()));
    byId('admin-refresh').addEventListener('click', () => this.loadAdminPanel());
    byId('admin-settings-form').addEventListener('submit', (event) => this.saveAdminSettings(event));
    byId('logout').addEventListener('click', () => this.logout());
    byId('edit-profile').addEventListener('click', () => this.openAccountModal('profile'));
    byId('account-signout').addEventListener('click', () => { this.closeDialog(byId('account-modal')); this.logout(); });
    byId('create-profile-form').addEventListener('submit', (event) => this.createCloudProfile(event));
    byId('cloud-profile-form').addEventListener('submit', (event) => this.saveEditableProfile(event));
    document.querySelectorAll('[data-account-tab]').forEach((tab) => tab.addEventListener('click', () => this.selectAccountTab(tab.dataset.accountTab)));
    byId('account-modal').querySelector('.account-tabs').addEventListener('keydown', (event) => this.handleAccountTabKeys(event));
    document.querySelectorAll('[data-signature-mode]').forEach((tab) => tab.addEventListener('click', () => this.selectProfileSignatureMode(tab.dataset.signatureMode)));
    byId('clear-profile-signature').addEventListener('click', () => this.profileSignaturePad.clear());
    byId('profile-signature-text').addEventListener('input', () => this.updateTypedSignaturePreview());
    byId('profile-signature-style').addEventListener('change', () => this.updateTypedSignaturePreview());
    this.initializeIdentityCardTilt();

    byId('sync-now').addEventListener('click', () => this.syncNow());
    byId('sync-all').addEventListener('click', () => this.syncNow());

    byId('template-editor-form').addEventListener('submit', (event) => this.saveTemplate(event));
    byId('close-template-editor').addEventListener('click', (event) => { event.preventDefault(); this.closeDialog(byId('template-editor-modal')); });
    byId('cancel-template-editor').addEventListener('click', (event) => { event.preventDefault(); this.closeDialog(byId('template-editor-modal')); });
    byId('close-config').addEventListener('click', () => this.closeDialog(byId('template-config-modal')));
    byId('close-config-cancel').addEventListener('click', () => this.closeDialog(byId('template-config-modal')));
    byId('save-config').addEventListener('click', () => this.useConfiguredTemplate());
    byId('close-pdf-preview').addEventListener('click', () => this.closeDialog(byId('pdf-preview-modal')));

    document.querySelectorAll('dialog').forEach((dialog) => {
      dialog.addEventListener('close', () => {
        if (dialog.id === 'camera-modal') this.stopCameraStream();
        if (!document.querySelector('dialog[open]')) document.body.classList.remove('modal-open');
      });
      dialog.addEventListener('click', (event) => {
        if (event.target === dialog) this.closeDialog(dialog);
      });
    });

    window.addEventListener('beforeunload', (event) => {
      if (!byId('document-editor').hidden && this.hasUnsavedChanges()) {
        event.preventDefault();
        event.returnValue = '';
      }
    });
    window.addEventListener('online', () => {
      if (this.syncService.configured) this.pullRemoteDocuments().catch((error) => console.warn('Cloud refresh failed', error));
    });
    window.addEventListener('resize', debounce(() => {
      if (byId('account-modal').open && this.profileSignatureMode === 'drawn') this.resizeProfileSignatureCanvas(false);
    }, 120));
    window.addEventListener('error', (event) => this.auditError(event.error || new Error(event.message)));
    window.addEventListener('unhandledrejection', (event) => this.auditError(event.reason));
  }

  async loadPlatformSession() {
    try {
      const response = await fetch('/api/session', { headers: { Accept: 'application/json' } });
      if (response.ok) this.platformSession = await response.json();
    } catch (error) {
      console.warn('Cloud profile service is not available yet', error);
    }

    if (!this.platformSession.authenticated && window.websim?.getUser) {
      try {
        const account = await window.websim.getUser();
        if (account) {
          this.platformSession = {
            authenticated: true,
            account: {
              username: account.username,
              id: account.id,
              avatarUrl: account.avatar_url || `https://images.websim.com/avatar/${encodeURIComponent(account.username)}`
            },
            profile: null,
            backendUnavailable: true
          };
        }
      } catch {}
    }
    this.updatePlatformAccountUi();
    await this.initializeGoogleSignIn();
  }

  async initializeGoogleSignIn() {
    try {
      const configResponse = await fetch('/api/auth/config', { headers: { Accept: 'application/json' } });
      const config = await configResponse.json();
      this.googleClientId = config.clientId || '';
      const configured = Boolean(this.googleClientId);
      ['google-setup-landing', 'google-setup-modal'].forEach((id) => { byId(id).hidden = configured; });
      byId('google-signin-help').textContent = configured
        ? `Sign in with Google to sync your agreements across devices. ${SIGNUP_NOTICE}`
        : 'Google sign-in needs an OAuth Web client ID. Use the account card for device-only access.';
      byId('google-modal-help').textContent = configured
        ? `Google accounts are verified by the PinkySwear server. ${SIGNUP_NOTICE}`
        : 'Google sign-in will be available when the OAuth client is configured.';
      if (!configured) return;
      await this.loadGoogleIdentityScript();
      const nonceResponse = await fetch('/api/auth/nonce', { headers: { Accept: 'application/json' } });
      const { nonce } = await nonceResponse.json();
      if (!window.google?.accounts?.id || !nonce) throw new Error('Google sign-in is not ready.');
      window.google.accounts.id.initialize({
        client_id: this.googleClientId,
        nonce,
        callback: (response) => this.completeGoogleSignIn(response).catch((error) => this.showToast(error.message, 'error', 6000))
      });
      ['google-signin-landing', 'google-signin-modal'].forEach((id) => {
        byId(id).replaceChildren();
        window.google.accounts.id.renderButton(byId(id), { type: 'standard', theme: 'filled_black', size: 'large', shape: 'pill', text: 'signin_with', width: 320 });
      });
    } catch (error) {
      console.warn('Google sign-in setup is unavailable', error);
      ['google-setup-landing', 'google-setup-modal'].forEach((id) => { byId(id).hidden = false; });
      byId('google-signin-help').textContent = 'Google sign-in could not load. Check the OAuth client configuration and reload.';
      byId('google-modal-help').textContent = 'Google sign-in could not load. Check the OAuth client configuration and reload.';
    }
  }

  loadGoogleIdentityScript() {
    if (window.google?.accounts?.id) return Promise.resolve();
    if (this.googleScriptPromise) return this.googleScriptPromise;
    this.googleScriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.defer = true;
      script.onload = resolve;
      script.onerror = () => reject(new Error('Google sign-in could not be loaded.'));
      document.head.append(script);
    });
    return this.googleScriptPromise;
  }

  async startGoogleSignIn() {
    if (!this.googleClientId) {
      this.showToast('Google sign-in needs an OAuth Web client ID. An @atozenith admin can add it in Admin settings.', 'info', 6500);
      return;
    }
    if (!window.google?.accounts?.id) await this.initializeGoogleSignIn();
    window.google?.accounts?.id?.prompt();
  }

  async completeGoogleSignIn(response) {
    if (!response?.credential) throw new Error('Google did not return a sign-in credential.');
    const result = await fetch('/api/auth/google', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ credential: response.credential })
    });
    const body = await result.json();
    if (!result.ok) throw new Error(body.error || 'Google sign-in failed.');
    this.platformSession = body;
    const sessionResponse = await fetch('/api/session', { headers: { Accept: 'application/json' } });
    if (sessionResponse.ok) this.platformSession = await sessionResponse.json();
    localStorage.removeItem(SIGNED_OUT_KEY);
    const previousOwner = localStorage.getItem(SIGNED_OUT_OWNER_KEY);
    this.currentUser = this.profileFromCloud(this.platformSession.profile);
    if (previousOwner && !previousOwner.startsWith('cloud:')) await documentDB.transferOwnerKey(previousOwner, this.currentUser.storageKey);
    localStorage.removeItem(SIGNED_OUT_OWNER_KEY);
    localStorage.setItem(PROFILE_KEY, JSON.stringify(this.currentUser));
    await documentDB.activateOwnerKey(this.currentUser.storageKey);
    this.syncService.endpoint = '/api/sync';
    this.syncService.schedule(250);
    this.updatePlatformAccountUi();
    this.closeDialog(byId('account-modal'));
    this.showWorkspace();
    await Promise.all([this.renderDocuments(), this.renderQueue()]);
    this.showToast(`Signed in as ${this.platformSession.account.username}.`, 'success');
  }

  async loadAdminPanel() {
    const response = await fetch('/api/admin/overview', { headers: { Accept: 'application/json' } });
    const data = await response.json();
    if (!response.ok) return this.showToast(data.error || 'Admin settings could not be loaded.', 'error');
    const settings = data.settings;
    byId('admin-brand-analysis').checked = settings.brandAnalysisEnabled;
    byId('admin-logo-proxy').checked = settings.logoProxyEnabled;
    byId('admin-document-sync').checked = settings.documentSyncEnabled;
    byId('admin-analysis-pages').value = String(settings.analysisMaxPages);
    byId('admin-google-client-id').value = settings.googleClientId || '';
    this.renderAdminUsers(data);
    const list = byId('admin-audit-list');
    list.replaceChildren();
    if (!data.audit.length) {
      const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = 'No changes recorded yet.'; list.append(empty);
    } else data.audit.forEach((entry) => {
      const row = document.createElement('div'); row.className = 'audit-row';
      const action = document.createElement('strong'); action.textContent = entry.action;
      const details = document.createElement('small');
      try { details.textContent = JSON.stringify(JSON.parse(entry.details_json)); } catch { details.textContent = ''; }
      const time = document.createElement('time'); time.dateTime = entry.created_at; time.textContent = formatDateTime(entry.created_at);
      row.append(action, details, time); list.append(row);
    });
  }

  renderAdminUsers(data) {
    const users = data.users || [];
    byId('admin-users-summary').textContent = `${users.length} profile${users.length === 1 ? '' : 's'} · ${data.googleCount || 0} Google account${data.googleCount === 1 ? '' : 's'} · admins: ${(data.admins || []).map((name) => '@' + name).join(', ')}`;
    const body = byId('admin-users-body');
    body.replaceChildren();
    users.forEach((user) => {
      const row = document.createElement('tr');
      const cells = [
        `${user.display_name} (@${user.username})${user.google_email ? ' · ' + user.google_email : ''}`,
        user.handle, user.role, String(user.documents),
        formatDateTime(user.created_at), user.last_sync ? formatDateTime(user.last_sync) : '—'
      ];
      cells.forEach((text) => { const cell = document.createElement('td'); cell.textContent = text; row.append(cell); });
      body.append(row);
    });
  }

  async saveAdminSettings(event) {
    event.preventDefault();
    const button = byId('admin-save'); button.disabled = true;
    byId('admin-save-status').textContent = 'Saving…';
    const settings = {
      brandAnalysisEnabled: byId('admin-brand-analysis').checked,
      logoProxyEnabled: byId('admin-logo-proxy').checked,
      documentSyncEnabled: byId('admin-document-sync').checked,
      analysisMaxPages: Number(byId('admin-analysis-pages').value),
      googleClientId: byId('admin-google-client-id').value.trim()
    };
    try {
      const response = await fetch('/api/admin/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ settings }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Settings could not be saved.');
      byId('admin-save-status').textContent = 'Saved.';
      await this.loadAdminPanel();
      if (settings.googleClientId !== this.googleClientId) await this.initializeGoogleSignIn();
      this.showToast('API settings saved.', 'success');
    } catch (error) {
      byId('admin-save-status').textContent = error.message;
    } finally { button.disabled = false; }
  }

  initializeProfile() {
    const signedOut = localStorage.getItem(SIGNED_OUT_KEY) === 'true';
    const modern = safeJsonParse(localStorage.getItem(PROFILE_KEY));
    const legacy = safeJsonParse(localStorage.getItem('currentUser'));
    const candidate = !signedOut && this.platformSession.profile
      ? this.profileFromCloud(this.platformSession.profile)
      : (signedOut ? null : this.normalizeStoredProfile(modern || legacy));
    localStorage.removeItem('currentUser');

    if (!candidate?.name) {
      this.updateLandingCard();
      return this.showLogin();
    }
    this.currentUser = candidate;
    if (!candidate.cloud) {
      const registryKey = 'pinkyswear.device-owners.v1';
      const owners = safeJsonParse(localStorage.getItem(registryKey), {}) || {};
      owners[candidate.name.toLocaleLowerCase()] = candidate.storageKey;
      localStorage.setItem(registryKey, JSON.stringify(owners));
    }
    localStorage.setItem(PROFILE_KEY, JSON.stringify(this.currentUser));
    this.showWorkspace();
  }

  profileFromCloud(profile) {
    return {
      name: normalizeName(profile.displayName),
      handle: String(profile.handle || '').toLowerCase(),
      role: normalizeName(profile.role) || 'Field Agent',
      bio: String(profile.bio || '').slice(0, 280),
      storageKey: `cloud:${this.platformSession.account?.id || this.platformSession.account?.username || profile.username}`,
      username: profile.username || this.platformSession.account?.username || '',
      avatarUrl: profile.avatarUrl || this.platformSession.account?.avatarUrl || '',
      signatureMode: profile.signatureMode || 'none',
      signatureText: profile.signatureText || '',
      signatureStyle: profile.signatureStyle || 'classic',
      signatureStrokes: Array.isArray(profile.signatureStrokes) ? profile.signatureStrokes : [],
      cloud: true
    };
  }

  normalizeStoredProfile(candidate) {
    if (!candidate?.name) return null;
    const name = normalizeName(candidate.name);
    let handle = String(candidate.handle || name.toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '')).toLowerCase();
    handle = handle.replace(/[^a-z0-9._-]/g, '').slice(0, 24);
    if (handle.length < 3) handle = `${handle || 'user'}.local`.slice(0, 24);
    return {
      name,
      handle,
      role: candidate.role && candidate.role !== 'read-only' ? String(candidate.role).slice(0, 80) : 'Field Agent',
      bio: String(candidate.bio || '').slice(0, 280),
      username: String(candidate.username || ''),
      avatarUrl: String(candidate.avatarUrl || ''),
      signatureMode: candidate.signatureMode || 'none',
      signatureText: String(candidate.signatureText || ''),
      signatureStyle: candidate.signatureStyle || 'classic',
      signatureStrokes: Array.isArray(candidate.signatureStrokes) ? candidate.signatureStrokes : [],
      storageKey: String(candidate.storageKey || `device:${crypto.randomUUID?.() || Date.now()}`),
      cloud: Boolean(candidate.cloud)
    };
  }

  deviceOwnerKey(name) {
    const registryKey = 'pinkyswear.device-owners.v1';
    const owners = safeJsonParse(localStorage.getItem(registryKey), {}) || {};
    const identity = normalizeName(name).toLocaleLowerCase();
    owners[identity] ||= `device:${crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
    localStorage.setItem(registryKey, JSON.stringify(owners));
    return owners[identity];
  }

  async login(event) {
    event.preventDefault();
    const name = normalizeName(byId('user-name').value);
    if (!name) {
      byId('user-name').focus();
      return this.showToast('Enter your name to continue.', 'warning');
    }
    this.currentUser = this.normalizeStoredProfile({ name, role: 'Field Agent', storageKey: this.deviceOwnerKey(name) });
    localStorage.removeItem(SIGNED_OUT_KEY);
    localStorage.removeItem(SIGNED_OUT_OWNER_KEY);
    localStorage.setItem(PROFILE_KEY, JSON.stringify(this.currentUser));
    await documentDB.activateOwnerKey(this.currentUser.storageKey);
    this.closeDialog(byId('account-modal'));
    this.showWorkspace();
    await Promise.all([this.renderDocuments(), this.renderQueue()]);
    documentDB.createUser({ username: name, role: 'Field Agent' }).catch(() => {});
    documentDB.saveAudit({ eventType: 'profile.open', actor: name, objectType: 'profile', objectId: null }).catch(() => {});
    this.showToast(`Welcome, ${name}.`, 'success');
  }

  async continueWithPlatformAccount() {
    if (!this.platformSession.authenticated) {
      return this.showToast('Sign in from the Websim account menu, then return here and try again.', 'info', 6500);
    }
    if (this.platformSession.profile) {
      const previousOwner = localStorage.getItem(SIGNED_OUT_OWNER_KEY);
      localStorage.removeItem(SIGNED_OUT_KEY);
      this.currentUser = this.profileFromCloud(this.platformSession.profile);
      if (previousOwner && !previousOwner.startsWith('cloud:')) await documentDB.transferOwnerKey(previousOwner, this.currentUser.storageKey);
      localStorage.removeItem(SIGNED_OUT_OWNER_KEY);
      localStorage.setItem(PROFILE_KEY, JSON.stringify(this.currentUser));
      await documentDB.activateOwnerKey(this.currentUser.storageKey);
      this.syncService.endpoint = '/api/sync';
      this.syncService.schedule(250);
      this.closeDialog(byId('account-modal'));
      this.showWorkspace();
      await Promise.all([this.renderDocuments(), this.renderQueue()]);
      return;
    }
    const username = this.platformSession.account.username;
    byId('create-display-name').value ||= username;
    byId('create-handle').value ||= username.toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 24);
    this.selectAccountTab('create');
  }

  async logout() {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    const actor = this.currentUser?.name;
    if (this.currentUser?.storageKey) localStorage.setItem(SIGNED_OUT_OWNER_KEY, this.currentUser.storageKey);
    localStorage.setItem(SIGNED_OUT_KEY, 'true');
    this.currentUser = null;
    documentDB.ownerKey = null;
    this.syncService.endpoint = '';
    this.platformSession = { authenticated: false, account: null, profile: null, isAdmin: false };
    this.updatePlatformAccountUi();
    window.currentUser = null;
    byId('app').hidden = true;
    byId('login-form').hidden = false;
    byId('user-name').value = '';
    this.updateLandingCard();
    documentDB.saveAudit({ eventType: 'profile.close', actor, objectType: 'profile', objectId: null }).catch(() => {});
  }

  showLogin() {
    byId('login-form').hidden = false;
    byId('app').hidden = true;
    this.updateLandingCard();
  }

  showWorkspace() {
    window.currentUser = this.currentUser;
    byId('login-form').hidden = true;
    byId('app').hidden = false;
    this.updateProfileUi();
  }

  updateProfileUi() {
    if (!this.currentUser) return;
    const initials = getInitials(this.currentUser.name);
    ['user-initials', 'settings-user-initials'].forEach((id) => this.setAvatar(byId(id), this.currentUser.avatarUrl, initials));
    ['user-name-display', 'settings-user-name'].forEach((id) => { byId(id).textContent = this.currentUser.name; });
    ['user-role-display', 'settings-user-role'].forEach((id) => { byId(id).textContent = this.currentUser.role; });
    byId('settings-user-handle').firstChild.textContent = `@${this.currentUser.handle || 'device'} · `;
    this.renderProfileSignature(byId('settings-profile-signature'), this.currentUser);
    this.updateLandingCard();
  }

  updateLandingCard() {
    const profile = this.currentUser || (this.platformSession.profile ? this.profileFromCloud(this.platformSession.profile) : null);
    const accountName = this.platformSession.account?.username;
    const name = profile?.name || accountName || 'Your profile';
    const handle = profile?.handle ? `@${profile.handle}` : (accountName ? `@${accountName} · profile ready to create` : 'Tap to sign in or create one');
    byId('landing-user-name').textContent = name;
    byId('landing-user-handle').textContent = handle;
    this.setAvatar(byId('landing-user-avatar'), profile?.avatarUrl || this.platformSession.account?.avatarUrl, getInitials(name));
    this.renderProfileSignature(byId('landing-card-signature'), profile || { name: 'PinkySwear', signatureMode: 'typed', signatureText: 'PinkySwear', signatureStyle: 'classic' });
  }

  setAvatar(element, url, initials) {
    element.replaceChildren();
    if (url) {
      const image = document.createElement('img');
      image.src = url;
      image.alt = '';
      image.addEventListener('error', () => { element.textContent = initials; }, { once: true });
      element.append(image);
    } else element.textContent = initials;
  }

  renderProfileSignature(element, profile) {
    element.replaceChildren();
    element.classList.remove('signature-classic', 'signature-editorial', 'signature-minimal');
    if (profile.signatureMode === 'drawn' && profile.signatureStrokes?.length) {
      const image = document.createElement('img');
      image.className = 'profile-signature-image';
      image.src = this.createDrawnSignaturePreview(profile.signatureStrokes);
      image.alt = 'Profile signature';
      element.append(image);
      return;
    }
    element.classList.add(`signature-${profile.signatureStyle || 'classic'}`);
    element.textContent = profile.signatureText || profile.name || 'PinkySwear';
  }

  createDrawnSignaturePreview(strokes) {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 200;
    const pad = new SignaturePad(canvas, { penColor: '#ffd3e3', minWidth: 1, maxWidth: 3 });
    pad.fromData(strokes);
    return pad.toDataURL('image/png');
  }

  updatePlatformAccountUi() {
    const account = this.platformSession.account;
    byId('platform-account-name').textContent = account ? (this.platformSession.provider === 'google' ? account.username : `@${account.username}`) : 'No account detected';
    byId('platform-account-detail').textContent = account
      ? (this.platformSession.profile ? `Signed in with ${this.platformSession.provider === 'google' ? 'Google' : 'Websim'} · cloud profile ready.` : 'Authenticated account found. Create your PinkySwear profile next.')
      : 'Sign in with Google or Websim to create a cloud profile.';
    byId('platform-account-badge').textContent = account ? 'Verified' : 'Signed out';
    byId('platform-account-badge').classList.toggle('synced', Boolean(account));
    byId('platform-account-avatar').src = account?.avatarUrl || './icon.svg';
    byId('platform-signin').hidden = !window.websim?.getUser;
    byId('platform-signin').textContent = account ? (this.platformSession.profile ? 'Open cloud profile' : 'Continue as @' + account.username) : 'Continue with Websim';
    byId('admin-nav').hidden = !this.platformSession.isAdmin;
    byId('create-profile-submit').disabled = !account || this.platformSession.backendUnavailable;
    byId('create-profile-help').textContent = this.platformSession.backendUnavailable
      ? 'Cloud profile storage becomes available after the project backend is published.'
      : (account ? 'Creating the cloud profile also enables sync for agreements in this browser.' : 'You must be signed into Websim to create a cloud profile.');
    this.updateLandingCard();
  }

  openAccountModal(preferredTab = null) {
    const tab = preferredTab || (this.currentUser ? 'profile' : 'signin');
    this.selectAccountTab(tab);
    this.populateEditableProfile();
    this.openDialog(byId('account-modal'));
    if (tab === 'profile') requestAnimationFrame(() => this.resizeProfileSignatureCanvas(true));
  }

  selectAccountTab(name) {
    if (!['signin', 'create', 'profile'].includes(name)) return;
    document.querySelectorAll('[data-account-tab]').forEach((tab) => {
      const selected = tab.dataset.accountTab === name;
      tab.classList.toggle('active', selected);
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });
    document.querySelectorAll('[data-account-panel]').forEach((panel) => { panel.hidden = panel.dataset.accountPanel !== name; });
    if (name === 'profile') requestAnimationFrame(() => this.resizeProfileSignatureCanvas(true));
  }

  handleAccountTabKeys(event) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tabs = [...document.querySelectorAll('[data-account-tab]')];
    const current = tabs.findIndex((tab) => tab.getAttribute('aria-selected') === 'true');
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    this.selectAccountTab(tabs[next].dataset.accountTab);
    tabs[next].focus();
  }

  async createCloudProfile(event) {
    event.preventDefault();
    if (!this.platformSession.authenticated || this.platformSession.backendUnavailable) return this.showToast('Cloud profiles require an available signed-in Websim session.', 'warning');
    const payload = {
      displayName: normalizeName(byId('create-display-name').value),
      handle: byId('create-handle').value.trim().toLowerCase(),
      role: normalizeName(byId('create-role').value) || 'Field Agent',
      bio: byId('create-bio').value.trim(),
      signatureMode: 'none', signatureText: '', signatureStyle: 'classic', signatureStrokes: []
    };
    await this.persistCloudProfile(payload, byId('create-profile-submit'));
  }

  populateEditableProfile() {
    const profile = this.currentUser || (this.platformSession.profile ? this.profileFromCloud(this.platformSession.profile) : null);
    const account = this.platformSession.account;
    byId('profile-display-name').value = profile?.name || account?.username || '';
    byId('profile-handle').value = profile?.handle || account?.username?.toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 24) || '';
    byId('profile-role').value = profile?.role || 'Field Agent';
    byId('profile-bio').value = profile?.bio || '';
    byId('profile-account-username').textContent = account ? `@${account.username}` : 'Device profile';
    byId('profile-cloud-status').textContent = profile?.cloud ? 'Synced cloud profile' : 'Saved on this device';
    byId('profile-avatar').src = profile?.avatarUrl || account?.avatarUrl || './icon.svg';
    byId('profile-signature-text').value = profile?.signatureText || profile?.name || '';
    byId('profile-signature-style').value = profile?.signatureStyle || 'classic';
    this.profileSignatureMode = profile?.signatureMode === 'typed' ? 'typed' : 'drawn';
    this.selectProfileSignatureMode(this.profileSignatureMode);
    this.pendingProfileStrokes = profile?.signatureStrokes || [];
    this.updateTypedSignaturePreview();
  }

  async saveEditableProfile(event) {
    event.preventDefault();
    const displayName = normalizeName(byId('profile-display-name').value);
    const handle = byId('profile-handle').value.trim().toLowerCase();
    if (!displayName) return this.showToast('Display name is required.', 'warning');
    if (!/^[a-z0-9][a-z0-9._-]{2,23}$/.test(handle)) return this.showToast('Handle must be 3–24 valid characters.', 'warning');

    const drawn = this.profileSignatureMode === 'drawn' && !this.profileSignaturePad.isEmpty();
    const signatureText = byId('profile-signature-text').value.trim();
    const typed = this.profileSignatureMode === 'typed' && signatureText;
    const payload = {
      displayName, handle,
      role: normalizeName(byId('profile-role').value) || 'Field Agent',
      bio: byId('profile-bio').value.trim().slice(0, 280),
      signatureMode: drawn ? 'drawn' : typed ? 'typed' : 'none',
      signatureText: typed ? signatureText : '',
      signatureStyle: byId('profile-signature-style').value,
      signatureStrokes: drawn ? this.profileSignaturePad.toData() : []
    };

    // A local profile is never promoted implicitly just because a Websim session exists.
    // Cloud creation is an explicit action in the Create profile tab.
    if (this.currentUser?.cloud && this.platformSession.authenticated && !this.platformSession.backendUnavailable) {
      await this.persistCloudProfile(payload, byId('save-cloud-profile'));
      return;
    }
    this.currentUser = this.normalizeStoredProfile({ ...payload, name: payload.displayName, cloud: false, storageKey: this.currentUser?.storageKey });
    localStorage.setItem(PROFILE_KEY, JSON.stringify(this.currentUser));
    this.updateProfileUi();
    this.closeDialog(byId('account-modal'));
    this.showToast('Profile and signature saved on this device.', 'success');
  }

  async persistCloudProfile(payload, button) {
    button.disabled = true;
    const originalText = button.textContent;
    button.textContent = 'Saving…';
    try {
      const response = await fetch('/api/profile', {
        method: 'PUT', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(payload)
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Profile could not be saved.');
      const previousOwner = this.currentUser?.storageKey || localStorage.getItem(SIGNED_OUT_OWNER_KEY);
      this.platformSession.profile = result.profile;
      localStorage.removeItem(SIGNED_OUT_KEY);
      this.currentUser = this.profileFromCloud(result.profile);
      if (previousOwner && !previousOwner.startsWith('cloud:')) {
        await documentDB.transferOwnerKey(previousOwner, this.currentUser.storageKey);
      }
      localStorage.removeItem(SIGNED_OUT_OWNER_KEY);
      await documentDB.activateOwnerKey(this.currentUser.storageKey);
      this.syncService.endpoint = '/api/sync';
      this.syncService.schedule(250);
      localStorage.setItem(PROFILE_KEY, JSON.stringify(this.currentUser));
      this.updatePlatformAccountUi();
      this.updateProfileUi();
      this.showWorkspace();
      await Promise.all([this.renderDocuments(), this.renderQueue()]);
      this.selectAccountTab('profile');
      this.populateEditableProfile();
      this.showToast('Cloud profile saved.', 'success');
    } catch (error) {
      this.showToast(error.message, 'error', 6500);
    } finally {
      button.disabled = false;
      button.textContent = originalText;
    }
  }

  initializeProfileSignaturePad() {
    this.profileSignaturePad = new SignaturePad(byId('profile-signature-canvas'), { penColor: '#f7f4f5', minWidth: 0.8, maxWidth: 2.5 });
  }

  resizeProfileSignatureCanvas(loadPending = false) {
    const canvas = byId('profile-signature-canvas');
    if (!canvas.clientWidth || !canvas.clientHeight) return;
    const existing = loadPending && this.pendingProfileStrokes ? this.pendingProfileStrokes : this.profileSignaturePad.toData();
    const ratio = Math.max(window.devicePixelRatio || 1, 1);
    canvas.width = Math.floor(canvas.clientWidth * ratio);
    canvas.height = Math.floor(canvas.clientHeight * ratio);
    canvas.getContext('2d').scale(ratio, ratio);
    this.profileSignaturePad.clear();
    if (existing?.length) this.profileSignaturePad.fromData(existing);
    this.pendingProfileStrokes = null;
  }

  selectProfileSignatureMode(mode) {
    this.profileSignatureMode = mode === 'typed' ? 'typed' : 'drawn';
    document.querySelectorAll('[data-signature-mode]').forEach((tab) => {
      const selected = tab.dataset.signatureMode === this.profileSignatureMode;
      tab.classList.toggle('active', selected);
      tab.setAttribute('aria-selected', String(selected));
    });
    byId('profile-signature-drawn').hidden = this.profileSignatureMode !== 'drawn';
    byId('profile-signature-typed').hidden = this.profileSignatureMode !== 'typed';
    if (this.profileSignatureMode === 'drawn') requestAnimationFrame(() => this.resizeProfileSignatureCanvas(true));
  }

  updateTypedSignaturePreview() {
    const preview = byId('typed-signature-preview');
    preview.classList.remove('signature-classic', 'signature-editorial', 'signature-minimal');
    preview.classList.add(`signature-${byId('profile-signature-style').value}`);
    preview.textContent = byId('profile-signature-text').value.trim() || 'Your signature';
  }

  initializeIdentityCardTilt() {
    const card = byId('auth-card-trigger');
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    card.addEventListener('pointermove', (event) => {
      const bounds = card.getBoundingClientRect();
      const x = (event.clientX - bounds.left) / bounds.width;
      const y = (event.clientY - bounds.top) / bounds.height;
      card.style.setProperty('--rx', `${(0.5 - y) * 10}deg`);
      card.style.setProperty('--ry', `${(x - 0.5) * 12}deg`);
      card.style.setProperty('--mx', `${x * 100}%`);
      card.style.setProperty('--my', `${y * 100}%`);
    });
    card.addEventListener('pointerleave', () => {
      card.style.setProperty('--rx', '0deg');
      card.style.setProperty('--ry', '0deg');
    });
  }

  navigate(viewName) {
    if (!['documents', 'templates', 'brand', 'my-templates', 'queue', 'settings', 'admin'].includes(viewName)) return;
    if (viewName === 'admin' && !this.platformSession.isAdmin) return;
    document.querySelectorAll('.view-section').forEach((view) => { view.hidden = true; });
    byId(`${viewName}-view`).hidden = false;
    document.querySelectorAll('[data-view]').forEach((control) => control.classList.toggle('active', control.dataset.view === viewName));
    this.toggleMenu(false);
    byId('main-content').focus({ preventScroll: true });
    if (viewName === 'documents') this.renderDocuments(byId('document-search').value);
    if (viewName === 'templates') this.renderTemplates(byId('template-category').value);
    if (viewName === 'brand') { this.renderBrandProfiles(); this.renderBrandTemplateChoices(); }
    if (viewName === 'my-templates') this.renderMyTemplates();
    if (viewName === 'queue') this.renderQueue();
    if (viewName === 'admin') this.loadAdminPanel();
  }

  toggleMenu(open) {
    byId('main-menu').classList.toggle('open', open);
    byId('menu-button').setAttribute('aria-expanded', String(open));
  }

  async renderDocuments(query = '') {
    const container = byId('documents-list');
    container.setAttribute('aria-busy', 'true');
    try {
      const documents = await documentDB.getDocuments(query);
      container.replaceChildren();
      if (!documents.length) {
        container.append(this.emptyState(query ? 'No matching documents' : 'No documents yet', query ? 'Try a different search.' : 'Create your first agreement and capture a signature.', query ? null : 'New document'));
        return;
      }
      documents.forEach((record) => container.append(this.createDocumentCard(record)));
    } catch (error) {
      container.replaceChildren(this.errorState('Documents could not be loaded', error.message));
    } finally {
      container.removeAttribute('aria-busy');
    }
  }

  createDocumentCard(record) {
    const card = document.createElement('article');
    card.className = 'document-card';
    const header = document.createElement('div');
    header.className = 'card-header';
    const titleWrap = document.createElement('div');
    const title = document.createElement('h3');
    title.textContent = record.title;
    const meta = document.createElement('p');
    meta.className = 'card-meta';
    meta.textContent = `Updated ${formatDateTime(record.modified, { includeTime: true })}`;
    titleWrap.append(title, meta);
    const status = document.createElement('span');
    status.className = `status-badge ${record.remoteConflictVersion ? 'conflict' : (record.status || 'draft')}`;
    status.textContent = record.remoteConflictVersion
      ? 'Conflict'
      : `${record.status === 'signed' ? 'Signed' : 'Draft'}${record.synced ? ' · Synced' : ''}`;
    header.append(titleWrap, status);

    const actions = document.createElement('div');
    actions.className = 'card-actions';
    actions.append(
      this.actionButton('Open', () => this.openDocumentEditor(record.id)),
      this.actionButton('Share', () => this.shareDocument(record.id)),
      this.actionButton('Delete', () => this.deleteDocument(record), true)
    );
    card.append(header, actions);
    card.addEventListener('dblclick', () => this.openDocumentEditor(record.id));
    return card;
  }

  async openDocumentEditor(documentId = null, templateData = null) {
    this.currentDocumentId = documentId ? Number(documentId) : null;
    this.currentDocumentBrand = null;
    this.photos = [];
    byId('document-title').value = '';
    byId('document-content').value = '';
    byId('signature-data').value = '';
    this.pendingSignerName = '';
    byId('signature-preview').hidden = true;
    byId('signature-placeholder').hidden = false;
    byId('signature-state').textContent = 'Required';
    byId('location-data').value = '';
    byId('location-info').textContent = 'No location captured';
    byId('template-selector').value = '';
    byId('template-selector-container').hidden = Boolean(documentId);
    byId('editor-mode').textContent = documentId ? 'Edit document' : 'New document';
    byId('document-timestamp').textContent = formatDateTime(new Date(), { includeTime: true });
    this.setDocumentLocked(false);

    if (documentId) {
      const record = await documentDB.getDocument(documentId);
      if (!record) return this.showToast('That document no longer exists.', 'error');
      byId('document-title').value = record.title;
      byId('document-content').value = record.content || '';
      this.currentDocumentBrand = record.brandProfileId ? { profileId: record.brandProfileId, name: record.brandName || '', logoUrl: record.brandLogoUrl || '', colors: record.brandColors || null, fonts: record.brandFonts || '' } : null;
      this.photos = record.photos || [];
      if (record.signature) this.setSignature(record.signature);
      if (record.location) this.setLocation(record.location);
      if (record.status === 'signed') {
        byId('document-timestamp').textContent = `Signed by ${record.signerName || 'Unknown signer'} · ${formatDateTime(record.signedAt || record.modified, { includeTime: true })}`;
        this.setDocumentLocked(true);
      }
    } else if (templateData) {
      byId('document-title').value = templateData.title || '';
      byId('document-content').value = templateContentToText(templateData.content || '');
      this.currentDocumentBrand = templateData.brandProfileId ? { profileId: templateData.brandProfileId, name: templateData.brandName || '', logoUrl: templateData.brandLogoUrl || '', colors: templateData.brandColors || null, fonts: templateData.brandFonts || '' } : null;
      this.photos = templateData.photos || [];
      if (templateData.location) this.setLocation(templateData.location);
    }

    await this.populateTemplateSelector();
    this.renderPhotos();
    document.querySelectorAll('.view-section').forEach((view) => { view.hidden = true; });
    byId('document-editor').hidden = false;
    this.editorSnapshot = this.serializeEditor();
    byId('document-title').focus();
  }

  closeDocumentEditor() {
    if (this.hasUnsavedChanges() && !window.confirm('Discard your unsaved changes?')) return;
    this.currentDocumentId = null;
    this.navigate('documents');
  }

  serializeEditor() {
    return JSON.stringify({
      title: byId('document-title').value,
      content: byId('document-content').value,
      signature: byId('signature-data').value,
      location: byId('location-data').value,
      photos: this.photos,
      brand: this.currentDocumentBrand
    });
  }

  hasUnsavedChanges() {
    return this.serializeEditor() !== this.editorSnapshot;
  }

  setDocumentLocked(locked) {
    ['document-title', 'document-content', 'template-selector', 'capture-location', 'add-photo', 'upload-photo', 'signature-field']
      .forEach((id) => { byId(id).disabled = locked; });
    byId('save-document').hidden = locked;
    byId('sign-document').hidden = locked;
    byId('amend-document').hidden = !locked;
  }

  async createAmendment() {
    const record = this.currentDocumentId ? await documentDB.getDocument(this.currentDocumentId) : null;
    if (!record) return this.showToast('The signed document could not be opened.', 'error');
    await this.openDocumentEditor(null, {
      title: `Amendment: ${record.title}`.slice(0, 160),
      content: record.content,
      brandProfileId: record.brandProfileId, brandName: record.brandName, brandLogoUrl: record.brandLogoUrl, brandColors: record.brandColors, brandFonts: record.brandFonts,
      photos: record.photos,
      location: record.location
    });
  }

  async saveDocument(sign = false) {
    const button = byId('save-document');
    const title = byId('document-title').value.trim();
    const signature = byId('signature-data').value;
    if (!title) { byId('document-title').focus(); return this.showToast('Add a document title.', 'warning'); }
    if (sign && !signature) { byId('signature-field').focus(); return this.showToast('Capture a signature before signing.', 'warning'); }
    if (sign && !(this.pendingSignerName || this.currentUser?.name)) return this.showToast('Choose a signer name before signing.', 'warning');

    const actionButton = sign ? byId('sign-document') : button;
    actionButton.disabled = true;
    actionButton.dataset.label ||= actionButton.textContent;
    actionButton.textContent = sign ? 'Signing…' : 'Saving…';
    try {
      const id = await documentDB.saveDocument({
        id: this.currentDocumentId,
        title,
        content: byId('document-content').value,
        signature,
        intent: sign ? 'sign' : 'draft',
        signerName: sign ? (this.pendingSignerName || this.currentUser.name) : '',
        location: safeJsonParse(byId('location-data').value),
        photos: this.photos,
        brandProfileId: this.currentDocumentBrand ? this.currentDocumentBrand.profileId : null,
        brandName: this.currentDocumentBrand?.name || '',
        brandLogoUrl: this.currentDocumentBrand?.logoUrl || '',
        brandColors: this.currentDocumentBrand?.colors || null,
        brandFonts: this.currentDocumentBrand?.fonts || ''
      });
      this.currentDocumentId = id;
      this.editorSnapshot = this.serializeEditor();
      await Promise.all([this.renderDocuments(), this.renderQueue()]);
      this.syncService.schedule(250);
      this.showToast(sign ? 'Document signed and saved on this device.' : 'Draft saved on this device.', 'success');
      this.navigate('documents');
    } catch (error) {
      console.error(error);
      this.showToast(error.message || 'The document could not be saved.', 'error');
    } finally {
      actionButton.disabled = false;
      actionButton.textContent = actionButton.dataset.label;
    }
  }

  async deleteDocument(record) {
    if (!window.confirm(`Delete “${record.title}”? This cannot be undone on this device.`)) return;
    await documentDB.deleteDocument(record.id);
    this.syncService.schedule(250);
    await Promise.all([this.renderDocuments(byId('document-search').value), this.renderQueue()]);
    this.showToast('Document deleted.', 'success');
  }

  async shareDocument(id) {
    const record = await documentDB.getDocument(id);
    if (!record) return;
    try {
      const pdf = await this.buildDocumentPdf(record);
      const file = new File([pdf.output('blob')], `${this.safeFilename(record.title)}.pdf`, { type: 'application/pdf' });
      if (navigator.canShare?.({ files: [file] }) && navigator.share) {
        await navigator.share({ title: record.title, text: `PinkySwear ${record.status} agreement`, files: [file] });
      } else {
        this.downloadBlob(file, file.name, file.type);
        this.showToast('A PDF copy was downloaded for sharing.', 'success');
      }
    } catch (error) {
      if (error.name !== 'AbortError') this.showToast('Sharing is unavailable in this browser.', 'warning');
    }
  }

  initializeSignaturePad() {
    const canvas = byId('signature-pad');
    this.signaturePad = new SignaturePad(canvas, { penColor: '#f7f4f5', minWidth: 0.8, maxWidth: 2.4 });
  }

  openSignaturePad() {
    const modal = byId('signature-modal');
    byId('document-signature-text').value ||= this.currentUser?.name || '';
    byId('document-signature-preview').textContent = byId('document-signature-text').value || 'Your signature';
    this.selectDocumentSignatureMode('drawn');
    this.openDialog(modal);
    requestAnimationFrame(() => {
      const canvas = byId('signature-pad');
      const ratio = Math.max(window.devicePixelRatio || 1, 1);
      canvas.width = Math.floor(canvas.clientWidth * ratio);
      canvas.height = Math.floor(canvas.clientHeight * ratio);
      canvas.getContext('2d').scale(ratio, ratio);
      this.signaturePad.clear();
    });
  }

  saveSignature() {
    if (this.documentSignatureMode === 'drawn') {
      if (this.signaturePad.isEmpty()) return this.showToast('Add your signature first.', 'warning');
      this.setSignature(this.signaturePad.toDataURL('image/png'));
    } else {
      const text = normalizeName(byId('document-signature-text').value);
      if (!text) return this.showToast('Enter the signer name first.', 'warning');
      const canvas = document.createElement('canvas');
      canvas.width = 900;
      canvas.height = 240;
      const context = canvas.getContext('2d');
      context.fillStyle = '#171417';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.font = 'italic 76px Georgia, serif';
      context.fillText(text, canvas.width / 2, canvas.height / 2, 840);
      this.setSignature(canvas.toDataURL('image/png'));
      this.pendingSignerName = text;
      byId('document-signature-text').value = text;
    }
    this.closeDialog(byId('signature-modal'));
    this.showToast('Signature captured.', 'success');
  }

  selectDocumentSignatureMode(mode) {
    this.documentSignatureMode = mode === 'typed' ? 'typed' : 'drawn';
    document.querySelectorAll('[data-document-signature-mode]').forEach((tab) => {
      const selected = tab.dataset.documentSignatureMode === this.documentSignatureMode;
      tab.classList.toggle('active', selected);
      tab.setAttribute('aria-pressed', String(selected));
    });
    byId('document-signature-drawn').hidden = this.documentSignatureMode !== 'drawn';
    byId('document-signature-typed').hidden = this.documentSignatureMode !== 'typed';
  }

  setSignature(dataUrl) {
    byId('signature-data').value = dataUrl;
    byId('signature-preview').src = dataUrl;
    byId('signature-preview').hidden = false;
    byId('signature-placeholder').hidden = true;
    byId('signature-state').textContent = 'Captured';
  }

  async captureLocation() {
    const button = byId('capture-location');
    if (!navigator.geolocation) return this.showToast('Location is not supported by this browser.', 'warning');
    button.disabled = true;
    button.textContent = 'Locating…';
    byId('location-info').textContent = 'Waiting for location permission…';
    try {
      const position = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true, timeout: 12_000, maximumAge: 30_000
      }));
      this.setLocation({ latitude: position.coords.latitude, longitude: position.coords.longitude, accuracy: position.coords.accuracy });
      this.showToast('Location captured.', 'success');
    } catch (error) {
      byId('location-info').textContent = 'No location captured';
      this.showToast(error.code === 1 ? 'Location permission was not granted.' : 'A location fix could not be obtained.', 'warning');
    } finally {
      button.disabled = false;
      button.textContent = 'Capture location';
    }
  }

  setLocation(location) {
    byId('location-data').value = JSON.stringify(location);
      const accuracy = location.accuracy ? ` · ±${Math.round(location.accuracy)} m` : '';
    const captured = location.capturedAt ? ` · ${formatDateTime(location.capturedAt, { includeTime: true })}` : '';
    byId('location-info').textContent = `${location.latitude.toFixed(5)}, ${location.longitude.toFixed(5)}${accuracy}${captured}`;
  }

  async openCamera() {
    if (this.photos.length >= 12) return this.showToast('A document can have up to 12 photos.', 'warning');
    if (!navigator.mediaDevices?.getUserMedia) return this.showToast('Camera capture is not supported here.', 'warning');
    this.openDialog(byId('camera-modal'));
    await this.startCameraStream();
  }

  async startCameraStream() {
    this.stopCameraStream();
    try {
      this.cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: this.facingMode }, width: { ideal: 1600 }, height: { ideal: 1200 } }, audio: false
      });
      byId('camera-preview').srcObject = this.cameraStream;
      await byId('camera-preview').play();
    } catch (error) {
      this.closeDialog(byId('camera-modal'));
      this.showToast(error.name === 'NotAllowedError' ? 'Camera permission was not granted.' : 'The camera could not be started.', 'error');
    }
  }

  stopCameraStream() {
    this.cameraStream?.getTracks().forEach((track) => track.stop());
    this.cameraStream = null;
    byId('camera-preview').srcObject = null;
  }

  closeCamera() {
    this.stopCameraStream();
    this.closeDialog(byId('camera-modal'));
  }

  async switchCamera() {
    this.facingMode = this.facingMode === 'environment' ? 'user' : 'environment';
    await this.startCameraStream();
  }

  capturePhoto() {
    if (this.photos.length >= 12) return this.showToast('A document can have up to 12 photos.', 'warning');
    const video = byId('camera-preview');
    if (!video.videoWidth) return this.showToast('The camera is still starting.', 'warning');
    const canvas = byId('photo-capture');
    const scale = Math.min(1, 1600 / video.videoWidth);
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    this.photos.push(canvas.toDataURL('image/jpeg', 0.82));
    this.renderPhotos();
    this.closeCamera();
    this.showToast('Photo attached.', 'success');
  }

  async addPhotoFiles(event) {
    const input = event.target;
    const files = [...(input.files || [])];
    input.value = '';
    if (this.photos.length + files.length > 12) return this.showToast('A document can have up to 12 photos.', 'warning');
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue;
      if (file.size > 20_000_000) return this.showToast(`${file.name} is larger than the 20 MB photo limit.`, 'warning');
      try {
        const source = URL.createObjectURL(file);
        const image = new Image();
        image.src = source;
        await image.decode();
        const scale = Math.min(1, 1600 / image.naturalWidth, 1600 / image.naturalHeight);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(source);
        this.photos.push(canvas.toDataURL('image/jpeg', 0.82));
      } catch {
        this.showToast(`${file.name} could not be read as an image.`, 'warning');
      }
    }
    this.renderPhotos();
  }

  renderPhotos() {
    const container = byId('photo-attachments');
    container.replaceChildren();
    this.photos.forEach((source, index) => {
      const wrapper = document.createElement('div');
      wrapper.className = 'photo-thumb';
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'photo-open';
      open.setAttribute('aria-label', `View attachment ${index + 1}`);
      const image = document.createElement('img');
      image.src = source;
      image.alt = '';
      open.append(image);
      open.addEventListener('click', () => this.openPhotoViewer(index));
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'photo-remove';
      remove.setAttribute('aria-label', `Remove attachment ${index + 1}`);
      remove.textContent = '×';
      remove.addEventListener('click', () => { this.photos.splice(index, 1); this.renderPhotos(); });
      wrapper.append(open, remove);
      container.append(wrapper);
    });
  }

  openPhotoViewer(index) {
    this.photoViewerIndex = index;
    byId('fullsize-photo').src = this.photos[index];
    this.openDialog(byId('photo-viewer'));
  }

  deleteViewedPhoto() {
    if (this.photoViewerIndex === null) return;
    this.photos.splice(this.photoViewerIndex, 1);
    this.photoViewerIndex = null;
    this.renderPhotos();
    this.closeDialog(byId('photo-viewer'));
  }

  async populateTemplateSelector() {
    const select = byId('template-selector');
    const currentValue = select.value;
    const templates = await documentDB.getTemplates();
    select.replaceChildren(new Option('Blank document', ''));
    templates.forEach((template) => select.add(new Option(template.title, String(template.id))));
    if ([...select.options].some((option) => option.value === currentValue)) select.value = currentValue;
  }

  async loadTemplateIntoEditor(templateId) {
    if (!templateId) return;
    const template = await documentDB.getTemplate(templateId);
    if (!template) return;
    if ((byId('document-title').value || byId('document-content').value) && !window.confirm('Replace the current title and content with this template?')) {
      byId('template-selector').value = '';
      return;
    }
    byId('document-title').value = template.title;
    byId('document-content').value = templateContentToText(template.content);
    this.currentDocumentBrand = template.brandProfileId ? {
      profileId: template.brandProfileId, name: template.brandName || '', logoUrl: template.brandLogoUrl || '', colors: template.brandColors || null, fonts: template.brandFonts || ''
    } : null;
    await documentDB.updateTemplateUsage(template.id);
  }

  async analyzeBrand(event) {
    event.preventDefault();
    const button = byId('analyze-brand');
    const sourceUrl = byId('brand-source-url').value.trim();
    if (!/^https?:\/\//i.test(sourceUrl)) return this.showToast('Enter a complete website URL beginning with https://.', 'warning');
    button.disabled = true;
    button.textContent = 'Analyzing…';
    try {
      const response = await fetch('/api/brand/analyze', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ url: sourceUrl })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'The website could not be analyzed.');
      const profile = result.profile;
      this.currentBrandProfile = { ...profile, id: this.currentBrandProfile?.id || null };
      byId('brand-name').value = profile.name || '';
      byId('brand-primary').value = profile.colors?.primary || '#35212f';
      byId('brand-secondary').value = profile.colors?.secondary || '#f5d6e3';
      byId('brand-accent').value = profile.colors?.accent || '#e75f96';
      byId('brand-fonts').value = profile.fonts || '';
      byId('brand-voice').value = profile.voice || '';
      byId('brand-audience').value = profile.audience || '';
      byId('brand-visual-style').value = profile.visualStyle || '';
      byId('brand-layout').value = profile.layout || '';
      byId('brand-evidence').value = `${profile.evidence || ''}\n\nPages analyzed:\n${(profile.pagesAnalyzed || []).join('\n')}`;
      byId('brand-confidence').textContent = `${profile.confidence || 'Medium'} confidence`;
      byId('brand-profile-panel').hidden = false;
      if (!byId('brand-logo-url').value && profile.suggestedLogoUrl) {
        byId('brand-logo-url').value = profile.suggestedLogoUrl;
        this.setBrandLogo(profile.suggestedLogoUrl);
      }
      byId('brand-batch-name').value ||= `${profile.name || 'Brand'} template batch`;
      await this.renderBrandTemplateChoices();
      this.showToast('Brand profile is ready to review.', 'success');
    } catch (error) {
      console.warn('Brand analysis failed', error);
      this.showToast(error.message || 'Could not analyze that website.', 'error', 6000);
    } finally {
      button.disabled = false;
      button.textContent = 'Analyze website';
    }
  }

  setBrandLogo(value) {
    const url = String(value || '').trim();
    const preview = byId('brand-logo-preview');
    const image = byId('brand-logo-image');
    if (!url) {
      preview.hidden = true;
      image.removeAttribute('src');
      if (this.currentBrandProfile) this.currentBrandProfile.logoUrl = '';
      return;
    }
    if (!/^https:\/\//i.test(url) && !/^data:image\/(?:png|jpeg|webp);base64,/i.test(url)) {
      preview.hidden = true;
      image.removeAttribute('src');
      if (this.currentBrandProfile) this.currentBrandProfile.logoUrl = '';
      return this.showToast('Use an HTTPS image URL or upload a PNG, JPEG, or WebP logo.', 'warning');
    }
    image.src = this.brandImageSource(url);
    preview.hidden = false;
    byId('brand-logo-source').textContent = url.startsWith('data:') ? 'Saved on this device' : 'Logo image';
    if (this.currentBrandProfile) this.currentBrandProfile.logoUrl = url;
  }

  brandImageSource(value) {
    const url = String(value || '');
    return /^data:image\//i.test(url) ? url : `/api/brand/logo?url=${encodeURIComponent(url)}`;
  }

  async loadBrandLogoData(value) {
    if (!value) return '';
    try {
      let blob;
      if (/^data:image\/(?:png|jpeg|webp);base64,/i.test(value)) blob = await (await fetch(value)).blob();
      else {
        const response = await fetch(this.brandImageSource(value));
        if (!response.ok) return '';
        blob = await response.blob();
      }
      const bitmap = await createImageBitmap(blob);
      const scale = Math.min(1, 700 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close?.();
      return { data: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height };
    } catch (error) {
      console.warn('Brand logo could not be prepared for PDF export', error);
      return '';
    }
  }

  async handleBrandLogoUpload(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 1_500_000) {
      event.target.value = '';
      return this.showToast('Choose a PNG, JPEG, or WebP logo under 1.5 MB.', 'warning');
    }
    try {
      let logoUrl = '';
      if (window.websim?.upload && navigator.onLine) {
        try { logoUrl = await window.websim.upload(file); } catch (error) { console.warn('Hosted logo upload failed; saving locally.', error); }
      }
      if (!logoUrl) {
        logoUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = async () => {
            try {
              const bitmap = await createImageBitmap(file);
              const scale = Math.min(1, 640 / Math.max(bitmap.width, bitmap.height));
              const canvas = document.createElement('canvas');
              canvas.width = Math.max(1, Math.round(bitmap.width * scale));
              canvas.height = Math.max(1, Math.round(bitmap.height * scale));
              canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
              bitmap.close?.();
              resolve(canvas.toDataURL('image/webp', 0.82));
            } catch { resolve(String(reader.result || '')); }
          };
          reader.onerror = () => reject(new Error('The logo file could not be read.'));
          reader.readAsDataURL(file);
        });
      }
      byId('brand-logo-url').value = logoUrl.startsWith('data:') ? '' : logoUrl;
      this.setBrandLogo(logoUrl);
      if (this.currentBrandProfile) this.currentBrandProfile.logoUrl = logoUrl;
    } catch (error) {
      this.showToast(error.message || 'The logo could not be loaded.', 'error');
    }
  }

  readBrandForm() {
    const logoUrl = this.currentBrandProfile?.logoUrl || byId('brand-logo-url').value.trim();
    return {
      ...(this.currentBrandProfile || {}),
      name: byId('brand-name').value.trim(), sourceUrl: byId('brand-source-url').value.trim(), logoUrl,
      colors: { primary: byId('brand-primary').value, secondary: byId('brand-secondary').value, accent: byId('brand-accent').value },
      fonts: byId('brand-fonts').value.trim(), voice: byId('brand-voice').value.trim(),
      audience: byId('brand-audience').value.trim(), visualStyle: byId('brand-visual-style').value.trim(),
      layout: byId('brand-layout').value.trim(), evidence: byId('brand-evidence').value.trim(),
      confidence: byId('brand-confidence').textContent.replace(/ confidence$/i, '')
    };
  }

  async saveCurrentBrandProfile() {
    try {
      const profile = this.readBrandForm();
      profile.id = await documentDB.saveBrandProfile(profile);
      this.currentBrandProfile = profile;
      await this.renderBrandProfiles();
      byId('brand-saved-profile').value = String(profile.id);
      this.showToast('Brand profile saved on this device.', 'success');
      return profile;
    } catch (error) {
      this.showToast(error.message || 'Brand profile could not be saved.', 'error');
      return null;
    }
  }

  async renderBrandTemplateChoices() {
    const container = byId('brand-template-choices');
    if (!container) return;
    const category = byId('brand-template-category').value;
    const templates = (await documentDB.getTemplates(category)).filter((template) => !template.batchId);
    container.replaceChildren();
    templates.forEach((template) => {
      const label = document.createElement('label');
      label.className = 'brand-template-choice';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox'; checkbox.value = String(template.id); checkbox.checked = true;
      const copy = document.createElement('span');
      copy.textContent = template.title;
      label.append(checkbox, copy);
      container.append(label);
    });
  }

  async renderBrandProfiles() {
    const select = byId('brand-saved-profile');
    if (!select) return;
    const selected = select.value;
    const profiles = await documentDB.getBrandProfiles();
    select.replaceChildren(new Option('New analysis', ''));
    profiles.forEach((profile) => select.add(new Option(profile.name, String(profile.id))));
    if (profiles.some((profile) => String(profile.id) === selected)) select.value = selected;
  }

  async loadSavedBrandProfile(id) {
    if (!id) {
      this.currentBrandProfile = null;
      byId('brand-profile-panel').hidden = true;
      return;
    }
    const profile = (await documentDB.getBrandProfiles()).find((candidate) => String(candidate.id) === String(id));
    if (!profile) return;
    this.currentBrandProfile = profile;
    byId('brand-source-url').value = profile.sourceUrl || '';
    byId('brand-name').value = profile.name || '';
    byId('brand-logo-url').value = profile.logoUrl?.startsWith('data:') ? '' : (profile.logoUrl || '');
    this.setBrandLogo(profile.logoUrl || '');
    byId('brand-primary').value = profile.colors?.primary || '#35212f';
    byId('brand-secondary').value = profile.colors?.secondary || '#f5d6e3';
    byId('brand-accent').value = profile.colors?.accent || '#e75f96';
    byId('brand-fonts').value = profile.fonts || '';
    byId('brand-voice').value = profile.voice || '';
    byId('brand-audience').value = profile.audience || '';
    byId('brand-visual-style').value = profile.visualStyle || '';
    byId('brand-layout').value = profile.layout || '';
    byId('brand-evidence').value = profile.evidence || '';
    byId('brand-confidence').textContent = `${profile.confidence || 'Medium'} confidence`;
    byId('brand-batch-name').value = `${profile.name} template batch`;
    byId('brand-profile-panel').hidden = false;
    await this.renderBrandTemplateChoices();
  }

  async generateBrandedBatch() {
    const selectedIds = [...byId('brand-template-choices').querySelectorAll('input:checked')].map((input) => Number(input.value));
    if (!selectedIds.length) return this.showToast('Select at least one template for the batch.', 'warning');
    const profile = await this.saveCurrentBrandProfile();
    if (!profile) return;
    const templates = await Promise.all(selectedIds.map((id) => documentDB.getTemplate(id)));
    const batchId = globalThis.crypto?.randomUUID?.() || `batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const batchName = byId('brand-batch-name').value.trim() || `${profile.name} templates`;
    const brandHeading = `<p><strong>${this.escapeHtml(profile.name)}</strong></p>`;
    let created = 0;
    for (const source of templates.filter(Boolean)) {
      const content = `${brandHeading}<p>${this.escapeHtml(source.description || 'Branded agreement template')}</p>${source.content || ''}`;
      await documentDB.saveTemplate({
        ...source, id: null, title: `${profile.name} — ${source.title}`.slice(0, 160), content,
        description: `${source.description || 'Reusable agreement template'} · ${profile.name} brand system`,
        brandProfileId: profile.id, batchId, batchName, brandName: profile.name,
        brandLogoUrl: profile.logoUrl, brandColors: profile.colors, brandFonts: profile.fonts, brandVoice: profile.voice,
        brandAudience: profile.audience, brandVisualStyle: profile.visualStyle, brandLayout: profile.layout,
        thumbnailUrl: null, thumbnailFor: null
      });
      created += 1;
    }
    await Promise.all([this.renderTemplates(byId('template-category').value), this.populateTemplateSelector(), this.renderMyTemplates()]);
    this.showToast(`${created} branded template${created === 1 ? '' : 's'} saved to My templates.`, 'success', 5000);
    this.navigate('my-templates');
  }

  async renderMyTemplates() {
    const container = byId('my-template-batches');
    const templates = (await documentDB.getTemplates()).filter((template) => template.batchId);
    container.replaceChildren();
    if (!templates.length) {
      const empty = this.emptyState('No branded batches yet', 'Analyze a brand and save a template batch to build your library.');
      empty.append(this.actionButton('Brand templates', () => this.navigate('brand')));
      container.append(empty);
      return;
    }
    const batches = new Map();
    templates.forEach((template) => {
      if (!batches.has(template.batchId)) batches.set(template.batchId, []);
      batches.get(template.batchId).push(template);
    });
    for (const [batchId, items] of batches) {
      const section = document.createElement('section');
      section.className = 'brand-batch';
      const heading = document.createElement('div'); heading.className = 'brand-batch-heading';
      const title = document.createElement('h2'); title.textContent = items[0].batchName || items[0].brandName || 'Branded batch';
      const count = document.createElement('span'); count.className = 'status-badge'; count.textContent = `${items.length} templates`;
      heading.append(title, count);
      const grid = document.createElement('div'); grid.className = 'template-grid';
      items.forEach((template) => grid.append(this.createTemplateCard(template)));
      section.append(heading, grid); section.dataset.batchId = batchId; container.append(section);
    }
  }

  escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  }

  async renderTemplates(category = 'all') {
    const container = byId('templates-list');
    try {
      const templates = (await documentDB.getTemplates(category)).filter((template) => !template.batchId);
      container.replaceChildren();
      if (!templates.length) {
        container.append(this.emptyState('No templates in this category', 'Create one for agreements you use often.', 'New template'));
        return;
      }
      templates.forEach((template) => container.append(this.createTemplateCard(template)));
    } catch (error) {
      container.replaceChildren(this.errorState('Templates could not be loaded', error.message));
    }
  }

  createTemplateCard(template) {
    const card = document.createElement('article');
    card.className = 'template-card';
    const thumbnailFrame = document.createElement('div');
    thumbnailFrame.className = 'template-thumbnail-frame';
    const thumbnail = document.createElement('img');
    thumbnail.className = 'template-thumbnail';
    thumbnail.alt = `Wireframe preview for ${template.title}`;
    thumbnail.loading = 'lazy';
    const fingerprint = templateThumbnailFingerprint(template);
    const hasCurrentGenerated = Boolean(template.thumbnailUrl && template.thumbnailFor === fingerprint);
    thumbnail.src = hasCurrentGenerated ? template.thumbnailUrl : createWireframeThumbnail(template);
    thumbnail.addEventListener('error', () => {
      thumbnail.src = createWireframeThumbnail(template);
    }, { once: true });
    const thumbnailCode = document.createElement('span');
    thumbnailCode.className = 'template-thumbnail-code';
    thumbnailCode.textContent = `FORM ${Number.isFinite(Number(template.id)) && Number(template.id) > 0 ? Number(template.id).toString(36).toUpperCase() : templateThumbnailSeed(template).toString(36).slice(0, 5).toUpperCase()}`;
    thumbnailCode.setAttribute('aria-hidden', 'true');
    thumbnailFrame.append(thumbnail, thumbnailCode);
    if (template.brandLogoUrl) {
      const brandMark = document.createElement('img');
      brandMark.className = 'template-brand-logo';
      brandMark.src = this.brandImageSource(template.brandLogoUrl);
      brandMark.alt = `${template.brandName || 'Brand'} logo`;
      brandMark.loading = 'lazy';
      brandMark.addEventListener('error', () => { brandMark.hidden = true; }, { once: true });
      thumbnailFrame.append(brandMark);
      const themeColor = /^#[0-9a-f]{6}$/i.test(String(template.brandColors?.primary || '')) ? template.brandColors.primary : '#e75f96';
      card.style.setProperty('--template-accent', themeColor);
    }
    const thumbnailAction = this.actionButton(
      this.generatingTemplateThumbnails.has(template.id) ? 'Generating…' : (hasCurrentGenerated ? 'Regenerate thumbnail' : 'Generate thumbnail'),
      (event) => this.generateTemplateThumbnail(template.id, event.currentTarget)
    );
    thumbnailAction.disabled = this.generatingTemplateThumbnails.has(template.id);
    thumbnailAction.setAttribute('aria-label', `${hasCurrentGenerated ? 'Regenerate' : 'Generate'} AI wireframe for ${template.title}`);
    const category = document.createElement('span');
    category.className = 'category-chip';
    category.textContent = template.category;
    const title = document.createElement('h3');
    title.textContent = template.title;
    const description = document.createElement('p');
    description.textContent = template.description || 'Reusable agreement template';
    const actions = document.createElement('div');
    actions.className = 'card-actions';
    actions.append(
      this.actionButton('Use', () => this.useTemplate(template.id)),
      this.actionButton('Configure', () => this.openTemplateConfiguration(template.id)),
      this.actionButton('Preview', () => this.previewTemplate(template.id)),
      this.actionButton('Edit', () => this.openTemplateEditor(template.id)),
      this.actionButton('Delete', () => this.deleteTemplate(template), true)
    );
    actions.append(thumbnailAction);
    card.append(thumbnailFrame, category, title, description, actions);
    return card;
  }

  async generateTemplateThumbnail(id, button) {
    if (this.generatingTemplateThumbnails.has(id)) return;
    const template = await documentDB.getTemplate(id);
    if (!template) return;
    if (!navigator.onLine) {
      this.showToast('Connect to the internet to generate an AI thumbnail. The wireframe preview works offline.', 'warning');
      return;
    }
    if (!window.websim?.imageGen) {
      this.showToast('AI image generation is unavailable here. The wireframe preview is still available.', 'warning');
      return;
    }

    this.generatingTemplateThumbnails.add(id);
    button.disabled = true;
    button.textContent = 'Generating…';
    button.setAttribute('aria-busy', 'true');
    try {
      const result = await window.websim.imageGen({ prompt: buildTemplateImagePrompt(template), aspect_ratio: '4:3', seed: templateThumbnailSeed(template) });
      const imageUrl = typeof result?.url === 'string' ? result.url : '';
      if (!/^https?:\/\//i.test(imageUrl)) throw new Error('The image service returned an invalid image URL.');
      const current = await documentDB.getTemplate(id);
      const fingerprint = templateThumbnailFingerprint(template);
      if (!current || templateThumbnailFingerprint(current) !== fingerprint) {
        throw new Error('The template changed while its thumbnail was being generated.');
      }
      await documentDB.setTemplateThumbnail(id, imageUrl, fingerprint);
      this.showToast('Template thumbnail saved.', 'success');
    } catch (error) {
      console.warn('Template thumbnail generation failed', error);
      this.showToast('Could not generate a thumbnail. The wireframe preview is still available.', 'error');
    } finally {
      this.generatingTemplateThumbnails.delete(id);
      await Promise.all([this.renderTemplates(byId('template-category').value), this.renderMyTemplates()]);
    }
  }

  async useTemplate(id) {
    const template = await documentDB.getTemplate(id);
    if (!template) return;
    await documentDB.updateTemplateUsage(id);
    this.openDocumentEditor(null, template);
  }

  async openTemplateEditor(id = null) {
    this.editingTemplateId = id ? Number(id) : null;
    if (!this.templateEditor) {
      this.templateEditor = new Quill('#template-editor-content', {
        theme: 'snow',
        modules: { toolbar: [[{ header: [1, 2, 3, false] }], ['bold', 'italic', 'underline'], [{ list: 'ordered' }, { list: 'bullet' }], ['link'], ['clean']] }
      });
    }
    byId('template-editor-title').textContent = id ? 'Edit template' : 'Create template';
    byId('template-editor-name').value = '';
    byId('template-editor-category').value = 'business';
    byId('template-editor-description').value = '';
    this.templateEditor.setText('');
    if (id) {
      const template = await documentDB.getTemplate(id);
      if (!template) return;
      byId('template-editor-name').value = template.title;
      byId('template-editor-category').value = template.category;
      byId('template-editor-description').value = template.description || '';
      this.templateEditor.root.innerHTML = sanitizeRichText(template.content);
    }
    this.openDialog(byId('template-editor-modal'));
    byId('template-editor-name').focus();
  }

  async saveTemplate(event) {
    event.preventDefault();
    const title = byId('template-editor-name').value.trim();
    const content = sanitizeRichText(this.templateEditor.root.innerHTML);
    if (!title) return this.showToast('Add a template name.', 'warning');
    if (!stripHtml(content).trim()) return this.showToast('Add template content.', 'warning');
    const previous = this.editingTemplateId ? await documentDB.getTemplate(this.editingTemplateId) : null;
    const next = {
      ...(previous || {}),
      id: this.editingTemplateId,
      title,
      category: byId('template-editor-category').value,
      description: byId('template-editor-description').value,
      content
    };
    if (previous && templateThumbnailFingerprint(previous) === templateThumbnailFingerprint(next)) {
      next.thumbnailUrl = previous.thumbnailUrl;
      next.thumbnailFor = previous.thumbnailFor;
    }
    await documentDB.saveTemplate(next);
    this.closeDialog(byId('template-editor-modal'));
    await Promise.all([this.renderTemplates(byId('template-category').value), this.renderMyTemplates(), this.populateTemplateSelector()]);
    this.showToast('Template saved.', 'success');
  }

  async deleteTemplate(template) {
    if (!window.confirm(`Delete the “${template.title}” template?`)) return;
    await documentDB.deleteTemplate(template.id);
    await Promise.all([this.renderTemplates(byId('template-category').value), this.renderMyTemplates(), this.populateTemplateSelector()]);
    this.showToast('Template deleted.', 'success');
  }

  async openTemplateConfiguration(id) {
    const template = await documentDB.getTemplate(id);
    if (!template) return;
    this.configuredTemplate = template;
    byId('template-config-title').textContent = template.title;
    const form = byId('template-config-form');
    form.replaceChildren();
    if (!template.fields?.length) return this.useTemplate(id);
    template.fields.forEach((field, index) => {
      const label = document.createElement('label');
      const id = `template-variable-${index}`;
      label.htmlFor = id;
      label.append(document.createTextNode(`${field.label}${field.required ? ' *' : ''}`));
      let input;
      if (field.type === 'textarea' || field.type === 'repeatable') {
        input = document.createElement('textarea');
        input.rows = field.type === 'repeatable' ? 4 : 3;
        input.maxLength = field.type === 'repeatable' ? 2400 : 1200;
      } else if (field.type === 'select' || field.type === 'multiselect') {
        input = document.createElement('select');
        if (field.type === 'multiselect') {
          input.multiple = true;
          input.size = Math.min(4, Math.max(2, field.options?.length || 2));
        } else {
          input.add(new Option('Choose an option', ''));
        }
        (field.options || []).forEach((option) => input.add(new Option(option, option)));
      } else {
        input = document.createElement('input');
        input.type = ['date', 'url', 'email'].includes(field.type) ? field.type : (field.type === 'currency' || field.type === 'number' ? 'number' : 'text');
        if (field.type === 'currency') input.step = '0.01';
        if (field.type === 'number') input.step = 'any';
        input.maxLength = 300;
      }
      input.id = id;
      input.dataset.templateField = field.key;
      input.required = Boolean(field.required);
      input.placeholder = field.placeholder || '';
      input.addEventListener('input', () => this.updateTemplateConfigurationPreview());
      input.addEventListener('change', () => this.updateTemplateConfigurationPreview());
      label.append(input);
      form.append(label);
    });
    const reviewNote = document.createElement('p');
    reviewNote.className = 'template-review-note';
    reviewNote.textContent = template.reviewNotes || 'Review this template before signing.';
    form.append(reviewNote);
    this.updateTemplateConfigurationPreview();
    this.openDialog(byId('template-config-modal'));
    form.querySelector('[data-template-field]')?.focus();
  }

  getTemplateConfigurationValues() {
    return Object.fromEntries([...byId('template-config-form').querySelectorAll('[data-template-field]')].map((input) => [
      input.dataset.templateField,
      input instanceof HTMLSelectElement && input.multiple
        ? [...input.selectedOptions].map((option) => option.value)
        : input.value
    ]));
  }

  updateTemplateConfigurationPreview() {
    if (!this.configuredTemplate) return;
    const values = this.getTemplateConfigurationValues();
    byId('template-config-preview').innerHTML = sanitizeRichText(applyTemplateSchemaValues(this.configuredTemplate, values));
  }

  useConfiguredTemplate() {
    if (!this.configuredTemplate) return;
    if (!byId('template-config-form').reportValidity()) return;
    const values = this.getTemplateConfigurationValues();
    const configured = { ...this.configuredTemplate, content: applyTemplateSchemaValues(this.configuredTemplate, values) };
    this.closeDialog(byId('template-config-modal'));
    this.openDocumentEditor(null, configured);
  }

  async previewTemplate(id) {
    const template = await documentDB.getTemplate(id);
    if (!template) return;
    const preview = byId('pdf-preview-content');
    preview.replaceChildren();
    const title = document.createElement('h1');
    title.textContent = template.title;
    const date = document.createElement('p');
    date.textContent = formatDateTime(new Date(), { includeTime: true });
    const content = document.createElement('div');
    content.innerHTML = sanitizeRichText(template.content);
    if (template.brandLogoUrl) {
      const brand = document.createElement('div'); brand.className = 'document-brand-preview';
      if (/^#[0-9a-f]{6}$/i.test(String(template.brandColors?.primary || ''))) brand.style.setProperty('--brand-accent', template.brandColors.primary);
      const logo = document.createElement('img'); logo.src = this.brandImageSource(template.brandLogoUrl); logo.alt = `${template.brandName || 'Brand'} logo`;
      const name = document.createElement('strong'); name.textContent = template.brandName || '';
      brand.append(logo, name);
      preview.append(brand);
    }
    preview.append(title, date, content);
    this.openDialog(byId('pdf-preview-modal'));
  }

  async exportPdf() {
    if (!window.jspdf?.jsPDF) return this.showToast('PDF support did not load.', 'error');
    const saved = this.currentDocumentId ? await documentDB.getDocument(this.currentDocumentId) : null;
    const record = {
      ...(saved || {}),
      title: byId('document-title').value.trim() || 'Untitled document',
      content: byId('document-content').value,
      location: safeJsonParse(byId('location-data').value),
      signature: byId('signature-data').value || null,
      photos: this.photos,
      status: saved?.status || 'draft',
      signerName: saved?.signerName || '',
      signedAt: saved?.signedAt || null,
      brandName: saved?.brandName || this.currentDocumentBrand?.name || '',
      brandLogoUrl: saved?.brandLogoUrl || this.currentDocumentBrand?.logoUrl || '',
      brandColors: saved?.brandColors || this.currentDocumentBrand?.colors || null,
      brandFonts: saved?.brandFonts || this.currentDocumentBrand?.fonts || ''
    };
    const pdf = await this.buildDocumentPdf(record);
    pdf.save(`${this.safeFilename(record.title)}.pdf`);
    this.showToast('PDF exported.', 'success');
  }

  async buildDocumentPdf(record) {
    const pdf = new window.jspdf.jsPDF({ unit: 'mm', format: 'a4' });
    const title = record.title || 'Untitled document';
    const margin = 18;
    const pageHeight = pdf.internal.pageSize.getHeight();
    let y = 20;
    if (record.brandName) {
      const brandLogo = await this.loadBrandLogoData(record.brandLogoUrl);
      const primary = record.brandColors?.primary;
      if (/^#[0-9a-f]{6}$/i.test(String(primary || ''))) pdf.setTextColor(primary);
      const fontFace = /serif/i.test(record.brandFonts || '') ? 'times' : (/mono/i.test(record.brandFonts || '') ? 'courier' : 'helvetica');
      pdf.setFont(fontFace, 'bold');
      pdf.setFontSize(10);
      pdf.text(record.brandName, margin, y);
      if (brandLogo) {
        try {
          const width = Math.min(34, 14 * brandLogo.width / brandLogo.height);
          const height = width * brandLogo.height / brandLogo.width;
          pdf.addImage(brandLogo.data, 'PNG', 192 - width, y - (height / 2) - 3, width, height, undefined, 'FAST');
        } catch (error) { console.warn('Brand logo could not be added to PDF', error); }
      }
      y += 9;
      pdf.setTextColor(20);
    }
    const documentFont = /serif/i.test(record.brandFonts || '') ? 'times' : (/mono/i.test(record.brandFonts || '') ? 'courier' : 'helvetica');
    pdf.setFont(documentFont, 'bold');
    pdf.setFontSize(18);
    const titleLines = pdf.splitTextToSize(title, 174);
    pdf.text(titleLines, margin, y);
    y += titleLines.length * 8 + 2;
    pdf.setFont(documentFont, 'normal');
    pdf.setFontSize(9);
    pdf.setTextColor(90);
    pdf.text(`Generated ${formatDateTime(new Date(), { includeTime: true })}`, margin, y);
    y += 9;
    if (record.status === 'signed') {
      pdf.text(`Signed by ${record.signerName || 'Unknown signer'} · ${formatDateTime(record.signedAt || record.modified, { includeTime: true })}`, margin, y);
      y += 7;
    } else {
      pdf.text('Draft copy · not signed', margin, y);
      y += 7;
    }
    pdf.setTextColor(20);
    pdf.setFontSize(11);
    for (const line of pdf.splitTextToSize(record.content || ' ', 174)) {
      if (y > pageHeight - 24) { pdf.addPage(); y = 20; }
      pdf.text(line, margin, y);
      y += 5.5;
    }
    if (record.location) {
      if (y > pageHeight - 32) { pdf.addPage(); y = 20; }
      y += 6;
      pdf.setFontSize(9);
      const { latitude, longitude, accuracy } = record.location;
      const captured = record.location.capturedAt ? ` · ${formatDateTime(record.location.capturedAt, { includeTime: true })}` : '';
      pdf.text(`Location ${latitude.toFixed(5)}, ${longitude.toFixed(5)}${accuracy ? ` · ±${Math.round(accuracy)} m` : ''}${captured}`, margin, y);
      y += 8;
    }
    if (record.signature && record.status === 'signed') {
      if (y > pageHeight - 45) { pdf.addPage(); y = 20; }
      pdf.text('Signature', margin, y);
      pdf.addImage(record.signature, 'PNG', margin, y + 3, 58, 24);
      y += 34;
    }
    for (let index = 0; index < (record.photos || []).length; index += 1) {
      pdf.addPage();
      pdf.setFont(documentFont, 'normal');
      pdf.setFontSize(9);
      pdf.text(`Evidence photo ${index + 1} of ${record.photos.length}`, margin, 16);
      const image = record.photos[index];
      try {
        const properties = pdf.getImageProperties(image);
        const scale = Math.min(174 / properties.width, 255 / properties.height);
        const width = properties.width * scale;
        const height = properties.height * scale;
        pdf.addImage(image, properties.fileType || 'JPEG', margin, 24, width, height);
      } catch { pdf.text('Photo could not be embedded.', margin, 25); }
    }
    return pdf;
  }

  async generateQrCode() {
    if (!window.QRCode) return this.showToast('QR code support did not load.', 'error');
    const content = byId('document-content').value;
    const saved = this.currentDocumentId ? await documentDB.getDocument(this.currentDocumentId) : null;
    const payload = JSON.stringify({
      v: 2,
      title: byId('document-title').value.trim().slice(0, 160),
      content: content.slice(0, 1_200),
      excerpt: content.length > 1_200,
      status: saved?.status || 'draft'
    });
    try {
      const target = byId('qr-canvas');
      target.replaceChildren();
      new window.QRCode(target, {
        text: payload,
        width: 280,
        height: 280,
        colorDark: '#111113',
        colorLight: '#ffffff',
        correctLevel: window.QRCode.CorrectLevel.M
      });
      this.openDialog(byId('qr-modal'));
    } catch {
      this.showToast('This document is too large for a QR code. Export a PDF instead.', 'warning');
    }
  }

  async exportBackup() {
    try {
      const backup = await documentDB.exportBackup();
      this.downloadBlob(JSON.stringify(backup, null, 2), `pinkyswear-backup-${new Date().toISOString().slice(0, 10)}.json`, 'application/json');
      this.showToast('Complete backup exported.', 'success');
    } catch (error) {
      this.showToast(`Backup failed: ${error.message}`, 'error');
    }
  }

  async importBackup(event) {
    const input = event.target;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (file.size > 25_000_000) return this.showToast('That backup is larger than the 25 MB import limit.', 'error');
    try {
      const backup = validateBackup(JSON.parse(await file.text()));
      if (!window.confirm(`Import ${backup.documents.length} documents, ${backup.templates.length} templates, and ${(backup.brandProfiles || []).length} brand profiles? Matching document IDs will be skipped.`)) return;
      const result = await documentDB.importBackup(backup);
      this.syncService.schedule(250);
      await Promise.all([this.renderDocuments(), this.renderTemplates(), this.renderMyTemplates(), this.renderBrandProfiles(), this.populateTemplateSelector(), this.renderQueue()]);
      const skipped = result.skippedDocuments ? ` ${result.skippedDocuments} duplicate document${result.skippedDocuments === 1 ? ' was' : 's were'} skipped.` : '';
      this.showToast(`${result.importedDocuments} documents, ${result.importedTemplates} templates, and ${result.importedBrandProfiles || 0} brand profiles imported.${skipped}`, 'success', 6000);
    } catch (error) {
      this.showToast(`Import failed: ${error.message}`, 'error', 7000);
    }
  }

  async exportSpreadsheet() {
    if (!window.XLSX) return this.showToast('Spreadsheet support did not load.', 'error');
    const records = await documentDB.getDocuments();
    const rows = records.map((record) => ({
      Title: record.title,
      Status: record.status,
      Created: formatDateTime(record.created, { includeTime: true }),
      Modified: formatDateTime(record.modified, { includeTime: true }),
      Synced: record.synced ? 'Yes' : 'No'
    }));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), 'Documents');
    XLSX.writeFile(workbook, `pinkyswear-documents-${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  async renderQueue() {
    const queue = await documentDB.getSyncQueue();
    const container = byId('sync-queue-list');
    const count = queue.length;
    byId('pending-count').textContent = `${count} local change${count === 1 ? '' : 's'} pending`;
    byId('queue-badge').hidden = count === 0;
    byId('queue-badge').textContent = String(count);
    container.replaceChildren();
    if (!queue.length) {
      container.append(this.emptyState('Everything is up to date', this.syncService.configured ? 'There are no local changes waiting to sync.' : 'There are no pending local changes.'));
      return;
    }
    queue.forEach((item) => {
      const card = document.createElement('article');
      card.className = 'queue-card';
      const header = document.createElement('div');
      header.className = 'card-header';
      const details = document.createElement('div');
      const title = document.createElement('h3');
      title.textContent = `${item.data.action[0].toUpperCase()}${item.data.action.slice(1)} document`;
      const meta = document.createElement('p');
      meta.className = 'card-meta';
      meta.textContent = `${formatDateTime(item.timestamp, { includeTime: true })}${item.attempts ? ` · ${item.attempts} failed attempt${item.attempts === 1 ? '' : 's'}` : ''}`;
      details.append(title, meta);
      const status = document.createElement('span');
      status.className = 'status-badge';
      status.textContent = this.syncService.configured ? 'Waiting' : 'Device only';
      header.append(details, status);
      card.append(header);
      if (item.lastError) {
        const error = document.createElement('p');
        error.className = 'card-meta';
        error.textContent = item.lastError;
        card.append(error);
        if (item.lastError.includes('Cloud version conflict')) {
          const actions = document.createElement('div');
          actions.className = 'card-actions';
          actions.append(
            this.actionButton('Use cloud copy', () => this.resolveSyncConflict(item.id, false)),
            this.actionButton('Keep this copy', () => this.resolveSyncConflict(item.id, true))
          );
          card.append(actions);
        }
      }
      container.append(card);
    });
  }

  async renderSyncState(state) {
    const indicator = byId('status-indicator');
    indicator.className = `status-dot ${state.online ? 'online' : 'offline'}`;
    byId('status-text').textContent = state.online ? (state.configured ? 'Online' : 'Device only') : 'Offline';
    const count = state.pending || 0;
    byId('pending-count').textContent = `${count} local change${count === 1 ? '' : 's'} pending`;
    byId('sync-description').textContent = state.configured
      ? (state.online ? 'Document copies sync to your signed-in Websim profile; attachment files are encrypted before storage.' : 'Local changes will sync to your signed-in profile when this device reconnects.')
      : 'No cloud profile is active. Documents and attachments remain in this browser.';
    byId('queue-badge').hidden = count === 0;
    byId('queue-badge').textContent = String(count);
    byId('sync-now').disabled = state.running;
    byId('sync-all').disabled = state.running;
    await this.renderQueue();
    if (state.processed || state.failed || state.conflicts) await this.renderDocuments(byId('document-search').value);
  }

  async syncNow() {
    try {
      if (this.syncService.configured) await this.pullRemoteDocuments();
      const result = await this.syncService.syncAll();
      if (this.syncService.configured) await this.pullRemoteDocuments();
      if (result.conflicts) this.showToast(`${result.conflicts} cloud conflict${result.conflicts === 1 ? '' : 's'} need a choice in Sync status.${result.failed ? ` ${result.failed} other change${result.failed === 1 ? '' : 's'} also failed.` : ''}`, 'warning', 6000);
      else if (result.failed) this.showToast(`${result.failed} change${result.failed === 1 ? '' : 's'} could not be synced yet.`, 'warning');
      else this.showToast(result.processed ? `${result.processed} change${result.processed === 1 ? '' : 's'} synced.` : 'No changes are waiting to sync.', 'success');
    } catch (error) {
      this.showToast(error.message, error instanceof SyncNotConfiguredError ? 'info' : 'warning', 6000);
    }
  }

  async pullRemoteDocuments() {
    if (!this.syncService.configured || !this.syncService.online) return;
    let offset = 0;
    let conflicts = 0;
    do {
      const response = await fetch(`/api/sync?offset=${offset}`, { headers: { Accept: 'application/json' }, credentials: 'include' });
      if (!response.ok) throw new Error('Cloud documents could not be downloaded.');
      const result = await response.json();
      const merged = await documentDB.mergeRemoteDocuments(result.documents || []);
      conflicts += merged.conflicts;
      offset = result.nextOffset;
    } while (offset !== null);
    await Promise.all([this.renderDocuments(byId('document-search').value), this.renderQueue()]);
    if (conflicts) this.showToast(`${conflicts} document${conflicts === 1 ? '' : 's'} changed on both devices. Choose a copy in Sync status.`, 'warning', 6500);
  }

  async resolveSyncConflict(queueId, keepLocal) {
    try {
      const choice = await documentDB.resolveRemoteConflict(queueId, keepLocal);
      await Promise.all([this.renderDocuments(byId('document-search').value), this.renderQueue()]);
      if (choice === 'device') this.syncService.schedule(250);
      else this.showToast('The cloud copy is now on this device.', 'success');
    } catch (error) {
      this.showToast(error.message, 'error');
    }
  }

  actionButton(label, handler, danger = false) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `card-action${danger ? ' danger' : ''}`;
    button.textContent = label;
    button.addEventListener('click', handler);
    return button;
  }

  emptyState(titleText, descriptionText, actionLabel = null) {
    const section = document.createElement('section');
    section.className = 'empty-state';
    const icon = document.createElement('span');
    icon.className = 'empty-state-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '◇';
    const title = document.createElement('h2');
    title.textContent = titleText;
    const description = document.createElement('p');
    description.textContent = descriptionText;
    section.append(icon, title, description);
    if (actionLabel) section.append(this.actionButton(actionLabel, () => actionLabel.includes('template') ? this.openTemplateEditor() : this.openDocumentEditor()));
    return section;
  }

  errorState(titleText, descriptionText) {
    const state = this.emptyState(titleText, descriptionText);
    state.classList.add('error-state');
    return state;
  }

  openDialog(dialog) {
    if (!dialog.open) dialog.showModal();
    document.body.classList.add('modal-open');
  }

  closeDialog(dialog) {
    if (dialog.open) dialog.close();
  }

  showToast(message, type = 'info', duration = 3500) {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const marker = document.createElement('span');
    marker.setAttribute('aria-hidden', 'true');
    marker.textContent = type === 'success' ? '✓' : type === 'error' ? '!' : 'i';
    const copy = document.createElement('p');
    copy.textContent = String(message);
    toast.append(marker, copy);
    byId('toast-container').append(toast);
    setTimeout(() => toast.remove(), duration);
  }

  downloadBlob(content, filename, type) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  safeFilename(value) {
    return String(value).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 100) || 'document';
  }

  auditError(error) {
    documentDB.saveAudit({
      eventType: 'client.error',
      actor: this.currentUser?.name || 'anonymous',
      objectType: 'application',
      objectId: null,
      metadata: { message: String(error?.message || error).slice(0, 500) }
    }).catch(() => {});
  }

  registerServiceWorker() {
    if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
    navigator.serviceWorker.register('./service-worker.js').catch((error) => console.warn('Service worker registration failed', error));
  }
}

const app = new PinkySwearApp();
window.PinkySwear = Object.freeze({ app, database: documentDB });
window.showToast = (...args) => app.showToast(...args);
app.init();

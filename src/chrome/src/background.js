import { ProviderManager } from './providers/manager.js';
import { Agent } from './agent/agent.js';

/**
 * WebBrain Service Worker (Background Script)
 * Routes messages between side panel, content scripts, and the agent.
 */

const providerManager = new ProviderManager();
const agent = new Agent(providerManager);

// Load maxSteps setting
async function loadMaxSteps() {
  const stored = await chrome.storage.local.get('maxAgentSteps');
  if (stored.maxAgentSteps) agent.maxSteps = stored.maxAgentSteps;
}

async function loadAutoScreenshot() {
  const stored = await chrome.storage.local.get('autoScreenshot');
  if (stored.autoScreenshot != null) agent.autoScreenshot = stored.autoScreenshot;
}
loadAutoScreenshot();

async function loadSiteAdapters() {
  const stored = await chrome.storage.local.get('useSiteAdapters');
  if (stored.useSiteAdapters != null) agent.useSiteAdapters = stored.useSiteAdapters;
}
loadSiteAdapters();

// Profile auto-fill: user-provided text (name, email, etc.) that gets
// appended to the system prompt when enabled. Plaintext in storage —
// security warning lives in the settings UI.
async function loadProfile() {
  const stored = await chrome.storage.local.get(['profileEnabled', 'profileText']);
  if (stored.profileEnabled != null) agent.profileEnabled = !!stored.profileEnabled;
  if (typeof stored.profileText === 'string') agent.profileText = stored.profileText;
  // No need to refresh live conversations on initial load — they don't
  // exist yet. Refresh only fires on user-initiated setting changes below.
}
loadProfile();

// Initialize on install
chrome.runtime.onInstalled.addListener(async () => {
  await providerManager.load();
  await loadMaxSteps();
  console.log('[WebBrain] Extension installed, providers loaded.');
});

// Also load on startup
chrome.runtime.onStartup?.addListener(async () => {
  await providerManager.load();
  await loadMaxSteps();
});

// Listen for setting changes
chrome.storage.onChanged.addListener((changes) => {
  if (changes.maxAgentSteps) {
    agent.maxSteps = changes.maxAgentSteps.newValue;
  }
  if (changes.autoScreenshot) {
    agent.autoScreenshot = changes.autoScreenshot.newValue;
  }
  // Any change that affects the composed system prompt needs to refresh
  // already-open conversations so the next turn sees the update — without
  // wiping the chat history.
  let refreshPrompts = false;
  if (changes.useSiteAdapters) {
    agent.useSiteAdapters = changes.useSiteAdapters.newValue;
    refreshPrompts = true;
  }
  if (changes.profileEnabled) {
    agent.profileEnabled = !!changes.profileEnabled.newValue;
    refreshPrompts = true;
  }
  if (changes.profileText) {
    agent.profileText = changes.profileText.newValue || '';
    refreshPrompts = true;
  }
  if (refreshPrompts) agent._refreshSystemPrompts();
});

// ────────────────────────────────────────────────────────────────────────
// Side-panel visibility model — Claude-for-Chrome style
//
// We tie the side panel to a per-window "WebBrain" tab group rather than to
// individual tabs. When the user clicks the action, the source tab joins
// (or seeds) a tab group; the panel is enabled only for tabs in that group.
// Switch to any tab outside the group → panel disabled → Chrome hides it.
//
// Why this and not a per-tab Set?
//
// Chrome's `sidePanel.setOptions({enabled: false})` doesn't actively close
// an already-open panel — it only prevents future opens. With a per-tab Set
// the panel was visible on every tab the user had ever clicked the action
// on, which mounted up across a session. Group membership is observable to
// the user (they see the colored group label) and matches the agent's own
// `_addToWebBrainGroup` behaviour for `new_tab` calls — so a sidebar
// session, an explicitly-opened new_tab, and a target=_blank redirect all
// land in the same group.
//
// `panelTabs` survives as a fallback for old Chromes without `tabGroups`
// (pre-89, very rare). On modern Chrome the group map is the source of truth.
// ────────────────────────────────────────────────────────────────────────

// Legacy per-tab fallback (used only if chrome.tabGroups is unavailable).
const panelTabs = new Set();
const PANEL_TABS_KEY = 'panelTabs';

async function loadPanelTabs() {
  try {
    const stored = await chrome.storage.session.get(PANEL_TABS_KEY);
    if (Array.isArray(stored[PANEL_TABS_KEY])) {
      stored[PANEL_TABS_KEY].forEach(id => panelTabs.add(id));
    }
  } catch (e) { /* session storage not available */ }
}
function savePanelTabs() {
  chrome.storage.session?.set({ [PANEL_TABS_KEY]: Array.from(panelTabs) }).catch(() => {});
}
loadPanelTabs();

// Per-window WebBrain group ID. windowId -> tabGroups groupId.
const webBrainGroupByWindow = new Map();
const WB_GROUPS_KEY = 'webBrainGroupByWindow';

async function loadWebBrainGroups() {
  if (!chrome.tabGroups) return;
  try {
    const stored = await chrome.storage.session.get(WB_GROUPS_KEY);
    const arr = stored[WB_GROUPS_KEY];
    if (Array.isArray(arr)) {
      // Validate each group still exists before re-adopting — Chrome may
      // have closed some between sessions / service-worker restarts.
      for (const [windowId, groupId] of arr) {
        try {
          await chrome.tabGroups.get(groupId);
          webBrainGroupByWindow.set(windowId, groupId);
        } catch { /* group gone, skip */ }
      }
    }
  } catch { /* session storage unavailable */ }
}
function saveWebBrainGroups() {
  chrome.storage.session?.set({
    [WB_GROUPS_KEY]: Array.from(webBrainGroupByWindow.entries()),
  }).catch(() => {});
}
loadWebBrainGroups();

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});

/**
 * Decide whether the side panel should show for `tab`.
 * Modern Chrome: tab.groupId === window's WebBrain group.
 * Legacy fallback: panelTabs membership.
 */
function shouldEnablePanelForTab(tab) {
  if (!tab) return false;
  if (chrome.tabGroups) {
    const wbGroupId = webBrainGroupByWindow.get(tab.windowId);
    if (wbGroupId == null) return false;
    return tab.groupId === wbGroupId;
  }
  return panelTabs.has(tab.id);
}

/**
 * Apply the current visibility decision to a tab. Cheap; called from any
 * listener that might have changed the answer (onActivated, onUpdated,
 * tabGroups.onRemoved, etc.).
 */
async function refreshPanelVisibility(tabId) {
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch { return; }
  if (!tab) return;
  const enabled = shouldEnablePanelForTab(tab);
  try {
    await chrome.sidePanel.setOptions({
      tabId,
      ...(enabled ? { path: 'src/ui/sidepanel.html' } : {}),
      enabled,
    });
  } catch { /* ignore */ }
}

/**
 * Make sure `tab.windowId` has a WebBrain group AND that `tab` is in it.
 * Returns the group ID, or -1 on failure / unsupported. Called from the
 * action.onClicked handler so the sidebar's source tab is always grouped
 * before the user can switch tabs and break visibility.
 */
async function ensureWebBrainGroup(tab) {
  if (!chrome.tabGroups || !tab?.id || tab.windowId == null) return -1;
  try {
    let groupId = webBrainGroupByWindow.get(tab.windowId);

    // Validate the cached group still exists in Chrome (user may have
    // ungrouped it manually, or the service worker restarted with a
    // stale stored ID).
    if (groupId != null) {
      try {
        await chrome.tabGroups.get(groupId);
      } catch {
        groupId = null;
        webBrainGroupByWindow.delete(tab.windowId);
        saveWebBrainGroups();
      }
    }

    if (groupId == null) {
      // Always create a FRESH WebBrain group for this window, even if the
      // source tab is currently in some other (user-owned) group. The
      // earlier behaviour adopted the source's existing group and renamed
      // it to "WebBrain" — surprising for users who had a "Dev" or
      // "Research" group of their own. Calling chrome.tabs.group with no
      // groupId moves the source tab out of any old group into the new
      // one; the user's old group keeps its other tabs untouched.
      groupId = await chrome.tabs.group({ tabIds: [tab.id] });
      try {
        await chrome.tabGroups.update(groupId, {
          title: 'WebBrain', color: 'blue', collapsed: false,
        });
      } catch { /* ignore styling failure */ }
      webBrainGroupByWindow.set(tab.windowId, groupId);
      saveWebBrainGroups();
    } else if (tab.groupId !== groupId) {
      // Group exists for this window but source tab isn't in it. Add it.
      try {
        await chrome.tabs.group({ groupId, tabIds: [tab.id] });
      } catch { /* tab might already be moving; ignore */ }
    }
    return groupId;
  } catch {
    return -1;
  }
}

// Disable the panel up-front on every tab. With group-scoped visibility,
// the panel is OFF by default everywhere — tabs only "earn" the panel by
// being part of a WebBrain group.
async function disablePanelOnAllTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (t.id == null) continue;
      const enabled = shouldEnablePanelForTab(t);
      if (!enabled) {
        chrome.sidePanel.setOptions({ tabId: t.id, enabled: false }).catch(() => {});
      }
    }
  } catch { /* ignore */ }
}
disablePanelOnAllTabs();

chrome.tabs.onCreated.addListener((tab) => {
  if (tab?.id == null) return;
  // New tab inherits "panel off" unless it lands in a WebBrain group
  // (e.g. agent's `_addToWebBrainGroup` adds it). The onUpdated handler
  // below will flip the panel on if/when that happens.
  if (!shouldEnablePanelForTab(tab)) {
    chrome.sidePanel.setOptions({ tabId: tab.id, enabled: false }).catch(() => {});
  }
});

// IMPORTANT: must be a sync handler with no awaits before sidePanel.open(),
// otherwise the user-gesture token expires across the await and Chrome
// silently refuses to open the panel.
chrome.action.onClicked.addListener((tab) => {
  if (!tab?.id) return;
  // Legacy fallback: keep panelTabs in sync for browsers without tabGroups.
  panelTabs.add(tab.id);
  savePanelTabs();
  // Fire-and-forget; do NOT await — preserves user gesture for open() below.
  chrome.sidePanel.setOptions({
    tabId: tab.id,
    path: 'src/ui/sidepanel.html',
    enabled: true,
  });
  chrome.sidePanel.open({ tabId: tab.id });
  // Now group the source tab so the visibility scope is established
  // before the user can switch tabs. Async — we already lost the user-
  // gesture window for sidePanel.open, but ensureWebBrainGroup doesn't
  // need it.
  ensureWebBrainGroup(tab).catch(() => {});
});

// When the active tab changes, re-check visibility against group membership.
// This is the path that makes "switch tab → sidebar disappears" actually
// work, since `setOptions({enabled: false})` told to a non-active tab
// only takes effect once Chrome re-renders the panel for the next tab.
chrome.tabs.onActivated.addListener(({ tabId }) => {
  refreshPanelVisibility(tabId).catch(() => {});
});

// In-place group changes — user dragged the active tab out of the WebBrain
// group, or the agent's `_addToWebBrainGroup` just dragged it in. Either
// way, the active tab's panel state may need to flip without a tab switch.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.groupId === undefined) return;
  refreshPanelVisibility(tabId).catch(() => {});
});

// User ungrouped (or Chrome auto-collapsed) the WebBrain group entirely.
// Forget the mapping for that window so the next action click can seed
// a fresh group rather than try to reuse a dead ID.
chrome.tabGroups?.onRemoved?.addListener?.((group) => {
  for (const [windowId, gid] of webBrainGroupByWindow) {
    if (gid === group.id) {
      webBrainGroupByWindow.delete(windowId);
      saveWebBrainGroups();
      break;
    }
  }
});

// Window closed — drop the per-window mapping.
chrome.windows?.onRemoved?.addListener?.((windowId) => {
  if (webBrainGroupByWindow.has(windowId)) {
    webBrainGroupByWindow.delete(windowId);
    saveWebBrainGroups();
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  panelTabs.delete(tabId);
  savePanelTabs();
  // Also clear any persisted chat state for that tab.
  chrome.storage.session?.remove(`tabChat:${tabId}`).catch(() => {});
  // Drop per-tab agent state (last interaction rect, etc.) so stale data
  // can't resurface if Chrome recycles the tab id for a new tab.
  try { agent._lastInteractionRect?.delete(tabId); } catch { /* ignore */ }
});

// SPA navigation tracking. Many sites change route via History API without
// a full page load — content scripts and any cached element snapshots become
// stale. We record per-tab timestamps for both full and history-only
// navigations and expose them on globalThis so cdpClient.resolveSelector can
// extend its retry budget when a click/type fires soon after a nav (the new
// route may still be hydrating).
const lastNavByTab = new Map(); // tabId -> { ts, type, url }
globalThis.__webbrainLastNav = lastNavByTab;

function recordNav(tabId, type, url) {
  if (tabId == null) return;
  lastNavByTab.set(tabId, { ts: Date.now(), type, url: url || '' });
}

chrome.webNavigation?.onHistoryStateUpdated?.addListener((details) => {
  if (details.frameId === 0) recordNav(details.tabId, 'history', details.url);
});
chrome.webNavigation?.onReferenceFragmentUpdated?.addListener((details) => {
  if (details.frameId === 0) recordNav(details.tabId, 'fragment', details.url);
});
chrome.webNavigation?.onCommitted?.addListener((details) => {
  if (details.frameId === 0) recordNav(details.tabId, 'committed', details.url);
});
chrome.webNavigation?.onCompleted?.addListener((details) => {
  if (details.frameId === 0) recordNav(details.tabId, 'completed', details.url);
});

chrome.tabs.onRemoved.addListener((tabId) => lastNavByTab.delete(tabId));

/**
 * Central message handler.
 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'background') return;

  handleMessage(msg, sender)
    .then(sendResponse)
    .catch(e => sendResponse({ error: e.message }));

  return true; // async response
});

async function handleMessage(msg, sender) {
  // Ensure providers are loaded
  if (providerManager.providers.size === 0) {
    await providerManager.load();
  }

  switch (msg.action) {
    // --- Chat / Agent ---
    case 'chat': {
      const tabId = msg.tabId || sender.tab?.id;
      if (!tabId) throw new Error('No tab ID');
      const mode = msg.mode || 'ask';

      // /allow-api flag is per-conversation. The sidebar tracks it locally
      // but sends it on every chat call so the agent stays in sync after a
      // service worker restart.
      if (msg.apiMutationsAllowed) agent.setApiMutationsAllowed(tabId, true);

      const updates = [];
      const result = await agent.processMessage(tabId, msg.text, (type, data) => {
        updates.push({ type, data });
        chrome.runtime.sendMessage({
          target: 'sidepanel',
          action: 'agent_update',
          type,
          data,
        }).catch(() => {});
      }, mode);

      return { content: result, updates };
    }

    case 'chat_stream': {
      const tabId = msg.tabId || sender.tab?.id;
      if (!tabId) throw new Error('No tab ID');
      const mode = msg.mode || 'ask';

      if (msg.apiMutationsAllowed) agent.setApiMutationsAllowed(tabId, true);

      const result = await agent.processMessageStream(tabId, msg.text, (type, data) => {
        chrome.runtime.sendMessage({
          target: 'sidepanel',
          action: 'agent_update',
          type,
          data,
        }).catch(() => {});
      }, mode);

      return { content: result };
    }

    case 'continue': {
      const tabId = msg.tabId || sender.tab?.id;
      if (!tabId) throw new Error('No tab ID');
      const mode = msg.mode || 'ask';

      const result = await agent.continueProcessing(tabId, (type, data) => {
        chrome.runtime.sendMessage({
          target: 'sidepanel',
          action: 'agent_update',
          type,
          data,
        }).catch(() => {});
      }, mode);

      return { content: result };
    }

    case 'clear_conversation': {
      const tabId = msg.tabId || sender.tab?.id;
      if (tabId) agent.clearConversation(tabId);
      return { ok: true };
    }

    case 'abort': {
      const tabId = msg.tabId || sender.tab?.id;
      if (tabId) agent.abort(tabId);
      return { ok: true };
    }

    case 'get_debug_log': {
      return { log: agent.getDebugLog() };
    }

    case 'clear_debug_log': {
      agent.clearDebugLog();
      return { ok: true };
    }

    // --- Provider Management ---
    case 'get_providers': {
      return { providers: providerManager.getAll(), active: providerManager.activeProviderId };
    }

    case 'set_active_provider': {
      await providerManager.setActive(msg.providerId);
      return { ok: true };
    }

    case 'update_provider': {
      await providerManager.updateProvider(msg.providerId, msg.config);
      return { ok: true };
    }

    case 'test_provider': {
      return await providerManager.testProvider(msg.providerId);
    }

    case 'test_vision_provider': {
      return await providerManager.testVisionProvider();
    }

    case 'list_ollama_models': {
      return await providerManager.listOllamaModels(msg.providerId);
    }

    // --- Page Info (quick, no agent loop) ---
    case 'get_page_info': {
      const tabId = msg.tabId || sender.tab?.id;
      try {
        const response = await chrome.tabs.sendMessage(tabId, {
          target: 'content',
          action: 'get_page_info',
        });
        return response;
      } catch {
        // Try injecting content script. accessibility-tree.js must load
        // first so content.js's a11y-tree handlers can reach the builder.
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ['src/content/accessibility-tree.js', 'src/content/content.js'],
        });
        return await chrome.tabs.sendMessage(tabId, {
          target: 'content',
          action: 'get_page_info',
        });
      }
    }

    default:
      throw new Error(`Unknown action: ${msg.action}`);
  }
}
import { config } from "../package.json";
import { getString, initLocale } from "./utils/locale";
import { registerPrefsScripts } from "./modules/preferenceScript";
import { createZToolkit } from "./utils/ztoolkit";
import {
  registerMenus,
  registerToolbar,
  registerShortcuts,
  unregisterMenus,
  unregisterToolbar,
} from "./modules/menu";
import {
  registerCitationColumn,
  registerOAColumn,
} from "./modules/citationColumn";
import { registerJournalMetricsRow } from "./modules/journalMetrics";
import { registerPreferences } from "./modules/prefs";
import { log } from "./utils/logger";

async function onStartup() {
  log.startup.info("======== STARTUP BEGIN ========");

  // 进程诊断
  try {
    const runtime = (Cc as any)["@mozilla.org/xre/app-info;1"]?.getService(
      (Ci as any).nsIXULRuntime,
    );
    const processType = runtime?.processType;
    const processID = runtime?.processID;
    const processTypeNames: Record<number, string> = {
      0: "PARENT",
      2: "CONTENT",
      4: "GPU",
      9: "UTILITY",
    };
    log.startup.info(
      `process: PID=${processID}, type=${processType} (${processTypeNames[processType] || "UNKNOWN"})`,
    );
  } catch (e) {
    log.startup.warn(`process info unavailable: ${e}`);
  }

  log.startup.info("waiting for Zotero initialization promises...");
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);
  log.startup.info("Zotero initialization promises resolved");

  initLocale();
  log.startup.info("locale initialized");

  // Register preference pane
  try {
    registerPreferences();
    log.startup.info("preferences pane registered");
  } catch (e) {
    log.startup.error("register preferences failed", e);
  }

  // Register custom columns (async)
  try {
    await Promise.all([registerCitationColumn(), registerOAColumn()]);
    log.startup.info("custom columns registered");
  } catch (e) {
    log.startup.error("column registration failed", e);
  }

  // Register journal metrics info row
  try {
    registerJournalMetricsRow();
    log.startup.info("journal metrics row registered");
  } catch (e) {
    log.startup.error("register journal metrics row failed", e);
  }

  // Register global shortcuts (menus are per-window, registered in onMainWindowLoad)
  try {
    registerShortcuts();
    log.startup.info("shortcuts registered");
  } catch (e) {
    log.startup.error("register shortcuts failed", e);
  }

  // Process all existing main windows
  log.startup.info("loading main windows...");
  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );
  log.startup.info("main windows loaded");

  // Mark initialized (scaffold test waits on this)
  addon.data.initialized = true;
  log.startup.info("======== STARTUP COMPLETE ========");
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  log.hooks.info(`onMainWindowLoad begin, win=${(win as any).location?.href || "?"}`);

  // Create ztoolkit for every window (per template convention)
  addon.data.ztoolkit = createZToolkit();

  // Insert FTL for main window
  try {
    win.MozXULElement.insertFTLIfNeeded(
      `${config.addonRef}-mainWindow.ftl`,
    );
    log.hooks.info("FTL inserted");
  } catch (e) {
    log.hooks.error("FTL insert failed", e);
  }

  // Register toolbar button (横向工具栏入口)
  try {
    registerToolbar(win);
  } catch (e) {
    log.hooks.error("register toolbar failed", e);
  }

  // Register menus (per-window, 原生 XUL API)
  try {
    registerMenus(win);
  } catch (e) {
    log.hooks.error("register menus failed", e);
  }

  log.hooks.info("onMainWindowLoad end");
}

async function onMainWindowUnload(win: Window): Promise<void> {
  log.hooks.info("onMainWindowUnload begin");
  try {
    unregisterToolbar(win as unknown as _ZoteroTypes.MainWindow);
  } catch (e) {
    log.hooks.warn("unregister toolbar failed", e);
  }
  try {
    unregisterMenus(win as unknown as _ZoteroTypes.MainWindow);
  } catch (e) {
    log.hooks.warn("unregister menus failed", e);
  }
  // Per-window cleanup is mostly handled by ztoolkit.unregisterAll on shutdown
  ztoolkit.unregisterAll();
  if (addon.data.dialog?.window) {
    addon.data.dialog.window.close();
  }
  log.hooks.info("onMainWindowUnload end");
}

function onShutdown(): void {
  log.shutdown.info("======== SHUTDOWN BEGIN ========");

  // Remove toolbar & menu elements from every open window
  try {
    for (const win of Zotero.getMainWindows()) {
      unregisterToolbar(win as unknown as _ZoteroTypes.MainWindow);
      unregisterMenus(win as unknown as _ZoteroTypes.MainWindow);
    }
    log.shutdown.info("toolbar & menu elements removed");
  } catch (e) {
    log.shutdown.warn(`remove toolbar & menu elements failed: ${e}`);
  }

  ztoolkit.unregisterAll();
  if (addon.data.dialog?.window) {
    addon.data.dialog.window.close();
  }
  addon.data.alive = false;
  delete (Zotero as any)[config.addonInstance];

  log.shutdown.info("======== SHUTDOWN COMPLETE ========");
}

/**
 * Notify dispatcher.
 */
async function onNotify(
  event: string,
  type: string,
  ids: Array<string | number>,
  extraData: { [key: string]: any },
) {
  // Currently no notifier-driven behavior; kept for future use.
  log.hooks.debug("notify", event, type, ids, extraData);
}

/**
 * Preference UI event dispatcher.
 */
async function onPrefsEvent(type: string, data: { [key: string]: any }) {
  log.prefs.info(`prefs event: ${type}`);
  switch (type) {
    case "load":
      registerPrefsScripts(data.window);
      break;
    default:
      return;
  }
}

/**
 * Shortcut dispatcher.
 */
function onShortcuts(type: string) {
  // Shortcuts are handled directly in registerShortcuts; keep for future routing.
  log.hooks.debug(`shortcut: ${type}`);
}

/**
 * Dialog dispatcher.
 */
function onDialogEvents(type: string) {
  switch (type) {
    default:
      break;
  }
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onNotify,
  onPrefsEvent,
  onShortcuts,
  onDialogEvents,
};

// keep import used
void getString;

/**
 * Zsearch menu & toolbar registration.
 *
 * 入口分布：
 *  - 横向主工具栏 zotero-items-toolbar：搜索按钮（图标 + tooltip）
 *  - Tools 菜单：打开搜索窗口 / 更新引用数
 *  - 条目右键菜单：Zsearch 子菜单（下载 PDF / 查找 PDF / 相关文献 / 更新引用数 / 查 DOI）
 *  - 快捷键：Ctrl/Cmd + Shift + S 打开搜索窗口
 *
 * 注意：zotero-plugin-toolkit 5.x 已移除 Menu 工具类，这里改用原生 XUL API
 * 直接创建 menuitem / menu 元素并插入到 Zotero 菜单容器中。
 */

import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { getPref } from "../utils/prefs";
import { log } from "../utils/logger";
import { openSearchWindow } from "./searchWindow";
import { downloadPDFsForItems } from "./pdfDownloader";
import { updateCitationCountsForItems } from "./batchUpdate";

export { registerMenus, registerToolbar, registerShortcuts, unregisterMenus, unregisterToolbar };

/** 工具栏按钮与分隔符 ID（卸载时清理用）。 */
const TOOLBAR_BUTTON_ID = "zsearch-toolbar-btn";
const TOOLBAR_SEPARATOR_ID = "zsearch-toolbar-separator";

/** 菜单元素 ID 前缀（卸载时清理用）。 */
const MENU_ID_PREFIX = "zsearch-menu-";

/** 工具栏按钮使用的 SVG 图标 chrome URL。 */
const toolbarIcon = `chrome://${config.addonRef}/content/icons/icon-toolbar.svg`;
/** 菜单使用的 PNG 图标（兼容性更好）。 */
const menuIcon = `chrome://${config.addonRef}/content/icons/favicon@0.5x.png`;
/** "查找 PDF" 菜单项使用的 SVG 图标 chrome URL。 */
const findPdfIcon = `chrome://${config.addonRef}/content/icons/icon-find-pdf.svg`;

function getSelectedItems(): Zotero.Item[] {
  const zp = Zotero.getActiveZoteroPane();
  if (!zp) return [];
  const items = zp.getSelectedItems();
  return items.filter((it) => it.isRegularItem() && !(it as any).isFeedItem);
}

/* ------------------------------------------------------------------ */
/* Menus — 原生 XUL API 注册                                          */
/* ------------------------------------------------------------------ */

/**
 * 在指定主窗口注册菜单。必须在 onMainWindowLoad 时调用。
 */
function registerMenus(win: _ZoteroTypes.MainWindow): void {
  const doc = win.document;
  log.menu.info("registering menus in window");

  // 先清理该窗口下已存在的 Zsearch 菜单（重新启用 / 多次 load 场景）
  unregisterMenus(win);

  // 1. Tools 菜单 — 打开搜索窗口
  registerToolsMenuItem(win, {
    id: `${MENU_ID_PREFIX}search`,
    label: getString("menu-search"),
    icon: menuIcon,
    onCommand: () => {
      log.menu.info("menu: open search window");
      openSearchWindow(addon.api.elsevier);
    },
  });

  // 2. Tools 菜单 — 更新引用数
  registerToolsMenuItem(win, {
    id: `${MENU_ID_PREFIX}update-citations-tools`,
    label: getString("menu-update-citations"),
    icon: menuIcon,
    onCommand: async () => {
      const items = getSelectedItems();
      if (items.length === 0) {
        alert(getString("menu-update-citations"));
        return;
      }
      log.menu.info(`menu: update citations for ${items.length} items`);
      await updateCitationCountsForItems(addon.api.elsevier, items);
    },
  });

  // 3. 条目右键菜单 — Zsearch 子菜单
  registerItemSubmenu(win);

  log.menu.info("menus registered");
}

/**
 * 在 Tools 菜单下追加一个 menuitem。
 */
function registerToolsMenuItem(
  win: _ZoteroTypes.MainWindow,
  opts: {
    id: string;
    label: string;
    icon?: string;
    onCommand: () => void;
  },
): void {
  const doc = win.document;
  try {
    // Zotero 7: menu_Tools_popup
    let popup = doc.getElementById("menu_Tools_popup");
    if (!popup) {
      // 回退：menu_Tools 下的 menupopup
      const toolsMenu = doc.getElementById("menu_Tools");
      if (toolsMenu) {
        popup = toolsMenu.querySelector("menupopup");
      }
    }
    if (!popup) {
      log.menu.warn("Tools popup not found, skip", opts.id);
      return;
    }

    const mi = doc.createXULElement("menuitem");
    mi.id = opts.id;
    mi.setAttribute("label", opts.label);
    if (opts.icon) {
      mi.setAttribute("class", "menuitem-iconic");
      mi.setAttribute("src", opts.icon);
    }
    mi.addEventListener("command", () => opts.onCommand());
    popup.appendChild(mi);
  } catch (e) {
    log.menu.error("registerToolsMenuItem failed", e);
  }
}

/**
 * 在条目右键菜单 (zotero-itemmenu) 下追加 Zsearch 子菜单。
 */
function registerItemSubmenu(win: _ZoteroTypes.MainWindow): void {
  const doc = win.document;
  try {
    const itemMenu = doc.getElementById("zotero-itemmenu");
    if (!itemMenu) {
      log.menu.warn("zotero-itemmenu not found, skip submenu");
      return;
    }

    // 创建主菜单 (menu)
    const menu = doc.createXULElement("menu");
    menu.id = `${MENU_ID_PREFIX}submenu`;
    menu.setAttribute("label", "Zsearch");
    menu.setAttribute("class", "menu-iconic");
    menu.setAttribute("image", menuIcon);

    const popup = doc.createXULElement("menupopup");
    popup.id = `${MENU_ID_PREFIX}submenu-popup`;

    // 子菜单项构造助手
    const addMenuItem = (
      id: string,
      label: string,
      icon: string,
      onCommand: () => void,
    ) => {
      const mi = doc.createXULElement("menuitem");
      mi.id = id;
      mi.setAttribute("label", label);
      mi.setAttribute("class", "menuitem-iconic");
      mi.setAttribute("src", icon);
      mi.addEventListener("command", () => onCommand());
      popup.appendChild(mi);
    };

    // 1. 下载 PDF (Elsevier)
    addMenuItem(
      `${MENU_ID_PREFIX}download-pdf`,
      getString("menu-download-pdf"),
      menuIcon,
      async () => {
        const items = getSelectedItems();
        if (items.length === 0) return;
        await runPDFDownload(items);
      },
    );

    // 2. 为该条目查找获取 PDF (新)
    addMenuItem(
      `${MENU_ID_PREFIX}find-pdf`,
      getString("menu-find-pdf"),
      findPdfIcon,
      async () => {
        const items = getSelectedItems();
        if (items.length === 0) return;
        await runPDFDownload(items);
      },
    );

    // 分隔线
    const sep1 = doc.createXULElement("menuseparator");
    popup.appendChild(sep1);

    // 3. 查找相关文献
    addMenuItem(
      `${MENU_ID_PREFIX}related`,
      getString("menu-related"),
      menuIcon,
      () => {
        const items = getSelectedItems();
        if (items.length === 0) return;
        openSearchWindow(addon.api.elsevier);
      },
    );

    // 4. 更新引用数
    addMenuItem(
      `${MENU_ID_PREFIX}update-citations`,
      getString("menu-update-citations"),
      menuIcon,
      async () => {
        const items = getSelectedItems();
        if (items.length === 0) return;
        await updateCitationCountsForItems(addon.api.elsevier, items);
      },
    );

    // 5. 查询 DOI
    addMenuItem(
      `${MENU_ID_PREFIX}lookup-doi`,
      getString("menu-lookup-doi"),
      menuIcon,
      async () => {
        const items = getSelectedItems();
        if (items.length === 0) return;
        await lookupDOIs(items);
      },
    );

    menu.appendChild(popup);
    itemMenu.appendChild(menu);
  } catch (e) {
    log.menu.error("registerItemSubmenu failed", e);
  }
}

/**
 * 从指定窗口移除所有 Zsearch 菜单元素。
 */
function unregisterMenus(win: _ZoteroTypes.MainWindow): void {
  try {
    const doc = (win as any).document;
    if (!doc) return;
    // 移除 Tools 菜单项
    doc.getElementById(`${MENU_ID_PREFIX}search`)?.remove();
    doc.getElementById(`${MENU_ID_PREFIX}update-citations-tools`)?.remove();
    // 移除右键子菜单（menu 元素，移除它会把子元素一起带走）
    doc.getElementById(`${MENU_ID_PREFIX}submenu`)?.remove();
  } catch (e) {
    log.menu.warn("unregister menus failed", e);
  }
}

/* ------------------------------------------------------------------ */
/* Toolbar (横向工具栏入口)                                            */
/* ------------------------------------------------------------------ */

function registerToolbar(win: _ZoteroTypes.MainWindow): void {
  const doc = win.document;
  log.toolbar.info("registering toolbar button");

  // 先清理已存在（多次 onMainWindowLoad / 重新启用场景）
  doc.getElementById(TOOLBAR_BUTTON_ID)?.remove();
  doc.getElementById(TOOLBAR_SEPARATOR_ID)?.remove();

  const toolbar = doc.getElementById("zotero-items-toolbar");
  if (!toolbar) {
    log.toolbar.warn("zotero-items-toolbar not found, skip");
    return;
  }

  // 创建分隔线
  const separator = doc.createXULElement("toolbarseparator");
  separator.id = TOOLBAR_SEPARATOR_ID;

  // 创建按钮
  const button = doc.createXULElement("toolbarbutton") as any;
  button.id = TOOLBAR_BUTTON_ID;
  button.setAttribute("label", "Zsearch");
  button.setAttribute("tooltiptext", getString("menu-toolbar-tooltip"));
  button.setAttribute("class", "zotero-tb-button");
  // 关键：使用 list-style-image 设置 SVG 图标
  button.style.listStyleImage = `url("${toolbarIcon}")`;

  button.addEventListener("command", () => {
    log.toolbar.info("toolbar button clicked");
    openSearchWindow(addon.api.elsevier);
  });

  // 插入到搜索框之前；无搜索框则追加到末尾
  const searchBox = doc.getElementById("zotero-tb-search");
  if (searchBox) {
    toolbar.insertBefore(separator, searchBox);
    toolbar.insertBefore(button, separator);
  } else {
    toolbar.appendChild(button);
    toolbar.appendChild(separator);
  }

  log.toolbar.info("toolbar button registered");
}

/** 从指定窗口移除工具栏入口。 */
function unregisterToolbar(win: _ZoteroTypes.MainWindow): void {
  try {
    const doc = (win as any).document;
    doc?.getElementById(TOOLBAR_BUTTON_ID)?.remove();
    doc?.getElementById(TOOLBAR_SEPARATOR_ID)?.remove();
  } catch (e) {
    log.toolbar.warn("unregister toolbar failed", e);
  }
}

/* ------------------------------------------------------------------ */
/* Shortcuts                                                          */
/* ------------------------------------------------------------------ */

function registerShortcuts(): void {
  log.hooks.info("registering shortcuts");
  try {
    ztoolkit.Keyboard.register((ev, keyOptions) => {
      // Ctrl/Cmd + Shift + S → open search
      if (keyOptions.keyboard?.equals("accel,shift,s")) {
        log.hooks.info("shortcut: open search window");
        openSearchWindow(addon.api.elsevier);
      }
    });
  } catch (e) {
    log.hooks.error("register shortcuts failed", e);
  }
}

/* ------------------------------------------------------------------ */
/* Actions                                                            */
/* ------------------------------------------------------------------ */

async function runPDFDownload(items: Zotero.Item[]): Promise<void> {
  if (!addon.api.elsevier.hasApiKey()) {
    alert(getString("err-no-apikey"));
    return;
  }
  const pw = new ztoolkit.ProgressWindow(config.addonName, {
    closeOnClick: true,
  });
  pw.createLine({
    text: `Downloading PDFs (0/${items.length})`,
    type: "default",
    progress: 0,
  }).show();

  const result = await downloadPDFsForItems(
    addon.api.elsevier,
    items,
    (done, total, lastResult) => {
      pw.changeLine({
        progress: Math.round((done / total) * 100),
        text: `Downloading PDFs (${done}/${total})`,
        type: lastResult.success ? "success" : "default",
      });
    },
  );

  pw.changeLine({
    progress: 100,
    text: `Done: ${result.success} ok, ${result.failed} failed`,
    type: result.failed === 0 ? "success" : "default",
  });
  pw.startCloseTimer(5000);
}

async function lookupDOIs(items: Zotero.Item[]): Promise<void> {
  const client = addon.api.elsevier;
  if (!client.hasApiKey()) {
    alert(getString("err-no-apikey"));
    return;
  }
  const pw = new ztoolkit.ProgressWindow(config.addonName, {
    closeOnClick: true,
  });
  pw.createLine({
    text: `Looking up DOIs (0/${items.length})`,
    type: "default",
    progress: 0,
  }).show();

  let done = 0;
  let found = 0;
  for (const item of items) {
    try {
      if (item.getField("DOI")) {
        done++;
        continue;
      }
      const title = String(item.getField("title") || "").trim();
      if (!title) {
        done++;
        continue;
      }
      const q = client.buildQuery(title);
      const res = await client.searchScopus({ query: q, count: 1 });
      if (res.entries.length > 0 && res.entries[0].doi) {
        item.setField("DOI", res.entries[0].doi);
        await item.saveTx();
        found++;
      }
    } catch (e) {
      log.api.warn("DOI lookup failed", e);
    }
    done++;
    pw.changeLine({
      progress: Math.round((done / items.length) * 100),
      text: `Looking up DOIs (${done}/${items.length})`,
    });
  }
  pw.changeLine({
    progress: 100,
    text: `Done: ${found} DOI(s) found`,
    type: "success",
  });
  pw.startCloseTimer(4000);
}

// keep import used
void getPref;

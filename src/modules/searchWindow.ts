import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { getPref, setPref } from "../utils/prefs";
import { openInBrowser, getChromeURL } from "../utils/window";
import { ElsevierClient, ElsevierAPIError } from "./elsevierClient";
import {
  EasyScholarClient,
  EasyScholarRankData,
  rankDataToBadges,
} from "./easyScholarClient";
import { importEntry } from "./importer";
import { hasPDFAttachment } from "./pdfDownloader";
import { log } from "../utils/logger";
import type { UnifiedEntry, SearchFilters as ISearchFilters, AnySearchSource, ISearchSource, WebSearchSource } from "./searchSource";
import {
  getAllSources,
  getActiveSource,
  getActiveSourceId,
  setActiveSource,
  getSourceById,
  getWebSearchUrl,
  initSearchSources,
  aggregateSearch,
  aggregateSearchMore,
  AGGREGATE_SOURCE_ID,
} from "./searchSources";
import { downloadPDFWithChain } from "./pdfDownloadChain";
import {
  isPDFTranslateAvailable,
  translateTitle,
} from "./translateClient";

let searchWindowState: {
  win?: Window;
  elsevierClient: ElsevierClient;
  easyScholar: EasyScholarClient;
  currentPage: number;
  pageSize: number;
  total: number;
  lastQuery: string;
  lastFilters: SearchFilters;
  lastEntries: UnifiedEntry[];
  lastDurationMs: number;
  searching: boolean;
  /** 最近一次搜索的期刊等级映射：publicationName -> rankData */
  lastRanks: Map<string, EasyScholarRankData | null>;
  /** 期刊等级筛选：勾选的等级 kind 列表（空表示不筛选） */
  rankFilter: Set<string>;
  /** 当前 refine 筛选（all/oa/cited50/...） */
  currentRefine: string;
  /** 聚合搜索专用：当前已加载的页码（1 表示仅第 1 页） */
  aggregatePage: number;
  /** 聚合搜索专用：DOI 去重映射（加载更多时复用） */
  aggregateByDoi?: Map<string, UnifiedEntry>;
  /** 聚合搜索专用：标题去重映射（加载更多时复用） */
  aggregateByTitle?: Map<string, UnifiedEntry>;
  /** 当前搜索模式：single=单源搜索（含翻页），aggregate=聚合搜索 */
  mode: "single" | "aggregate";
  /** 聚合搜索专用：已查询过 rank 的期刊名集合（跨加载更多持久化，避免重复请求 EasyScholar） */
  aggregateRankedJournals?: Set<string>;
} | null = null;

interface SearchFilters {
  yearFrom?: number;
  yearTo?: number;
  sort: string;
  type: string; // "" | "ar" | "re" | "cp"
}

export function openSearchWindow(client: ElsevierClient): void {
  if (searchWindowState?.win && !searchWindowState.win.closed) {
    searchWindowState.win.focus();
    return;
  }

  const url = getChromeURL("searchWindow.xhtml");
  const win = Zotero.getMainWindow().openDialog(
    url,
    "zsearch-search-window",
    "chrome,centerscreen,resizable=yes,dialog=no,width=900,height=700",
  ) as Window;

  searchWindowState = {
    win,
    elsevierClient: client,
    easyScholar: addon.api.easyScholar,
    currentPage: 1,
    pageSize: Number(getPref("pageSize") || 25),
    total: 0,
    lastQuery: "",
    lastFilters: { sort: String(getPref("defaultSort") || ""), type: "" },
    lastEntries: [],
    lastDurationMs: 0,
    searching: false,
    lastRanks: new Map(),
    rankFilter: new Set(),
    currentRefine: "all",
    aggregatePage: 1,
    aggregateByDoi: undefined,
    aggregateByTitle: undefined,
    mode: "single",
    aggregateRankedJournals: undefined,
  };

  win.addEventListener("load", () => {
    initSearchWindow(win, client);
  });
  win.addEventListener("unload", () => {
    if (searchWindowState?.win === win) searchWindowState.win = undefined;
  });
}

function initSearchWindow(win: Window, client: ElsevierClient): void {
  const doc = win.document;

  // Load FTL for the window
  try {
    (win as any).MozXULElement?.insertFTLIfNeeded?.(
      `${config.addonRef}-addon.ftl`,
    );
  } catch {
    /* ignore */
  }

  // Set window title
  doc.title = getString("search-window-title");

  // Localize static labels
  setText(doc, "#zsearch-search-btn", getString("search-button"));
  setPlaceholder(doc, "#zsearch-input", getString("search-placeholder"));

  // 创建搜索源下拉选择器
  createSourceMenulist(doc);

  // 动态创建 menulist（参考 zotero-addons 做法，比 xul: 前缀直接写在 XHTML 里更可靠）
  createMenulist(
    doc,
    "#zsearch-sort-placeholder",
    "zsearch-sort",
    [
      { value: "", label: "Relevance" },
      { value: "-citedby-count", label: "Cited (desc)" },
      { value: "-coverDate", label: "Date (newest)" },
    ],
    searchWindowState!.lastFilters.sort,
  );
  createMenulist(
    doc,
    "#zsearch-type-placeholder",
    "zsearch-type",
    [
      { value: "", label: "All" },
      { value: "ar", label: "Article" },
      { value: "re", label: "Review" },
      { value: "cp", label: "Conference" },
    ],
    searchWindowState!.lastFilters.type,
  );

  // Status: initial empty
  setStatus(doc, "");

  // Events
  const input = doc.querySelector("#zsearch-input") as HTMLInputElement;
  const searchBtn = doc.querySelector("#zsearch-search-btn") as HTMLButtonElement;
  const historyBtn = doc.querySelector("#zsearch-history-btn") as HTMLButtonElement;
  const prevBtn = doc.querySelector("#zsearch-prev") as HTMLButtonElement;
  const nextBtn = doc.querySelector("#zsearch-next") as HTMLButtonElement;
  const importAllBtn = doc.querySelector("#zsearch-import-all") as HTMLButtonElement;

  searchBtn.addEventListener("click", () => doSearch(win, client, 1));
  input.addEventListener("keydown", (ev: KeyboardEvent) => {
    // Ctrl/Cmd + Enter: 搜索
    if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      doSearch(win, client, 1);
      return;
    }
    // Enter: 搜索
    if (ev.key === "Enter") {
      ev.preventDefault();
      doSearch(win, client, 1);
      return;
    }
    // Esc: 清空输入框
    if (ev.key === "Escape") {
      ev.preventDefault();
      input.value = "";
      input.focus();
      return;
    }
  });
  // 搜索历史按钮：点击切换面板
  if (historyBtn) {
    historyBtn.addEventListener("click", () => toggleHistoryPanel(win));
  }
  // 收藏按钮：显示阅读队列
  const starredBtn = doc.querySelector("#zsearch-starred-btn");
  if (starredBtn) {
    starredBtn.addEventListener("click", () => showStarredDialog(win));
  }
  // 统计按钮：显示结果统计面板
  const statsBtn = doc.querySelector("#zsearch-stats-btn");
  if (statsBtn) {
    statsBtn.addEventListener("click", () => showStatsDialog(win));
  }
  // 点击历史面板外部时关闭
  doc.addEventListener("click", (ev: MouseEvent) => {
    const panel = doc.querySelector("#zsearch-history-panel") as HTMLElement;
    if (!panel || panel.style.display === "none") return;
    const target = ev.target as Node;
    if (panel.contains(target)) return;
    const btn = doc.querySelector("#zsearch-history-btn");
    if (btn && btn.contains(target)) return;
    panel.style.display = "none";
  });
  prevBtn.addEventListener("click", () => {
    if (searchWindowState!.currentPage > 1)
      doSearch(win, client, searchWindowState!.currentPage - 1);
  });
  nextBtn.addEventListener("click", () => {
    if (
      searchWindowState!.currentPage * searchWindowState!.pageSize <
      searchWindowState!.total
    )
      doSearch(win, client, searchWindowState!.currentPage + 1);
  });
  importAllBtn.addEventListener("click", () => importAll(win, client));

  // 高级搜索语法快捷按钮：由 updateSyntaxBar 动态生成，点击在光标位置插入语法
  // 初始时按当前选中源生成一次
  const initialSourceId = readMenulistValue(doc, "#zsearch-source") || "scopus";
  updateSyntaxBar(win, initialSourceId);

  // 结果二次筛选条：点击切换筛选条件，前端过滤当前页结果
  // 仅绑定带 data-refine 属性的按钮（排除等级筛选按钮）
  const refineBtns = doc.querySelectorAll<HTMLButtonElement>(".zsearch-btn-chip[data-refine]");
  refineBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const refine = btn.getAttribute("data-refine") || "all";
      // 切换 active 状态
      refineBtns.forEach((b) => b.classList.remove("zsearch-refine-active"));
      btn.classList.add("zsearch-refine-active");
      applyRefine(win, refine);
    });
  });

  // 期刊等级筛选按钮：点击切换面板
  const rankFilterBtn = doc.querySelector("#zsearch-rankfilter-btn");
  if (rankFilterBtn) {
    rankFilterBtn.addEventListener("click", () => {
      toggleRankFilterPanel(win);
    });
  }

  // 全选复选框：同步所有可见卡片的选中状态
  const selectAll = doc.querySelector("#zsearch-select-all") as HTMLInputElement;
  if (selectAll) {
    selectAll.addEventListener("change", () => {
      const checked = selectAll.checked;
      const cards = doc.querySelectorAll<HTMLElement>(".zsearch-result");
      cards.forEach((card) => {
        if (card.style.display !== "none") {
          const cb = card.querySelector<HTMLInputElement>(".zsearch-result-checkbox");
          if (cb) cb.checked = checked;
        }
      });
      updateExportButtonsState(win);
    });
  }

  // 导出按钮
  const exportBibtex = doc.querySelector("#zsearch-export-bibtex") as HTMLButtonElement;
  const exportRis = doc.querySelector("#zsearch-export-ris") as HTMLButtonElement;
  const exportCsv = doc.querySelector("#zsearch-export-csv") as HTMLButtonElement;
  exportBibtex.addEventListener("click", () => exportSelected(win, "bibtex"));
  exportRis.addEventListener("click", () => exportSelected(win, "ris"));
  exportCsv.addEventListener("click", () => exportSelected(win, "csv"));

  // 动态计算滚动容器高度（Zotero 7 XHTML 窗口下 CSS flex 不可靠，用 JS 固定高度）
  const updateScrollHeight = () => updateResultsScrollHeight(win);
  // 多次延迟调用，确保窗口完全布局后高度正确
  updateScrollHeight();
  setTimeout(updateScrollHeight, 100);
  setTimeout(updateScrollHeight, 300);
  win.addEventListener("resize", updateScrollHeight);
}

/**
 * 动态计算并设置结果滚动容器的高度。
 * 参考 zotero-addons 做法：用窗口高度减去顶部和底部固定区的高度。
 * 关键：用 setTimeout 延迟计算，确保 DOM 完全布局。
 */
function updateResultsScrollHeight(win: Window): void {
  const doc = win.document;
  const scroll = doc.querySelector("#zsearch-results-scroll") as HTMLElement;
  const topbar = doc.querySelector("#zsearch-topbar") as HTMLElement;
  const pagination = doc.querySelector("#zsearch-pagination") as HTMLElement;
  if (!scroll) return;

  // 用 setTimeout 确保布局完成后再读取高度
  setTimeout(() => {
    // 优先用 innerHeight，回退到 documentElement.clientHeight
    const winHeight = win.innerHeight || doc.documentElement?.clientHeight || 700;
    const topbarH = topbar ? topbar.offsetHeight : 0;
    let paginationH = 0;
    if (pagination) {
      const style = win.getComputedStyle(pagination);
      if (style.display !== "none") {
        paginationH = pagination.offsetHeight;
      }
    }

    const scrollHeight = Math.max(winHeight - topbarH - paginationH, 100);
    scroll.style.height = `${scrollHeight}px`;
    log.search.info(`updateResultsScrollHeight: win=${winHeight}, topbar=${topbarH}, pagination=${paginationH}, scroll=${scrollHeight}`);
  }, 50);
}

function setText(doc: Document, selector: string, text: string): void {
  const el = doc.querySelector(selector);
  if (el) el.textContent = text;
}

function setPlaceholder(doc: Document, selector: string, text: string): void {
  const el = doc.querySelector(selector) as HTMLInputElement | null;
  if (el) el.placeholder = text;
}

function setStatus(doc: Document, text: string, kind?: "loading" | "error" | "info"): void {
  const el = doc.querySelector("#zsearch-status") as HTMLElement;
  if (!el) return;
  el.className = "zsearch-status";
  if (kind === "loading") el.classList.add("zsearch-loading");
  if (kind === "error") el.classList.add("zsearch-error");
  el.innerHTML = "";
  if (kind === "loading" && text) {
    const spinner = doc.createElement("span");
    spinner.className = "zsearch-spinner";
    el.appendChild(spinner);
    el.appendChild(doc.createTextNode(text));
  } else {
    el.textContent = text;
  }
}

/**
 * 切换搜索进行中的 UI 状态：禁用/启用搜索按钮、翻页按钮、导入全部按钮、输入框、搜索源下拉框。
 * 避免用户在搜索进行中重复触发操作或切换源导致状态污染。
 */
function setSearchingUI(doc: Document, searching: boolean): void {
  const ids = [
    "#zsearch-search-btn",
    "#zsearch-prev",
    "#zsearch-next",
    "#zsearch-import-all",
    "#zsearch-export-bibtex",
    "#zsearch-export-ris",
    "#zsearch-export-csv",
  ];
  ids.forEach((sel) => {
    const btn = doc.querySelector(sel) as HTMLButtonElement;
    if (btn) btn.disabled = searching;
  });
  const input = doc.querySelector("#zsearch-input") as HTMLInputElement;
  if (input) input.disabled = searching;
  // 搜索源下拉框也需禁用，避免搜索中切换源导致状态污染
  const sourceML = doc.querySelector("#zsearch-source") as HTMLElement;
  if (sourceML) {
    if (searching) {
      sourceML.setAttribute("disabled", "true");
    } else {
      sourceML.removeAttribute("disabled");
    }
  }
}

/**
 * 切换搜索源时清理 UI 和状态：清空结果区、隐藏分页/批量栏/筛选栏、重置 refine/rank 筛选、
 * 重置 mode 和聚合状态、恢复 prev/next 按钮原貌。
 * 避免用户切换源后看到上一个源的结果和筛选状态产生混淆。
 */
function resetStateOnSourceChange(doc: Document, newSourceId: string): void {
  const state = searchWindowState;
  // 清空结果区
  const resultsEl = doc.querySelector("#zsearch-results") as HTMLElement;
  if (resultsEl) resultsEl.innerHTML = "";
  // 隐藏分页栏、批量操作栏、筛选栏
  (doc.querySelector("#zsearch-pagination") as HTMLElement)?.setAttribute("style", "display: none;");
  (doc.querySelector("#zsearch-batch") as HTMLElement)?.setAttribute("style", "display: none;");
  const refineEl = doc.querySelector("#zsearch-refine") as HTMLElement;
  if (refineEl) refineEl.style.display = "none";
  const rankPanel = doc.querySelector("#zsearch-rankfilter-panel") as HTMLElement;
  if (rankPanel) rankPanel.style.display = "none";
  // 清空状态栏
  setStatus(doc, "");
  // 重置状态
  if (state) {
    state.lastEntries = [];
    state.total = 0;
    state.lastQuery = "";
    state.lastDurationMs = 0;
    state.currentRefine = "all";
    state.rankFilter.clear();
    state.lastRanks = new Map();
    state.mode = newSourceId === AGGREGATE_SOURCE_ID ? "aggregate" : "single";
    state.aggregatePage = 1;
    state.aggregateByDoi = undefined;
    state.aggregateByTitle = undefined;
    state.aggregateRankedJournals = undefined;
  }
  rankFilterMatchers.clear();
  // 重置 refine 按钮 active 状态到 "All"
  const refineBtns = doc.querySelectorAll<HTMLButtonElement>(".zsearch-btn-chip[data-refine]");
  refineBtns.forEach((b) => b.classList.remove("zsearch-refine-active"));
  const allBtn = doc.querySelector<HTMLButtonElement>('.zsearch-btn-chip[data-refine="all"]');
  if (allBtn) allBtn.classList.add("zsearch-refine-active");
  // 取消等级筛选面板中所有复选框的勾选
  const rankCheckboxes = doc.querySelectorAll<HTMLInputElement>(".zsearch-rankfilter-checkbox");
  rankCheckboxes.forEach((cb) => { cb.checked = false; });
  updateRankFilterButton(doc.defaultView as Window);
  // 重置全选复选框
  const selectAll = doc.querySelector("#zsearch-select-all") as HTMLInputElement;
  if (selectAll) selectAll.checked = false;
  // 恢复 prev/next 按钮原貌（移除可能被 updateAggregatePagination 绑定的 loadMoreAggregate 监听器）
  resetPaginationButtons(doc);
  // 重新计算滚动容器高度
  updateResultsScrollHeight(doc.defaultView as Window);
}

/**
 * 恢复 prev/next 按钮的原貌：显示、文本、监听器。
 * 聚合搜索的 updateAggregatePagination 会用 cloneNode 替换 next 按钮并绑定 loadMoreAggregate，
 * 切换回单源或新搜索时需重置监听器，否则单源翻页会错误触发 loadMoreAggregate。
 */
function resetPaginationButtons(doc: Document): void {
  const prevBtn = doc.querySelector("#zsearch-prev") as HTMLButtonElement;
  const nextBtn = doc.querySelector("#zsearch-next") as HTMLButtonElement;
  if (prevBtn) {
    prevBtn.style.display = "";
    prevBtn.textContent = "‹ Prev";
    prevBtn.disabled = true;
  }
  if (nextBtn) {
    nextBtn.textContent = "Next ›";
    nextBtn.style.display = "";
    nextBtn.disabled = true;
  }
}

/**
 * 在窗口右下角显示 toast 通知，3 秒后自动消失。
 * 替代 alert()，不打断用户操作。
 */
function showToast(win: Window, text: string, kind: "success" | "error" | "info" = "info"): void {
  const doc = win.document;
  let container = doc.querySelector("#zsearch-toast-container") as HTMLElement;
  if (!container) {
    container = doc.createElement("div");
    container.id = "zsearch-toast-container";
    // z-index 必须高于 modal overlay（10000），否则 toast 会被模态弹窗遮挡
    container.style.cssText =
      "position: fixed; bottom: 16px; right: 16px; z-index: 10001; display: flex; flex-direction: column; gap: 8px; pointer-events: none; max-height: 60vh; overflow: hidden;";
    doc.body.appendChild(container);
  }
  const toast = doc.createElement("div");
  const colors: Record<string, string> = {
    success: "#137333",
    error: "#d93025",
    info: "#1a73e8",
  };
  const bgs: Record<string, string> = {
    success: "#e6f4ea",
    error: "#fef7f7",
    info: "#e8f0fe",
  };
  toast.style.cssText =
    `pointer-events: auto; padding: 10px 16px; border-radius: 8px; font-size: 13px; color: ${colors[kind]}; background: ${bgs[kind]}; border: 1px solid ${colors[kind]}33; box-shadow: 0 2px 8px rgba(0,0,0,0.15); max-width: 360px; word-break: break-word; transition: opacity 0.3s, transform 0.3s; opacity: 0; transform: translateY(10px);`;
  toast.textContent = text;
  // 限制容器内最多 5 个 toast，超出时移除最旧的
  while (container.children.length >= 5) {
    container.firstChild?.remove();
  }
  container.appendChild(toast);
  // 触发入场动画
  requestAnimationFrame(() => {
    toast.style.opacity = "1";
    toast.style.transform = "translateY(0)";
  });
  // 3 秒后淡出移除
  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(10px)";
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

/**
 * 复制文本到剪贴板，兼容 Zotero 环境。
 */
function copyToClipboard(win: Window, text: string): boolean {
  try {
    const clipboard = (Zotero as any).Clipboard;
    if (clipboard && clipboard.addText) {
      clipboard.addText(text, "text/plain");
      return true;
    }
  } catch {
    /* fallthrough */
  }
  // 回退方案：用 textarea + execCommand
  try {
    const doc = win.document;
    const ta = doc.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position: fixed; left: -9999px;";
    doc.body.appendChild(ta);
    ta.select();
    const ok = doc.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/**
 * 检查 Zotero 库中是否已存在相同 DOI 的条目。
 * 用于在结果卡片上标记"已在库中"，避免重复导入。
 */
function isEntryInLibrary(entry: UnifiedEntry): boolean {
  // 规范化 DOI：去除 URL 前缀、转小写
  const normalizeDoiStr = (s: string): string => {
    return s.trim().toLowerCase()
      .replace(/^https?:\/\/doi\.org\//i, "")
      .replace(/^doi:\s*/i, "");
  };

  // 1. 优先按 DOI 检测（最准确）
  if (entry.doi) {
    try {
      const doi = normalizeDoiStr(entry.doi);
      let rows: any[] | null = null;
      try {
        // Zotero 7+ 路径：通过 itemDataValues 精确匹配
        const sql7 = `SELECT idv.itemID FROM itemDataValues idv
                      JOIN itemData id ON idv.valueID = id.valueID
                      JOIN fields f ON id.fieldID = f.fieldID
                      WHERE f.fieldName = 'DOI' AND LOWER(idv.value) = ?`;
        rows = (Zotero as any).DB.query(sql7, [doi]);
      } catch {
        /* fallthrough to legacy path */
      }
      if (rows && rows.length > 0) return true;
      // 旧版路径：itemData.value 直接存储值
      const sql = "SELECT itemID FROM itemData WHERE fieldID IN (SELECT fieldID FROM fields WHERE fieldName='DOI') AND LOWER(value) = ?";
      rows = (Zotero as any).DB.query(sql, [doi]);
      if (rows && rows.length > 0) return true;
    } catch {
      /* fallthrough to title matching */
    }
  }

  // 2. 无 DOI 或 DOI 未命中：按标题匹配（适用于 arXiv/无 DOI 条目）
  // 标题归一化：去标点、空格，仅保留字母数字
  const normalizeTitle = (s: string): string => {
    return (s || "").toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, "");
  };
  const targetTitle = normalizeTitle(entry.title || "");
  if (!targetTitle || targetTitle.length < 5) return false; // 标题太短不匹配，避免误判
  try {
    // 通过 Zotero.Search 按标题精确匹配（更可靠）
    const s = new (Zotero as any).Search();
    s.addCondition("title", "is", entry.title || "");
    s.addCondition("noChildren", "true");
    const ids = s.search();
    if (ids && ids.length > 0) return true;
    // 回退：LIKE 匹配（防止大小写/标点差异）
    const s2 = new (Zotero as any).Search();
    s2.addCondition("title", "contains", entry.title || "");
    s2.addCondition("noChildren", "true");
    const ids2 = s2.search();
    if (ids2 && ids2.length > 0) {
      // 二次校验：归一化比较，避免 contains 误判
      for (const id of ids2) {
        const item = (Zotero as any).Items.get(id);
        if (item) {
          const libTitle = normalizeTitle(item.getField("title") || "");
          if (libTitle === targetTitle) return true;
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* 搜索历史管理                                                         */
/* ------------------------------------------------------------------ */

const HISTORY_MAX = 10;

/* ------------------------------------------------------------------ */
/* 阅读队列/收藏功能                                                    */
/* ------------------------------------------------------------------ */

const STARRED_MAX = 200;

/** 获取收藏条目列表 */
function getStarredEntries(): Array<{ title: string; doi?: string; url?: string; savedAt: string }> {
  try {
    const raw = (getPref("starredEntries") as string) || "[]";
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/** 判断条目是否已收藏（按 DOI 或标题匹配） */
function isEntryStarred(entry: UnifiedEntry): boolean {
  const starred = getStarredEntries();
  if (entry.doi) {
    return starred.some((s) => s.doi && s.doi.toLowerCase() === entry.doi!.toLowerCase());
  }
  return starred.some((s) => s.title === entry.title);
}

/** 切换条目收藏状态 */
function toggleStarred(entry: UnifiedEntry): boolean {
  let starred = getStarredEntries();
  // 严格根据 entry 是否有 DOI 来决定匹配/移除逻辑，避免误删其他 DOI 不同但标题相同的条目
  const hasDoi = !!entry.doi;
  const doiLower = hasDoi ? entry.doi!.toLowerCase() : "";
  const matches = (s: { doi?: string; title: string }) =>
    hasDoi
      ? !!(s.doi && s.doi.toLowerCase() === doiLower)
      : s.title === entry.title;
  const exists = starred.some(matches);
  if (exists) {
    starred = starred.filter((s) => !matches(s));
    setPref("starredEntries", JSON.stringify(starred));
    return false;
  } else {
    starred.unshift({
      title: entry.title || "",
      doi: entry.doi,
      url: entry.url,
      savedAt: new Date().toISOString(),
    });
    if (starred.length > STARRED_MAX) starred = starred.slice(0, STARRED_MAX);
    setPref("starredEntries", JSON.stringify(starred));
    return true;
  }
}

/* ------------------------------------------------------------------ */
/* 引用格式预览                                                         */
/* ------------------------------------------------------------------ */

/**
 * 解析多种作者格式为 [lastName, firstName] 数组。
 * 支持的输入：
 *   1. 数组：["Smith J K", "Doe J"] 或 Scopus 对象数组（先在 formatAuthors 中归一化）
 *   2. 字符串："Smith, J K; Doe, J"（分号分隔，标准格式）
 *   3. 字符串："Smith J K, Doe J"（逗号分隔，姓在前）
 *   4. 字符串："Smith, J K, Doe, J"（混合格式，按分号→and→&→逗号优先级拆分）
 *   5. 字符串："J K Smith"（名缩写在前，姓在后）
 */
function parseAuthorList(authors: string[] | string | undefined): Array<[string, string]> {
  if (!authors) return [];
  let arr: string[];
  if (Array.isArray(authors)) {
    // 处理 Scopus 对象数组：[{authname}, {surname, given-name}, ...]
    arr = authors.map((a: any) => {
      if (typeof a === "string") return a;
      // 优先用 authname（Scopus 完整格式）
      if (a.authname) return a.authname;
      // 回退到 surname + given-name
      const surname = a.surname || a["ce:surname"] || "";
      const given = a.givenName || a["given-name"] || a["ce:given-name"] || "";
      if (surname && given) return `${surname}, ${given}`;
      return surname || given || a.name || "";
    }).filter(Boolean);
  } else {
    const s = String(authors).trim();
    if (!s) return [];
    // 优先按分号分隔（Scopus/Springer 标准格式 "Smith, J K; Doe, J"）
    if (s.includes(";")) {
      arr = s.split(/\s*;\s*/).filter(Boolean);
    } else if (/\s+and\s+/i.test(s)) {
      // "Smith J K and Doe J"
      arr = s.split(/\s+and\s+/i).filter(Boolean);
    } else if (/\s+&\s+/.test(s)) {
      arr = s.split(/\s+&\s+/).filter(Boolean);
    } else {
      // 逗号分隔：可能是 "Smith J K, Doe J"（姓在前）或 "Smith, J K, Doe, J"（标准格式）
      // 用启发式判断：如果逗号数量 >= 2 且交替出现 "姓, 名, 姓, 名" 模式，按 2 个一组拆分
      const commaCount = (s.match(/,/g) || []).length;
      if (commaCount >= 3) {
        // 可能是 "Smith, J K, Doe, J" 标准格式，按 2 个逗号一组拆分
        const tokens = s.split(/,\s*/);
        arr = [];
        for (let i = 0; i + 1 < tokens.length; i += 2) {
          arr.push(`${tokens[i]}, ${tokens[i + 1]}`);
        }
        if (tokens.length % 2 === 1) arr.push(tokens[tokens.length - 1]);
      } else {
        // 普通逗号分隔："Smith J K, Doe J"
        arr = s.split(/,\s*/).filter(Boolean);
      }
    }
  }
  return arr.map((a) => {
    const s = a.trim();
    if (!s) return ["", ""] as [string, string];
    // 格式 1："Smith, J K" → 标准格式（姓, 名）
    if (s.includes(",")) {
      const [last, first] = s.split(",", 2).map((x) => x.trim());
      return [last, first] as [string, string];
    }
    const parts = s.split(/\s+/);
    if (parts.length === 1) return [parts[0], ""] as [string, string];
    // 判断首部分是否为名缩写：仅当长度为 1（"J"）或带点号（"J."）时才视为缩写
    // 注意：长度 2 的拼音姓（如 "Li"、"Wu"）不应被误判
    const firstPartIsInitial = parts[0].length === 1 || /^([A-Z]\.)$/.test(parts[0]);
    if (firstPartIsInitial) {
      const last = parts[parts.length - 1];
      const first = parts.slice(0, -1).join(" ");
      return [last, first] as [string, string];
    }
    // 否则假设姓在前："Smith J K" → ["Smith", "J K"]
    const last = parts[0];
    const first = parts.slice(1).join(" ");
    return [last, first] as [string, string];
  });
}

/**
 * 将 UnifiedEntry 转换为 Zotero Item 对象（临时内存对象，不入库），
 * 用于调用 Zotero 内置的引用生成 API。
 */
function entryToZoteroItem(entry: UnifiedEntry): any {
  // 创建临时 Zotero Item（不保存到数据库）
  const item = new (Zotero as any).Item("journalArticle");

  if (entry.title) item.setField("title", entry.title);

  // 作者：解析为 [lastName, firstName] 并逐个添加 creator
  const authorList = parseAuthorList(entry.authors || entry.rawAuthors);
  const creators: any[] = [];
  for (const [last, first] of authorList) {
    if (!last) continue;
    const creator: any = {
      lastName: last,
      creatorType: "author",
      fieldMode: first ? 0 : 1,
    };
    if (first) {
      creator.firstName = first;
    }
    creators.push(creator);
  }
  if (creators.length > 0) {
    item.setCreators(creators);
  }

  // 日期
  if (entry.coverDate) {
    item.setField("date", entry.coverDate);
  }

  // 期刊名
  if (entry.publicationName) {
    item.setField("publicationTitle", entry.publicationName);
  }

  // 卷期页码
  if (entry.volume) item.setField("volume", entry.volume);
  if (entry.issue) item.setField("issue", entry.issue);
  if (entry.pageRange) item.setField("pages", entry.pageRange);

  // DOI / URL
  if (entry.doi) item.setField("DOI", entry.doi);
  if (entry.url) item.setField("url", entry.url);

  // ISSN / ISBN
  if (entry.issn) item.setField("ISSN", entry.issn);
  if (entry.isbn) item.setField("ISBN", entry.isbn);

  // 摘要
  if (entry.abstract) item.setField("abstractNote", entry.abstract);

  // 文献类型映射：统一使用 setType API（typeID 直接赋字符串不会生效）
  const subtype = (entry.subtype || "").toLowerCase();
  if (entry.source === "arxiv" || subtype === "preprint") {
    item.setType("preprint");
  } else if (subtype === "bk" || subtype === "book") {
    item.setType("book");
  } else if (subtype === "cp" || subtype === "conference") {
    item.setType("conferencePaper");
  }

  return item;
}

/**
 * 使用 Zotero 内置样式生成引用文本。
 * 通过创建临时 Zotero Item 调用 Zotero.QuickCopy.getContentFromItems，
 * 避免直接操作 citeproc-js 内部 API 导致的兼容性问题。
 * @param styleId Zotero 样式 ID（URI 形式，如 http://www.zotero.org/styles/apa）
 */
function generateZoteroCitation(entry: UnifiedEntry, styleId: string): string {
  try {
    const style = (Zotero as any).Styles.get(styleId);
    if (!style) return "[样式未找到，请在 Zotero 首选项 → 引用 中安装]";

    // 创建临时 Zotero Item
    const item = entryToZoteroItem(entry);

    // 方式 1：使用 Zotero.QuickCopy.getContentFromItems（推荐）
    // 需要 format 参数：styleId + | + mode (html/export)
    try {
      const format = styleId + "|html";
      const content = (Zotero as any).QuickCopy.getContentFromItems(
        [item],
        format,
        null,
        false,
      );
      if (content && content.html) {
        // 去除 HTML 标签
        return String(content.html).replace(/<[^>]+>/g, "").trim();
      }
      if (content && content.string) {
        return String(content.string).replace(/<[^>]+>/g, "").trim();
      }
    } catch {
      /* 降级到方式 2 */
    }

    // 方式 2：使用 Zotero.Cite.makeBibliography（直接调用 citeproc-js）
    const cslItem = entryToCSLJSON(entry);
    const locale = Zotero.locale || "en-US";
    const citeproc = style.getCiteProc(locale, "html");
    (citeproc as any).retrieveItem = (id: string | number) => {
      if (id === cslItem.id || String(id) === String(cslItem.id)) {
        return cslItem;
      }
      throw new Error(`Unknown item id: ${id}`);
    };
    citeproc.updateItems([cslItem.id]);
    const bib = citeproc.makeBibliography();
    if (!bib || !bib[1] || bib[1].length === 0) return "[生成失败：无输出]";
    const raw = bib[1].join("");
    return raw.replace(/<[^>]+>/g, "").trim();
  } catch (e) {
    return `[生成错误: ${(e as Error).message}]`;
  }
}

/**
 * 将 UnifiedEntry 转换为 CSL JSON（降级方案）。
 * CSL JSON 规范见 https://citeproc-js.readthedocs.io/en/latest/csl-json/markup.html
 */
function entryToCSLJSON(entry: UnifiedEntry): any {
  const authorList = parseAuthorList(entry.authors || entry.rawAuthors);
  const authors = authorList.map(([last, first]) => {
    if (!last) return null;
    if (!first || !first.trim()) return { family: last };
    return { family: last, given: first };
  }).filter(Boolean);

  const yearStr = (entry.coverDate || "").slice(0, 4);
  const year = parseInt(yearStr, 10);
  const issued = year
    ? { "date-parts": [[year]] }
    : undefined;

  // 文献类型映射
  let type = "article-journal";
  const subtype = (entry.subtype || "").toLowerCase();
  if (entry.source === "arxiv" || subtype.includes("preprint")) {
    type = "article";
  } else if (subtype.includes("book") || entry.subtype === "bk") {
    type = "book";
  } else if (subtype.includes("conference") || entry.subtype === "cp") {
    type = "paper-conference";
  }

  const csl: any = {
    id: 1,
    type,
    title: entry.title || "",
  };
  if (authors.length > 0) csl.author = authors;
  if (entry.publicationName) csl["container-title"] = entry.publicationName;
  if (issued) csl.issued = issued;
  if (entry.volume) csl.volume = entry.volume;
  if (entry.issue) csl.issue = entry.issue;
  if (entry.pageRange) csl.page = entry.pageRange;
  if (entry.doi) csl.DOI = entry.doi;
  if (entry.url) csl.URL = entry.url;
  if (entry.issn) csl.ISSN = entry.issn;
  if (entry.isbn) csl.ISBN = entry.isbn;
  if (entry.abstract) csl.abstract = entry.abstract;
  if (entry.keywords && entry.keywords.length > 0) csl.keyword = entry.keywords.join("; ");

  return csl;
}

/**
 * 获取 Zotero 已安装的所有引用样式，按标题排序。
 */
function getZoteroStyles(): Array<{ id: string; title: string }> {
  try {
    const styles = (Zotero as any).Styles.getAll();
    const result: Array<{ id: string; title: string }> = [];
    if (styles instanceof Map) {
      styles.forEach((style: any, id: string) => {
        if (style && style.styleID) {
          result.push({ id: style.styleID, title: style.title || style.styleID });
        }
      });
    } else if (styles && typeof styles === "object") {
      for (const key in styles) {
        const style = styles[key];
        if (style && style.styleID) {
          result.push({ id: style.styleID, title: style.title || style.styleID });
        }
      }
    }
    result.sort((a, b) => a.title.localeCompare(b.title));
    return result;
  } catch {
    return [];
  }
}

/**
 * 显示引用格式预览弹窗。
 * 使用 Zotero 内置引用样式，支持下拉框选择样式。
 */
function showCitationDialog(win: Window, entry: UnifiedEntry): void {
  const doc = win.document;
  // 移除已有弹窗
  const existing = doc.querySelector("#zsearch-citation-overlay");
  if (existing) existing.remove();

  const overlay = doc.createElement("div");
  overlay.id = "zsearch-citation-overlay";
  overlay.className = "zsearch-modal-overlay";

  const modal = doc.createElement("div");
  modal.className = "zsearch-modal";

  // 标题
  const title = doc.createElement("div");
  title.className = "zsearch-modal-title";
  title.textContent = getString("cite-dialog-title");
  modal.appendChild(title);

  // 说明
  const note = doc.createElement("div");
  note.className = "zsearch-modal-note";
  note.textContent = getString("cite-dialog-note");
  modal.appendChild(note);

  // 条目标题
  const entryTitle = doc.createElement("div");
  entryTitle.className = "zsearch-modal-entry-title";
  entryTitle.textContent = entry.title || "";
  modal.appendChild(entryTitle);

  // 样式选择下拉框
  const styleRow = doc.createElement("div");
  styleRow.className = "zsearch-citation-style-row";

  const styleLabel = doc.createElement("label");
  styleLabel.className = "zsearch-citation-style-label";
  styleLabel.textContent = getString("cite-style-label");
  styleLabel.htmlFor = "zsearch-citation-style-select";

  const styleSelect = doc.createElement("select");
  styleSelect.id = "zsearch-citation-style-select";
  styleSelect.className = "zsearch-citation-style-select";

  const styles = getZoteroStyles();
  // 优先选择的默认样式（按优先级排序）
  const preferredStyles = [
    "http://www.zotero.org/styles/gb-t-7714-2015-numeric",
    "http://www.zotero.org/styles/gb-t-7714-2015-note",
    "http://www.zotero.org/styles/china-national-standard-gb-t-7714-2015-numeric",
    "http://www.zotero.org/styles/apa",
    "http://www.zotero.org/styles/apa-7th-edition",
    "http://www.zotero.org/styles/modern-language-association",
    "http://www.zotero.org/styles/chicago-author-date",
    "http://www.zotero.org/styles/ieee",
  ];
  let defaultSelected = false;
  for (const s of styles) {
    const opt = doc.createElement("option");
    opt.value = s.id;
    opt.textContent = s.title;
    if (!defaultSelected && preferredStyles.includes(s.id)) {
      opt.selected = true;
      defaultSelected = true;
    }
    styleSelect.appendChild(opt);
  }
  // 若无首选样式可用，默认选第一个
  if (!defaultSelected && styles.length > 0) {
    const firstOpt = styleSelect.querySelector("option");
    if (firstOpt) (firstOpt as HTMLOptionElement).selected = true;
  }

  styleRow.appendChild(styleLabel);
  styleRow.appendChild(styleSelect);
  modal.appendChild(styleRow);

  // 引用文本显示区域
  const textArea = doc.createElement("div");
  textArea.className = "zsearch-citation-text zsearch-citation-text-preview";
  modal.appendChild(textArea);

  // 按钮行：复制 + 关闭
  const btnRow = doc.createElement("div");
  btnRow.className = "zsearch-modal-btn-row";

  const copyBtn = doc.createElement("button");
  copyBtn.className = "zsearch-btn zsearch-btn-secondary";
  copyBtn.textContent = getString("cite-copy");
  copyBtn.addEventListener("click", () => {
    const ok = copyToClipboard(win, textArea.textContent || "");
    copyBtn.textContent = ok ? "✓ 已复制" : "✗ 失败";
    setTimeout(() => (copyBtn.textContent = getString("cite-copy")), 1500);
  });

  // 生成引用的函数
  const updateCitation = () => {
    const styleId = styleSelect.value;
    textArea.textContent = getString("cite-generating");
    // 异步执行避免阻塞下拉框关闭
    setTimeout(() => {
      try {
        const citation = generateZoteroCitation(entry, styleId);
        textArea.textContent = citation;
      } catch (e) {
        textArea.textContent = getString("cite-error", { args: { message: (e as Error).message } });
      }
    }, 0);
  };

  // 初始生成
  updateCitation();
  // 切换样式时重新生成
  styleSelect.addEventListener("change", updateCitation);

  const closeBtn = doc.createElement("button");
  closeBtn.className = "zsearch-btn zsearch-btn-primary";
  closeBtn.textContent = getString("cite-close");
  closeBtn.addEventListener("click", () => overlay.remove());

  btnRow.appendChild(copyBtn);
  btnRow.appendChild(closeBtn);
  modal.appendChild(btnRow);

  overlay.appendChild(modal);
  // 点击遮罩关闭
  overlay.addEventListener("click", (ev: Event) => {
    if (ev.target === overlay) overlay.remove();
  });
  doc.body.appendChild(overlay);
}

/* ------------------------------------------------------------------ */
/* 阅读队列/收藏列表展示                                                */
/* ------------------------------------------------------------------ */

/** 显示阅读队列弹窗，列出所有收藏条目 */
function showStarredDialog(win: Window): void {
  const doc = win.document;
  const starred = getStarredEntries();

  // 移除已有弹窗
  const existing = doc.querySelector("#zsearch-starred-overlay");
  if (existing) existing.remove();

  const overlay = doc.createElement("div");
  overlay.id = "zsearch-starred-overlay";
  overlay.className = "zsearch-modal-overlay";

  const modal = doc.createElement("div");
  modal.className = "zsearch-modal";

  // 标题
  const title = doc.createElement("div");
  title.className = "zsearch-modal-title";
  title.textContent = `阅读队列（${starred.length} / ${STARRED_MAX}）`;
  modal.appendChild(title);

  if (starred.length === 0) {
    const empty = doc.createElement("div");
    empty.className = "zsearch-stats-row";
    empty.style.cssText = "padding: 24px; text-align: center; color: #70757a;";
    empty.textContent = getString("starred-empty");
    modal.appendChild(empty);
  } else {
    // 列表
    const list = doc.createElement("div");
    list.className = "zsearch-starred-list";
    for (const item of starred) {
      const row = doc.createElement("div");
      row.className = "zsearch-starred-item";
      const info = doc.createElement("div");
      info.className = "zsearch-starred-item-info";
      const t = doc.createElement("div");
      t.className = "zsearch-starred-item-title";
      t.textContent = item.title;
      const meta = doc.createElement("div");
      meta.className = "zsearch-starred-item-meta";
      const metaParts: string[] = [];
      if (item.doi) metaParts.push(`DOI: ${item.doi}`);
      if (item.savedAt) {
        const date = new Date(item.savedAt).toLocaleDateString();
        metaParts.push(`收藏于 ${date}`);
      }
      meta.textContent = metaParts.join(" · ");
      info.appendChild(t);
      info.appendChild(meta);
      // 点击标题在浏览器打开
      info.style.cursor = "pointer";
      info.addEventListener("click", () => {
        if (item.url) openInBrowser(item.url);
        else if (item.doi) openInBrowser(`https://doi.org/${item.doi}`);
      });
      row.appendChild(info);

      // 取消收藏按钮
      const removeBtn = doc.createElement("button");
      removeBtn.className = "zsearch-btn zsearch-btn-mini";
      removeBtn.textContent = getString("starred-remove");
      removeBtn.addEventListener("click", () => {
        const fakeEntry: UnifiedEntry = { source: "starred", title: item.title, doi: item.doi, url: item.url };
        toggleStarred(fakeEntry);
        row.remove();
        // 更新标题计数
        const newList = getStarredEntries();
        title.textContent = `阅读队列（${newList.length} / ${STARRED_MAX}）`;
        // 同步刷新搜索结果卡片的星标状态
        syncCardStarStates(win);
        showToast(win, getString("toast-starred-remove"), "info");
      });
      row.appendChild(removeBtn);
      list.appendChild(row);
    }
    modal.appendChild(list);

    // 清空全部按钮
    const clearBtn = doc.createElement("button");
    clearBtn.className = "zsearch-btn zsearch-btn-secondary";
    clearBtn.textContent = getString("starred-clear");
    clearBtn.style.marginRight = "8px";
    clearBtn.addEventListener("click", () => {
      if (confirm("确定要清空所有收藏吗？")) {
        setPref("starredEntries", "[]");
        title.textContent = `阅读队列（0 / ${STARRED_MAX}）`;
        list.innerHTML = "";
        // 同步刷新搜索结果卡片的星标状态（清空后所有卡片星标应变为未收藏）
        syncCardStarStates(win);
        showToast(win, "已清空阅读队列", "info");
      }
    });
    modal.appendChild(clearBtn);
  }

  // 关闭按钮
  const closeBtn = doc.createElement("button");
  closeBtn.className = "zsearch-btn zsearch-btn-secondary";
  closeBtn.textContent = getString("cite-close");
  closeBtn.addEventListener("click", () => overlay.remove());
  modal.appendChild(closeBtn);

  overlay.appendChild(modal);
  overlay.addEventListener("click", (ev: Event) => {
    if (ev.target === overlay) overlay.remove();
  });
  doc.body.appendChild(overlay);
}

/* ------------------------------------------------------------------ */
/* DOI/arXiv ID 直接定位                                                */
/* ------------------------------------------------------------------ */

/** 判断输入是否为 DOI 或 arXiv ID，并返回对应的识别 URL */
function detectIdentifier(input: string): { type: "doi" | "arxiv"; id: string; url: string } | null {
  const s = input.trim();
  if (!s) return null;
  // DOI：10.xxxx/yyyy
  const doiMatch = s.match(/\b(10\.\d{4,9}\/[-._;()\/:A-Za-z0-9]+)\b/i);
  if (doiMatch) {
    return { type: "doi", id: doiMatch[1], url: `https://doi.org/${doiMatch[1]}` };
  }
  // arXiv ID：2301.12345 或 arXiv:2301.12345
  const arxivMatch = s.match(/(?:arxiv:)?(\d{4}\.\d{4,5}(?:v\d+)?|[a-z\-]+\/\d{7})/i);
  if (arxivMatch) {
    return { type: "arxiv", id: arxivMatch[1], url: `https://arxiv.org/abs/${arxivMatch[1]}` };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 搜索结果统计面板                                                     */
/* ------------------------------------------------------------------ */

/** 显示搜索结果统计面板（年份分布、被引分布、OA 占比） */
function showStatsDialog(win: Window): void {
  const doc = win.document;
  const entries = searchWindowState?.lastEntries || [];
  if (entries.length === 0) {
    showToast(win, "无搜索结果可统计", "info");
    return;
  }

  // 移除已有弹窗
  const existing = doc.querySelector("#zsearch-stats-overlay");
  if (existing) existing.remove();

  // 统计
  const yearDist = new Map<string, number>();
  const citedBuckets = { "0": 0, "1-9": 0, "10-49": 0, "50-99": 0, "100+": 0 };
  let oaCount = 0;
  let withDoiCount = 0;
  let withAbstractCount = 0;

  for (const e of entries) {
    const year = (e.coverDate || "").slice(0, 4) || "未知";
    yearDist.set(year, (yearDist.get(year) || 0) + 1);
    const cited = e.citedByCount || 0;
    if (cited === 0) citedBuckets["0"]++;
    else if (cited < 10) citedBuckets["1-9"]++;
    else if (cited < 50) citedBuckets["10-49"]++;
    else if (cited < 100) citedBuckets["50-99"]++;
    else citedBuckets["100+"]++;
    if (e.openAccess) oaCount++;
    if (e.doi) withDoiCount++;
    if (e.abstract) withAbstractCount++;
  }

  const overlay = doc.createElement("div");
  overlay.id = "zsearch-stats-overlay";
  overlay.className = "zsearch-modal-overlay";

  const modal = doc.createElement("div");
  modal.className = "zsearch-modal";

  const title = doc.createElement("div");
  title.className = "zsearch-modal-title";
  title.textContent = `搜索结果统计（共 ${entries.length} 条）`;
  modal.appendChild(title);

  // 总览
  const overview = doc.createElement("div");
  overview.className = "zsearch-stats-section";
  const pct = (n: number) => ((n / entries.length) * 100).toFixed(1);
  const makeRow = (label: string, value: string) => {
    const row = doc.createElement("div");
    row.className = "zsearch-stats-row";
    const s1 = doc.createElement("span");
    s1.textContent = label;
    const s2 = doc.createElement("span");
    s2.textContent = value;
    row.appendChild(s1);
    row.appendChild(s2);
    return row;
  };
  overview.appendChild(makeRow("开放获取", `${oaCount} / ${entries.length}（${pct(oaCount)}%）`));
  overview.appendChild(makeRow("含 DOI", `${withDoiCount} / ${entries.length}（${pct(withDoiCount)}%）`));
  overview.appendChild(makeRow("含摘要", `${withAbstractCount} / ${entries.length}（${pct(withAbstractCount)}%）`));
  modal.appendChild(overview);

  // 年份分布
  const yearSection = doc.createElement("div");
  yearSection.className = "zsearch-stats-section";
  const yearTitle = doc.createElement("div");
  yearTitle.className = "zsearch-stats-section-title";
  yearTitle.textContent = getString("stats-year-title");
  yearSection.appendChild(yearTitle);

  const sortedYears = Array.from(yearDist.entries()).sort((a, b) => b[0].localeCompare(a[0]));
  const maxYearCount = Math.max(...sortedYears.map(([, c]) => c), 1);
  for (const [year, count] of sortedYears) {
    const row = doc.createElement("div");
    row.className = "zsearch-stats-bar-row";
    const label = doc.createElement("span");
    label.className = "zsearch-stats-bar-label";
    label.textContent = year;
    const barWrap = doc.createElement("div");
    barWrap.className = "zsearch-stats-bar-wrap";
    const bar = doc.createElement("div");
    bar.className = "zsearch-stats-bar";
    bar.style.width = `${(count / maxYearCount) * 100}%`;
    bar.textContent = String(count);
    barWrap.appendChild(bar);
    row.appendChild(label);
    row.appendChild(barWrap);
    yearSection.appendChild(row);
  }
  modal.appendChild(yearSection);

  // 被引分布
  const citedSection = doc.createElement("div");
  citedSection.className = "zsearch-stats-section";
  const citedTitle = doc.createElement("div");
  citedTitle.className = "zsearch-stats-section-title";
  citedTitle.textContent = getString("stats-cited-title");
  citedSection.appendChild(citedTitle);
  const maxCitedCount = Math.max(...Object.values(citedBuckets), 1);
  for (const [label, count] of Object.entries(citedBuckets)) {
    const row = doc.createElement("div");
    row.className = "zsearch-stats-bar-row";
    const labelEl = doc.createElement("span");
    labelEl.className = "zsearch-stats-bar-label";
    labelEl.textContent = label;
    const barWrap = doc.createElement("div");
    barWrap.className = "zsearch-stats-bar-wrap";
    const bar = doc.createElement("div");
    bar.className = "zsearch-stats-bar";
    bar.style.width = `${(count / maxCitedCount) * 100}%`;
    bar.textContent = String(count);
    barWrap.appendChild(bar);
    row.appendChild(labelEl);
    row.appendChild(barWrap);
    citedSection.appendChild(row);
  }
  modal.appendChild(citedSection);

  // 关闭按钮
  const closeBtn = doc.createElement("button");
  closeBtn.className = "zsearch-btn zsearch-btn-secondary";
  closeBtn.textContent = getString("stats-close");
  closeBtn.addEventListener("click", () => overlay.remove());
  modal.appendChild(closeBtn);

  overlay.appendChild(modal);
  overlay.addEventListener("click", (ev: Event) => {
    if (ev.target === overlay) overlay.remove();
  });
  doc.body.appendChild(overlay);
}

/** 读取搜索历史（返回数组，最新在前） */
function getSearchHistory(): string[] {
  try {
    const raw = (getPref("searchHistory") as string) || "[]";
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x: any) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** 记录一条搜索词到历史（去重，最新在前，最多 10 条） */
function addSearchHistory(query: string): void {
  const q = query.trim();
  if (!q) return;
  let history = getSearchHistory();
  // 去重：移除已存在的相同条目
  history = history.filter((h) => h !== q);
  // 添加到最前
  history.unshift(q);
  // 限制数量
  if (history.length > HISTORY_MAX) history = history.slice(0, HISTORY_MAX);
  try {
    setPref("searchHistory", JSON.stringify(history));
  } catch (e) {
    log.search.warn("addSearchHistory failed", e);
  }
}

/** 清空搜索历史 */
function clearSearchHistory(): void {
  try {
    setPref("searchHistory", "[]");
  } catch (e) {
    log.search.warn("clearSearchHistory failed", e);
  }
}

/**
 * 切换搜索历史面板的显示/隐藏。
 * 面板内列出最近 10 条搜索词，点击即填充到输入框并搜索。
 */
function toggleHistoryPanel(win: Window): void {
  const doc = win.document;
  const panel = doc.querySelector("#zsearch-history-panel") as HTMLElement;
  if (!panel) return;

  // 当前已显示：隐藏
  if (panel.style.display !== "none") {
    panel.style.display = "none";
    return;
  }

  // 构建面板内容
  panel.innerHTML = "";
  const history = getSearchHistory();

  // 头部：标题 + 清空按钮
  const header = doc.createElement("div");
  header.className = "zsearch-history-header";
  const titleEl = doc.createElement("span");
  titleEl.textContent = getString("history-label" as any);
  const clearBtn = doc.createElement("button");
  clearBtn.className = "zsearch-history-clear-btn";
  clearBtn.textContent = getString("history-clear" as any);
  clearBtn.addEventListener("click", () => {
    clearSearchHistory();
    toggleHistoryPanel(win);
  });
  header.appendChild(titleEl);
  header.appendChild(clearBtn);
  panel.appendChild(header);

  if (history.length === 0) {
    const empty = doc.createElement("div");
    empty.className = "zsearch-history-empty";
    empty.textContent = getString("history-empty" as any);
    panel.appendChild(empty);
  } else {
    for (const q of history) {
      const item = doc.createElement("div");
      item.className = "zsearch-history-item";
      const icon = doc.createElement("span");
      icon.className = "zsearch-history-item-icon";
      icon.textContent = "🕘";
      const text = doc.createElement("span");
      text.textContent = q;
      text.style.flex = "1";
      item.appendChild(icon);
      item.appendChild(text);
      item.addEventListener("click", () => {
        const input = doc.querySelector("#zsearch-input") as HTMLInputElement;
        if (input) {
          input.value = q;
          input.focus();
        }
        panel.style.display = "none";
        doSearch(win, searchWindowState!.elsevierClient, 1);
      });
      panel.appendChild(item);
    }
  }

  panel.style.display = "block";
}

function readFilters(doc: Document): SearchFilters {
  const yf = (doc.querySelector("#zsearch-year-from") as HTMLInputElement)?.value;
  const yt = (doc.querySelector("#zsearch-year-to") as HTMLInputElement)?.value;
  // menulist 读取：优先 .value，回退到 selectedIndex + menuitem value
  const sort = readMenulistValue(doc, "#zsearch-sort");
  const type = readMenulistValue(doc, "#zsearch-type");
  log.search.debug("readFilters", { yf, yt, sort, type });
  return {
    yearFrom: yf ? Number(yf) : undefined,
    yearTo: yt ? Number(yt) : undefined,
    sort: String(sort),
    type: String(type),
  };
}

/**
 * 动态创建 XUL menulist 并插入到占位 div 中。
 * 参考 zotero-addons 的 replaceSourceSelectList 做法：
 * - 用 doc.createXULElement 创建（在 XHTML 文档里比 xul: 前缀更可靠）
 * - 设置 native="true" 使用原生下拉
 * - 监听 command 事件
 * - 用 setAttribute("value", ...) 设置初始值
 */
function createMenulist(
  doc: Document,
  placeholderSelector: string,
  id: string,
  options: Array<{ value: string; label: string }>,
  currentValue: string,
): void {
  const placeholder = doc.querySelector(placeholderSelector);
  if (!placeholder) {
    log.search.warn(`createMenulist: placeholder ${placeholderSelector} not found`);
    return;
  }

  // 创建 menulist
  const menulist = (doc as any).createXULElement("menulist");
  menulist.id = id;
  menulist.setAttribute("native", "true");
  menulist.setAttribute("value", currentValue);
  menulist.setAttribute("selectedIndex", "0");
  menulist.style.cursor = "pointer";
  menulist.style.height = "28px";
  menulist.style.minHeight = "28px";
  menulist.className = "zsearch-filter-menulist";

  // 创建 menupopup + menuitem
  const menupopup = (doc as any).createXULElement("menupopup");
  let selectedIdx = 0;
  for (let i = 0; i < options.length; i++) {
    const opt = options[i];
    const menuitem = (doc as any).createXULElement("menuitem");
    menuitem.setAttribute("label", opt.label);
    menuitem.setAttribute("value", opt.value);
    if (opt.value === currentValue) {
      selectedIdx = i;
    }
    menupopup.appendChild(menuitem);
  }
  menulist.appendChild(menupopup);

  // 设置选中项
  try {
    menulist.selectedIndex = selectedIdx;
  } catch {
    /* ignore */
  }

  // 监听 command 事件（XUL 标准，不是 HTML 的 change）
  menulist.addEventListener("command", () => {
    const val = menulist.getAttribute("value");
    log.search.info(`menulist ${id} command: value=${val}`);
  });

  // 替换占位 div
  placeholder.parentNode!.replaceChild(menulist, placeholder);
}

/**
 * 可靠读取 XUL menulist 的选中值。
 * 参考 zotero-addons 做法：用 getAttribute("value") 读取。
 * 回退方案：通过 selectedIndex 读取选中 menuitem 的 value。
 */
function readMenulistValue(doc: Document, selector: string): string {
  const ml = doc.querySelector(selector) as any;
  if (!ml) return "";
  // 方式1：getAttribute("value")（zotero-addons 的做法）
  let val = ml.getAttribute && ml.getAttribute("value");
  if (val) return String(val);
  // 方式2：.value 属性（XUL menulist 标准属性）
  try {
    val = ml.value;
    if (val) return String(val);
  } catch {
    /* ignore */
  }
  // 方式3：通过 selectedIndex 读取选中 menuitem
  try {
    const idx = ml.selectedIndex;
    if (idx !== undefined && idx >= 0) {
      const items = ml.querySelectorAll("menuitem");
      const selected = items[idx];
      if (selected) {
        val = selected.getAttribute("value") || "";
        return String(val);
      }
    }
  } catch {
    /* ignore */
  }
  return "";
}

/**
 * 可靠设置 XUL menulist 的选中值。
 * 先尝试 .value = ... （XUL 会自动匹配 menuitem），失败则遍历 menuitem 找匹配项设 selectedIndex。
 */
function setMenulistValue(doc: Document, selector: string, value: string): void {
  const ml = doc.querySelector(selector) as any;
  if (!ml) return;
  const target = String(value || "");
  // 方式1：直接设 .value
  try {
    ml.value = target;
    if (ml.value === target) return;
  } catch {
    /* ignore */
  }
  // 方式2：遍历 menuitem 找匹配项
  try {
    const items = ml.querySelectorAll("menuitem");
    for (let i = 0; i < items.length; i++) {
      const v = items[i].getAttribute("value") || "";
      if (v === target) {
        ml.selectedIndex = i;
        return;
      }
    }
    // 未找到匹配项，默认选第一个
    if (items.length > 0) ml.selectedIndex = 0;
  } catch {
    /* ignore */
  }
}

/** 各搜索源的高级语法快捷按钮配置 */
const SYNTAX_BUTTONS: Record<string, Array<{ label: string; insert: string }>> = {
  scopus: [
    { label: "title", insert: "TITLE-ABS-KEY()" },
    { label: "author", insert: "AUTHOR-NAME()" },
    { label: "affil", insert: "AFFIL()" },
    { label: "year", insert: "PUBYEAR > 2020" },
    { label: "AND", insert: " AND " },
    { label: "OR", insert: " OR " },
    { label: "NOT", insert: " NOT " },
    { label: "ar", insert: 'LIMIT-TO(DOCTYPE,"ar")' },
    { label: "oa", insert: 'LIMIT-TO(OA,"all")' },
  ],
  pubmed: [
    { label: "tiab", insert: "[tiab]" },
    { label: "au", insert: "[au]" },
    { label: "dp", insert: "[dp]" },
    { label: "AND", insert: " AND " },
    { label: "OR", insert: " OR " },
    { label: "NOT", insert: " NOT " },
  ],
  arxiv: [
    { label: "ti:", insert: "ti:" },
    { label: "au:", insert: "au:" },
    { label: "abs:", insert: "abs:" },
    { label: "cat:", insert: "cat:" },
    { label: "AND", insert: " AND " },
    { label: "OR", insert: " OR " },
    { label: "ANDNOT", insert: " ANDNOT " },
  ],
  ieee: [
    { label: "AND", insert: " AND " },
    { label: "OR", insert: " OR " },
    { label: "NOT", insert: " NOT " },
  ],
  semanticscholar: [
    { label: "AND", insert: " AND " },
    { label: "OR", insert: " OR " },
  ],
  springer: [
    { label: "keyword", insert: "keyword:" },
    { label: "doi", insert: "doi:" },
    { label: "year", insert: "year:" },
    { label: "type", insert: "type:" },
    { label: "AND", insert: " AND " },
    { label: "OR", insert: " OR " },
  ],
  googleScholar: [
    // Google Scholar 仅支持自由文本，无特殊语法
  ],
  google: [],
  researchgate: [],
  jstor: [],
};

/**
 * 按当前搜索源更新语法快捷按钮。
 * 在语法栏的 label 和 divider 之间动态插入按钮。
 */
function updateSyntaxBar(win: Window, sourceId: string): void {
  const doc = win.document;
  const bar = doc.querySelector("#zsearch-syntax-bar");
  if (!bar) return;

  // 找到语法标签和分隔符之间的区域，清空后重新插入按钮
  const label = bar.querySelector(".zsearch-syntax-label");
  const divider = bar.querySelector(".zsearch-filter-divider");
  if (!label || !divider) return;

  // 移除旧的动态按钮（label 之后、divider 之前的所有 .zsearch-btn-syntax）
  let node = label.nextSibling;
  while (node && node !== divider) {
    const next = node.nextSibling;
    bar.removeChild(node);
    node = next;
  }

  // 获取当前源的语法按钮配置
  const buttons = SYNTAX_BUTTONS[sourceId] || [];
  if (buttons.length === 0) {
    // 无语法按钮时，在 label 后显示提示文字
    const hint = doc.createElement("span");
    hint.className = "zsearch-syntax-hint";
    hint.textContent = "(自由文本搜索)";
    hint.style.cssText = "font-size: 12px; color: #5f6368; margin-left: 4px;";
    bar.insertBefore(hint, divider);
    return;
  }

  const input = doc.querySelector("#zsearch-input") as HTMLInputElement;
  for (const opt of buttons) {
    const btn = doc.createElement("button");
    btn.className = "zsearch-btn zsearch-btn-syntax";
    btn.setAttribute("data-insert", opt.insert);
    btn.textContent = `{${opt.label}}`;
    btn.addEventListener("click", () => {
      insertSyntaxAtCursor(input, opt.insert);
      input.focus();
    });
    bar.insertBefore(btn, divider);
  }
}

/**
 * 创建搜索源下拉选择器。
 * 包含所有 API 源（可返回结构化结果）和 Web 源（浏览器跳转）。
 */
function createSourceMenulist(doc: Document): void {
  const placeholder = doc.querySelector("#zsearch-source-placeholder");
  if (!placeholder) {
    log.search.warn("createSourceMenulist: placeholder not found");
    return;
  }

  const sources = getAllSources();
  // 优先使用 getActiveSourceId 读取 pref（支持虚拟的 aggregate 源），
  // 若 pref 中是实际源 ID，则回退到 getActiveSource
  const activeId = getActiveSourceId();

  const options: Array<{ value: string; label: string }> = [
    // 聚合搜索放在首位
    { value: AGGREGATE_SOURCE_ID, label: "🔀 聚合搜索" },
  ];
  for (const s of sources) {
    options.push({ value: s.id, label: `${s.icon} ${s.name}` });
  }

  createMenulist(doc, "#zsearch-source-placeholder", "zsearch-source", options, activeId);

  // 监听切换事件
  const ml = doc.querySelector("#zsearch-source") as any;
  if (ml) {
    ml.addEventListener("command", () => {
      const val = readMenulistValue(doc, "#zsearch-source");
      if (val) {
        // 搜索进行中不允许切换源（防止状态污染）
        if (searchWindowState?.searching) {
          log.search.warn("Cannot switch source while searching");
          return;
        }
        setActiveSource(val);
        log.search.info(`Search source switched to: ${val}`);
        // 切换源时清理上次搜索的状态和 UI（结果区、分页栏、refine/rank 筛选等）
        resetStateOnSourceChange(doc, val);
        // 切换源时更新语法栏
        updateSyntaxBar(doc.defaultView as Window, val);
      }
    });
  }
}

async function doSearch(win: Window, client: ElsevierClient, page: number): Promise<void> {
  if (searchWindowState?.searching) return;
  const doc = win.document;
  const inputEl = doc.querySelector("#zsearch-input") as HTMLInputElement;
  const keywords = (inputEl?.value || "").trim();

  if (!keywords) {
    setStatus(doc, getString("search-placeholder"), "info");
    return;
  }

  // 检测 DOI/arXiv ID：若输入是单个标识符，直接在浏览器打开
  const identifier = detectIdentifier(keywords);
  if (identifier && page === 1) {
    // 仅当输入几乎只含标识符时才触发（长度限制避免误判含 DOI 的复杂查询）
    if (keywords.length <= identifier.id.length + 10) {
      openInBrowser(identifier.url);
      setStatus(
        doc,
        `检测到 ${identifier.type.toUpperCase()}：${identifier.id}，已在浏览器打开`,
        "info",
      );
      return;
    }
  }

  // 获取当前选中的搜索源
  const sourceId = readMenulistValue(doc, "#zsearch-source") || "scopus";

  // 聚合搜索：并行调用所有可用 API 源
  if (sourceId === AGGREGATE_SOURCE_ID) {
    const filters = readFilters(doc);
    log.search.info("doSearch (aggregate)", { keywords, filters, page });
    const state = searchWindowState!;
    state.lastQuery = keywords;
    addSearchHistory(keywords);
    state.searching = true;
    setSearchingUI(doc, true);
    state.lastFilters = filters;
    state.currentPage = 1;

    setStatus(doc, "🔀 聚合搜索中… (0/?)", "loading");
    const resultsEl = doc.querySelector("#zsearch-results") as HTMLElement;
    resultsEl.innerHTML = "";
    (doc.querySelector("#zsearch-pagination") as HTMLElement).style.display = "none";
    (doc.querySelector("#zsearch-batch") as HTMLElement).style.display = "none";
    const refineEl0 = doc.querySelector("#zsearch-refine") as HTMLElement;
    if (refineEl0) refineEl0.style.display = "none";

    // 重置聚合状态
    state.aggregatePage = 1;
    state.aggregateByDoi = undefined;
    state.aggregateByTitle = undefined;
    state.mode = "aggregate";
    // 初始化 rankedJournals 集合（跨加载更多持久化，避免重复请求 EasyScholar）
    state.aggregateRankedJournals = new Set<string>();

    const t0 = Date.now();
    try {
      // 聚合搜索：流式合并，每源完成即渲染
      const result = await aggregateSearch(
        keywords,
        filters,
        state.pageSize,
        (done, total, srcId, count) => {
          setStatus(doc, `🔀 聚合搜索中… (${done}/${total}) ${srcId}: +${count}条`, "loading");
        },
        (allMerged, newCount, doneSources, totalSources) => {
          // 流式增量渲染：每源完成即更新结果列表
          state.lastEntries = allMerged;
          state.total = allMerged.length;
          const elapsedMs = Date.now() - t0;
          renderResults(win, client, allMerged, allMerged.length, 1, elapsedMs);
          updateAggregatePagination(win, state);
          updateResultsScrollHeight(win);
          // 异步查询新增条目的期刊等级（仅查新条目，避免重复请求）
          if (newCount > 0) {
            const newEntries = allMerged.slice(allMerged.length - newCount);
            void fetchAndApplyRanksIncremental(win, newEntries, state.aggregateRankedJournals!);
          }
        },
        (byDoi, byTitle) => {
          // 保存去重映射供加载更多使用
          state.aggregateByDoi = byDoi;
          state.aggregateByTitle = byTitle;
        },
      );
      state.total = result.entries.length;
      state.lastEntries = result.entries;
      state.lastDurationMs = Date.now() - t0;
      state.searching = false;
      setSearchingUI(doc, false);

      // 最终渲染
      renderResults(win, client, result.entries, result.entries.length, 1, state.lastDurationMs);
      updateAggregatePagination(win, state);
      updateResultsScrollHeight(win);
      // 最终再补查一次 rank（覆盖之前失败的）
      void fetchAndApplyRanks(win, result.entries);
    } catch (e) {
      state.searching = false;
      setSearchingUI(doc, false);
      // 搜索失败时清空 lastEntries，避免统计面板显示陈旧数据
      state.lastEntries = [];
      state.total = 0;
      log.search.error("aggregate search failed", e);
      showSearchError(doc, e, { source: "aggregate", keywords, page });
    }
    return;
  }

  const source = getSourceById(sourceId);
  if (!source) {
    setStatus(doc, "No search source selected", "error");
    return;
  }

  // Web 源：在浏览器中打开搜索页
  if (source.kind === "web") {
    const webSrc = source as WebSearchSource;
    const url = getWebSearchUrl(webSrc, keywords);
    log.search.info(`Opening web search: ${webSrc.id} -> ${url}`);
    // 清理上次搜索的状态和 UI（避免显示旧源结果，让用户误以为是当前源的结果）
    resetStateOnSourceChange(doc, sourceId);
    // Web 源搜索也记录到历史
    addSearchHistory(keywords);
    openInBrowser(url);
    setStatus(doc, `Opened in browser: ${webSrc.name}`, "info");
    return;
  }

  // API 源：检查 API Key
  const apiSrc = source as ISearchSource;
  if (apiSrc.needsApiKey && !apiSrc.hasApiKey()) {
    showAPIKeyError(doc);
    return;
  }

  const filters = readFilters(doc);
  log.search.info("doSearch", { source: sourceId, keywords, filters, page });
  const state = searchWindowState!;
  state.lastQuery = keywords;
  // 记录搜索历史
  addSearchHistory(keywords);
  state.lastFilters = filters;
  state.currentPage = page;
  state.searching = true;
  setSearchingUI(doc, true);

  // 重置聚合状态：切回单源模式，恢复 prev/next 按钮原貌
  state.mode = "single";
  state.aggregatePage = 1;
  state.aggregateByDoi = undefined;
  state.aggregateByTitle = undefined;

  setStatus(doc, getString("searching"), "loading");
  // Clear previous results
  const resultsEl = doc.querySelector("#zsearch-results") as HTMLElement;
  resultsEl.innerHTML = "";
  (doc.querySelector("#zsearch-pagination") as HTMLElement).style.display = "none";
  (doc.querySelector("#zsearch-batch") as HTMLElement).style.display = "none";
  const refineElPre = doc.querySelector("#zsearch-refine") as HTMLElement;
  if (refineElPre) refineElPre.style.display = "none";

  const t0 = Date.now();

  try {
    const result = await apiSrc.search(keywords, filters, page, state.pageSize);
    state.total = result.total;
    state.lastEntries = result.entries;
    state.lastDurationMs = Date.now() - t0;
    state.searching = false;
    setSearchingUI(doc, false);

    // 立即渲染结果卡片（翻页时保留 refine/rank 筛选）
    const isPaging = page > 1;
    renderResults(win, client, result.entries, result.total, page, state.lastDurationMs, isPaging);

    // 渲染后重新计算滚动容器高度
    updateResultsScrollHeight(win);

    // 异步批量查询期刊等级（不阻塞渲染，查到后回填徽章）
    void fetchAndApplyRanks(win, result.entries);
  } catch (e) {
    state.searching = false;
    setSearchingUI(doc, false);
    // 搜索失败时清空 lastEntries（仅新搜索失败时），避免统计面板显示陈旧数据
    // 翻页失败时保留旧结果，用户仍可查看
    if (page === 1) {
      state.lastEntries = [];
      state.total = 0;
    }
    log.search.error("search failed", e);
    showSearchError(doc, e, { source: sourceId, keywords, page });
  }
}

/**
 * 批量查询当前页所有条目的期刊等级，并将结果回填到已渲染的卡片上。
 * - 期刊名去重后并发请求（EasyScholarClient 内部已去重 + 缓存）。
 * - 查到后通过 data-eid 定位卡片，在标题下方插入彩色等级徽章行。
 * - 未配置 EasyScholar API Key 时直接返回（不渲染徽章）。
 */
async function fetchAndApplyRanks(win: Window, entries: UnifiedEntry[]): Promise<void> {
  const state = searchWindowState;
  if (!state) return;
  const easyScholar = state.easyScholar;
  if (!easyScholar.hasApiKey()) return;

  // 收集去重的期刊名
  const names = entries
    .map((e) => e.publicationName)
    .filter((n): n is string => Boolean(n && n.trim()));
  if (names.length === 0) return;

  log.search.info(`fetchAndApplyRanks: ${names.length} journals to query`);
  try {
    const ranksMap = await easyScholar.getRanksBatch(names);
    state.lastRanks = ranksMap;
    log.search.info(`fetchAndApplyRanks: got ${ranksMap.size} results, applying to cards`);
    applyRanksToCards(win, entries, ranksMap);
  } catch (e) {
    log.search.warn("fetchAndApplyRanks failed", e);
  }
}

/**
 * 流式聚合搜索的增量 rank 查询：仅查询未查过的期刊名。
 * 避免每次 onBatch 都重复查询所有期刊。
 * @param rankedJournals 已查过的期刊名集合（会被此函数更新）
 */
async function fetchAndApplyRanksIncremental(
  win: Window,
  newEntries: UnifiedEntry[],
  rankedJournals: Set<string>,
): Promise<void> {
  const state = searchWindowState;
  if (!state) return;
  const easyScholar = state.easyScholar;
  if (!easyScholar.hasApiKey()) return;

  // 仅查询未查过的期刊名
  const names = newEntries
    .map((e) => e.publicationName)
    .filter((n): n is string => Boolean(n && n.trim()))
    .filter((n) => !rankedJournals.has(n));
  if (names.length === 0) return;

  // 标记为已查
  names.forEach((n) => rankedJournals.add(n));

  log.search.info(`fetchAndApplyRanksIncremental: ${names.length} new journals to query`);
  try {
    const ranksMap = await easyScholar.getRanksBatch(names);
    // 合并到 lastRanks
    if (state.lastRanks) {
      for (const [k, v] of ranksMap) state.lastRanks.set(k, v);
    } else {
      state.lastRanks = ranksMap;
    }
    applyRanksToCards(win, newEntries, ranksMap);
  } catch (e) {
    log.search.warn("fetchAndApplyRanksIncremental failed", e);
  }
}

/**
 * 将期刊等级徽章插入到已渲染的卡片中。
 * 通过 entry.eid 定位卡片（卡片元素带 data-eid 属性）。
 */
function applyRanksToCards(
  win: Window,
  entries: UnifiedEntry[],
  ranksMap: Map<string, EasyScholarRankData | null>,
): void {
  const doc = win.document;
  let applied = 0;
  for (const entry of entries) {
    if (!entry.sourceId || !entry.publicationName) continue;
    const card = doc.querySelector(
      `.zsearch-result[data-eid="${cssEscape(entry.sourceId)}"]`,
    ) as HTMLElement | null;
    if (!card) {
      log.search.warn(`applyRanksToCards: card not found for sourceId=${entry.sourceId}`);
      continue;
    }

    // 避免重复插入
    const existing = card.querySelector(":scope > .zsearch-result-ranks");
    if (existing) existing.remove();

    const rankData = ranksMap.get(entry.publicationName) || null;
    const badges = rankDataToBadges(rankData);
    if (badges.length === 0) continue;

    const ranksRow = buildRanksRow(doc, badges);
    // 插入到标题之后、meta 之前
    const titleEl = card.querySelector(":scope > .zsearch-result-title");
    if (titleEl) {
      titleEl.after(ranksRow);
    } else {
      card.prepend(ranksRow);
    }
    applied++;
  }
  log.search.info(`applyRanksToCards: applied badges to ${applied}/${entries.length} cards`);

  // 徽章插入后若当前有 rank 筛选条件，需重新应用筛选以更新可见性
  if (searchWindowState?.rankFilter && searchWindowState.rankFilter.size > 0) {
    applyFilters(win);
  }
}

/**
 * 构建期刊等级徽章行（彩色矩形背景）。
 * 每个 badge 一个 span，按 kind 着色（CSS class: zsearch-rank-{kind}）。
 * 同时设置 data-value 属性，便于 CSS 按 Q1/Q2/Q3/Q4 区分颜色。
 */
function buildRanksRow(
  doc: Document,
  badges: Array<{ label: string; value: string; kind: string }>,
): HTMLElement {
  const row = doc.createElement("div");
  row.className = "zsearch-result-ranks";
  for (const b of badges) {
    const span = doc.createElement("span");
    span.className = `zsearch-rank-badge zsearch-rank-${b.kind}`;
    span.textContent = b.label;
    span.setAttribute("title", b.label);
    span.setAttribute("data-value", b.value);
    span.setAttribute("data-kind", b.kind);
    row.appendChild(span);
  }
  return row;
}

/** CSS.escape polyfill（Zotero 内置 CSS 全局对象，但兜底一下）。 */
function cssEscape(s: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(s);
  }
  return String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => "\\" + c);
}

function formatError(msg: string): string {
  if (/apikey|401|unauthorized/i.test(msg)) {
    return getString("err-no-apikey");
  }
  if (/429|rate/i.test(msg)) {
    return getString("err-rate-limit");
  }
  if (/404|not found/i.test(msg)) {
    return getString("err-not-found");
  }
  return getString("err-generic", { args: { message: msg } });
}

/**
 * 在状态栏显示搜索失败的详细信息。
 * - 第一行：简洁的错误分类文案 + 错误码
 * - 可展开的详情区：搜索源、关键词、页码、完整错误消息、错误堆栈
 * - 详情默认折叠，点击"详情"切换
 */
function showSearchError(
  doc: Document,
  e: any,
  context: { source: string; keywords: string; page: number },
): void {
  const el = doc.querySelector("#zsearch-status") as HTMLElement;
  if (!el) return;

  el.className = "zsearch-status zsearch-error";
  el.innerHTML = "";

  // 提取错误信息
  const isApiError = e instanceof ElsevierAPIError;
  const status = isApiError ? (e as ElsevierAPIError).status : 0;
  const rawMsg = e?.message || String(e);
  const stack = e?.stack || "";
  const brief = formatError(rawMsg);

  // 第一行：简洁错误 + HTTP 状态码（若有）
  const mainLine = doc.createElement("span");
  mainLine.className = "zsearch-error-main";
  mainLine.textContent = status > 0 ? `${brief}  (HTTP ${status})` : brief;
  el.appendChild(mainLine);

  // "详情"切换按钮
  const toggle = doc.createElement("a");
  toggle.className = "zsearch-error-toggle";
  toggle.href = "#";
  toggle.textContent = getString("result-detail");
  toggle.style.cssText =
    "margin-left: 12px; color: #1a73e8; cursor: pointer; font-size: 12px; text-decoration: none;";
  el.appendChild(toggle);

  // 详情区（默认隐藏）
  const detail = doc.createElement("div");
  detail.className = "zsearch-error-detail";
  detail.style.cssText =
    "display: none; margin-top: 6px; padding: 8px 10px; background: #fef7f7; border: 1px solid #f5c5c5; border-radius: 4px; font-size: 12px; color: #5f2120; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre-wrap; word-break: break-all; max-height: 200px; overflow-y: auto;";

  const detailLines: string[] = [
    `搜索源: ${context.source}`,
    `关键词: ${context.keywords}`,
    `页码:   ${context.page}`,
    `错误类型: ${isApiError ? "ElsevierAPIError" : e?.constructor?.name || "Error"}`,
    `HTTP 状态: ${status > 0 ? status : "N/A"}`,
    `错误消息: ${rawMsg}`,
  ];
  if (stack) {
    detailLines.push("", "堆栈:", stack);
  }
  detail.textContent = detailLines.join("\n");
  el.appendChild(detail);

  toggle.addEventListener("click", (ev: Event) => {
    ev.preventDefault();
    const isHidden = detail.style.display === "none";
    detail.style.display = isHidden ? "block" : "none";
    toggle.textContent = isHidden ? "收起" : "详情";
  });
}

function showAPIKeyError(doc: Document): void {
  setStatus(doc, getString("err-no-apikey"), "error");
}

/**
 * 聚合搜索专用分页栏：显示"加载更多"按钮和当前条目数。
 * 聚合搜索不使用传统翻页，而是通过"加载更多"拉取各源下一页。
 */
function updateAggregatePagination(win: Window, state: NonNullable<typeof searchWindowState>): void {
  const doc = win.document;
  const pagination = doc.querySelector("#zsearch-pagination") as HTMLElement;
  if (!pagination) return;
  pagination.style.display = "flex";

  // 隐藏 prev 按钮，显示"加载更多"按钮和页码信息
  const prevBtn = doc.querySelector("#zsearch-prev") as HTMLButtonElement;
  if (prevBtn) prevBtn.style.display = "none";

  // 页码信息显示当前条目数和已加载页数
  const pageInfo = doc.querySelector("#zsearch-page-info") as HTMLElement;
  if (pageInfo) {
    pageInfo.textContent = `共 ${state.total} 条 (第 ${state.aggregatePage} 页)`;
  }

  // next 按钮改为"加载更多"
  const nextBtn = doc.querySelector("#zsearch-next") as HTMLButtonElement;
  if (nextBtn) {
    nextBtn.textContent = getString("load-more");
    nextBtn.style.display = "";
    nextBtn.disabled = state.searching;
    // 移除原有 click 监听（通过克隆节点）
    const newNext = nextBtn.cloneNode(true) as HTMLButtonElement;
    nextBtn.parentNode?.replaceChild(newNext, nextBtn);
    newNext.addEventListener("click", () => loadMoreAggregate(win, state.elsevierClient));
  }
}

/**
 * 在结果列表末尾显示加载占位符（spinner + 提示文字）。
 * 加载更多时调用，让用户直观看到"正在加载"而不跳动已有卡片。
 */
function showLoadMorePlaceholder(win: Window, text: string = "加载中…"): HTMLElement | null {
  const doc = win.document;
  const resultsEl = doc.querySelector("#zsearch-results") as HTMLElement;
  if (!resultsEl) return null;
  // 已存在则先移除
  const existing = resultsEl.querySelector("#zsearch-loadmore-placeholder");
  if (existing) existing.remove();
  const placeholder = doc.createElement("div");
  placeholder.id = "zsearch-loadmore-placeholder";
  placeholder.className = "zsearch-loadmore-placeholder";
  placeholder.style.cssText =
    "display: flex; align-items: center; justify-content: center; gap: 10px; padding: 18px 12px; color: #5f6368; font-size: 13px; border-top: 1px dashed rgba(0,0,0,0.1);";
  const spinner = doc.createElement("span");
  spinner.className = "zsearch-spinner";
  placeholder.appendChild(spinner);
  const textEl = doc.createElement("span");
  textEl.textContent = text;
  placeholder.appendChild(textEl);
  resultsEl.appendChild(placeholder);
  return placeholder;
}

/**
 * 更新加载占位符的文字。
 */
function updateLoadMorePlaceholder(win: Window, text: string): void {
  const doc = win.document;
  const placeholder = doc.querySelector("#zsearch-loadmore-placeholder");
  if (!placeholder) return;
  const textEl = placeholder.querySelector("span:last-child");
  if (textEl) textEl.textContent = text;
}

/**
 * 移除加载占位符。
 */
function removeLoadMorePlaceholder(win: Window): void {
  const doc = win.document;
  const placeholder = doc.querySelector("#zsearch-loadmore-placeholder");
  if (placeholder) placeholder.remove();
}

/**
 * 增量追加新卡片到结果列表末尾（不重建已有卡片，保持用户滚动位置）。
 * 用于"加载更多"流程：每源完成即追加新增条目，加载占位符始终位于末尾。
 * @param win 窗口
 * @param client Elsevier 客户端
 * @param allEntries 合并后的全量条目（用于计算 data-idx）
 * @param prevCount 追加前已有的条目数（新条目从 prevCount 开始）
 * @returns 新追加的卡片数
 */
function appendResultCards(
  win: Window,
  client: ElsevierClient,
  allEntries: UnifiedEntry[],
  prevCount: number,
): number {
  const doc = win.document;
  const resultsEl = doc.querySelector("#zsearch-results") as HTMLElement;
  if (!resultsEl) return 0;

  // 保留用户已勾选的复选框状态（通过 DOI/sourceId/title 标识）
  const selectedIds = new Set<string>();
  const oldCheckboxes = doc.querySelectorAll<HTMLInputElement>(".zsearch-result-checkbox");
  oldCheckboxes.forEach((cb) => {
    if (!cb.checked) return;
    const card = cb.closest(".zsearch-result") as HTMLElement | null;
    if (!card) return;
    const cardIdx = Number(card.getAttribute("data-idx") || "-1");
    const oldEntries = searchWindowState?.lastEntries || [];
    const entry = cardIdx >= 0 ? oldEntries[cardIdx] : undefined;
    if (entry) {
      const id = entry.doi || entry.sourceId || entry.title || "";
      if (id) selectedIds.add(id);
    }
  });

  // 取出新增条目（从 prevCount 到 allEntries.length）
  const newEntries = allEntries.slice(prevCount);
  if (newEntries.length === 0) return 0;

  // 加载占位符（若存在）需在追加后重新放到末尾
  const placeholder = resultsEl.querySelector("#zsearch-loadmore-placeholder");

  // 为每个新条目创建卡片并插入到占位符之前
  for (let i = 0; i < newEntries.length; i++) {
    const entry = newEntries[i];
    const idx = prevCount + i; // 在 allEntries 中的全局索引
    const card = buildResultCard(win, client, entry, idx);
    // 恢复选中状态
    const id = entry.doi || entry.sourceId || entry.title || "";
    if (id && selectedIds.has(id)) {
      const cb = card.querySelector<HTMLInputElement>(".zsearch-result-checkbox");
      if (cb) cb.checked = true;
    }
    if (placeholder) {
      placeholder.parentNode?.insertBefore(card, placeholder);
    } else {
      resultsEl.appendChild(card);
    }
  }

  // 新卡片追加后应用当前筛选条件（让新卡片也遵循 refine/rank 筛选）
  applyFilters(win);

  return newEntries.length;
}

/**
 * 聚合搜索"加载更多"：拉取各源下一页并合并到现有结果。
 * 关键：增量追加新卡片，不调用 renderResults 全量重建，保持用户滚动位置。
 */
async function loadMoreAggregate(win: Window, client: ElsevierClient): Promise<void> {
  const state = searchWindowState;
  if (!state || state.searching) return;
  if (!state.aggregateByDoi || !state.aggregateByTitle) {
    log.search.warn("loadMoreAggregate: 去重映射未初始化");
    return;
  }
  if (!state.lastQuery) return;

  const doc = win.document;
  state.searching = true;
  setSearchingUI(doc, true);
  state.aggregatePage += 1;
  const nextPage = state.aggregatePage;
  const t0 = Date.now();

  // 记录追加前的条目数（用于增量追加）
  let prevCount = state.lastEntries.length;

  // 显示加载占位符并更新状态栏
  showLoadMorePlaceholder(win, `🔀 加载更多… (0/?) 第 ${nextPage} 页`);
  setStatus(doc, `🔀 加载更多… (0/?) 第 ${nextPage} 页`, "loading");
  // 确保"加载更多"按钮在加载期间禁用
  const nextBtn = doc.querySelector("#zsearch-next") as HTMLButtonElement;
  if (nextBtn) nextBtn.disabled = true;

  // 复用 state 中的 rankedJournals 集合（跨加载更多持久化，避免重复请求 EasyScholar）
  if (!state.aggregateRankedJournals) state.aggregateRankedJournals = new Set<string>();
  try {
    const result = await aggregateSearchMore(
      state.lastQuery,
      state.lastFilters,
      state.pageSize,
      nextPage,
      state.lastEntries,
      state.aggregateByDoi,
      state.aggregateByTitle,
      (done, total, srcId, count) => {
        const progressText = `🔀 加载更多… (${done}/${total}) ${srcId}: +${count}条`;
        setStatus(doc, progressText, "loading");
        updateLoadMorePlaceholder(win, progressText);
      },
      (allMerged, newCount, doneSources, totalSources) => {
        // 流式增量追加：仅追加新增条目，不重建已有卡片
        state.lastEntries = allMerged;
        state.total = allMerged.length;
        const appended = appendResultCards(win, client, allMerged, prevCount);
        if (appended > 0) prevCount = allMerged.length;
        // 更新分页信息（条目数和页码）
        const pageInfo = doc.querySelector("#zsearch-page-info") as HTMLElement;
        if (pageInfo) {
          pageInfo.textContent = `共 ${state.total} 条 (第 ${state.aggregatePage} 页)`;
        }
        // 异步查询新增条目的期刊等级（仅查新条目，避免重复请求）
        if (appended > 0) {
          const newEntries = allMerged.slice(allMerged.length - appended);
          void fetchAndApplyRanksIncremental(win, newEntries, state.aggregateRankedJournals!);
        }
      },
    );
    state.total = result.entries.length;
    state.lastEntries = result.entries;
    state.lastDurationMs = Date.now() - t0;
    state.searching = false;
    setSearchingUI(doc, false);

    // 移除加载占位符
    removeLoadMorePlaceholder(win);
    // 更新状态栏显示最终结果数和耗时
    const seconds = (state.lastDurationMs / 1000).toFixed(2);
    setStatus(
      doc,
      getString("results-count", { args: { total: String(state.total), seconds } }),
      "info",
    );
    updateAggregatePagination(win, state);
    updateResultsScrollHeight(win);
  } catch (e) {
    state.searching = false;
    setSearchingUI(doc, false);
    state.aggregatePage -= 1; // 回退页码
    removeLoadMorePlaceholder(win);
    log.search.error("loadMoreAggregate failed", e);
    setStatus(doc, `加载更多失败: ${(e as Error).message}`, "error");
  }
}

function renderResults(
  win: Window,
  client: ElsevierClient,
  entries: UnifiedEntry[],
  total: number,
  page: number,
  durationMs: number,
  preserveFilters: boolean = false,
): void {
  const doc = win.document;
  const resultsEl = doc.querySelector("#zsearch-results") as HTMLElement;

  // 加载更多时：保留用户已勾选的复选框状态（通过 entry 的 sourceId 或 DOI 标识）
  // 避免用户选中几条准备导出后，点击"加载更多"丢失选择
  const selectedSourceIds = new Set<string>();
  if (preserveFilters) {
    const oldCheckboxes = doc.querySelectorAll<HTMLInputElement>(".zsearch-result-checkbox");
    oldCheckboxes.forEach((cb) => {
      if (!cb.checked) return;
      const card = cb.closest(".zsearch-result") as HTMLElement | null;
      if (!card) return;
      const cardIdx = Number(card.getAttribute("data-idx") || "-1");
      const oldEntries = searchWindowState?.lastEntries || [];
      const entry = cardIdx >= 0 ? oldEntries[cardIdx] : undefined;
      if (entry) {
        const id = entry.doi || entry.sourceId || entry.title || "";
        if (id) selectedSourceIds.add(id);
      }
    });
  }

  // 清空容器：避免聚合搜索流式渲染时重复追加卡片
  resultsEl.innerHTML = "";

  if (entries.length === 0) {
    setStatus(doc, getString("no-results"), "info");
    // 空结果时隐藏 batch、refine bar、pagination，避免旧状态残留
    (doc.querySelector("#zsearch-batch") as HTMLElement).style.display = "none";
    const refineEl0 = doc.querySelector("#zsearch-refine") as HTMLElement;
    if (refineEl0) refineEl0.style.display = "none";
    (doc.querySelector("#zsearch-pagination") as HTMLElement).style.display = "none";
    // 清理筛选状态
    if (searchWindowState) {
      searchWindowState.rankFilter.clear();
      rankFilterMatchers.clear();
      searchWindowState.currentRefine = "all";
    }
    updateResultsScrollHeight(win);
    return;
  }
  const seconds = (durationMs / 1000).toFixed(2);
  setStatus(
    doc,
    getString("results-count", { args: { total: String(total), seconds } }),
    "info",
  );

  // Batch actions
  (doc.querySelector("#zsearch-batch") as HTMLElement).style.display = "flex";
  // Refine bar：结果加载后显示
  const refineEl = doc.querySelector("#zsearch-refine") as HTMLElement;
  if (refineEl) {
    refineEl.style.display = "flex";
    if (!preserveFilters) {
      // 新搜索：重置 active 状态到 All
      const refineBtns = doc.querySelectorAll<HTMLButtonElement>(".zsearch-btn-chip");
      refineBtns.forEach((b) => b.classList.remove("zsearch-refine-active"));
      const allBtn = doc.querySelector<HTMLButtonElement>('.zsearch-btn-chip[data-refine="all"]');
      if (allBtn) allBtn.classList.add("zsearch-refine-active");
      // 重置 refine 状态
      if (searchWindowState) {
        searchWindowState.currentRefine = "all";
        // 清除期刊等级筛选：避免新搜索后 rankFilter 残留导致卡片被隐藏
        searchWindowState.rankFilter.clear();
        rankFilterMatchers.clear();
      }
      // 取消等级筛选面板中所有复选框的勾选
      const rankCheckboxes = doc.querySelectorAll<HTMLInputElement>(".zsearch-rankfilter-checkbox");
      rankCheckboxes.forEach((cb) => { cb.checked = false; });
      // 重置等级筛选按钮标签
      updateRankFilterButton(win);
      // 初始化计数为 "N / N"（当前为"全部"筛选，所有卡片可见）
      const countEl = doc.querySelector("#zsearch-refine-count") as HTMLElement;
      if (countEl) {
        countEl.textContent = getString("refine-count" as any, {
          args: { shown: String(entries.length), total: String(entries.length) },
        });
      }
    }
    // preserveFilters=true 时保留当前 active 状态和计数（后续 applyFilters 会更新计数）
  }
  // 重置全选复选框
  const selectAll = doc.querySelector("#zsearch-select-all") as HTMLInputElement;
  if (selectAll) selectAll.checked = false;
  // 重置导出按钮状态
  updateExportButtonsState(win);

  // Result cards
  for (let i = 0; i < entries.length; i++) {
    resultsEl.appendChild(buildResultCard(win, client, entries[i], i));
  }

  // 加载更多时：恢复之前选中的复选框状态
  if (preserveFilters && selectedSourceIds.size > 0) {
    const cards = doc.querySelectorAll<HTMLElement>(".zsearch-result");
    cards.forEach((card) => {
      const cardIdx = Number(card.getAttribute("data-idx") || "-1");
      const entry = cardIdx >= 0 ? entries[cardIdx] : undefined;
      if (!entry) return;
      const id = entry.doi || entry.sourceId || entry.title || "";
      if (id && selectedSourceIds.has(id)) {
        const cb = card.querySelector<HTMLInputElement>(".zsearch-result-checkbox");
        if (cb) cb.checked = true;
      }
    });
    // 重新更新导出按钮状态
    updateExportButtonsState(win);
  }

  // Pagination：聚合搜索由 updateAggregatePagination 单独处理，单源搜索用默认分页
  const isAggregate = searchWindowState?.mode === "aggregate";
  if (!isAggregate) {
    const pageSize = searchWindowState!.pageSize;
    const totalPages = Math.min(Math.ceil(total / pageSize), 200) || 1;
    (doc.querySelector("#zsearch-pagination") as HTMLElement).style.display = "flex";

    // 关键修复：聚合搜索的 updateAggregatePagination 会用 cloneNode 替换 next 按钮并绑定
    // loadMoreAggregate 监听器。切回单源搜索时必须用 cloneNode 重置监听器，否则单源翻页会
    // 错误触发 loadMoreAggregate。
    const prevBtnOld = doc.querySelector("#zsearch-prev") as HTMLButtonElement;
    if (prevBtnOld) {
      const prevBtn = prevBtnOld.cloneNode(true) as HTMLButtonElement;
      prevBtnOld.parentNode?.replaceChild(prevBtn, prevBtnOld);
      prevBtn.style.display = "";
      prevBtn.textContent = "‹ Prev";
      prevBtn.disabled = page <= 1;
      prevBtn.addEventListener("click", () => {
        if (searchWindowState && searchWindowState.currentPage > 1) {
          doSearch(win, client, searchWindowState.currentPage - 1);
        }
      });
    }
    const nextBtnOld = doc.querySelector("#zsearch-next") as HTMLButtonElement;
    if (nextBtnOld) {
      const nextBtn = nextBtnOld.cloneNode(true) as HTMLButtonElement;
      nextBtnOld.parentNode?.replaceChild(nextBtn, nextBtnOld);
      nextBtn.textContent = "Next ›";
      nextBtn.style.display = "";
      nextBtn.disabled = page * pageSize >= total;
      nextBtn.addEventListener("click", () => {
        if (
          searchWindowState &&
          searchWindowState.currentPage * searchWindowState.pageSize < searchWindowState.total
        ) {
          doSearch(win, client, searchWindowState.currentPage + 1);
        }
      });
    }
    (doc.querySelector("#zsearch-page-info") as HTMLElement).textContent =
      getString("pagination-page", { args: { page: String(page), total: String(totalPages) } });
  }

  // 重新计算滚动容器高度（pagination 显示后布局变化）
  updateResultsScrollHeight(win);

  // 加载更多时：应用当前 refine + rank 筛选条件到新渲染的卡片
  if (preserveFilters && searchWindowState) {
    applyFilters(win);
  }
}

/**
 * 构建搜索结果卡片。
 * 显示：标题 / 至多3位作者 / 期刊+年份+卷期 / 一行摘要 / 引用数+OA徽章 / 导入按钮
 * 悬浮显示完整信息（title 属性）
 */
function buildResultCard(win: Window, client: ElsevierClient, entry: UnifiedEntry, index: number): HTMLElement {
  const doc = win.document;
  const card = doc.createElement("div");
  card.className = "zsearch-result";
  // 用 sourceId 作为卡片唯一标识，便于异步查询期刊等级后回填徽章
  if (entry.sourceId) card.setAttribute("data-eid", entry.sourceId);
  // 保存 entry 索引（用于复选框导出，避免 indexOf 的引用相等性依赖）
  card.setAttribute("data-idx", String(index));

  // 左侧复选框（用于批量导出）
  const checkbox = doc.createElement("input");
  // XHTML 文档必须用 setAttribute 设置 type，直接赋值不可靠
  checkbox.setAttribute("type", "checkbox");
  checkbox.className = "zsearch-result-checkbox";
  checkbox.addEventListener("change", () => updateExportButtonsState(win));
  card.appendChild(checkbox);

  // 检查是否已在 Zotero 库中（通过 DOI 匹配）
  const inLibrary = isEntryInLibrary(entry);

  // 构建完整悬浮提示文本（显示完整作者列表，不限数量）
  const tooltipParts: string[] = [];
  tooltipParts.push(`Title: ${entry.title || "(no title)"}`);
  // tooltip 中显示所有作者
  const allAuthors = entry.authors || entry.rawAuthors;
  if (allAuthors) {
    const formattedAll = formatAuthors(allAuthors, 9999); // 不限制数量
    if (formattedAll) tooltipParts.push(`Authors: ${formattedAll}`);
  }
  if (entry.publicationName) tooltipParts.push(`Journal: ${entry.publicationName}`);
  if (entry.coverDate) tooltipParts.push(`Date: ${entry.coverDate}`);
  if (entry.volume) tooltipParts.push(`Volume: ${entry.volume}`);
  if (entry.issue) tooltipParts.push(`Issue: ${entry.issue}`);
  if (entry.pageRange) tooltipParts.push(`Pages: ${entry.pageRange}`);
  if (entry.doi) tooltipParts.push(`DOI: ${entry.doi}`);
  if (entry.citedByCount !== undefined) tooltipParts.push(`Cited by: ${entry.citedByCount}`);
  if (entry.openAccess) tooltipParts.push(`Open Access: Yes`);
  if (entry.subtypeDescription) tooltipParts.push(`Type: ${entry.subtypeDescription}`);
  if (entry.abstract) tooltipParts.push(`\nAbstract: ${entry.abstract}`);
  card.setAttribute("title", tooltipParts.join("\n"));

  // Title (link) - 关键词高亮
  const title = doc.createElement("a");
  title.className = "zsearch-result-title";
  const titleText = entry.title || "(no title)";
  const query = searchWindowState?.lastQuery || "";
  if (query) {
    title.innerHTML = highlightKeywords(doc, titleText, query);
  } else {
    title.textContent = titleText;
  }
  const href =
    entry.url ||
    (entry.doi ? `https://doi.org/${entry.doi}` : entry.sourceId || "#");
  title.href = href;
  title.addEventListener("click", (ev: Event) => {
    ev.preventDefault();
    openInBrowser(href);
  });
  card.appendChild(title);

  // Meta line: 至多3位作者 — journal, year, vol(issue):pages
  const meta = doc.createElement("div");
  meta.className = "zsearch-result-meta";
  const metaParts: string[] = [];

  // 作者处理：至多显示3位
  const authorStr = entry.authors || entry.rawAuthors || "";
  log.search.info(`buildResultCard authors: type=${typeof authorStr}, isArray=${Array.isArray(authorStr)}, value=${JSON.stringify(authorStr)?.slice(0, 200)}`);
  if (authorStr) {
    const formatted = formatAuthors(authorStr, 3);
    if (formatted) metaParts.push(formatted);
  }
  if (entry.publicationName) metaParts.push(`— ${entry.publicationName}`);
  const year = (entry.coverDate || "").slice(0, 4) || entry.coverDisplayDate || "";
  if (year) metaParts.push(year);
  const volIssue = [
    entry.volume ? `vol.${entry.volume}` : "",
    entry.issue ? `(${entry.issue})` : "",
    entry.pageRange ? `, pp.${entry.pageRange}` : entry.articleNumber ? `, art.no.${entry.articleNumber}` : "",
  ].join("");
  if (volIssue) metaParts.push(volIssue);
  meta.textContent = metaParts.join(" ");
  card.appendChild(meta);

  // URL line (DOI green) + 复制按钮
  if (entry.doi) {
    const urlEl = doc.createElement("div");
    urlEl.className = "zsearch-result-url";

    const doiLink = doc.createElement("span");
    doiLink.textContent = `https://doi.org/${entry.doi}`;
    urlEl.appendChild(doiLink);

    const copyBtn = doc.createElement("button");
    copyBtn.className = "zsearch-btn zsearch-btn-mini zsearch-btn-copy";
    copyBtn.textContent = getString("result-copy-doi");
    copyBtn.title = entry.doi;
    copyBtn.addEventListener("click", () => {
      const ok = copyToClipboard(win, entry.doi || "");
      copyBtn.textContent = ok
        ? getString("result-copied")
        : "✗";
      showToast(win, ok ? getString("toast-doi-copied" as any) : "复制失败", ok ? "success" : "error");
      setTimeout(() => {
        copyBtn.textContent = getString("result-copy-doi");
      }, 2000);
    });
    urlEl.appendChild(copyBtn);

    card.appendChild(urlEl);
  }

  // Abstract snippet — 只显示一行，关键词高亮；双击展开完整摘要
  if (entry.abstract) {
    const abs = doc.createElement("div");
    abs.className = "zsearch-result-abstract";
    const query2 = searchWindowState?.lastQuery || "";
    if (query2) {
      abs.innerHTML = highlightKeywords(doc, entry.abstract, query2);
    } else {
      abs.textContent = entry.abstract;
    }
    // 双击摘要：切换展开/收起
    abs.addEventListener("dblclick", (ev: Event) => {
      ev.preventDefault();
      if (abs.classList.contains("zsearch-abstract-expanded")) {
        abs.classList.remove("zsearch-abstract-expanded");
        abs.title = "双击展开完整摘要";
      } else {
        abs.classList.add("zsearch-abstract-expanded");
        abs.title = "双击收起摘要";
      }
    });
    abs.title = "双击展开完整摘要";
    card.appendChild(abs);
  }

  // Actions row: badges + import button (无 PDF 按钮)
  const actions = doc.createElement("div");
  actions.className = "zsearch-result-actions";

  // 来源徽章（聚合搜索时显示多来源；单源时显示该来源）
  const sourceIcons: Record<string, string> = {
    scopus: "🔬 Scopus",
    pubmed: "🏥 PubMed",
    arxiv: "📄 arXiv",
    semanticscholar: "🧠 S2",
    springer: "📚 Springer",
    googleScholar: "🎓 GS",
    ieee: "⚡ IEEE",
  };
  const sourceList = entry.sources && entry.sources.length > 0
    ? entry.sources
    : [entry.source];
  if (sourceList.length > 0) {
    const sourceBadge = doc.createElement("span");
    sourceBadge.className = "zsearch-badge zsearch-badge-source";
    sourceBadge.textContent = sourceList
      .map((s) => sourceIcons[s] || s)
      .join(" + ");
    if (sourceList.length > 1) {
      sourceBadge.classList.add("zsearch-badge-source-multi");
      sourceBadge.title = `命中 ${sourceList.length} 个来源：${sourceList.join(", ")}`;
    }
    actions.appendChild(sourceBadge);
  }

  // Cited badge
  if (entry.citedByCount !== undefined) {
    const cited = doc.createElement("span");
    cited.className = "zsearch-badge zsearch-badge-cited";
    cited.textContent = getString("result-cited", { args: { count: String(entry.citedByCount) } });
    actions.appendChild(cited);
  }
  // OA badge
  if (entry.openAccess) {
    const oa = doc.createElement("span");
    oa.className = "zsearch-badge zsearch-badge-oa";
    oa.textContent = getString("result-oa");
    actions.appendChild(oa);
  }

  // 已在库中标记
  if (inLibrary) {
    const existsBadge = doc.createElement("span");
    existsBadge.className = "zsearch-badge zsearch-badge-exists";
    existsBadge.textContent = getString("result-exists" as any);
    actions.appendChild(existsBadge);
  }

  // 收藏按钮（星标）
  const starBtn = doc.createElement("button");
  starBtn.className = "zsearch-btn zsearch-btn-icon zsearch-btn-star";
  starBtn.title = "收藏到阅读队列";
  const starred = isEntryStarred(entry);
  if (starred) {
    starBtn.classList.add("zsearch-starred");
    starBtn.textContent = "★";
  } else {
    starBtn.textContent = "☆";
  }
  starBtn.addEventListener("click", () => {
    const nowStarred = toggleStarred(entry);
    if (nowStarred) {
      starBtn.classList.add("zsearch-starred");
      starBtn.textContent = "★";
      showToast(win, getString("toast-starred-add"), "success");
    } else {
      starBtn.classList.remove("zsearch-starred");
      starBtn.textContent = "☆";
      showToast(win, getString("toast-starred-remove"), "info");
    }
  });
  actions.appendChild(starBtn);

  // spacer
  const spacer = doc.createElement("span");
  spacer.className = "zsearch-result-spacer";
  actions.appendChild(spacer);

  // 翻译标题按钮（手动触发，调用 zotero-pdf-translate 插件 API）
  const translateBtn = doc.createElement("button");
  translateBtn.className = "zsearch-btn zsearch-btn-secondary zsearch-btn-small zsearch-btn-translate";
  translateBtn.textContent = getString("result-translate");
  translateBtn.title = "翻译标题（依赖 zotero-pdf-translate 插件）";
  translateBtn.addEventListener("click", async () => {
    if (!isPDFTranslateAvailable()) {
      showToast(win, getString("toast-translate-no-plugin"), "error");
      return;
    }
    if (!entry.title) {
      showToast(win, getString("toast-translate-no-title"), "info");
      return;
    }
    translateBtn.disabled = true;
    const originalText = translateBtn.textContent;
    translateBtn.textContent = "⏳";
    try {
      const translated = await translateTitle(entry.title);
      if (translated) {
        // 在标题下方插入/更新翻译结果显示
        showTranslatedTitleInCard(card, doc, entry.title || "", translated);
        showToast(win, getString("toast-translate-ok"), "success");
        translateBtn.textContent = "✓";
      } else {
        showToast(win, getString("toast-translate-fail"), "error");
        translateBtn.textContent = originalText || "译";
      }
    } catch (e) {
      showToast(win, getString("toast-translate-fail-detail", { args: { message: (e as Error).message } }), "error");
      translateBtn.textContent = originalText || "译";
    } finally {
      translateBtn.disabled = false;
      // 2 秒后恢复按钮文本
      setTimeout(() => { translateBtn.textContent = originalText || "译"; }, 2000);
    }
  });
  actions.appendChild(translateBtn);

  // 引用格式预览按钮
  const citeBtn = doc.createElement("button");
  citeBtn.className = "zsearch-btn zsearch-btn-secondary zsearch-btn-small";
  citeBtn.textContent = getString("result-cite");
  citeBtn.title = "查看引用格式（GB/T 7714-2025、APA 7th、MLA 9th）";
  citeBtn.addEventListener("click", () => {
    showCitationDialog(win, entry);
  });
  actions.appendChild(citeBtn);

  // Import button
  const importBtn = doc.createElement("button");
  importBtn.className = "zsearch-btn zsearch-btn-secondary zsearch-btn-small";
  importBtn.textContent = getString("result-import");
  if (inLibrary) {
    importBtn.classList.add("zsearch-imported-exists");
  }
  importBtn.addEventListener("click", () => {
    importOne(win, client, entry, importBtn);
  });
  actions.appendChild(importBtn);

  // 找相关文献按钮：基于该文章标题关键词重新搜索
  const relatedBtn = doc.createElement("button");
  relatedBtn.className = "zsearch-btn zsearch-btn-related";
  relatedBtn.textContent = getString("result-related" as any);
  relatedBtn.title = entry.title || "";
  relatedBtn.addEventListener("click", () => {
    searchRelated(win, client, entry);
  });
  actions.appendChild(relatedBtn);

  card.appendChild(actions);

  // 搜索时自动翻译标题：若启用且 pdf-translate 插件可用，异步翻译并显示在标题下一行。
  // 非阻塞：卡片先渲染，翻译完成后回填。translateClient 内置缓存与并发去重，
  // 卡片被重建（翻页/加载更多/筛选）时同标题命中缓存会立即返回。
  if (getPref("autoTranslateTitle") && entry.title && isPDFTranslateAvailable()) {
    const cardRef = card;
    const docRef = doc;
    const titleRef = entry.title;
    // 不 await，fire-and-forget，避免阻塞卡片渲染
    translateTitle(titleRef)
      .then((translated) => {
        // 卡片可能已被移除（翻页/新搜索/清空），需检查是否仍在文档中
        if (!translated) return;
        if (!cardRef.isConnected) return;
        showTranslatedTitleInCard(cardRef, docRef, titleRef, translated);
      })
      .catch((e) => {
        log.translate.warn("autoTranslateTitle: translate failed", e);
      });
  }

  return card;
}

/**
 * 在文本中高亮搜索关键词。
 * 将关键词拆分为单词，用 <mark> 标签包裹匹配项。
 * 返回 HTML 字符串（已转义非匹配部分）。
 */
function highlightKeywords(doc: Document, text: string, query: string): string {
  if (!query || !text) return escapeHtml(text);
  // 拆分关键词为单词（按空格、引号、布尔运算符分割）
  const keywords = query
    .split(/[\s"']+|(?:AND|OR|NOT|TITLE-ABS-KEY|TITLE|ABS|KEY)\b/i)
    .map((k) => k.trim())
    .filter((k) => k.length >= 2);
  if (keywords.length === 0) return escapeHtml(text);

  // 构建正则（转义特殊字符，不区分大小写）
  const escaped = keywords.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const regex = new RegExp(`(${escaped.join("|")})`, "gi");
  // 转义 HTML 后替换匹配项
  const escapedText = escapeHtml(text);
  return escapedText.replace(regex, '<mark class="zsearch-highlight">$1</mark>');
}

/** HTML 转义 */
function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * 格式化作者列表：至多显示 maxCount 位，超出则加 "et al."
 * 支持多种输入格式：
 * 1. 字符串："Smith, J.; Liu, W.; Zhang, C."（分号分隔）
 * 2. 字符串："Smith J."（单个作者）
 * 3. 对象数组：[{surname, given-name}, ...]（Scopus COMPLETE 视图 author 字段）
 * 4. 对象数组：[{authname, given-name, surname}, ...]（Scopus author 字段完整格式）
 */
function formatAuthors(source: any, maxCount: number): string {
  if (!source) return "";
  let authors: string[] = [];

  if (Array.isArray(source)) {
    // Scopus COMPLETE 视图的 author 字段返回对象数组
    authors = source.map((a: any) => {
      if (typeof a === "string") return a;
      // 优先用 authname（Scopus 完整格式）
      if (a.authname) return a.authname;
      // 回退到 surname + given-name
      const surname = a.surname || a["ce:surname"] || "";
      const given = a.givenName || a["given-name"] || a["ce:given-name"] || "";
      if (surname && given) return `${surname}, ${given}`;
      return surname || given || a.name || "";
    }).filter(Boolean);
  } else if (typeof source === "string") {
    // 字符串格式：先按分号分割，若无分号则视为单个作者
    if (source.includes(";")) {
      authors = source.split(/\s*;\s*/).filter(Boolean);
    } else if (source.includes(" and ")) {
      authors = source.split(/\s+and\s+/).filter(Boolean);
    } else if (source.includes(" & ")) {
      authors = source.split(/\s+&\s+/).filter(Boolean);
    } else {
      authors = [source];
    }
  }

  if (authors.length === 0) return "";
  if (authors.length <= maxCount) {
    return authors.join("; ");
  }
  return authors.slice(0, maxCount).join("; ") + " et al.";
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/**
 * 将 UnifiedEntry 转换为 importer 兼容的 ScopusEntry 格式。
 * importer.ts 中的 importEntry 仍使用 ScopusEntry 类型，
 * 通过此适配器函数避免修改 importer 的接口。
 */
function unifiedToScopusEntry(entry: UnifiedEntry): any {
  // 对于非 Scopus 源（如 Google Scholar），scopusId/eid 设为 undefined，
  // 避免 importer 误用这些 ID 调用 Elsevier Abstract API 浪费配额。
  const isScopus = entry.source === "scopus";
  return {
    eid: isScopus ? entry.sourceId : undefined,
    doi: entry.doi,
    pii: entry.pii,
    scopusId: isScopus ? entry.sourceId : undefined,
    title: entry.title,
    authors: entry.rawAuthors,
    creator: Array.isArray(entry.authors) ? entry.authors[0] : entry.rawAuthors,
    publicationName: entry.publicationName,
    coverDate: entry.coverDate,
    coverDisplayDate: entry.coverDisplayDate,
    volume: entry.volume,
    issue: entry.issue,
    pageRange: entry.pageRange,
    articleNumber: entry.articleNumber,
    issn: entry.issn,
    eIssn: entry.eIssn,
    isbn: entry.isbn,
    citedByCount: entry.citedByCount,
    openAccess: entry.openAccess,
    description: entry.abstract,
    subtype: entry.subtype,
    subtypeDescription: entry.subtypeDescription,
    scopusUrl: entry.url,
    authKeywords: entry.keywords,
  };
}

async function importOne(
  win: Window,
  client: ElsevierClient,
  entry: UnifiedEntry,
  btn: HTMLButtonElement,
): Promise<void> {
  btn.disabled = true;
  btn.textContent = getString("result-importing");
  // 读取默认集合配置（与批量导入保持一致，单条导入也落到配置的集合）
  const collectionID = Number(getPref("defaultCollection")) || undefined;
  try {
    const scopusEntry = unifiedToScopusEntry(entry);
    const result = await importEntry(scopusEntry, client, {
      withAbstract: true,
      collectionID,
      autoPDF: false, // PDF 下载改由下载链处理
    });
    if (result.skipped) {
      btn.textContent = getString("result-imported");
      btn.classList.add("zsearch-imported-exists");
    } else {
      btn.textContent = getString("result-imported");
      showToast(
        win,
        getString("toast-import-ok" as any, { args: { title: (entry.title || "").slice(0, 60) } }),
        "success",
      );
    }
    // 使用 PDF 下载链尝试下载 PDF
    if (result.item && getPref("autoDownloadPDF") && !hasPDFAttachment(result.item)) {
      btn.textContent = "⏳ PDF…";
      const pdfRes = await downloadPDFWithChain(entry, result.item, client);
      if (pdfRes.success) {
        btn.textContent = `✓ PDF (${pdfRes.provider})`;
        showToast(
          win,
          getString("toast-pdf-ok" as any, { args: { provider: pdfRes.provider || "" } }),
          "success",
        );
      } else {
        // PDF 下载失败时恢复按钮可点击，允许用户重试
        btn.disabled = false;
        btn.textContent = getString("result-imported");
        showToast(
          win,
          getString("toast-pdf-fail" as any, { args: { reason: (pdfRes.reason || "").slice(0, 80) } }),
          "error",
        );
      }
    } else {
      // 无需下载 PDF 时恢复按钮可点击（允许重新导入或重试）
      btn.disabled = false;
    }
    // 导入成功后刷新其他相同 DOI 卡片的"已在库中"状态
    refreshInLibraryBadges(win, entry);
  } catch (e) {
    btn.disabled = false;
    btn.textContent = getString("result-import");
    const msg = (e as Error).message || String(e);
    log.import.warn("importOne failed", e);
    showToast(
      win,
      getString("toast-import-fail" as any, { args: { message: msg.slice(0, 100) } }),
      "error",
    );
  }
}

/**
 * 导入成功后刷新所有相同 DOI/标题的卡片的"已在库中"徽章和导入按钮状态。
 * 避免聚合搜索中重复条目被多次导入。
 */
function refreshInLibraryBadges(win: Window, importedEntry: UnifiedEntry): void {
  const doc = win.document;
  const cards = doc.querySelectorAll<HTMLElement>(".zsearch-result");
  const importedDoi = importedEntry.doi?.toLowerCase().trim();
  const importedTitle = importedEntry.title?.trim().toLowerCase();
  cards.forEach((card) => {
    // 跳过已标记为"已在库中"的卡片
    if (card.querySelector(".zsearch-badge-exists")) return;
    const cardIdx = Number(card.getAttribute("data-idx") || "-1");
    const entries = searchWindowState?.lastEntries || [];
    const entry = cardIdx >= 0 ? entries[cardIdx] : undefined;
    if (!entry) return;
    const cardDoi = entry.doi?.toLowerCase().trim();
    const cardTitle = entry.title?.trim().toLowerCase();
    const isMatch = (importedDoi && cardDoi === importedDoi) ||
                    (!importedDoi && importedTitle && cardTitle === importedTitle);
    if (!isMatch) return;
    // 添加"已在库中"徽章
    const actions = card.querySelector(".zsearch-result-actions");
    if (actions) {
      const existsBadge = doc.createElement("span");
      existsBadge.className = "zsearch-badge zsearch-badge-exists";
      existsBadge.textContent = getString("result-exists" as any);
      // 插入到已导入徽章之后
      const existsOld = actions.querySelector(".zsearch-badge-exists");
      if (!existsOld) actions.appendChild(existsBadge);
    }
    // 更新导入按钮状态
    const importBtn = card.querySelector(".zsearch-btn-small") as HTMLButtonElement;
    if (importBtn && !importBtn.classList.contains("zsearch-imported-exists")) {
      importBtn.textContent = getString("result-imported");
      importBtn.classList.add("zsearch-imported-exists");
    }
  });
}

async function importAll(win: Window, client: ElsevierClient): Promise<void> {
  const doc = win.document;
  const btn = doc.querySelector("#zsearch-import-all") as HTMLButtonElement;
  const entries = searchWindowState?.lastEntries || [];
  if (entries.length === 0) return;

  // 批量导入过程中禁用其他操作（搜索、翻页、导出、单条导入、源切换）
  setSearchingUI(doc, true);
  btn.disabled = true;
  const original = btn.textContent;
  let done = 0;
  let success = 0;
  let skipped = 0;
  let failed = 0;
  const total = entries.length;
  btn.textContent = `0 / ${total}`;

  const collectionID = Number(getPref("defaultCollection")) || undefined;

  for (const entry of entries) {
    try {
      const scopusEntry = unifiedToScopusEntry(entry);
      const result = await importEntry(scopusEntry, client, {
        withAbstract: true,
        collectionID,
        autoPDF: false,
      });
      // 使用 PDF 下载链
      if (result.item && getPref("autoDownloadPDF") && !hasPDFAttachment(result.item)) {
        await downloadPDFWithChain(entry, result.item, client);
      }
      if (result.skipped) {
        skipped++;
      } else {
        success++;
      }
    } catch (e) {
      log.import.warn("import all: entry failed", e);
      failed++;
    }
    done++;
    btn.textContent = `${done} / ${total}`;
  }
  // 恢复 UI 状态
  setSearchingUI(doc, false);
  btn.disabled = false;
  btn.textContent = original;
  // 完成提示区分成功/跳过/失败
  const summary = `成功 ${success} · 跳过 ${skipped} · 失败 ${failed}（共 ${total}）`;
  new ztoolkit.ProgressWindow(config.addonName, { closeTime: 4000 })
    .createLine({
      text: summary,
      type: failed > 0 ? "warning" : "success",
      progress: 100,
    })
    .show();
  // 批量导入后刷新所有卡片的"已在库中"状态
  refreshAllInLibraryBadges(win);
}

/**
 * 批量导入后刷新所有卡片的"已在库中"徽章状态。
 */
function refreshAllInLibraryBadges(win: Window): void {
  const doc = win.document;
  const cards = doc.querySelectorAll<HTMLElement>(".zsearch-result");
  const entries = searchWindowState?.lastEntries || [];
  cards.forEach((card) => {
    const cardIdx = Number(card.getAttribute("data-idx") || "-1");
    const entry = cardIdx >= 0 ? entries[cardIdx] : undefined;
    if (!entry) return;
    if (card.querySelector(".zsearch-badge-exists")) return;
    if (isEntryInLibrary(entry)) {
      const actions = card.querySelector(".zsearch-result-actions");
      if (actions) {
        const existsBadge = doc.createElement("span");
        existsBadge.className = "zsearch-badge zsearch-badge-exists";
        existsBadge.textContent = getString("result-exists" as any);
        actions.appendChild(existsBadge);
      }
      const importBtn = card.querySelector(".zsearch-btn-small") as HTMLButtonElement;
      if (importBtn && !importBtn.classList.contains("zsearch-imported-exists")) {
        importBtn.textContent = getString("result-imported");
        importBtn.classList.add("zsearch-imported-exists");
      }
    }
  });
}

/**
 * 同步刷新搜索结果卡片的星标状态。
 * 在收藏列表弹窗中移除/清空条目后，搜索结果卡片的星标按钮可能仍显示已收藏状态，
 * 需要根据实际收藏数据重新同步，避免点击行为反转。
 */
function syncCardStarStates(win: Window): void {
  const doc = win.document;
  const cards = doc.querySelectorAll<HTMLElement>(".zsearch-result");
  const entries = searchWindowState?.lastEntries || [];
  cards.forEach((card) => {
    const cardIdx = Number(card.getAttribute("data-idx") || "-1");
    const entry = cardIdx >= 0 ? entries[cardIdx] : undefined;
    if (!entry) return;
    const starBtn = card.querySelector(".zsearch-btn-star") as HTMLElement;
    if (!starBtn) return;
    const starred = isEntryStarred(entry);
    if (starred) {
      starBtn.classList.add("zsearch-starred");
      starBtn.textContent = "★";
    } else {
      starBtn.classList.remove("zsearch-starred");
      starBtn.textContent = "☆";
    }
  });
}

/**
 * 在卡片标题下方显示翻译后的标题。
 * 若已存在翻译结果元素则更新内容，否则新建一个浅灰色的副标题元素。
 */
function showTranslatedTitleInCard(
  card: HTMLElement,
  doc: Document,
  originalTitle: string,
  translatedTitle: string,
): void {
  let translateEl = card.querySelector(":scope > .zsearch-result-translated-title") as HTMLElement | null;
  if (!translateEl) {
    translateEl = doc.createElement("div");
    translateEl.className = "zsearch-result-translated-title";
    translateEl.style.cssText =
      "font-size: 12px; color: #5f6368; margin: 4px 0 0 0; padding: 4px 8px; background: #f1f3f4; border-radius: 4px; line-height: 1.4;";
    // 插入到标题之后
    const titleEl = card.querySelector(":scope > .zsearch-result-title");
    if (titleEl) {
      titleEl.after(translateEl);
    } else {
      card.prepend(translateEl);
    }
  }
  translateEl.textContent = `🌐 ${translatedTitle}`;
  translateEl.title = `原标题：${originalTitle}`;
}

// Keep references to suppress tree-shaking
void setPref;
void truncate;

/* ------------------------------------------------------------------ */
/* 高级搜索语法：在光标位置插入语法模板                                  */
/* ------------------------------------------------------------------ */

/**
 * 在输入框光标位置插入文本，并将光标移到插入文本末尾。
 * 对于带括号的语法（如 TITLE-ABS-KEY()），光标会移到括号内便于直接输入关键词。
 */
function insertSyntaxAtCursor(input: HTMLInputElement, insert: string): void {
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  const before = input.value.slice(0, start);
  const after = input.value.slice(end);
  // 智能空格：如果前后已有空格或运算符，不再加空格
  let prefix = "";
  let suffix = "";
  if (before && !/\s$/.test(before) && !/(AND|OR|NOT|\(|\))$/i.test(before)) {
    prefix = " ";
  }
  if (after && !/^\s/.test(after) && !/^(AND|OR|NOT|\)|\()/i.test(after)) {
    suffix = " ";
  }
  const inserted = `${prefix}${insert}${suffix}`;
  input.value = before + inserted + after;
  // 智能定位光标：如果插入文本以 () 结尾，光标移到括号内
  const cursorOffset = insert.endsWith("()") ? -1 - suffix.length : -suffix.length;
  const newCursor = (before + inserted).length + cursorOffset;
  input.selectionStart = input.selectionEnd = newCursor;
}

/* ------------------------------------------------------------------ */
/* 结果二次筛选：前端过滤当前页结果（不重新请求 API）                    */
/* ------------------------------------------------------------------ */

/**
 * 应用二次筛选条件，显示/隐藏卡片。
 * 筛选维度：all / oa / cited50 / cited100 / year3 / year5 / review
 * 注意：当 refine === "all" 时显示所有卡片（包括 data-idx 异常的卡片），
 *      避免因索引失配导致"全部"反而隐藏卡片的逻辑错误。
 */
function applyRefine(win: Window, refine: string): void {
  // 保存当前 refine，与等级筛选一起应用
  if (searchWindowState) searchWindowState.currentRefine = refine;
  applyFilters(win);
}

/**
 * 统一筛选：同时应用 refine（单选）和 rankFilter（多选）。
 * 卡片需同时满足两个条件才显示。
 */
function applyFilters(win: Window): void {
  const doc = win.document;
  const cards = doc.querySelectorAll<HTMLElement>(".zsearch-result");
  const entries = searchWindowState?.lastEntries || [];
  const refine = searchWindowState?.currentRefine || "all";
  const rankFilter = searchWindowState?.rankFilter || new Set<string>();
  const currentYear = new Date().getFullYear();
  let shown = 0;

  cards.forEach((card) => {
    let visible = true;

    // 1. refine 筛选（单选互斥）
    if (refine !== "all") {
      const idx = Number(card.getAttribute("data-idx") || "-1");
      const entry = idx >= 0 ? entries[idx] : undefined;
      if (!entry) {
        visible = false;
      } else {
        switch (refine) {
          case "oa":
            visible = !!entry.openAccess;
            break;
          case "cited50":
            visible = (entry.citedByCount ?? 0) >= 50;
            break;
          case "cited100":
            visible = (entry.citedByCount ?? 0) >= 100;
            break;
          case "year3":
            {
              const y = Number((entry.coverDate || "").slice(0, 4)) || 0;
              visible = y >= currentYear - 2;
            }
            break;
          case "year5":
            {
              const y = Number((entry.coverDate || "").slice(0, 4)) || 0;
              visible = y >= currentYear - 4;
            }
            break;
          case "review":
            visible = (entry.subtype || "").toLowerCase() === "re" ||
                      (entry.subtypeDescription || "").toLowerCase().includes("review");
            break;
          default:
            visible = true;
        }
      }
    }

    // 2. 期刊等级筛选（多选叠加）
    if (visible && rankFilter.size > 0) {
      visible = cardMatchesRankFilter(card, rankFilter);
    }

    card.style.display = visible ? "" : "none";
    if (visible) shown++;
  });

  // 更新计数显示
  const countEl = doc.querySelector("#zsearch-refine-count") as HTMLElement;
  if (countEl) {
    countEl.textContent = getString("refine-count" as any, {
      args: { shown: String(shown), total: String(cards.length) },
    });
  }
  updateResultsScrollHeight(win);
}

/**
 * 检查卡片是否匹配期刊等级筛选。
 * 遍历勾选的筛选选项，对每个选项用其 match 函数检查卡片上的徽章。
 * 任一选项匹配即返回 true。
 */
function cardMatchesRankFilter(card: HTMLElement, rankFilter: Set<string>): boolean {
  const badges = card.querySelectorAll<HTMLElement>(".zsearch-rank-badge");
  if (badges.length === 0) return false; // 无等级徽章，不匹配
  for (const key of rankFilter) {
    const matchFn = rankFilterMatchers.get(key);
    if (!matchFn) continue;
    const [kind] = key.split(":");
    for (const badge of badges) {
      const badgeKind = badge.getAttribute("data-kind") || "";
      const badgeValue = badge.getAttribute("data-value") || "";
      if (badgeKind === kind && matchFn(badgeValue)) return true;
    }
  }
  return false;
}

/**
 * 期刊等级筛选的可选项。
 * kind 对应 RankBadge.kind，value 是等级阈值（如 Q1+ 表示 Q1 及以上）。
 */
const RANK_FILTER_OPTIONS: Array<{
  kind: string;
  label: string;
  /** 值匹配函数：传入 badge 的 value，返回是否匹配 */
  match: (value: string) => boolean;
}> = [
  { kind: "jcr", label: "JCR Q1+", match: (v) => /^Q1$/i.test(v) },
  { kind: "jcr", label: "JCR Q1+Q2", match: (v) => /^Q[12]$/i.test(v) },
  { kind: "jcr", label: "JCR Q1-Q3", match: (v) => /^Q[123]$/i.test(v) },
  { kind: "cas", label: "中科院1区+", match: (v) => /1区/.test(v) },
  { kind: "cas", label: "中科院1-2区", match: (v) => /[12]区/.test(v) },
  { kind: "cas", label: "中科院1-3区", match: (v) => /[123]区/.test(v) },
  { kind: "ei", label: "EI 收录", match: (v) => true },
  { kind: "cssci", label: "CSSCI", match: (v) => true },
  { kind: "pku", label: "北大核心", match: (v) => true },
  { kind: "cscd", label: "CSCD", match: (v) => true },
  { kind: "chinacore", label: "中国科技核心", match: (v) => true },
];

/**
 * 显示期刊等级筛选面板。
 * 面板包含多个 checkbox，用户勾选后实时筛选。
 */
function toggleRankFilterPanel(win: Window): void {
  const doc = win.document;
  let panel = doc.querySelector("#zsearch-rankfilter-panel") as HTMLElement | null;

  // 切换面板显示
  if (panel) {
    if (panel.style.display === "none") {
      panel.style.display = "";
    } else {
      panel.style.display = "none";
    }
    return;
  }

  // 首次创建面板
  panel = doc.createElement("div");
  panel.id = "zsearch-rankfilter-panel";
  panel.className = "zsearch-rankfilter-panel";

  const title = doc.createElement("div");
  title.className = "zsearch-rankfilter-title";
  title.textContent = getString("rank-filter-dialog-title");
  panel.appendChild(title);

  const grid = doc.createElement("div");
  grid.className = "zsearch-rankfilter-grid";

  for (const opt of RANK_FILTER_OPTIONS) {
    const label = doc.createElement("label");
    label.className = "zsearch-rankfilter-item";
    const cb = doc.createElement("input");
    cb.setAttribute("type", "checkbox");
    cb.value = `${opt.kind}:${opt.label}`;
    // 当前是否已勾选
    const key = `${opt.kind}:${opt.label}`;
    const state = searchWindowState?.rankFilter;
    if (state && state.has(key)) {
      cb.checked = true;
    }
    cb.addEventListener("change", () => {
      const s = searchWindowState?.rankFilter;
      if (!s) return;
      if (cb.checked) {
        s.add(key);
      } else {
        s.delete(key);
      }
      // 存储该选项的 match 函数（挂在 dataset 上无法存函数，用全局 map）
      rankFilterMatchers.set(key, opt.match);
      applyFilters(win);
      updateRankFilterButton(win);
    });
    // 首次注册 match 函数
    if (cb.checked) {
      rankFilterMatchers.set(key, opt.match);
    }
    label.appendChild(cb);
    const span = doc.createElement("span");
    span.textContent = opt.label;
    label.appendChild(span);
    grid.appendChild(label);
  }
  panel.appendChild(grid);

  // 清空按钮
  const clearBtn = doc.createElement("button");
  clearBtn.className = "zsearch-btn zsearch-btn-secondary zsearch-rankfilter-clear";
  clearBtn.textContent = getString("rank-filter-clear");
  clearBtn.addEventListener("click", () => {
    if (searchWindowState) searchWindowState.rankFilter.clear();
    rankFilterMatchers.clear();
    grid.querySelectorAll<HTMLInputElement>("input[type=checkbox]").forEach((cb) => {
      cb.checked = false;
    });
    applyFilters(win);
    updateRankFilterButton(win);
  });
  panel.appendChild(clearBtn);

  // 插入到 refine bar 之后
  const refineEl = doc.querySelector("#zsearch-refine");
  if (refineEl && refineEl.parentNode) {
    refineEl.parentNode.insertBefore(panel, refineEl.nextSibling);
  }
}

/** match 函数缓存：key -> match 函数 */
const rankFilterMatchers = new Map<string, (value: string) => boolean>();

/**
 * 更新等级筛选按钮的标签（显示已勾选数量）。
 */
function updateRankFilterButton(win: Window): void {
  const doc = win.document;
  const btn = doc.querySelector("#zsearch-rankfilter-btn") as HTMLElement;
  if (!btn) return;
  const count = searchWindowState?.rankFilter.size || 0;
  btn.textContent = count > 0 ? `📊 等级(${count})` : "📊 等级";
}

/* ------------------------------------------------------------------ */
/* 多选导出：根据复选框选中状态导出 BibTeX/RIS/CSV                       */
/* ------------------------------------------------------------------ */

/**
 * 更新导出按钮的启用/禁用状态。
 * 至少选中 1 个卡片时启用导出按钮。
 */
function updateExportButtonsState(win: Window): void {
  const doc = win.document;
  const checkboxes = doc.querySelectorAll<HTMLInputElement>(".zsearch-result-checkbox");
  let checkedCount = 0;
  checkboxes.forEach((cb) => {
    if (!cb.checked) return;
    const card = cb.closest(".zsearch-result") as HTMLElement | null;
    // 仅统计可见卡片中选中的复选框
    if (card && card.style.display !== "none") {
      checkedCount++;
    }
  });
  const disable = checkedCount === 0;
  const bibtexBtn = doc.querySelector("#zsearch-export-bibtex") as HTMLButtonElement | null;
  const risBtn = doc.querySelector("#zsearch-export-ris") as HTMLButtonElement | null;
  const csvBtn = doc.querySelector("#zsearch-export-csv") as HTMLButtonElement | null;
  if (bibtexBtn) bibtexBtn.disabled = disable;
  if (risBtn) risBtn.disabled = disable;
  if (csvBtn) csvBtn.disabled = disable;
}

/**
 * 导出选中条目为指定格式（bibtex / ris / csv）。
 * 使用 Zotero 临时条目 + 导出器实现，无需先导入到库。
 */
async function exportSelected(win: Window, format: "bibtex" | "ris" | "csv"): Promise<void> {
  const doc = win.document;
  const entries = searchWindowState?.lastEntries || [];
  const cards = doc.querySelectorAll<HTMLElement>(".zsearch-result");
  const selectedEntries: UnifiedEntry[] = [];
  cards.forEach((card) => {
    if (card.style.display === "none") return;
    const cb = card.querySelector<HTMLInputElement>(".zsearch-result-checkbox");
    if (cb && cb.checked) {
      const idx = Number(card.getAttribute("data-idx") || "-1");
      if (idx >= 0 && entries[idx]) selectedEntries.push(entries[idx]);
    }
  });

  if (selectedEntries.length === 0) {
    showToast(win, "未选中任何条目", "error");
    return;
  }

  try {
    // 生成导出内容
    let content = "";
    let ext = format;
    if (format === "bibtex") {
      content = entriesToBibtex(selectedEntries);
      ext = "bib"; // BibTeX 标准扩展名为 .bib
    } else if (format === "ris") {
      content = entriesToRis(selectedEntries);
    } else {
      content = entriesToCsv(selectedEntries);
      ext = "csv";
    }
    // CSV 加 UTF-8 BOM，避免 Excel 打开中文乱码
    if (format === "csv") {
      content = "\uFEFF" + content;
    }

    // 让用户选择保存位置
    const fp = new (Zotero as any).FilePicker();
    fp.init(win, "导出文献", (Zotero as any).FilePicker.modeSave);
    fp.appendFilter(format.toUpperCase(), `*.${ext}`);
    fp.defaultString = `zsearch_export.${ext}`;
    const result = await fp.show();
    if (result === (Zotero as any).FilePicker.returnOK || result === (Zotero as any).FilePicker.returnReplace) {
      const file = fp.file;
      await Zotero.File.putContentsAsync(file, content);
      showToast(
        win,
        getString("toast-export-ok" as any, {
          args: { count: String(selectedEntries.length), format: format.toUpperCase() },
        }),
        "success",
      );
    }
  } catch (e) {
    const msg = (e as Error).message || String(e);
    log.search.warn("exportSelected failed", e);
    showToast(
      win,
      getString("toast-export-fail" as any, { args: { message: msg.slice(0, 100) } }),
      "error",
    );
  }
}

/** 生成 BibTeX 格式字符串 */
function entriesToBibtex(entries: UnifiedEntry[]): string {
  const lines: string[] = [];
  // 用于生成唯一 citekey：相同 base 加序号
  const usedKeys = new Map<string, number>();
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const base = (e.doi || e.sourceId || `entry${i}`).replace(/[^a-zA-Z0-9]/g, "").slice(0, 16) || `entry${i}`;
    // citekey 去重：相同前缀加序号后缀
    let key = base;
    const used = usedKeys.get(base) || 0;
    if (used > 0) key = `${base}${used}`;
    usedKeys.set(base, used + 1);

    // 文献类型：review 也用 @article（BibTeX 标准），但加 note 标注
    const type = "article";
    const fields: string[] = [];
    if (e.title) fields.push(`  title = {${escapeBibtex(e.title)}}`);
    if (e.authors || e.rawAuthors) {
      const authors = formatAuthors(e.authors || e.rawAuthors || "", 9999);
      if (authors) fields.push(`  author = {${escapeBibtex(authors)}}`);
    }
    if (e.publicationName) fields.push(`  journal = {${escapeBibtex(e.publicationName)}}`);
    if (e.volume) fields.push(`  volume = {${e.volume}}`);
    if (e.issue) fields.push(`  number = {${e.issue}}`);
    if (e.pageRange) fields.push(`  pages = {${e.pageRange}}`);
    if (e.coverDate) fields.push(`  year = {${(e.coverDate || "").slice(0, 4)}}`);
    if (e.doi) fields.push(`  doi = {${e.doi}}`);
    if (e.url) fields.push(`  url = {${e.url}}`);
    if (e.abstract) fields.push(`  abstract = {${escapeBibtex(e.abstract)}}`);
    if ((e.subtype || "").toLowerCase() === "re") {
      fields.push(`  note = {Review article}`);
    }
    lines.push(`@${type}{${key},`);
    lines.push(...fields);
    lines.push("}\n");
  }
  return lines.join("\n");
}

/** 转义 BibTeX 特殊字符（在特殊字符前加反斜杠） */
function escapeBibtex(s: string): string {
  if (!s) return "";
  // 保留 URL 中的 & 用于 doi/url 字段（这些字段不经过此函数）
  // title/author/journal/abstract 中的特殊字符需要转义
  return s.replace(/[&%$#_{}~^\\]/g, "\\$&");
}

/** 生成 RIS 格式字符串 */
function entriesToRis(entries: UnifiedEntry[]): string {
  const lines: string[] = [];
  for (const e of entries) {
    // 文献类型映射：Scopus subtype -> RIS TY
    const subtype = (e.subtype || "").toLowerCase();
    let risType = "JOUR";
    if (subtype === "re") risType = "JOUR"; // review 仍为 JOUR，加 M3 标注
    else if (subtype === "cp") risType = "CONF"; // conference paper
    lines.push(`TY  - ${risType}`);
    if (e.title) lines.push(`TI  - ${e.title}`);
    if (e.authors || e.rawAuthors) {
      const authors = formatAuthors(e.authors || e.rawAuthors || "", 9999);
      if (authors) {
        // RIS 每个 AU 单独一行
        authors.split(";").forEach((a) => {
          const trimmed = a.trim();
          if (trimmed) lines.push(`AU  - ${trimmed}`);
        });
      }
    }
    if (e.publicationName) lines.push(`JO  - ${e.publicationName}`);
    if (e.volume) lines.push(`VL  - ${e.volume}`);
    if (e.issue) lines.push(`IS  - ${e.issue}`);
    // 页码：拆分 "12-34" 为 SP/EP，单页直接放 SP
    if (e.pageRange) {
      const m = String(e.pageRange).match(/^(\d+)\s*[-–]\s*(\d+)$/);
      if (m) {
        lines.push(`SP  - ${m[1]}`);
        lines.push(`EP  - ${m[2]}`);
      } else {
        lines.push(`SP  - ${e.pageRange}`);
      }
    }
    if (e.coverDate) lines.push(`PY  - ${(e.coverDate || "").slice(0, 4)}`);
    if (e.doi) lines.push(`DO  - ${e.doi}`);
    if (e.abstract) lines.push(`AB  - ${e.abstract}`);
    if (e.url) lines.push(`UR  - ${e.url}`);
    // 文献子类型标注
    if (subtype === "re") lines.push(`M3  - Review`);
    lines.push("ER  -\n");
  }
  return lines.join("\n");
}

/** 生成 CSV 格式字符串（含表头） */
function entriesToCsv(entries: UnifiedEntry[]): string {
  const headers = ["Title", "Authors", "Journal", "Year", "Volume", "Issue", "Pages", "DOI", "URL", "CitedBy", "OA", "Abstract"];
  const escapeCsv = (s: string): string => {
    if (!s) return "";
    if (/[",\n\r]/.test(s)) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  const rows: string[] = [headers.join(",")];
  for (const e of entries) {
    const authors = formatAuthors(e.authors || e.rawAuthors || "", 9999);
    const row = [
      escapeCsv(e.title || ""),
      escapeCsv(authors),
      escapeCsv(e.publicationName || ""),
      (e.coverDate || "").slice(0, 4),
      escapeCsv(e.volume || ""),
      escapeCsv(e.issue || ""),
      escapeCsv(e.pageRange || ""),
      escapeCsv(e.doi || ""),
      escapeCsv(e.url || ""),
      String(e.citedByCount ?? ""),
      e.openAccess ? "Yes" : "No",
      escapeCsv(e.abstract || ""),
    ];
    rows.push(row.join(","));
  }
  return rows.join("\n");
}

/* ------------------------------------------------------------------ */
/* 查找相关文献：基于该文章标题关键词重新搜索                            */
/* ------------------------------------------------------------------ */

/**
 * 基于点击文章的标题，提取关键词后重新搜索。
 * 策略：从标题中提取长度≥3的实词，取前4个，
 *       按当前搜索源的语法组装查询字符串。
 * - Scopus: TITLE-ABS-KEY(w1 AND w2 ...)
 * - PubMed: w1[tiab] AND w2[tiab]
 * - arXiv:  ti:"w1 w2"
 * - 其他源: 直接用关键词以 AND 连接（自由文本）
 */
function searchRelated(win: Window, client: ElsevierClient, entry: UnifiedEntry): Promise<void> {
  const doc = win.document;
  const input = doc.querySelector("#zsearch-input") as HTMLInputElement;
  if (!input) return Promise.resolve();

  const title = entry.title || "";
  if (!title) {
    showToast(win, "该文章无标题，无法提取关键词", "error");
    return Promise.resolve();
  }

  // 提取关键词：去掉常见停用词，保留长度≥3的词
  const stopwords = new Set([
    "the", "and", "for", "with", "from", "into", "this", "that", "based",
    "using", "via", "through", "towards", "toward", "study", "analysis",
    "research", "approach", "method", "results", "conclusion",
    "not", "but", "are", "was", "were", "been", "have", "has", "had",
    "its", "their", "they", "them", "between", "among",
  ]);
  const words = title
    .toLowerCase()
    .split(/[^a-zA-Z0-9]+/)
    .filter((w) => w.length >= 3 && !stopwords.has(w))
    .slice(0, 4);

  // 按当前搜索源生成查询字符串
  const sourceId = readMenulistValue(doc, "#zsearch-source") || "scopus";
  let query: string;
  if (words.length === 0) {
    // 退化：直接用原标题（用引号包裹防止被解析为运算符）
    query = `"${title.replace(/"/g, " ")}"`;
  } else {
    query = buildRelatedQuery(sourceId, words);
  }
  input.value = query;

  showToast(
    win,
    getString("toast-related" as any, { args: { query: input.value.slice(0, 60) } }),
    "info",
  );

  return doSearch(win, client, 1);
}

/** 按搜索源生成"查找相关"查询字符串 */
function buildRelatedQuery(sourceId: string, words: string[]): string {
  switch (sourceId) {
    case "scopus":
      return `TITLE-ABS-KEY(${words.join(" AND ")})`;
    case "pubmed":
      return words.map((w) => `${w}[tiab]`).join(" AND ");
    case "arxiv":
      return `ti:"${words.join(" ")}"`;
    case "springer":
      return words.map((w) => `keyword:"${w}"`).join(" AND ");
    case "ieee":
    case "semanticscholar":
    case "googleScholar":
    default:
      // 自由文本：用 AND 连接
      return words.join(" AND ");
  }
}

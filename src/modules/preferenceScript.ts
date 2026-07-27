import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { getPref, setPref } from "../utils/prefs";
import { log } from "../utils/logger";
import {
  ALL_PROVIDERS,
  PROVIDER_NAMES,
  getDownloadOrder,
  setDownloadOrder,
} from "./pdfDownloadChain";
import { queryUnpaywall } from "./unpaywallClient";
import { findSciHubPdfUrl } from "./scihubClient";

/**
 * Preference pane script. Called when the prefs XHTML loads via
 * onload="Zotero.__addonInstance__.hooks.onPrefsEvent('load', { window });"
 *
 * 仿 zotero-mcp-plus 的 preferenceScript.ts，对 HTML input/checkbox/select
 * 采用手动绑定（Zotero 的 preference 属性绑定在某些场景下不可靠）。
 */
export async function registerPrefsScripts(win: Window): Promise<void> {
  log.prefs.info("registerPrefsScripts begin");

  addon.data.prefs = { window: win };

  const doc = win.document;

  // 诊断：检查 preference-bound 元素
  try {
    const prefElements = doc.querySelectorAll("[preference]");
    log.prefs.info(`found ${prefElements.length} preference-bound elements`);
  } catch (e) {
    log.prefs.warn(`diagnostic failed: ${e}`);
  }

  // 手动绑定所有控件（双保险：preference 属性 + 手动 change 监听）
  bindHtmlInput(doc, "#zsearch-apikey", "apiKey", false);
  bindHtmlInput(doc, "#zsearch-insttoken", "insttoken", false);
  bindHtmlInput(doc, "#zsearch-easyscholar-key", "easyScholarKey", false);
  bindHtmlCheckbox(doc, "#zsearch-autodownload", "autoDownloadPDF");
  bindHtmlInput(doc, "#zsearch-pagesize", "pageSize", true);
  bindHtmlMenulist(doc, "#zsearch-defaultsort", "defaultSort");
  bindHtmlInput(doc, "#zsearch-timeout", "requestTimeout", true);
  bindHtmlInput(doc, "#zsearch-retries", "maxRetries", true);

  // 其他搜索源 API Key
  bindHtmlInput(doc, "#zsearch-springer-key", "springerKey", false);
  bindHtmlInput(
    doc,
    "#zsearch-semantic-scholar-key",
    "semanticScholarKey",
    false,
  );
  bindHtmlInput(doc, "#zsearch-pubmed-key", "pubmedApiKey", false);
  bindHtmlInput(doc, "#zsearch-unpaywall-email", "unpaywallEmail", false);

  // PDF 下载顺序拖拽排序
  buildPdfOrderList(doc);

  // 测试按钮
  const testBtn = doc.getElementById("zsearch-test-btn");
  if (testBtn) {
    testBtn.addEventListener("command", () => testConnection(doc));
    log.prefs.info("test button bound");
  } else {
    log.prefs.warn("test button not found");
  }

  // 测试所有连接按钮
  const testAllBtn = doc.getElementById("zsearch-test-all-btn");
  if (testAllBtn) {
    testAllBtn.addEventListener("command", () => testAllConnections(doc));
    log.prefs.info("test-all button bound");
  } else {
    log.prefs.warn("test-all button not found");
  }

  log.prefs.info("registerPrefsScripts end");
}

/* ------------------------------------------------------------------ */
/* PDF 下载顺序拖拽排序                                                 */
/* ------------------------------------------------------------------ */

/**
 * 在 #zsearch-pdf-order-list 容器中动态构建可拖拽的下载渠道列表。
 * - 每个渠道项为一个 hbox，包含拖拽手柄、名称、上下移动按钮
 * - 使用 HTML5 原生 drag-and-drop API（Zotero 7 XHTML 支持）
 * - 拖拽完成或点击上下按钮后，将新顺序写入 pdfDownloadOrder 偏好
 *
 * 注意：Zotero 偏好设置面板是 XHTML 片段，可能没有 doc.head，
 * 因此样式必须注入到 doc.documentElement，且容器清空需用 removeChild。
 */
function buildPdfOrderList(doc: Document): void {
  const container = doc.querySelector("#zsearch-pdf-order-list");
  if (!container) {
    log.prefs.warn("buildPdfOrderList: container not found");
    return;
  }
  // 清空容器（XHTML 中 innerHTML 不可靠，用 removeChild）
  while (container.firstChild) {
    container.removeChild(container.firstChild);
  }

  // 当前顺序（已保存的偏好）
  const currentOrder = getDownloadOrder();
  // 加入未在偏好中但属于 ALL_PROVIDERS 的渠道（保证完整）
  const fullOrder = [
    ...currentOrder,
    ...ALL_PROVIDERS.filter((id) => !currentOrder.includes(id)),
  ];

  // 注入内联样式（仅注入一次）
  ensureOrderListStyles(doc);

  const XHTML_NS = "http://www.w3.org/1999/xhtml";
  for (let i = 0; i < fullOrder.length; i++) {
    const providerId = fullOrder[i];
    const row = createOrderRow(doc, providerId, i, fullOrder.length, XHTML_NS);
    container.appendChild(row);
  }

  log.prefs.info(`buildPdfOrderList: ${fullOrder.length} providers rendered`);
}

/** 仅注入一次的内联样式（避免依赖外部 CSS） */
function ensureOrderListStyles(doc: Document): void {
  if (doc.getElementById("zsearch-pdf-order-style")) return;
  const XHTML_NS = "http://www.w3.org/1999/xhtml";
  const style = doc.createElementNS(XHTML_NS, "style");
  style.id = "zsearch-pdf-order-style";
  style.textContent = `
    .zsearch-pdf-order-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 8px;
      margin: 2px 0;
      background: #f7f7f7;
      border: 1px solid #d4d4d4;
      border-radius: 3px;
      cursor: grab;
      user-select: none;
    }
    .zsearch-pdf-order-row.zsearch-dragging {
      opacity: 0.4;
      cursor: grabbing;
    }
    .zsearch-pdf-order-row.zsearch-drag-over {
      border-top: 2px solid #0a84ff;
    }
    .zsearch-pdf-order-handle {
      cursor: grab;
      color: #5f6368;
      font-size: 14px;
      padding: 0 4px;
    }
    .zsearch-pdf-order-name {
      flex: 1;
      font-size: 13px;
      color: #202124;
    }
    .zsearch-pdf-order-pos {
      font-size: 11px;
      color: #5f6368;
      background: #e8eaed;
      border-radius: 2px;
      padding: 1px 6px;
    }
    .zsearch-pdf-order-btn {
      min-width: 24px;
      height: 22px;
      padding: 0 4px;
      font-size: 11px;
      cursor: pointer;
    }
  `;
  // Zotero 偏好设置面板可能没有 doc.head，注入到 documentElement
  (doc.head || doc.documentElement).appendChild(style);
}

/**
 * 创建单个渠道行。
 * 支持拖拽排序和上下移动按钮两种方式调整顺序。
 * 使用 createElementNS 确保在 XHTML 文档中正确渲染。
 */
function createOrderRow(
  doc: Document,
  providerId: string,
  index: number,
  total: number,
  ns: string,
): HTMLElement {
  const row = doc.createElementNS(ns, "div");
  row.className = "zsearch-pdf-order-row";
  row.setAttribute("data-provider", providerId);
  row.setAttribute("draggable", "true");

  // 拖拽手柄
  const handle = doc.createElementNS(ns, "span");
  handle.className = "zsearch-pdf-order-handle";
  handle.textContent = "⋮⋮";
  row.appendChild(handle);

  // 渠道名称
  const name = doc.createElementNS(ns, "span");
  name.className = "zsearch-pdf-order-name";
  name.textContent = PROVIDER_NAMES[providerId] || providerId;
  row.appendChild(name);

  // 位置序号
  const pos = doc.createElementNS(ns, "span");
  pos.className = "zsearch-pdf-order-pos";
  pos.textContent = `#${index + 1}`;
  row.appendChild(pos);

  // 上移按钮
  const upBtn = doc.createElementNS(ns, "button");
  upBtn.setAttribute("type", "button");
  upBtn.className = "zsearch-pdf-order-btn";
  upBtn.textContent = "▲";
  upBtn.disabled = index === 0;
  upBtn.addEventListener("click", () => moveRow(doc, providerId, -1));
  row.appendChild(upBtn);

  // 下移按钮
  const downBtn = doc.createElementNS(ns, "button");
  downBtn.setAttribute("type", "button");
  downBtn.className = "zsearch-pdf-order-btn";
  downBtn.textContent = "▼";
  downBtn.disabled = index === total - 1;
  downBtn.addEventListener("click", () => moveRow(doc, providerId, 1));
  row.appendChild(downBtn);

  // HTML5 拖拽事件
  row.addEventListener("dragstart", (ev: DragEvent) => {
    row.classList.add("zsearch-dragging");
    if (ev.dataTransfer) {
      ev.dataTransfer.effectAllowed = "move";
      ev.dataTransfer.setData("text/plain", providerId);
    }
  });
  row.addEventListener("dragend", () => {
    row.classList.remove("zsearch-dragging");
    clearDragOverMarks(doc);
  });
  row.addEventListener("dragover", (ev: DragEvent) => {
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
    clearDragOverMarks(doc);
    row.classList.add("zsearch-drag-over");
  });
  row.addEventListener("dragleave", () => {
    row.classList.remove("zsearch-drag-over");
  });
  row.addEventListener("drop", (ev: DragEvent) => {
    ev.preventDefault();
    const srcId = ev.dataTransfer?.getData("text/plain");
    row.classList.remove("zsearch-drag-over");
    if (srcId && srcId !== providerId) {
      reorderProviders(doc, srcId, providerId);
    }
  });

  return row;
}

/** 清除所有行的 drag-over 标记 */
function clearDragOverMarks(doc: Document): void {
  const rows = doc.querySelectorAll(".zsearch-pdf-order-row.zsearch-drag-over");
  rows.forEach((r) => r.classList.remove("zsearch-drag-over"));
}

/**
 * 通过按钮点击移动某行的位置。
 * @param providerId 目标渠道 ID
 * @param delta      -1 上移 / +1 下移
 */
function moveRow(doc: Document, providerId: string, delta: number): void {
  const order = getDownloadOrder();
  const idx = order.indexOf(providerId);
  if (idx < 0) return;
  const newIdx = idx + delta;
  if (newIdx < 0 || newIdx >= order.length) return;
  // 交换
  const tmp = order[idx];
  order[idx] = order[newIdx];
  order[newIdx] = tmp;
  setDownloadOrder(order);
  buildPdfOrderList(doc);
}

/**
 * 拖拽完成后的重新排序：将 srcId 移动到 targetId 的位置之前。
 */
function reorderProviders(
  doc: Document,
  srcId: string,
  targetId: string,
): void {
  const order = getDownloadOrder();
  const srcIdx = order.indexOf(srcId);
  const targetIdx = order.indexOf(targetId);
  if (srcIdx < 0 || targetIdx < 0 || srcIdx === targetIdx) return;
  // 移除源，插入到目标位置之前
  order.splice(srcIdx, 1);
  const newTargetIdx = order.indexOf(targetId);
  order.splice(newTargetIdx, 0, srcId);
  setDownloadOrder(order);
  buildPdfOrderList(doc);
}

/* ------------------------------------------------------------------ */
/* Manual binding helpers (仿 MCP bindHtmlCheckbox/Input/Select)       */
/* ------------------------------------------------------------------ */

function bindHtmlCheckbox(doc: Document, selector: string, prefKey: string): void {
  const el = doc.querySelector(selector) as HTMLInputElement;
  if (!el) {
    log.prefs.warn(`checkbox not found: ${selector}`);
    return;
  }
  const val = getPref(prefKey as any);
  el.checked = val === true || val === "true";
  el.addEventListener("command", () => {
    setPref(prefKey as any, el.checked);
    log.prefs.info(`${prefKey} → ${el.checked}`);
  });
}

function bindHtmlInput(
  doc: Document,
  selector: string,
  prefKey: string,
  isNumber: boolean,
): void {
  const el = doc.querySelector(selector) as HTMLInputElement;
  if (!el) {
    log.prefs.warn(`input not found: ${selector}`);
    return;
  }
  const val = getPref(prefKey as any);
  if (val !== undefined && val !== null) {
    el.value = String(val);
  }
  el.addEventListener("change", () => {
    const v = isNumber ? parseInt(el.value, 10) : el.value;
    if (isNumber && isNaN(v as number)) return;
    setPref(prefKey as any, v as any);
    log.prefs.info(`${prefKey} → ${v}`);
  });
}

function bindHtmlMenulist(doc: Document, selector: string, prefKey: string): void {
  const el = doc.querySelector(selector) as any;
  if (!el) {
    log.prefs.warn(`menulist not found: ${selector}`);
    return;
  }
  const val = getPref(prefKey as any);
  if (val !== undefined && val !== null) {
    el.value = String(val);
  }
  el.addEventListener("command", () => {
    setPref(prefKey as any, el.value);
    log.prefs.info(`${prefKey} → ${el.value}`);
  });
}

/* ------------------------------------------------------------------ */
/* Test connection                                                     */
/* ------------------------------------------------------------------ */

async function testConnection(doc: Document): Promise<void> {
  const resultEl = doc.getElementById("zsearch-test-result");
  const apiKeyInput = doc.getElementById("zsearch-apikey") as HTMLInputElement;
  if (!resultEl) return;

  const apiKey = apiKeyInput?.value || (getPref("apiKey") as string) || "";
  if (!apiKey) {
    setResult(doc, getString("err-no-apikey" as any), true);
    return;
  }

  setResult(doc, "Testing…", false);

  try {
    const client = addon.api.elsevier;
    const oldKey = getPref("apiKey") as string;
    setPref("apiKey", apiKey);

    const res = await client.searchScopus({
      query: 'TITLE-ABS-KEY("test")',
      count: 1,
    });

    // 恢复旧值（用户需点 Save 才会持久化）
    setPref("apiKey", oldKey);

    if (res) {
      setResult(doc, getString("prefs-test-success" as any), false);
      log.prefs.info("test connection: success");
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setResult(doc, msg, true);
    log.prefs.error("test connection failed", e);
  }
}

function setResult(doc: Document, text: string, fail: boolean): void {
  const el = doc.getElementById("zsearch-test-result");
  if (!el) return;
  el.textContent = text;
  el.className = "zsearch-prefs-test-result" + (fail ? " zsearch-fail" : "");
}

/* ------------------------------------------------------------------ */
/* Test all connections                                                */
/* ------------------------------------------------------------------ */

interface TestItem {
  id: string;
  name: string;
  /** 返回 null 表示未配置 Key（跳过），true 成功，false 失败 */
  test: () => Promise<{ ok: boolean; detail?: string } | null>;
}

/**
 * 测试所有已配置 API 的连通性，弹窗报告结果。
 * - 未配置 Key 的源标记为跳过
 * - 已配置 Key 的源执行轻量级测试请求
 * - 测试完成后用 window.alert 弹窗显示汇总结果
 */
async function testAllConnections(doc: Document): Promise<void> {
  const resultEl = doc.getElementById("zsearch-test-result");

  // 同步当前 UI 输入到 pref（避免用户未点 Save 时测试的是旧值）
  syncInputsToPrefs(doc);

  // 构建测试列表
  const items: TestItem[] = [
    {
      id: "elsevier",
      name: "Elsevier (Scopus)",
      test: testElsevier,
    },
    {
      id: "easyscholar",
      name: "EasyScholar",
      test: testEasyScholar,
    },
    {
      id: "springer",
      name: "Springer",
      test: testSpringer,
    },
    {
      id: "semanticScholar",
      name: "Semantic Scholar",
      test: testSemanticScholar,
    },
    {
      id: "pubmed",
      name: "PubMed",
      test: testPubMed,
    },
    {
      id: "unpaywall",
      name: "Unpaywall",
      test: testUnpaywall,
    },
    {
      id: "scihub",
      name: "SciHub",
      test: testSciHub,
    },
  ];

  const total = items.length;
  let done = 0;
  let success = 0;
  let failed = 0;
  let skipped = 0;
  const results: Array<{ name: string; status: "ok" | "fail" | "skip"; detail?: string }> = [];

  // 初始状态
  if (resultEl) {
    resultEl.textContent = `0 / ${total}`;
    resultEl.className = "zsearch-prefs-test-result";
  }

  for (const item of items) {
    let status: "ok" | "fail" | "skip" = "fail";
    let detail: string | undefined;
    try {
      const r = await item.test();
      if (r === null) {
        status = "skip";
        skipped++;
      } else if (r.ok) {
        status = "ok";
        success++;
      } else {
        status = "fail";
        failed++;
        detail = r.detail;
      }
    } catch (e: any) {
      status = "fail";
      failed++;
      detail = e?.message || String(e);
    }
    results.push({ name: item.name, status, detail });
    done++;
    if (resultEl) {
      resultEl.textContent = `${done} / ${total}`;
    }
  }

  // 构建弹窗内容
  const lines: string[] = [getString("prefs-test-all-title" as any), ""];
  for (const r of results) {
    let mark: string;
    let suffix = "";
    if (r.status === "ok") {
      mark = getString("prefs-test-ok" as any);
    } else if (r.status === "skip") {
      mark = getString("prefs-test-skip-short" as any);
    } else {
      mark = getString("prefs-test-fail-short" as any);
      if (r.detail) {
        // 截断过长的错误信息
        const d = r.detail.length > 120 ? r.detail.slice(0, 120) + "…" : r.detail;
        suffix = `  (${d})`;
      }
    }
    lines.push(`${mark}  ${r.name}${suffix}`);
  }
  lines.push("");
  lines.push(
    getString("prefs-test-all-done" as any, {
      args: { success: String(success), failed: String(failed) },
    }) + (skipped > 0 ? `  ·  跳过 ${skipped}` : ""),
  );

  // 更新 result label
  if (resultEl) {
    const allOk = failed === 0;
    resultEl.textContent = `${success}/${total - skipped}`;
    resultEl.className = "zsearch-prefs-test-result" + (allOk ? "" : " zsearch-fail");
  }

  // 弹窗显示
  const message = lines.join("\n");
  log.prefs.info(`testAllConnections:\n${message}`);
  try {
    (Zotero.getMainWindow() as any).alert(message);
  } catch {
    // 回退方案
    alert(message);
  }
}

/** 将当前 UI 输入的值同步到 pref，确保测试使用最新输入 */
function syncInputsToPrefs(doc: Document): void {
  const map: Array<{ selector: string; key: string; isNumber?: boolean }> = [
    { selector: "#zsearch-apikey", key: "apiKey" },
    { selector: "#zsearch-insttoken", key: "insttoken" },
    { selector: "#zsearch-easyscholar-key", key: "easyScholarKey" },
    { selector: "#zsearch-springer-key", key: "springerKey" },
    { selector: "#zsearch-semantic-scholar-key", key: "semanticScholarKey" },
    { selector: "#zsearch-pubmed-key", key: "pubmedApiKey" },
    { selector: "#zsearch-unpaywall-email", key: "unpaywallEmail" },
    { selector: "#zsearch-scihub-url", key: "scihubUrl" },
    { selector: "#zsearch-pagesize", key: "pageSize", isNumber: true },
    { selector: "#zsearch-timeout", key: "requestTimeout", isNumber: true },
    { selector: "#zsearch-retries", key: "maxRetries", isNumber: true },
  ];
  for (const m of map) {
    const el = doc.querySelector(m.selector) as HTMLInputElement;
    if (!el) continue;
    const v = m.isNumber ? parseInt(el.value, 10) : el.value;
    if (m.isNumber && isNaN(v as number)) continue;
    try {
      setPref(m.key as any, v as any);
    } catch (e) {
      log.prefs.warn(`syncInputsToPrefs: ${m.key} failed: ${e}`);
    }
  }
}

/** 测试 Elsevier (Scopus) - 使用轻量级 search 请求 */
async function testElsevier(): Promise<{ ok: boolean; detail?: string } | null> {
  const apiKey = (getPref("apiKey") as string) || "";
  if (!apiKey) return null;
  try {
    const client = addon.api.elsevier;
    const res = await client.searchScopus({
      query: 'TITLE-ABS-KEY("test")',
      count: 1,
    });
    return { ok: !!res, detail: res ? `返回 ${res.total} 条结果` : "空响应" };
  } catch (e: any) {
    return { ok: false, detail: e?.message || String(e) };
  }
}

/** 测试 EasyScholar - 查询一个常见期刊名验证连通性 */
async function testEasyScholar(): Promise<{ ok: boolean; detail?: string } | null> {
  const apiKey = (getPref("easyScholarKey") as string) || "";
  if (!apiKey) return null;
  try {
    const client = addon.api.easyScholar;
    // 用 Nature 作为测试期刊（几乎必收录）
    const data = await client.getRank("Nature");
    // getRank 返回 null 可能是未收录，但只要 HTTP 成功就算连通
    return { ok: true, detail: data ? "已收录" : "HTTP 成功（测试期刊未收录）" };
  } catch (e: any) {
    return { ok: false, detail: e?.message || String(e) };
  }
}

/** 测试 Springer - 执行最小分页搜索 */
async function testSpringer(): Promise<{ ok: boolean; detail?: string } | null> {
  const apiKey = (getPref("springerKey") as string) || "";
  if (!apiKey) return null;
  try {
    const url =
      "https://api.springernature.com/meta/v2/json" +
      "?q=test&p=1&s=1&api_key=" + encodeURIComponent(apiKey);
    const resp = await Zotero.HTTP.request("GET", url, {
      responseType: "json",
      timeout: 15000,
      headers: { Accept: "application/json" },
    });
    if (resp.status >= 200 && resp.status < 300) {
      const total = resp.response?.total;
      return { ok: true, detail: `返回 ${total || 0} 条结果` };
    }
    return { ok: false, detail: `HTTP ${resp.status}` };
  } catch (e: any) {
    return { ok: false, detail: e?.message || String(e) };
  }
}

/** 测试 Semantic Scholar - 执行最小分页搜索 */
async function testSemanticScholar(): Promise<{ ok: boolean; detail?: string } | null> {
  const apiKey = (getPref("semanticScholarKey") as string) || "";
  // Semantic Scholar 无 Key 也可用，所以即使没 Key 也测试
  try {
    const url =
      "https://api.semanticscholar.org/graph/v1/paper/search" +
      "?query=test&offset=0&limit=1&fields=title";
    const headers: Record<string, string> = { Accept: "application/json" };
    if (apiKey) {
      headers["x-api-key"] = apiKey;
    }
    const resp = await Zotero.HTTP.request("GET", url, {
      responseType: "json",
      timeout: 15000,
      headers,
    });
    if (resp.status >= 200 && resp.status < 300) {
      const total = resp.response?.total;
      return { ok: true, detail: `返回 ${total || 0} 条结果${apiKey ? "（带 Key）" : "（无 Key）"}` };
    }
    return { ok: false, detail: `HTTP ${resp.status}` };
  } catch (e: any) {
    return { ok: false, detail: e?.message || String(e) };
  }
}

/** 测试 PubMed - 执行 esearch 最小请求 */
async function testPubMed(): Promise<{ ok: boolean; detail?: string } | null> {
  // PubMed 无 Key 也可用
  const apiKey = (getPref("pubmedApiKey") as string) || "";
  try {
    let url =
      "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi" +
      "?db=pubmed&term=test&retmax=1&retmode=json";
    if (apiKey) url += "&api_key=" + encodeURIComponent(apiKey);
    const resp = await Zotero.HTTP.request("GET", url, {
      responseType: "text",
      timeout: 15000,
      headers: { Accept: "application/json" },
    });
    if (resp.status >= 200 && resp.status < 300) {
      const body = typeof resp.response === "string" ? JSON.parse(resp.response) : resp.response;
      const total = body?.esearchresult?.count;
      return { ok: true, detail: `返回 ${total || 0} 条结果${apiKey ? "（带 Key）" : "（无 Key）"}` };
    }
    return { ok: false, detail: `HTTP ${resp.status}` };
  } catch (e: any) {
    return { ok: false, detail: e?.message || String(e) };
  }
}

/** 测试 Unpaywall - 用一个已知 DOI 查询 */
async function testUnpaywall(): Promise<{ ok: boolean; detail?: string } | null> {
  const email = (getPref("unpaywallEmail") as string) || "";
  // Unpaywall 无 email 也可用（会用默认值）
  try {
    // 用 10.1038/nature12373 作为测试 DOI（Nature 文章，OA 元数据稳定存在）
    const result = await queryUnpaywall("10.1038/nature12373");
    return {
      ok: result !== null,
      detail: result
        ? `OA=${result.isOa}, status=${result.oaStatus || "-"}${email ? "（带 email）" : "（默认 email）"}`
        : "未找到记录",
    };
  } catch (e: any) {
    return { ok: false, detail: e?.message || String(e) };
  }
}

/** 测试 SciHub - 用一个已知 DOI 查询 PDF 链接 */
async function testSciHub(): Promise<{ ok: boolean; detail?: string } | null> {
  const scihubUrl = (getPref("scihubUrl") as string) || "";
  if (!scihubUrl) return null;
  try {
    // 用 10.1038/nature12373 作为测试 DOI
    const result = await findSciHubPdfUrl("10.1038/nature12373");
    return {
      ok: result.success,
      detail: result.success
        ? `找到 PDF 链接（${result.pdfUrl?.slice(0, 60)}…）`
        : result.reason,
    };
  } catch (e: any) {
    return { ok: false, detail: e?.message || String(e) };
  }
}

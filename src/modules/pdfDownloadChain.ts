/**
 * PDF 下载链管理器。
 * 按用户设置的优先级顺序，依次尝试多个下载渠道，直到成功。
 *
 * 渠道：
 * 1. unpaywall - 通过 Unpaywall API 查找 OA PDF URL 并下载
 * 2. scihub - 通过 SciHub 镜像下载（需配置地址）
 * 3. zotero_builtin - Zotero 内置的 Find PDF 功能
 * 4. scopus - 通过 Elsevier Article Retrieval API 下载
 */

import { getPref, setPref } from "../utils/prefs";
import { log } from "../utils/logger";
import type { UnifiedEntry } from "./searchSource";
import { findOaPdfUrl } from "./unpaywallClient";
import { findSciHubPdfUrl } from "./scihubClient";
import { downloadPDFForItem } from "./pdfDownloader";
import { ElsevierClient } from "./elsevierClient";

export interface PDFDownloadChainResult {
  success: boolean;
  provider?: string; // 哪个渠道成功
  reason?: string;
  attachment?: Zotero.Item;
}

/** 所有可用渠道 ID */
export const ALL_PROVIDERS = ["unpaywall", "scihub", "zotero_builtin", "scopus"] as const;

/** 渠道显示名称 */
export const PROVIDER_NAMES: Record<string, string> = {
  unpaywall: "Unpaywall (OA)",
  scihub: "SciHub",
  zotero_builtin: "Zotero 内置查找",
  scopus: "Scopus (Elsevier API)",
};

/**
 * 从 pref 读取用户配置的下载顺序。
 * 返回渠道 ID 数组，如 ["unpaywall", "zotero_builtin", "scopus"]
 */
export function getDownloadOrder(): string[] {
  const raw = (getPref("pdfDownloadOrder") as string) || "";
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr) && arr.length > 0) {
      // 过滤掉无效的渠道 ID
      return arr.filter((id) => ALL_PROVIDERS.includes(id as any));
    }
  } catch {
    /* ignore */
  }
  // 默认顺序
  return ["unpaywall", "scihub", "zotero_builtin", "scopus"];
}

/**
 * 设置下载顺序。
 * @param order 渠道 ID 数组
 */
export function setDownloadOrder(order: string[]): void {
  const valid = order.filter((id) => ALL_PROVIDERS.includes(id as any));
  setPref("pdfDownloadOrder", JSON.stringify(valid));
}

/**
 * 下载 PDF 文件到临时路径并附加到 Zotero 条目。
 * 从给定 URL 下载 PDF 二进制数据。
 */
async function downloadPdfFromUrl(
  url: string,
  item: Zotero.Item,
): Promise<{ success: boolean; attachment?: Zotero.Item; reason?: string }> {
  try {
    const resp = await Zotero.HTTP.request("GET", url, {
      responseType: "arraybuffer",
      timeout: 30000,
      headers: { "User-Agent": "Zsearch/0.1 (zotero-plugin)" },
    });

    if (resp.status < 200 || resp.status >= 300) {
      return { success: false, reason: `HTTP ${resp.status}` };
    }

    const pdfBytes = new Uint8Array(resp.response);
    if (!pdfBytes || pdfBytes.length === 0) {
      return { success: false, reason: "Empty response" };
    }

    // 写入临时文件
    const tmpDir = Zotero.getTempDirectory().path;
    const tmpPath = PathUtils.join(tmpDir, `zsearch-oa-${Date.now()}.pdf`);
    await IOUtils.write(tmpPath, pdfBytes);

    // 验证 PDF magic bytes
    const head = await IOUtils.read(tmpPath, { maxBytes: 4 });
    const headStr = String.fromCharCode(...Array.from(head));
    if (!headStr.startsWith("%PDF")) {
      await IOUtils.remove(tmpPath, { ignoreAbsent: true });
      return { success: false, reason: "Not a valid PDF" };
    }

    // 附加到 Zotero 条目
    const attachment = await Zotero.Attachments.importFromFile({
      file: tmpPath,
      parentItemID: item.id,
      contentType: "application/pdf",
    } as any);

    await IOUtils.remove(tmpPath, { ignoreAbsent: true });
    return { success: true, attachment };
  } catch (e: any) {
    return { success: false, reason: e?.message || String(e) };
  }
}

/**
 * 尝试通过 Unpaywall 下载 OA PDF。
 */
async function tryUnpaywall(
  entry: UnifiedEntry,
  item: Zotero.Item,
): Promise<{ success: boolean; attachment?: Zotero.Item; reason?: string }> {
  if (!entry.doi) {
    return { success: false, reason: "No DOI for Unpaywall lookup" };
  }

  const pdfUrl = await findOaPdfUrl(entry);
  if (!pdfUrl) {
    return { success: false, reason: "No OA PDF found on Unpaywall" };
  }

  log.api.info(`Unpaywall PDF URL found: ${pdfUrl}`);
  return downloadPdfFromUrl(pdfUrl, item);
}

/**
 * 尝试通过 SciHub 下载 PDF。
 * 需要在设置中配置 SciHub 镜像地址。
 */
async function trySciHub(
  entry: UnifiedEntry,
  item: Zotero.Item,
): Promise<{ success: boolean; attachment?: Zotero.Item; reason?: string }> {
  if (!entry.doi) {
    return { success: false, reason: "No DOI for SciHub lookup" };
  }

  const result = await findSciHubPdfUrl(entry.doi);
  if (!result.success || !result.pdfUrl) {
    return { success: false, reason: result.reason || "SciHub lookup failed" };
  }

  log.api.info(`SciHub PDF URL found: ${result.pdfUrl}`);
  return downloadPdfFromUrl(result.pdfUrl, item);
}

/**
 * 尝试使用 Zotero 内置的 Find PDF 功能。
 * Zotero 7+ 支持 Zotero.Attachments.findPDFForItem。
 */
async function tryZoteroBuiltin(
  entry: UnifiedEntry,
  item: Zotero.Item,
): Promise<{ success: boolean; attachment?: Zotero.Item; reason?: string }> {
  try {
    // Zotero 7+ 的 findPDFForItem 是异步的
    if (typeof (Zotero.Attachments as any).findPDFForItem === "function") {
      log.api.info("Trying Zotero built-in findPDFForItem");
      const attachments = await (Zotero.Attachments as any).findPDFForItem(item);
      if (attachments && attachments.length > 0) {
        return { success: true, attachment: attachments[0] };
      }
      return { success: false, reason: "Zotero built-in found no PDF" };
    }
    return { success: false, reason: "Zotero built-in findPDF not available" };
  } catch (e: any) {
    return { success: false, reason: e?.message || String(e) };
  }
}

/**
 * 尝试通过 Scopus (Elsevier API) 下载 PDF。
 */
async function tryScopus(
  entry: UnifiedEntry,
  item: Zotero.Item,
  client: ElsevierClient,
): Promise<{ success: boolean; attachment?: Zotero.Item; reason?: string }> {
  if (!client.hasApiKey()) {
    return { success: false, reason: "Scopus API key not configured" };
  }

  const result = await downloadPDFForItem(client, item, { skipEntitlement: true });
  return {
    success: result.success,
    attachment: result.attachment,
    reason: result.reason,
  };
}

/**
 * 按用户配置的顺序，依次尝试所有 PDF 下载渠道。
 * 任一渠道成功即返回，全部失败则返回最后一个错误。
 *
 * @param entry 搜索结果条目（用于 Unpaywall DOI 查询）
 * @param item 已导入的 Zotero 条目
 * @param elsevierClient Scopus 客户端（用于 Scopus 渠道）
 */
export async function downloadPDFWithChain(
  entry: UnifiedEntry,
  item: Zotero.Item,
  elsevierClient: ElsevierClient,
): Promise<PDFDownloadChainResult> {
  const order = getDownloadOrder();
  log.search.info(`PDF download chain order: ${order.join(" → ")}`);

  let lastReason = "No download providers tried";

  for (const providerId of order) {
    log.search.info(`Trying PDF provider: ${providerId}`);
    let result: { success: boolean; attachment?: Zotero.Item; reason?: string };

    try {
      switch (providerId) {
        case "unpaywall":
          result = await tryUnpaywall(entry, item);
          break;
        case "scihub":
          result = await trySciHub(entry, item);
          break;
        case "zotero_builtin":
          result = await tryZoteroBuiltin(entry, item);
          break;
        case "scopus":
          result = await tryScopus(entry, item, elsevierClient);
          break;
        default:
          continue;
      }
    } catch (e: any) {
      result = { success: false, reason: e?.message || String(e) };
    }

    if (result.success) {
      log.search.info(`PDF downloaded via ${providerId}`);
      return { success: true, provider: providerId, attachment: result.attachment };
    }

    lastReason = `${providerId}: ${result.reason}`;
    log.search.info(`Provider ${providerId} failed: ${result.reason}`);
  }

  return { success: false, reason: lastReason };
}

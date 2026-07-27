import { ElsevierClient, ElsevierAPIError } from "./elsevierClient";
import { parseExtraDOI, parseExtraField } from "./importer";
import { getPref } from "../utils/prefs";

/**
 * Download a PDF for a Zotero item via Elsevier Article Retrieval API.
 *
 * Flow:
 *  1. Resolve identifier (DOI > PII > EID)
 *  2. Check entitlement (unless OA)
 *  3. Download PDF binary
 *  4. Write to temp file
 *  5. Zotero.Attachments.importFromFile as child attachment
 */

export interface DownloadResult {
  success: boolean;
  reason?: string;
  attachment?: Zotero.Item;
}

/**
 * Resolve the best identifier + type for an item.
 */
export function resolveItemId(item: Zotero.Item): {
  idType: "doi" | "pii" | "eid" | "scopus_id";
  id: string;
} | null {
  const doi = parseExtraDOI(item);
  if (doi) return { idType: "doi", id: doi };
  const extra = String(item.getField("extra") || "");
  const pii = parseExtraField(extra, "PII");
  if (pii) return { idType: "pii", id: pii };
  const eid = parseExtraField(extra, "Scopus EID");
  if (eid) return { idType: "eid", id: eid };
  return null;
}

export async function checkEntitlement(
  client: ElsevierClient,
  item: Zotero.Item,
): Promise<{ entitled: boolean; reason?: string }> {
  const idInfo = resolveItemId(item);
  if (!idInfo) {
    return { entitled: false, reason: "No DOI/PII/EID found for this item." };
  }
  // DOI or PII supported by entitlements endpoint
  if (idInfo.idType !== "doi" && idInfo.idType !== "pii") {
    // Try DOI-less: assume not entitled unless OA
    return { entitled: false, reason: "Entitlement check requires DOI or PII." };
  }
  try {
    const ok = await client.getEntitlement(idInfo.idType, idInfo.id);
    return { entitled: ok, reason: ok ? undefined : "No entitlement" };
  } catch (e) {
    return { entitled: false, reason: (e as Error).message };
  }
}

export async function downloadPDFForItem(
  client: ElsevierClient,
  item: Zotero.Item,
  opts: { skipEntitlement?: boolean } = {},
): Promise<DownloadResult> {
  const idInfo = resolveItemId(item);
  if (!idInfo) {
    return { success: false, reason: "No DOI/PII/EID found for this item." };
  }

  // 不再强制 entitlement 检查 — 无论有无 insttoken 都尝试下载，
  // 由 API 返回 401/403 时再判定失败原因。OA 文章可直接下载。
  // 仅当调用方明确要求检查时才检查（保留接口兼容）。
  if (!opts.skipEntitlement) {
    // 跳过 entitlement 检查，直接尝试下载
  }

  // Download PDF
  let pdfBytes: Uint8Array;
  try {
    pdfBytes = await client.downloadPDF(idInfo.idType, idInfo.id);
  } catch (e) {
    if (e instanceof ElsevierAPIError) {
      if (e.status === 404) {
        return { success: false, reason: "Full text not found in Elsevier." };
      }
      if (e.status === 401 || e.status === 403) {
        return {
          success: false,
          reason: "Permission denied (insttoken required for full text).",
        };
      }
      return { success: false, reason: e.message };
    }
    return { success: false, reason: (e as Error).message };
  }

  if (!pdfBytes || pdfBytes.length === 0) {
    return { success: false, reason: "Empty PDF response." };
  }

  // Write to temp file
  const tmpDir = Zotero.getTempDirectory().path;
  const safeId = (idInfo.id.replace(/[^a-zA-Z0-9]/g, "_")).slice(0, 40);
  const tmpPath = PathUtils.join(tmpDir, `zsearch-${safeId}-${Date.now()}.pdf`);

  try {
    // IOUtils.write expects a TypedArray
    await IOUtils.write(tmpPath, pdfBytes);
  } catch (e) {
    return { success: false, reason: `Failed to write temp file: ${(e as Error).message}` };
  }

  // Check we have a valid PDF (magic bytes %PDF)
  try {
    const head = await IOUtils.read(tmpPath, { maxBytes: 4 });
    const headStr = String.fromCharCode(...Array.from(head));
    if (!headStr.startsWith("%PDF")) {
      // Probably an error JSON/HTML returned with 200; remove and fail
      await IOUtils.remove(tmpPath, { ignoreAbsent: true });
      return {
        success: false,
        reason: "Response was not a valid PDF (possibly an error page).",
      };
    }
  } catch {
    /* ignore magic check failure */
  }

  // Import into Zotero as attachment
  try {
    const attachment = await Zotero.Attachments.importFromFile({
      file: tmpPath,
      parentItemID: item.id,
      contentType: "application/pdf",
    } as any);
    // Clean up temp file (importFromFile copies it)
    await IOUtils.remove(tmpPath, { ignoreAbsent: true });
    return { success: true, attachment };
  } catch (e) {
    await IOUtils.remove(tmpPath, { ignoreAbsent: true });
    return {
      success: false,
      reason: `Failed to import attachment: ${(e as Error).message}`,
    };
  }
}

/**
 * Download PDFs for multiple items serially (respecting rate limit).
 */
export async function downloadPDFsForItems(
  client: ElsevierClient,
  items: Zotero.Item[],
  onProgress?: (done: number, total: number, lastResult: DownloadResult) => void,
): Promise<{ success: number; failed: number }> {
  let success = 0;
  let failed = 0;
  const total = items.length;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const result = await downloadPDFForItem(client, item);
    if (result.success) success++;
    else failed++;
    if (onProgress) onProgress(i + 1, total, result);
  }
  return { success, failed };
}

/**
 * Quick check: does item already have a PDF attachment?
 */
export function hasPDFAttachment(item: Zotero.Item): boolean {
  const attachments = item.getAttachments();
  for (const id of attachments) {
    const att = Zotero.Items.get(id);
    if (att && att.attachmentContentType === "application/pdf") {
      return true;
    }
  }
  return false;
}

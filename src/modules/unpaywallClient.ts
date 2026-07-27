/**
 * Unpaywall 客户端。
 * 免费 API，通过 DOI 查找论文的开放获取 PDF 链接。
 * 无需 API Key，仅需在请求中带 email 参数。
 *
 * 端点：GET https://api.unpaywall.org/v2/{doi}?email=YOUR_EMAIL
 * 速率限制：每天 100,000 次
 */

import { getPref } from "../utils/prefs";
import { log } from "../utils/logger";
import type { UnifiedEntry } from "./searchSource";

const API_URL = "https://api.unpaywall.org/v2";

export interface UnpaywallLocation {
  urlForPdf?: string;
  urlForLandingPage?: string;
  version?: string; // submittedVersion / acceptedVersion / publishedVersion
  hostType?: string; // publisher / repository
  license?: string;
}

export interface UnpaywallResult {
  isOa: boolean;
  oaStatus?: string; // gold / hybrid / bronze / green / closed
  bestLocation?: UnpaywallLocation;
  allLocations: UnpaywallLocation[];
}

/**
 * 通过 DOI 查询 Unpaywall 获取 OA PDF 链接。
 * 返回 null 表示查询失败或未找到。
 */
export async function queryUnpaywall(doi: string): Promise<UnpaywallResult | null> {
  const email = (getPref("unpaywallEmail") as string) || "zsearch@user.local";
  if (!doi) return null;

  const url = `${API_URL}/${encodeURIComponent(doi)}?email=${encodeURIComponent(email)}`;
  log.api.info(`Unpaywall querying: ${doi}`);

  try {
    const resp = await Zotero.HTTP.request("GET", url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "Zsearch/0.1 (zotero-plugin)",
      },
      responseType: "text",
      timeout: 15000,
    });

    if (resp.status < 200 || resp.status >= 300) {
      log.api.warn(`Unpaywall HTTP ${resp.status} for ${doi}`);
      return null;
    }

    let body: any = resp.response;
    if (typeof body === "string") {
      body = JSON.parse(body);
    }

    const bestLoc = body?.best_oa_location;
    const allLocs: any[] = body?.oa_locations || [];

    const mapLoc = (loc: any): UnpaywallLocation => ({
      urlForPdf: loc?.url_for_pdf || undefined,
      urlForLandingPage: loc?.url_for_landing_page || undefined,
      version: loc?.version || undefined,
      hostType: loc?.host_type || undefined,
      license: loc?.license || undefined,
    });

    const result: UnpaywallResult = {
      isOa: body?.is_oa === true,
      oaStatus: body?.oa_status || undefined,
      bestLocation: bestLoc ? mapLoc(bestLoc) : undefined,
      allLocations: allLocs.map(mapLoc).filter((l) => l.urlForPdf || l.urlForLandingPage),
    };

    log.api.info(
      `Unpaywall result for ${doi}: isOa=${result.isOa}, status=${result.oaStatus}, ` +
      `pdfUrls=${result.allLocations.filter((l) => l.urlForPdf).length}`,
    );
    return result;
  } catch (e: any) {
    log.api.warn(`Unpaywall request failed for ${doi}: ${e?.message || e}`);
    return null;
  }
}

/**
 * 从 UnifiedEntry 获取最佳 PDF URL（优先 publishedVersion，其次 acceptedVersion）。
 * 返回 null 表示无可用 PDF。
 */
export async function findOaPdfUrl(entry: UnifiedEntry): Promise<string | null> {
  if (!entry.doi) return null;
  const result = await queryUnpaywall(entry.doi);
  if (!result || !result.isOa) return null;

  // 优先 publishedVersion，其次 acceptedVersion，最后 submittedVersion
  const locations = result.allLocations.filter((l) => l.urlForPdf);
  if (locations.length === 0) return null;

  const byVersion = (ver: string) =>
    locations.find((l) => l.version === ver)?.urlForPdf;

  return (
    byVersion("publishedVersion") ||
    byVersion("acceptedVersion") ||
    byVersion("submittedVersion") ||
    locations[0].urlForPdf ||
    null
  );
}

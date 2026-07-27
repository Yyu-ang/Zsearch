/**
 * SciHub 客户端。
 * 通过用户配置的 SciHub 镜像地址，根据 DOI 查找并下载 PDF。
 *
 * 实现参考 zotero-scihub 插件（https://github.com/ethanwillis/zotero-scihub）：
 * 1. 构造 URL: ${scihubUrl}/${doi}
 * 2. GET 请求（使用 iPhone User-Agent 避免 403）
 * 3. 解析返回的 HTML，从 #pdf 元素的 src 属性提取 PDF URL
 * 4. 处理相对路径（拼接 base URL）
 * 5. 转换为 HTTPS 后下载
 *
 * 常见 SciHub 镜像：
 *  - https://sci-hub.ru/
 *  - https://sci-hub.st/
 *  - https://sci-hub.se/
 *
 * 注意：SciHub 可能在某些地区无法访问，或在请求频繁时要求验证码。
 */

import { getPref } from "../utils/prefs";
import { log } from "../utils/logger";
import type { UnifiedEntry } from "./searchSource";

/** SciHub 下载结果 */
export interface SciHubResult {
  success: boolean;
  pdfUrl?: string;
  reason?: string;
}

/** 获取用户配置的 SciHub 地址，保证以 / 结尾 */
export function getScihubUrl(): string {
  let url = (getPref("scihubUrl") as string) || "https://sci-hub.ru/";
  if (!url.endsWith("/")) url += "/";
  return url;
}

/**
 * 从 SciHub 查找指定 DOI 的 PDF 下载链接。
 *
 * @param doi 文章的 DOI
 * @returns 成功时返回 { success: true, pdfUrl }，失败时返回 { success: false, reason }
 */
export async function findSciHubPdfUrl(doi: string): Promise<SciHubResult> {
  if (!doi) {
    return { success: false, reason: "No DOI provided for SciHub lookup" };
  }

  const baseUrl = getScihubUrl();
  // 构造 SciHub 文章 URL：${baseUrl}/${doi}
  const articleUrl = `${baseUrl}${doi}`;
  log.api.info(`SciHub querying: ${articleUrl}`);

  try {
    const resp = await Zotero.HTTP.request("GET", articleUrl, {
      responseType: "document",
      timeout: 30000,
      // 使用 iPhone User-Agent 避免 403（参考 zotero-scihub 实现）
      headers: {
        "User-Agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 11_3_1 like Mac OS X) AppleWebKit/603.1.30 (KHTML, like Gecko) Version/10.0 Mobile/14E304 Safari/602.1",
      },
    });

    if (resp.status < 200 || resp.status >= 300) {
      return { success: false, reason: `SciHub HTTP ${resp.status}` };
    }

    const doc = resp.responseXML;
    if (!doc) {
      return { success: false, reason: "SciHub returned no document" };
    }

    // 检测验证码页面（SciHub 要求人工验证时无法自动下载）
    const body = doc.querySelector("body");
    const bodyHtml = body?.innerHTML || "";
    if (isCaptchaPage(bodyHtml)) {
      return {
        success: false,
        reason: "SciHub requires captcha (open in browser to solve)",
      };
    }

    // 检测文章不存在的错误页面
    if (isArticleNotFound(bodyHtml)) {
      return { success: false, reason: "Article not found on SciHub" };
    }

    // 解析 PDF URL：
    // - 旧版 .tf 域名：iframe#pdf 的 src 属性
    // - 新版 .st 域名：embed#pdf 的 src 属性
    const pdfEl = doc.querySelector("#pdf");
    if (!pdfEl) {
      return { success: false, reason: "No #pdf element found on SciHub page" };
    }

    let rawPdfUrl = pdfEl.getAttribute("src") || "";
    if (!rawPdfUrl) {
      return { success: false, reason: "PDF element has no src attribute" };
    }

    // 处理相对路径：
    // - 以 // 开头：协议相对，添加 https:
    // - 以 / 开头：路径相对，拼接 baseUrl
    // - 以 http 开头：已是完整 URL
    let pdfUrl: string;
    if (rawPdfUrl.startsWith("//")) {
      pdfUrl = `https:${rawPdfUrl}`;
    } else if (rawPdfUrl.startsWith("http://") || rawPdfUrl.startsWith("https://")) {
      pdfUrl = rawPdfUrl;
    } else if (rawPdfUrl.startsWith("/")) {
      // 路径相对，拼接 baseUrl 的 origin
      try {
        const origin = new URL(baseUrl).origin;
        pdfUrl = `${origin}${rawPdfUrl}`;
      } catch {
        pdfUrl = `${baseUrl}${rawPdfUrl.replace(/^\//, "")}`;
      }
    } else {
      // 相对路径，直接拼接 baseUrl
      pdfUrl = `${baseUrl}${rawPdfUrl}`;
    }

    // 强制使用 HTTPS（参考 zotero-scihub 的 UrlUtil.urlToHttps）
    pdfUrl = pdfUrl.replace(/^http:\/\//i, "https://");

    log.api.info(`SciHub PDF URL found: ${pdfUrl}`);
    return { success: true, pdfUrl };
  } catch (e: any) {
    return { success: false, reason: e?.message || String(e) };
  }
}

/**
 * 检测页面是否为验证码页面。
 * SciHub 在频繁请求时可能要求用户输入验证码。
 */
function isCaptchaPage(html: string): boolean {
  if (!html) return false;
  // 常见验证码标志
  if (/captcha|recaptcha/i.test(html)) return true;
  // 检测 SciHub 的验证码提示文本
  if (/please\s+enter\s+the\s+text\s+from\s+the\s+image/i.test(html)) return true;
  return false;
}

/**
 * 检测页面是否为"文章未找到"错误页。
 * 参考zotero-scihub 的 isPdfNotAvailable 判断逻辑。
 */
function isArticleNotFound(html: string): boolean {
  if (!html) return true; // 空页面视为未找到
  const trimmed = html.trim();
  if (trimmed === "") return true;
  // 旧版 .tf 域名的错误信息
  if (/Please try to search again using DOI/im.test(html)) return true;
  // 俄文错误信息（文章未找到在数据库中）
  if (/статья не найдена в базе/im.test(html)) return true;
  // 英文：article not found
  if (/article\s+not\s+found/i.test(html)) return true;
  return false;
}

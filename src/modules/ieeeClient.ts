import { getPref } from "../utils/prefs";
import { log } from "../utils/logger";
import {
  type ISearchSource,
  type SearchFilters,
  type SearchResult,
  type UnifiedEntry,
} from "./searchSource";

/**
 * IEEE Xplore Metadata API 客户端。
 *
 * 端点：GET https://ieeexploreapi.ieee.org/api/v1/search/articles
 *   - apikey         必需，从 https://developer.ieee.org 申请
 *   - querytext      自由文本搜索（支持布尔运算）
 *   - start_record   分页起始（从 1 开始）
 *   - max_records    每页条数（上限 200）
 *   - start_year     起始年份
 *   - end_year       结束年份
 *   - content_type   Journals/Conferences/Books/Standards 等
 *   - open_access    true/false
 *
 * 鉴权：需要 API Key（https://developer.ieee.org/my-account）
 * 排序：API 不支持服务端排序，由客户端排序。
 * 限速：官方未公开具体限制，保守按 1 次 / 秒。
 */

const IEEE_API_URL = "https://ieeexploreapi.ieee.org/api/v1/search/articles";

/** 单次请求最大条数（IEEE API 上限 200） */
const MAX_PAGE_SIZE = 200;

/** 限速间隔：保守按 1000ms */
const RATE_LIMIT_MS = 1000;

/** contentType → subtype 映射表 */
const CONTENT_TYPE_MAP: Record<string, string> = {
  Journals: "article",
  Conferences: "conference",
  Books: "book",
  Standards: "standard",
  Magazines: "article",
  Courses: "course",
  "Early Access": "article",
};

/** 简单限速器 */
class RateLimiter {
  private lastRequest = 0;
  constructor(private minInterval: number) {}
  async wait(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequest;
    if (elapsed < this.minInterval) {
      await Zotero.Promise.delay(this.minInterval - elapsed);
    }
    this.lastRequest = Date.now();
  }
}

export class IeeeClient implements ISearchSource {
  id = "ieee";
  name = "IEEE Xplore";
  icon = "⚡";
  kind = "api" as const;
  needsApiKey = true;

  /** 限速器 */
  private rateLimiter = new RateLimiter(RATE_LIMIT_MS);

  /** 从偏好读取 IEEE API Key */
  get apiKey(): string {
    return (getPref("ieeeKey") as string) || "";
  }

  hasApiKey(): boolean {
    return this.apiKey.length > 0;
  }

  /** 请求超时（毫秒） */
  private get timeout(): number {
    return Number(getPref("requestTimeout") || 15000);
  }

  /**
   * 构建 IEEE 查询字符串。
   * IEEE API 的 querytext 支持自由文本和布尔运算，
   * 直接透传用户输入的关键词即可。
   * 年份和类型过滤通过独立参数传递，不拼入 querytext。
   */
  buildQuery(keywords: string, _filters?: SearchFilters): string {
    return (keywords || "").trim();
  }

  /**
   * 执行 IEEE Xplore 搜索。
   * @param query     关键词
   * @param filters   过滤器（年份/类型/排序）
   * @param page      页码（从 1 开始）
   * @param pageSize  每页条数
   */
  async search(
    query: string,
    filters: SearchFilters,
    page: number,
    pageSize: number,
  ): Promise<SearchResult> {
    if (!this.hasApiKey()) {
      throw new Error(
        "IEEE API Key 未配置。请在偏好设置中填写 IEEE API Key（申请：https://developer.ieee.org/）",
      );
    }

    const q = this.buildQuery(query, filters);
    if (!q) {
      log.api.warn("IEEE search: 查询为空");
      return { total: 0, entries: [] };
    }

    // 限速
    await this.rateLimiter.wait();

    // 限制单页条数
    const maxRecords = Math.min(Math.max(pageSize, 1), MAX_PAGE_SIZE);
    const startRecord = (Math.max(page, 1) - 1) * maxRecords + 1;

    // 构建请求 URL
    let url =
      IEEE_API_URL +
      "?apikey=" + encodeURIComponent(this.apiKey) +
      "&querytext=" + encodeURIComponent(q) +
      "&start_record=" + encodeURIComponent(String(startRecord)) +
      "&max_records=" + encodeURIComponent(String(maxRecords));

    // 年份过滤
    if (filters?.yearFrom) {
      url += "&start_year=" + encodeURIComponent(String(filters.yearFrom));
    }
    if (filters?.yearTo) {
      url += "&end_year=" + encodeURIComponent(String(filters.yearTo));
    }

    // 类型过滤
    if (filters?.type) {
      const typeMap: Record<string, string> = {
        ar: "Journals",
        re: "Journals",
        cp: "Conferences",
      };
      const ct = typeMap[filters.type];
      if (ct) {
        url += "&content_type=" + encodeURIComponent(ct);
      }
    }

    log.api.info(`IEEE 请求: q="${q}", page=${page}, pageSize=${maxRecords}`);

    // 发起 HTTP 请求
    // successCodes: null 让所有 HTTP 状态码都返回响应对象，避免 Zotero.HTTP.request
    // 在 4xx/5xx 时直接抛出 UnexpectedStatusException，导致 403 被错误地归类为"网络错误"。
    // 配合下面对状态码的显式分支处理，能给出更准确的错误信息。
    // IEEE API 通过 Mashery 代理，常见 403 错误码（X-Mashery-Error-Code 响应头）：
    //   - ERR_403_DEVELOPER_INACTIVE: 账号不活跃（30 天未用/被禁用/未激活），需去开发者门户重新激活
    //   - ERR_403_OVER_RATE_LIMIT: 配额耗尽
    //   - ERR_403_DEVELOPER_OVER_RATE: 开发者级配额耗尽
    // 仅对网络瞬时错误重试；账号问题与配额问题重试无意义，直接抛出。
    let data: any;
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      let resp: any;
      try {
        resp = await Zotero.HTTP.request("GET", url, {
          responseType: "json",
          timeout: this.timeout,
          headers: {
            Accept: "application/json",
            "User-Agent": "Zsearch/0.1 (zotero-plugin)",
          },
          successCodes: null,
        });
      } catch (e: any) {
        log.api.warn(`IEEE 网络错误 (attempt ${attempt + 1}/2): ${e?.message || e}`);
        lastError = new Error(`IEEE API 网络错误: ${e?.message || e}`);
        if (attempt === 0) {
          await Zotero.Promise.delay(2000);
          continue;
        }
        break;
      }

      if (resp.status >= 200 && resp.status < 300) {
        data = resp.response;
        lastError = null;
        break;
      }

      // 读取 IEEE/Mashery 特有的错误响应头与响应体
      const masheryErrCode = this.readHeader(resp, "X-Mashery-Error-Code");
      const errorDetail = this.readHeader(resp, "X-Error-Detail-Header");
      const bodyErr = this.extractError(resp.response);
      const errInfo = [masheryErrCode, errorDetail, bodyErr].filter(Boolean).join(" | ");
      log.api.warn(`IEEE HTTP ${resp.status} (attempt ${attempt + 1}/2): ${errInfo}`);

      if (resp.status === 403) {
        // ERR_403_DEVELOPER_INACTIVE：账号不活跃，重试无意义
        if (masheryErrCode && /DEVELOPER_INACTIVE|ACCOUNT_INACTIVE/i.test(masheryErrCode)) {
          throw new Error(
            `IEEE API 403 账号不活跃（${masheryErrCode}）：${errorDetail || bodyErr}。` +
            `该 API Key 对应的 IEEE 开发者账号已被标记为不活跃，常见原因：超过 30 天未使用 / 被禁用 / 未完成激活。` +
            `请前往 https://developer.ieee.org/my-account 重新激活账号或重新申请 API Key。`,
          );
        }
        // ERR_403_OVER_RATE_LIMIT / ERR_403_DEVELOPER_OVER_RATE：配额耗尽，重试无意义
        if (masheryErrCode && /OVER_RATE/i.test(masheryErrCode)) {
          throw new Error(
            `IEEE API 403 配额耗尽（${masheryErrCode}）：${errorDetail || bodyErr}。` +
            `今日/本月的请求配额已用尽，请次日重试或申请更高配额。`,
          );
        }
        // 其他 403：可能是 Key 无效、偶发反爬误判，重试 1 次
        lastError = new Error(
          `IEEE API 403 Forbidden：${errInfo}。可能原因：API Key 无效或被限制访问。请检查 Zsearch 首选项中的 IEEE API Key 配置（申请：https://developer.ieee.org/）。`,
        );
        if (attempt === 0) {
          await Zotero.Promise.delay(2000);
          continue;
        }
        break;
      }

      if (resp.status === 429) {
        // 429：限额耗尽，重试无意义
        throw new Error(
          `IEEE API 429 Too Many Requests：请求过于频繁，请稍后再试。${errInfo}`,
        );
      }

      // 其他状态码：直接抛出
      throw new Error(`IEEE API 请求失败 (HTTP ${resp.status}): ${errInfo}`);
    }

    if (lastError) throw lastError;
    if (!data) {
      throw new Error("IEEE API 请求未返回数据");
    }
    const total = Number(data?.totalfound || 0);
    const records = Array.isArray(data?.articles) ? data.articles : [];
    let entries: UnifiedEntry[] = records.map((r: any) => this.mapRecord(r));

    // 客户端排序（API 不支持服务端排序）
    entries = this.sortEntries(entries, filters.sort);

    log.api.info(`IEEE 结果: total=${total}, 返回=${entries.length}`);

    return { total, entries };
  }

  /**
   * 将 IEEE 记录映射为统一条目格式。
   * - title/abstract: 直接取字段
   * - authors: 从 authors.authors[].full_name 提取
   * - doi: 取 doi 字段
   * - coverDate: 优先 publication_year，其次 publication_date
   * - openAccess: access_type 包含 "Open Access" 或 "Ephemera"
   * - pageRange: start_page + "-" + end_page
   * - url: html_url 或 abstract_url
   * - subtype: content_type 映射
   * - keywords: 合并 author_terms 和 ieee_terms
   */
  private mapRecord(r: any): UnifiedEntry {
    const title = this.asStr(r.title);
    const abstract = this.cleanAbstract(this.asStr(r.abstract));
    const authors = this.extractAuthors(r.authors);
    const doi = this.asStr(r.doi);
    const coverDate = this.extractDate(r);
    const pageRange = this.buildPageRange(r.start_page, r.end_page);
    const url = this.asStr(r.html_url) || this.asStr(r.abstract_url);
    const openAccess = this.isOpenAccess(r.access_type);
    const contentType = this.asStr(r.content_type);
    const subtype = contentType ? CONTENT_TYPE_MAP[contentType] : undefined;
    const articleNumber = this.asStr(r.article_number);
    const keywords = this.extractKeywords(r);

    return {
      source: "ieee",
      sourceId: articleNumber || doi,
      title,
      authors,
      rawAuthors: r.authors,
      publicationName: this.asStr(r.publication_title),
      coverDate,
      volume: this.asStr(r.volume),
      issue: this.asStr(r.issue),
      pageRange,
      articleNumber,
      doi,
      issn: this.asStr(r.issn),
      isbn: this.asStr(r.isbn),
      citedByCount: this.asNumber(r.citing_paper_count),
      openAccess,
      abstract,
      subtype,
      subtypeDescription: contentType,
      url,
      keywords,
    };
  }

  /** 从 authors 对象提取作者名列表 */
  private extractAuthors(authorsObj: any): string[] | undefined {
    if (!authorsObj || typeof authorsObj !== "object") return undefined;
    const arr = authorsObj.authors;
    if (!Array.isArray(arr) || arr.length === 0) return undefined;
    const authors: string[] = [];
    for (const a of arr) {
      const name = this.asStr(a?.full_name);
      if (name) authors.push(name);
    }
    return authors.length > 0 ? authors : undefined;
  }

  /** 提取合并关键词：author_terms + ieee_terms */
  private extractKeywords(r: any): string[] | undefined {
    const terms: string[] = [];
    // author_terms: 可能是对象 {terms: [...]} 或数组
    const auTerms = r.author_terms;
    if (auTerms) {
      const arr = Array.isArray(auTerms?.terms)
        ? auTerms.terms
        : Array.isArray(auTerms) ? auTerms : [];
      for (const t of arr) {
        const s = this.asStr(typeof t === "string" ? t : t?.term);
        if (s) terms.push(s);
      }
    }
    // ieee_terms: 同上结构
    const ieeeTerms = r.ieee_terms;
    if (ieeeTerms) {
      const arr = Array.isArray(ieeeTerms?.terms)
        ? ieeeTerms.terms
        : Array.isArray(ieeeTerms) ? ieeeTerms : [];
      for (const t of arr) {
        const s = this.asStr(typeof t === "string" ? t : t?.term);
        if (s && !terms.includes(s)) terms.push(s);
      }
    }
    return terms.length > 0 ? terms : undefined;
  }

  /** 提取出版日期：优先 publication_year，其次 publication_date */
  private extractDate(r: any): string | undefined {
    const year = this.asStr(r.publication_year);
    if (year) return year;
    return this.asStr(r.publication_date);
  }

  /** 判断是否开放获取 */
  private isOpenAccess(accessType: any): boolean {
    const s = this.asStr(accessType);
    if (!s) return false;
    const lower = s.toLowerCase();
    return lower.includes("open access") || lower.includes("ephemera");
  }

  /** 组合起止页码 */
  private buildPageRange(start?: any, end?: any): string | undefined {
    const s = start ? String(start) : "";
    const e = end ? String(end) : "";
    if (s && e) return `${s}-${e}`;
    if (s) return s;
    if (e) return e;
    return undefined;
  }

  /** 清理摘要中的 HTML 标签 */
  private cleanAbstract(s: string | undefined): string | undefined {
    if (!s) return undefined;
    let text = String(s);
    text = text.replace(/<\/?(p|br|b|i|strong|em|span|div)[^>]*>/gi, "");
    text = text.replace(/&lt;[^&gt;]+&gt;/gi, "");
    text = text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
    text = text.trim();
    return text === "" ? undefined : text;
  }

  /** 安全转字符串 */
  private asStr(v: any): string | undefined {
    if (v === undefined || v === null) return undefined;
    const s = String(v).trim();
    return s === "" ? undefined : s;
  }

  /** 安全转数字 */
  private asNumber(v: any): number | undefined {
    if (v === undefined || v === null) return undefined;
    const n = Number(v);
    return isNaN(n) ? undefined : n;
  }

  /**
   * 客户端排序（IEEE API 不支持服务端排序）。
   * - ""              : 保持 API 返回顺序（rank 相关性）
   * - "-coverDate"    : 按日期降序
   * - "-citedby-count": 按被引数降序
   */
  private sortEntries(entries: UnifiedEntry[], sort: string): UnifiedEntry[] {
    if (!sort || entries.length === 0) return entries;
    const sorted = [...entries];
    if (sort === "-coverDate") {
      sorted.sort((a, b) => {
        const da = a.coverDate || "";
        const db = b.coverDate || "";
        return db.localeCompare(da);
      });
    } else if (sort === "-citedby-count") {
      sorted.sort((a, b) => {
        const ca = a.citedByCount ?? 0;
        const cb = b.citedByCount ?? 0;
        return cb - ca;
      });
    }
    return sorted;
  }

  /** 从错误响应中提取可读信息 */
  private extractError(resp: any): string {
    try {
      if (typeof resp === "string") return resp.slice(0, 200);
      if (resp && typeof resp === "object") {
        return String(
          resp.message || resp.error || resp.errorMessage || JSON.stringify(resp).slice(0, 200),
        );
      }
    } catch {
      /* ignore */
    }
    return "Unknown error";
  }

  /**
   * 从 Zotero.HTTP.request 响应对象中读取指定响应头（大小写不敏感）。
   * Zotero 的响应对象可能把头放在 responseHeaders 或 getAllResponseHeaders() 中。
   * @returns 头部值字符串；不存在时返回 undefined
   */
  private readHeader(resp: any, name: string): string | undefined {
    if (!resp) return undefined;
    const lower = String(name).toLowerCase();
    try {
      // 1. responseHeaders 字段（Zotero 常用）
      const headersObj = resp.responseHeaders;
      if (headersObj && typeof headersObj === "object") {
        for (const k of Object.keys(headersObj)) {
          if (String(k).toLowerCase() === lower) {
            const v = headersObj[k];
            return v ? String(v) : undefined;
          }
        }
      }
      // 2. getAllResponseHeaders 方法（XMLHttpRequest 标准 API）
      if (typeof resp.getAllResponseHeaders === "function") {
        const all = String(resp.getAllResponseHeaders() || "");
        // 格式："Name: Value\r\nName2: Value2\r\n..."
        const lines = all.split(/\r?\n/);
        for (const line of lines) {
          const idx = line.indexOf(":");
          if (idx > 0 && line.slice(0, idx).trim().toLowerCase() === lower) {
            return line.slice(idx + 1).trim() || undefined;
          }
        }
      }
      // 3. responseHeaders 字段（字符串形式）
      if (typeof headersObj === "string") {
        const lines = headersObj.split(/\r?\n/);
        for (const line of lines) {
          const idx = line.indexOf(":");
          if (idx > 0 && line.slice(0, idx).trim().toLowerCase() === lower) {
            return line.slice(idx + 1).trim() || undefined;
          }
        }
      }
    } catch {
      /* ignore */
    }
    return undefined;
  }
}

/** 默认单例实例 */
export const ieeeClient = new IeeeClient();

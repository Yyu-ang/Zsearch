import { getPref } from "../utils/prefs";
import { log } from "../utils/logger";
import {
  ISearchSource,
  SearchFilters,
  SearchResult,
  UnifiedEntry,
} from "./searchSource";

/**
 * Springer Nature Meta API 客户端。
 *
 * 端点：GET https://api.springernature.com/meta/v2/json
 *   - q       查询字符串（关键词 + year/type 过滤）
 *   - p       页码（从 1 开始）
 *   - s       每页条数
 *   - api_key 免费 API Key（https://dev.springernature.com/）
 *
 * 限速：每次请求间隔至少 1200ms。
 * 排序：API 不支持服务端排序，由客户端排序。
 */

const META_API_URL = "https://api.springernature.com/meta/v2/json";

/** contentType → subtype 映射表 */
const CONTENT_TYPE_MAP: Record<string, string> = {
  Article: "article",
  Review: "review",
  ConferencePaper: "conference",
};

/** 简单限速器：保证两次请求之间至少间隔 minInterval 毫秒 */
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

export class SpringerClient implements ISearchSource {
  id = "springer";
  name = "Springer";
  icon = "📚";
  kind = "api" as const;
  needsApiKey = true;

  /** 限速器：1200ms 间隔 */
  private rateLimiter = new RateLimiter(1200);

  /** 从偏好读取 Springer API Key */
  get apiKey(): string {
    return (getPref("springerKey") as string) || "";
  }

  hasApiKey(): boolean {
    return this.apiKey.length > 0;
  }

  /**
   * 构建 Springer Meta API 查询字符串。
   * - 关键词原样拼接
   * - 年份过滤：year:YYYY-YYYY
   * - 类型过滤：type:Journal / type:Book
   */
  buildQuery(keywords: string, filters?: SearchFilters): string {
    const kw = (keywords || "").trim();
    if (!kw) return "";
    let q = kw;

    // 年份过滤
    if (filters?.yearFrom && filters?.yearTo) {
      q += ` year:${filters.yearFrom}-${filters.yearTo}`;
    } else if (filters?.yearFrom) {
      q += ` year:${filters.yearFrom}-${new Date().getFullYear()}`;
    } else if (filters?.yearTo) {
      q += ` year:1900-${filters.yearTo}`;
    }

    // 类型过滤：统一类型码 → Springer 出版物类型
    if (filters?.type) {
      const typeMap: Record<string, string> = {
        ar: "Journal",
        re: "Journal",
        cp: "Book",
      };
      const springerType = typeMap[filters.type];
      if (springerType) {
        q += ` type:${springerType}`;
      }
    }

    return q;
  }

  /**
   * 执行 Springer Meta API 搜索。
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
    // 检查 API Key
    if (!this.hasApiKey()) {
      throw new Error(
        "Springer API Key 未配置。请在偏好设置中填写 Springer API Key（免费申请：https://dev.springernature.com/）",
      );
    }

    const q = this.buildQuery(query, filters);
    if (!q) {
      log.api.warn("Springer search: 查询为空");
      return { total: 0, entries: [] };
    }

    // 限速
    await this.rateLimiter.wait();

    // 构建请求 URL（手动拼接，避免 URL 构造函数在某些上下文不可用）
    const url =
      META_API_URL +
      "?q=" + encodeURIComponent(q) +
      "&p=" + encodeURIComponent(String(Math.max(1, page))) +
      "&s=" + encodeURIComponent(String(Math.max(1, pageSize))) +
      "&api_key=" + encodeURIComponent(this.apiKey);

    log.api.info(`Springer 请求: q="${q}", page=${page}, pageSize=${pageSize}`);

    // 发起 HTTP 请求
    let resp: any;
    try {
      resp = await Zotero.HTTP.request("GET", url, {
        responseType: "json",
        timeout: 15000,
        headers: {
          Accept: "application/json",
          "User-Agent": "Zsearch/0.1 (zotero-plugin)",
        },
      });
    } catch (e: any) {
      log.api.warn(`Springer 网络错误: ${e?.message || e}`);
      throw new Error(`Springer API 网络错误: ${e?.message || e}`);
    }

    // 检查 HTTP 状态码
    if (resp.status < 200 || resp.status >= 300) {
      const errInfo = this.extractError(resp.response);
      log.api.warn(`Springer HTTP ${resp.status}: ${errInfo}`);
      throw new Error(`Springer API 请求失败 (HTTP ${resp.status}): ${errInfo}`);
    }

    const data = resp.response;
    const total = Number(data?.total || 0);
    const records = Array.isArray(data?.records) ? data.records : [];
    let entries: UnifiedEntry[] = records.map((r: any) => this.mapRecord(r));

    // 客户端排序（API 不支持服务端排序）
    entries = this.sortEntries(entries, filters.sort);

    log.api.info(`Springer 结果: total=${total}, 返回=${entries.length}`);

    return { total, entries };
  }

  /**
   * 将 Springer record 映射为统一条目格式。
   * - title/abstract：数组取首元素
   * - authors：从 creators[].creator 提取
   * - doi：从 identifier 字段提取（格式 "doi:10.xxx/xxx"）
   * - coverDate：从 publicationDate 提取
   * - openAccess：openaccess === "true"
   * - pageRange：startingPage + "-" + endingPage
   * - url：url 数组中 format=html 的 value
   * - subtype：contentType 映射（Article→article, Review→review, ConferencePaper→conference）
   */
  private mapRecord(r: any): UnifiedEntry {
    const title = this.firstString(r.title);
    const abstract = this.cleanAbstract(this.firstString(r.abstract));
    const authors = this.extractAuthors(r.creators);
    const doi = this.extractDoi(r.identifier);
    const coverDate = r.publicationDate ? String(r.publicationDate) : undefined;
    const pageRange = this.buildPageRange(r.startingPage, r.endingPage);
    const url = this.extractHtmlUrl(r.url);
    const openAccess = r.openaccess === "true" || r.openaccess === true;
    const contentType = r.contentType ? String(r.contentType) : undefined;
    const subtype = contentType ? CONTENT_TYPE_MAP[contentType] : undefined;

    return {
      source: "springer",
      sourceId: doi || (r.identifier ? String(r.identifier) : undefined),
      title,
      authors,
      rawAuthors: r.creators,
      publicationName: r.publicationName
        ? String(r.publicationName)
        : r.journal
          ? String(r.journal)
          : undefined,
      coverDate,
      volume: r.volume ? String(r.volume) : undefined,
      issue: r.number ? String(r.number) : undefined,
      pageRange,
      doi,
      issn: r.issn ? String(r.issn) : undefined,
      isbn: r.isbn ? String(r.isbn) : undefined,
      openAccess,
      abstract,
      subtype,
      subtypeDescription: contentType,
      url,
    };
  }

  /** 取数组首元素或字符串本身，空值返回 undefined */
  private firstString(v: any): string | undefined {
    if (!v) return undefined;
    if (Array.isArray(v)) {
      if (v.length === 0) return undefined;
      const s = String(v[0]).trim();
      return s === "" ? undefined : s;
    }
    const s = String(v).trim();
    return s === "" ? undefined : s;
  }

  /** 从 creators 数组提取作者名列表 */
  private extractAuthors(creators: any): string[] | undefined {
    if (!Array.isArray(creators) || creators.length === 0) return undefined;
    const authors: string[] = [];
    for (const c of creators) {
      if (c && c.creator) {
        authors.push(String(c.creator));
      }
    }
    return authors.length > 0 ? authors : undefined;
  }

  /** 从 identifier 字段提取 DOI（格式 "doi:10.xxx/xxx"） */
  private extractDoi(identifier: any): string | undefined {
    if (!identifier) return undefined;
    // identifier 可能是字符串或数组
    const ids: string[] = Array.isArray(identifier)
      ? identifier.map((x: any) => String(x))
      : [String(identifier)];
    for (const id of ids) {
      const m = id.match(/^doi:(.+)$/i);
      if (m) return m[1].trim();
    }
    return undefined;
  }

  /** 组合起止页码为页码范围字符串 */
  private buildPageRange(start?: any, end?: any): string | undefined {
    const s = start ? String(start) : "";
    const e = end ? String(end) : "";
    if (s && e) return `${s}-${e}`;
    if (s) return s;
    if (e) return e;
    return undefined;
  }

  /** 从 url 数组中查找 format=html 的 value */
  private extractHtmlUrl(urls: any): string | undefined {
    if (!Array.isArray(urls) || urls.length === 0) return undefined;
    const html = urls.find((u: any) => u && u.format === "html");
    if (html && html.value) return String(html.value);
    // 兜底：返回第一个有 value 的条目
    const first = urls.find((u: any) => u && u.value);
    return first ? String(first.value) : undefined;
  }

  /** 清理摘要中的 HTML 标签和实体 */
  private cleanAbstract(s: string | undefined): string | undefined {
    if (!s) return undefined;
    let text = String(s);
    // Springer 摘要可能含简单 HTML 标签
    text = text.replace(/<\/?(p|br|b|i|strong|em|span|div)[^>]*>/gi, "");
    text = text.replace(/&lt;[^&gt;]+&gt;/gi, "");
    text = text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
    text = text.trim();
    return text === "" ? undefined : text;
  }

  /**
   * 客户端排序（Springer Meta API 不支持服务端排序）。
   * - ""              : 保持 API 返回顺序（相关性）
   * - "-coverDate"    : 按日期降序
   * - "-citedby-count": Springer 不返回引用数，保持原序
   */
  private sortEntries(entries: UnifiedEntry[], sort: string): UnifiedEntry[] {
    if (!sort || entries.length === 0) return entries;
    const sorted = [...entries];
    if (sort === "-coverDate") {
      // 按日期降序
      sorted.sort((a, b) => {
        const da = a.coverDate || "";
        const db = b.coverDate || "";
        return db.localeCompare(da);
      });
    }
    // -citedby-count: Springer Meta API 不返回引用数，无法排序
    return sorted;
  }

  /** 从错误响应中提取可读信息 */
  private extractError(resp: any): string {
    try {
      if (typeof resp === "string") return resp.slice(0, 200);
      if (resp && typeof resp === "object") {
        return String(
          resp.message || resp.error || JSON.stringify(resp).slice(0, 200),
        );
      }
    } catch {
      /* ignore */
    }
    return "Unknown error";
  }
}

/** 默认单例实例，供搜索源注册直接使用 */
export const springerClient = new SpringerClient();

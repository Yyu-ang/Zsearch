/**
 * arXiv 搜索源客户端。
 *
 * arXiv 是免费的预印本平台，无需 API Key。
 * 端点：GET http://export.arxiv.org/api/query
 * 返回 Atom 1.0 XML。
 *
 * 搜索语法：all:关键词 / ti:标题 / au:作者 / cat:cs.AI
 * 排序：sortBy=relevance / submittedDate / lastUpdatedDate；sortOrder=ascending/descending
 * 年份过滤：arXiv 无原生年份过滤，需在客户端按 published 日期过滤。
 * 限速：建议每 3 秒 1 次请求，单次最多 2000 条。
 * totalResults 在 <openSearch:totalResults> 元素中。
 */

import { log } from "../utils/logger";
import {
  type ISearchSource,
  type SearchFilters,
  type SearchResult,
  type UnifiedEntry,
} from "./searchSource";

/** arXiv API 端点 */
const ARXIV_API_URL = "http://export.arxiv.org/api/query";

// Atom / openSearch / arXiv 命名空间常量
const NS_ATOM = "http://www.w3.org/2005/Atom";
const NS_OPENSEARCH = "http://a9.com/-/spec/opensearch/1.1/";
const NS_ARXIV = "http://arxiv.org/schemas/atom";

/** 限速间隔：arXiv 建议每 3 秒 1 次请求，实际提高到 5 秒以避免 429 */
const RATE_LIMIT_MS = 5000;

/** 429 重试最大次数 */
const MAX_RETRIES = 3;

/** 429 重试初始退避时间（毫秒），每次翻倍 */
const RETRY_BACKOFF_MS = 5000;

/** 单次请求最大条数（arXiv 上限 2000） */
const MAX_PAGE_SIZE = 2000;

/**
 * arXiv 搜索源：实现 ISearchSource 接口。
 * 完全免费、不需要 API Key，hasApiKey() 始终返回 true。
 */
export class ArxivSearchSource implements ISearchSource {
  id = "arxiv";
  name = "arXiv";
  icon = "🔬";
  kind = "api" as const;
  needsApiKey = false;

  /** 上次请求时间戳，用于限速 */
  private lastRequestTs = 0;

  hasApiKey(): boolean {
    // arXiv 免费，始终视为已配置
    return true;
  }

  /**
   * 构建 arXiv 搜索查询字符串。
   * 用户输入若已包含字段前缀（如 ti:/au:/cat:）则原样使用，
   * 否则默认用 all: 包裹关键词。
   */
  buildQuery(keywords: string, _filters?: SearchFilters): string {
    const kw = (keywords || "").trim();
    if (!kw) return "";
    // 若用户已使用字段前缀，原样返回
    if (/(all|ti|au|abs|cat|id|jr|co):/i.test(kw)) {
      return kw;
    }
    // 否则用 all: 包裹
    return `all:${kw}`;
  }

  /**
   * 执行 arXiv 搜索。
   * @param query 搜索关键词
   * @param filters 过滤器（年份在客户端过滤）
   * @param page 页码（从 1 开始）
   * @param pageSize 每页条数
   */
  async search(
    query: string,
    filters: SearchFilters,
    page: number,
    pageSize: number,
  ): Promise<SearchResult> {
    const searchQuery = this.buildQuery(query, filters);
    if (!searchQuery) {
      return { total: 0, entries: [] };
    }

    // 限制单页条数不超过 arXiv 上限
    const count = Math.min(Math.max(pageSize, 1), MAX_PAGE_SIZE);
    const start = (Math.max(page, 1) - 1) * count;

    // 构建排序参数
    const sortBy = this.mapSort(filters?.sort);
    const sortOrder = "descending";

    // 拼接 URL（手动拼接以避免 URL 构造函数在某些上下文不可用）
    const url =
      ARXIV_API_URL +
      "?search_query=" + encodeURIComponent(searchQuery) +
      "&start=" + start +
      "&max_results=" + count +
      "&sortBy=" + sortBy +
      "&sortOrder=" + sortOrder;

    log.api.info(
      `arXiv search: query="${searchQuery}", start=${start}, max=${count}, sortBy=${sortBy}`,
    );

    // 限速：确保两次请求间隔至少 RATE_LIMIT_MS
    await this.applyRateLimit();

    // 429 重试机制：arXiv 在频繁请求时会返回 429 Rate exceeded
    let resp: any;
    let lastError: any;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        resp = await Zotero.HTTP.request("GET", url, {
          responseType: "text",
          timeout: 30000,
          headers: {
            Accept: "application/atom+xml",
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          },
        });
        // 成功则跳出重试循环
        break;
      } catch (e: any) {
        lastError = e;
        const status = e?.status || (e?.xhr?.status as number) || 0;
        // 429 / 503：退避重试
        if (status === 429 || status === 503) {
          if (attempt < MAX_RETRIES) {
            const backoff = RETRY_BACKOFF_MS * Math.pow(2, attempt);
            log.api.warn(
              `arXiv ${status} (attempt ${attempt + 1}/${MAX_RETRIES + 1}), retrying in ${backoff}ms...`,
            );
            await Zotero.Promise.delay(backoff);
            // 重试前再次限速
            this.lastRequestTs = 0;
            await this.applyRateLimit();
            continue;
          }
        }
        // 非 429/503 或重试次数耗尽，抛出友好错误
        log.api.warn(`arXiv request failed: ${e?.message || e}`);
        if (status === 429) {
          throw new Error(
            `arXiv API 429 Rate exceeded：请求过于频繁。arXiv 限速严格（建议每 5 秒 1 次），请稍候 30 秒后再试，或改用其他搜索源（Scopus / Semantic Scholar）。`,
          );
        }
        throw new Error(
          `arXiv 请求失败（HTTP ${status || "N/A"}）：${e?.message || e}`,
        );
      }
    }

    if (!resp) {
      throw lastError || new Error("arXiv 请求失败：无响应");
    }

    if (resp.status < 200 || resp.status >= 300) {
      log.api.warn(`arXiv HTTP ${resp.status}`);
      if (resp.status === 429) {
        throw new Error(
          `arXiv API 429 Rate exceeded：请求过于频繁，请稍候再试或改用其他搜索源。`,
        );
      }
      return { total: 0, entries: [] };
    }

    const xmlText = resp.response;
    log.api.debug(
      `arXiv raw response (first 500 chars): ${
        typeof xmlText === "string" ? xmlText.slice(0, 500) : ""
      }`,
    );

    const parsed = this.parseAtomXML(xmlText);
    log.api.info(
      `arXiv result: total=${parsed.total}, entries=${parsed.entries.length}`,
    );

    // 客户端年份过滤
    const filtered = this.applyYearFilter(parsed.entries, filters);
    return { total: parsed.total, entries: filtered };
  }

  /** 限速：确保两次请求间隔至少 RATE_LIMIT_MS 毫秒 */
  private async applyRateLimit(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestTs;
    if (elapsed < RATE_LIMIT_MS) {
      await Zotero.Promise.delay(RATE_LIMIT_MS - elapsed);
    }
    this.lastRequestTs = Date.now();
  }

  /** 将统一过滤器 sort 映射到 arXiv sortBy 参数 */
  private mapSort(sort?: string): string {
    switch ((sort || "").toLowerCase()) {
      case "date":
      case "submitteddate":
      case "year":
        return "submittedDate";
      case "lastupdated":
      case "lastupdateddate":
        return "lastUpdatedDate";
      case "relevance":
      case "relevancedesc":
      default:
        return "relevance";
    }
  }

  /** 解析 arXiv Atom XML 响应 */
  private parseAtomXML(
    xmlText: string,
  ): { total: number; entries: UnifiedEntry[] } {
    let doc: Document;
    try {
      doc = new DOMParser().parseFromString(xmlText, "application/xml");
    } catch (e: any) {
      log.api.warn(`arXiv XML parse failed: ${e?.message || e}`);
      return { total: 0, entries: [] };
    }

    // 检查解析错误
    const parseError = doc.getElementsByTagName("parsererror");
    if (parseError.length > 0) {
      log.api.warn(
        `arXiv XML parse error: ${parseError[0].textContent?.slice(0, 200)}`,
      );
      return { total: 0, entries: [] };
    }

    // 提取总数
    const total = this.extractTotal(doc);

    // 提取 entry 列表
    const entryEls = doc.getElementsByTagNameNS(NS_ATOM, "entry");
    const entries: UnifiedEntry[] = [];
    for (let i = 0; i < entryEls.length; i++) {
      const entry = this.mapEntry(entryEls[i]);
      if (entry) entries.push(entry);
    }
    return { total, entries };
  }

  /** 提取 openSearch:totalResults（兼容前缀大小写差异） */
  private extractTotal(doc: Document): number {
    // 优先用 opensearch 命名空间匹配
    const nsEls = doc.getElementsByTagNameNS(NS_OPENSEARCH, "totalResults");
    let target: Element | undefined;
    if (nsEls.length > 0) {
      target = nsEls[0];
    } else {
      // 兜底：遍历根元素直接子元素，按 localName 匹配（兼容前缀大小写差异）
      const root = doc.documentElement;
      if (root) {
        for (let i = 0; i < root.children.length; i++) {
          if (root.children[i].localName === "totalResults") {
            target = root.children[i];
            break;
          }
        }
      }
    }
    if (!target) return 0;
    const text = target.textContent || "0";
    const n = parseInt(text, 10);
    return isNaN(n) ? 0 : n;
  }

  /** 将单个 <entry> 元素映射为 UnifiedEntry */
  private mapEntry(el: Element): UnifiedEntry | null {
    try {
      const idText = this.getText(el, NS_ATOM, "id") || "";
      const arxivId = this.extractArxivId(idText);
      const title = this.cleanText(this.getText(el, NS_ATOM, "title"));
      const summary = this.cleanText(this.getText(el, NS_ATOM, "summary"));
      const published = this.getText(el, NS_ATOM, "published") || "";
      const coverDate = this.toDateStr(published);

      // 作者列表：从 <author><name> 提取
      const authors = this.extractAuthors(el);

      // DOI（arxiv 命名空间）
      const doi = this.getText(el, NS_ARXIV, "doi");

      // abs 页面链接（rel=alternate 优先，否则用 arxivId 构造）
      const url =
        this.extractAbsUrl(el) ||
        (arxivId ? `http://arxiv.org/abs/${arxivId}` : idText);

      const entry: UnifiedEntry = {
        source: "arxiv",
        sourceId: arxivId,
        title,
        authors,
        rawAuthors: authors,
        abstract: summary,
        coverDate,
        coverDisplayDate: coverDate,
        doi: doi || undefined,
        openAccess: true, // arXiv 全部 OA
        subtype: "preprint",
        url,
      };
      return entry;
    } catch (e: any) {
      log.api.warn(`arXiv mapEntry failed: ${e?.message || e}`);
      return null;
    }
  }

  /** 从 entry 中提取作者名数组（<author><name>） */
  private extractAuthors(el: Element): string[] {
    const authorEls = el.getElementsByTagNameNS(NS_ATOM, "author");
    const authors: string[] = [];
    for (let i = 0; i < authorEls.length; i++) {
      const name = this.getText(authorEls[i], NS_ATOM, "name");
      if (name) authors.push(name);
    }
    return authors;
  }

  /** 提取 abs 页面链接（rel=alternate 或无 rel 的 text/html 链接） */
  private extractAbsUrl(el: Element): string | undefined {
    const links = el.getElementsByTagNameNS(NS_ATOM, "link");
    for (let i = 0; i < links.length; i++) {
      const rel = links[i].getAttribute("rel");
      const type = links[i].getAttribute("type");
      if (rel === "alternate" || (rel === null && type === "text/html")) {
        return links[i].getAttribute("href") || undefined;
      }
    }
    return undefined;
  }

  /** 获取指定命名空间下第一个匹配 localName 的子元素文本内容 */
  private getText(
    parent: Element,
    ns: string,
    localName: string,
  ): string | undefined {
    const els = parent.getElementsByTagNameNS(ns, localName);
    if (els.length === 0) return undefined;
    return els[0].textContent || undefined;
  }

  /**
   * 从 arXiv id URL 中提取 arxivId。
   * 例：http://arxiv.org/abs/2401.12345v1 → 2401.12345
   */
  private extractArxivId(idText: string): string {
    if (!idText) return "";
    const m = idText.match(/abs\/([^/\s?#]+)$/);
    if (!m) return idText.trim();
    // 去除版本号 v1/v2 等
    return m[1].replace(/v\d+$/i, "");
  }

  /** 将 ISO 时间字符串转为 YYYY-MM-DD（使用 UTC 避免时区偏移） */
  private toDateStr(iso: string): string | undefined {
    if (!iso) return undefined;
    const d = new Date(iso);
    if (isNaN(d.getTime())) return undefined;
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(
      d.getUTCDate(),
    )}`;
  }

  /** 清理文本：合并多余空白、去除首尾空白 */
  private cleanText(s: string | undefined): string | undefined {
    if (!s) return s;
    return s.replace(/\s+/g, " ").trim();
  }

  /** 客户端年份过滤：比较 coverDate（YYYY-MM-DD）的年份部分 */
  private applyYearFilter(
    entries: UnifiedEntry[],
    filters: SearchFilters,
  ): UnifiedEntry[] {
    const from = filters?.yearFrom;
    const to = filters?.yearTo;
    if (!from && !to) return entries;
    return entries.filter((e) => {
      if (!e.coverDate) return false;
      const year = parseInt(e.coverDate.slice(0, 4), 10);
      if (isNaN(year)) return false;
      if (from && year < from) return false;
      if (to && year > to) return false;
      return true;
    });
  }
}

/** 导出单例，便于在搜索源注册表中直接引用 */
export const arxivSearchSource = new ArxivSearchSource();

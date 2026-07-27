import { getPref } from "../utils/prefs";
import { log } from "../utils/logger";
import type {
  ISearchSource,
  SearchFilters,
  SearchResult,
  UnifiedEntry,
} from "./searchSource";

/**
 * Semantic Scholar API 搜索源客户端。
 *
 * 端点：GET https://api.semanticscholar.org/graph/v1/paper/search
 * - 免费，可选 API Key（申请后约 1 次/秒，无 Key 约 100 次/5 分钟共享池）
 * - 若配置了 API Key，通过 Header `x-api-key` 传递
 * - fields 参数控制返回字段
 * - year 参数支持年份过滤，如 year=2020-2025
 * - API 不支持排序参数，排序在客户端完成
 *
 * 限速：
 * - 无 Key：每次请求间隔至少 3100ms（约 100 次/5 分钟）
 * - 有 Key：每次请求间隔至少 1100ms（约 1 次/秒）
 */

const BASE_URL = "https://api.semanticscholar.org/graph/v1/paper/search";

/** 请求返回字段列表 */
const FIELDS =
  "title,authors,abstract,year,venue,externalIds,citationCount,openAccessPdf,publicationTypes,journal";

/** 无 Key 时最小请求间隔（毫秒） */
const MIN_INTERVAL_NO_KEY = 3100;
/** 有 Key 时最小请求间隔（毫秒） */
const MIN_INTERVAL_WITH_KEY = 1100;

/** Semantic Scholar API 错误 */
export class SemanticScholarError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "SemanticScholarError";
    this.status = status;
  }
}

/** 简单间隔限速器：保证两次请求间至少间隔指定毫秒 */
class IntervalRateLimiter {
  private lastRequest = 0;
  /** 等待直到满足最小间隔要求 */
  async wait(minInterval: number): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequest;
    if (elapsed < minInterval) {
      await Zotero.Promise.delay(minInterval - elapsed);
    }
    this.lastRequest = Date.now();
  }
}

/**
 * Semantic Scholar 搜索源，实现 ISearchSource 接口。
 */
export class SemanticScholarSource implements ISearchSource {
  id = "semanticscholar";
  name = "Semantic Scholar";
  icon = "🧠";
  kind = "api" as const;
  /** API Key 可选 */
  needsApiKey = false;

  /** 全局限速器（单例，共享 lastRequest 时间戳） */
  private rateLimiter = new IntervalRateLimiter();

  /** 用户配置的 API Key（可能为空） */
  get apiKey(): string {
    return (getPref("semanticScholarKey") as string) || "";
  }

  /** 始终返回 true（API Key 可选，无 Key 也可用） */
  hasApiKey(): boolean {
    return true;
  }

  /** 当前是否实际配置了 API Key */
  private hasKeyConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  /** 根据是否配置 Key 返回对应的最小请求间隔 */
  private get minInterval(): number {
    return this.hasKeyConfigured()
      ? MIN_INTERVAL_WITH_KEY
      : MIN_INTERVAL_NO_KEY;
  }

  /**
   * 构建查询字符串（用于调试日志）。
   * Semantic Scholar 搜索直接使用关键词，不支持复杂查询语法。
   */
  buildQuery(keywords: string, _filters?: SearchFilters): string {
    return (keywords || "").trim();
  }

  /**
   * 执行搜索。
   * @param query 搜索关键词
   * @param filters 过滤器（年份范围、排序等）
   * @param page 页码（从 1 开始）
   * @param pageSize 每页数量
   */
  async search(
    query: string,
    filters: SearchFilters,
    page: number,
    pageSize: number,
  ): Promise<SearchResult> {
    const trimmedQuery = (query || "").trim();
    if (!trimmedQuery) {
      return { total: 0, entries: [] };
    }

    // 计算分页：API 上限 100 条/页
    const limit = Math.max(1, Math.min(pageSize, 100));
    const offset = Math.max(0, (page - 1) * limit);

    // 构建请求参数
    const params: Record<string, string> = {
      query: trimmedQuery,
      offset: String(offset),
      limit: String(limit),
      fields: FIELDS,
    };

    // 年份过滤：API 支持 year=2020-2025 格式
    const yearRange = this.buildYearRange(filters.yearFrom, filters.yearTo);
    if (yearRange) params.year = yearRange;

    // 构建完整 URL
    const url = this.buildUrl(params);

    // 请求头
    // 注意：Zotero 基于 Gecko 引擎，默认 User-Agent 会被 Semantic Scholar 识别为机器人返回 403。
    // 使用浏览器化 UA 可绕过此限制；若仍 403，建议用户配置 API Key。
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    };
    if (this.hasKeyConfigured()) {
      headers["x-api-key"] = this.apiKey;
    }

    // 限速
    await this.rateLimiter.wait(this.minInterval);

    log.api.info(
      `Semantic Scholar search: query="${trimmedQuery}", offset=${offset}, limit=${limit}, year=${yearRange || "-"}, hasKey=${this.hasKeyConfigured()}`,
    );

    // 最多尝试 2 次：第 1 次失败若为 403，延迟 2 秒后重试 1 次（应对瞬时反爬误判）
    let data: any;
    let lastError: SemanticScholarError | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // successCodes: null 让所有 HTTP 状态码都返回响应对象，避免 Zotero.HTTP.request
        // 在 4xx/5xx 时直接抛出 UnexpectedStatusException，导致无法读取响应体或区分状态码。
        // 配合下面对 403/429 的显式分支处理，能给出更准确的错误信息与重试逻辑。
        const resp = await Zotero.HTTP.request("GET", url, {
          responseType: "json",
          timeout: 15000,
          headers,
          successCodes: null,
        });

        if (resp.status >= 200 && resp.status < 300) {
          data = resp.response;
          lastError = null;
          break;
        }

        const errMsg = this.extractError(resp.response);
        log.api.warn(`Semantic Scholar HTTP ${resp.status} (attempt ${attempt + 1}/2): ${errMsg}`);

        if (resp.status === 403) {
          // 403：无 Key 时常见反爬；首次失败延迟 2s 后重试一次，仍失败再抛友好错误
          lastError = new SemanticScholarError(
            403,
            this.hasKeyConfigured()
              ? `403 Forbidden：API Key 无效或已被封禁。请检查 Semantic Scholar API Key 配置。`
              : `403 Forbidden：Semantic Scholar 拒绝访问（无 API Key 时被反爬限制）。建议在 Zsearch 首选项中配置 Semantic Scholar API Key（申请地址：https://www.semanticscholar.org/product/api）。`,
          );
          if (attempt === 0) {
            await Zotero.Promise.delay(2000);
            continue;
          }
          break;
        }

        if (resp.status === 429) {
          // 429：限额耗尽，重试也无济于事，直接抛出
          throw new SemanticScholarError(
            429,
            `429 Too Many Requests：请求过于频繁，请稍后再试。无 API Key 时共享限额被耗尽，建议配置 API Key。`,
          );
        }

        throw new SemanticScholarError(
          resp.status,
          `Semantic Scholar API ${resp.status}: ${errMsg}`,
        );
      } catch (e: any) {
        // 已包装的错误直接抛出（429 等已构造好的 SemanticScholarError）
        if (e instanceof SemanticScholarError) throw e;
        log.api.warn(`Semantic Scholar request failed (attempt ${attempt + 1}/2): ${e?.message || e}`);
        lastError = new SemanticScholarError(0, `Network error: ${e?.message || e}`);
        // 网络错误也重试一次
        if (attempt === 0) {
          await Zotero.Promise.delay(2000);
          continue;
        }
        break;
      }
    }

    if (lastError) throw lastError;
    if (!data) {
      throw new SemanticScholarError(0, "Semantic Scholar 请求未返回数据");
    }

    const total = Number(data?.total || 0);
    const rawPapers = Array.isArray(data?.data) ? data.data : [];

    log.api.info(
      `Semantic Scholar response: total=${total}, returned=${rawPapers.length}`,
    );

    // 映射为 UnifiedEntry[]
    let entries: UnifiedEntry[] = rawPapers.map((p: any) => this.mapEntry(p));

    // 客户端排序（API 不支持排序参数）
    entries = this.applySort(entries, filters.sort);

    return { total, entries };
  }

  /** 构建年份范围字符串："2020-2025" / "2020-" / "-2025" */
  private buildYearRange(from?: number, to?: number): string | undefined {
    if (from && to) return `${from}-${to}`;
    if (from) return `${from}-`;
    if (to) return `-${to}`;
    return undefined;
  }

  /** 手动拼接 URL，避免 URL 构造函数在某些上下文不可用 */
  private buildUrl(params: Record<string, string>): string {
    const qs = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");
    return `${BASE_URL}?${qs}`;
  }

  /** 将 Semantic Scholar 论文对象映射为 UnifiedEntry */
  private mapEntry(p: any): UnifiedEntry {
    const paperId: string | undefined = p.paperId;

    // 作者名数组：从 authors[].name 提取
    const authors: string[] = Array.isArray(p.authors)
      ? p.authors
          .map((a: any) => (a?.name ? String(a.name) : ""))
          .filter(Boolean)
      : [];

    // 年份 → coverDate（统一为 ${year}-01-01 格式）
    const year =
      p.year != null && p.year !== "" ? Number(p.year) : undefined;
    const coverDate = year ? `${year}-01-01` : undefined;

    // DOI 从 externalIds 提取
    const doi: string | undefined = p?.externalIds?.DOI;

    // 期刊名：优先 journal.name（完整名），其次 venue
    const publicationName: string | undefined =
      p?.journal?.name || p.venue || undefined;

    // 开放访问：openAccessPdf 不为空则视为 OA
    const openAccess = !!p.openAccessPdf;

    // 引用数
    const citedByCount =
      p.citationCount != null ? Number(p.citationCount) : undefined;

    // 文献类型：取 publicationTypes 第一个
    const pubTypes: string[] = Array.isArray(p.publicationTypes)
      ? p.publicationTypes.filter(Boolean)
      : [];
    const subtype = pubTypes[0] || undefined;

    // 在 Semantic Scholar 网站上的链接
    const url = paperId
      ? `https://www.semanticscholar.org/paper/${paperId}`
      : undefined;

    return {
      sourceId: paperId,
      source: "semanticscholar",
      title: p.title || undefined,
      authors: authors.length > 0 ? authors : undefined,
      rawAuthors: p.authors,
      publicationName,
      coverDate,
      coverDisplayDate: year ? String(year) : undefined,
      volume: p?.journal?.volume || undefined,
      pageRange: p?.journal?.pages || undefined,
      doi,
      citedByCount,
      openAccess,
      abstract: p.abstract || undefined,
      subtype,
      subtypeDescription: subtype,
      url,
    };
  }

  /**
   * 客户端排序（API 不支持排序参数）。
   * - sort 含 "cited"：按引用数降序
   * - sort 含 "date"/"year"：按年份降序
   * - 其他：保持 API 返回顺序（相关性）
   */
  private applySort(entries: UnifiedEntry[], sort: string): UnifiedEntry[] {
    if (!sort) return entries;
    const s = String(sort).toLowerCase();
    if (s.includes("cited")) {
      return [...entries].sort(
        (a, b) => (b.citedByCount || 0) - (a.citedByCount || 0),
      );
    }
    if (s.includes("date") || s.includes("year")) {
      return [...entries].sort((a, b) => {
        const ya = a.coverDate ? Number(a.coverDate.slice(0, 4)) || 0 : 0;
        const yb = b.coverDate ? Number(b.coverDate.slice(0, 4)) || 0 : 0;
        return yb - ya;
      });
    }
    return entries;
  }

  /** 从错误响应中提取错误信息 */
  private extractError(resp: any): string {
    try {
      if (typeof resp === "string") {
        const j = JSON.parse(resp);
        return String(j?.error || j?.message || resp.slice(0, 200));
      }
      if (resp && typeof resp === "object") {
        return String(
          resp?.error || resp?.message || JSON.stringify(resp).slice(0, 200),
        );
      }
    } catch {
      /* ignore */
    }
    return "Unknown error";
  }
}

/** 单例导出，供搜索源注册使用 */
export const semanticScholarSource = new SemanticScholarSource();

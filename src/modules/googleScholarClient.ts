/**
 * Google Scholar 搜索源客户端。
 *
 * Google Scholar 没有公开 API，本客户端通过抓取搜索结果页 HTML 并解析为 UnifiedEntry。
 *
 * HTML 结构（关键 class）：
 *   - .gs_r.gs_or.gs_scl    每条结果容器
 *   - .gs_rt                 标题（含 <a> 链接）
 *   - .gs_a                  作者/期刊/年份/出版商
 *   - .gs_rs                 摘要片段
 *   - a[href*="cites="]      被引数链接（文本含 "Cited by N"）
 *   - .gs_or_ggsm / .gs_ggsd PDF 链接（GS 改版频繁，需多 selector 容错）
 *
 * 注意：
 *   - GS 严格反爬，必须使用真实浏览器 User-Agent，否则返回 429
 *   - 分页通过 start=N 参数（每页 10 条）
 *   - 总数从 "About N results" 文本解析
 *   - DOI 不直接提供，从摘要片段或 URL 中正则提取
 */

import { log } from "../utils/logger";
import {
  type ISearchSource,
  type SearchFilters,
  type SearchResult,
  type UnifiedEntry,
} from "./searchSource";

/** GS 搜索端点 */
const GS_URL = "https://scholar.google.com/scholar";

/** 浏览器 User-Agent，避免被识别为爬虫 */
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** 单页结果数（GS 固定 10 条） */
const GS_PAGE_SIZE = 10;

/** 限速间隔：GS 对频繁请求敏感，至少 5 秒一次 */
const RATE_LIMIT_MS = 5000;

/**
 * Google Scholar 搜索源。
 * 不需要 API Key，但抓取可能因 IP/频率受限。
 */
export class GoogleScholarSearchSource implements ISearchSource {
  id = "googleScholar";
  name = "Google Scholar";
  icon = "📚";
  kind = "api" as const;
  needsApiKey = false;

  /** 上次请求时间戳，用于限速 */
  private lastRequestTs = 0;

  hasApiKey(): boolean {
    // GS 免费，始终视为已配置
    return true;
  }

  /**
   * GS 查询语法直接使用用户输入。
   * GS 支持：双引号精确匹配、author:、intitle:、source: 等运算符。
   */
  buildQuery(keywords: string, _filters?: SearchFilters): string {
    return (keywords || "").trim();
  }

  /**
   * 执行 Google Scholar 搜索。
   * @param query 搜索关键词
   * @param filters 过滤器（年份映射为 as_ylo/as_yhi）
   * @param page 页码（从 1 开始）
   * @param pageSize 每页条数（GS 固定 10，忽略此参数）
   */
  async search(
    query: string,
    filters: SearchFilters,
    page: number,
    _pageSize: number,
  ): Promise<SearchResult> {
    const searchQuery = this.buildQuery(query, filters);
    if (!searchQuery) {
      return { total: 0, entries: [] };
    }

    const start = (Math.max(page, 1) - 1) * GS_PAGE_SIZE;

    // 构建查询参数
    const params: string[] = [
      `q=${encodeURIComponent(searchQuery)}`,
      `start=${start}`,
    ];
    // 年份过滤：as_ylo/as_yhi
    if (filters?.yearFrom) {
      params.push(`as_ylo=${filters.yearFrom}`);
    }
    if (filters?.yearTo) {
      params.push(`as_yhi=${filters.yearTo}`);
    }
    // 排序：GS 默认按相关度，按日期排序用 as_vis=1（显示日期视图）
    // 注意：as_sdt 是"排除引用"参数，与排序无关，不在此设置
    if ((filters?.sort || "").toLowerCase().includes("date")) {
      params.push("as_vis=1");
    }

    const url = `${GS_URL}?${params.join("&")}`;
    log.api.info(`Google Scholar search: ${url}`);

    // 限速
    await this.applyRateLimit();

    let resp: any;
    try {
      resp = await Zotero.HTTP.request("GET", url, {
        responseType: "text",
        timeout: 30000,
        headers: {
          "User-Agent": USER_AGENT,
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8",
        },
      });
    } catch (e: any) {
      log.api.warn(`Google Scholar request failed: ${e?.message || e}`);
      throw new Error(
        `Google Scholar 请求失败：${e?.message || "网络错误"}。GS 可能限制了访问，请稍后重试或使用代理。`,
      );
    }

    if (resp.status === 429) {
      // 429 退避：将下次请求推迟到 60 秒后
      this.lastRequestTs = Date.now() + 60_000;
      throw new Error(
        "Google Scholar 返回 429（请求过于频繁）。请等待几分钟后再试，或配置代理。" +
        "\n\n注意：Zotero 基于 Firefox/Gecko，可能被 GS 识别为非浏览器流量。" +
        "如需稳定使用 GS 源，建议在浏览器中先访问 scholar.google.com 完成验证，或使用 Scopus/PubMed 等结构化源。",
      );
    }
    if (resp.status === 503) {
      this.lastRequestTs = Date.now() + 60_000;
      throw new Error(
        "Google Scholar 暂时不可用（503），可能需要验证码。请在浏览器中访问 scholar.google.com 完成验证后再试。",
      );
    }
    if (resp.status < 200 || resp.status >= 300) {
      throw new Error(`Google Scholar HTTP ${resp.status}`);
    }

    const html = resp.response || resp.responseText;
    if (typeof html !== "string" || html.length < 100) {
      log.api.warn(`Google Scholar empty response (len=${html?.length || 0})`);
      return { total: 0, entries: [] };
    }

    // 检测验证码页面
    if (html.includes("g-recaptcha") || html.includes("id=\"captcha\"")) {
      throw new Error(
        "Google Scholar 要求验证码。请在浏览器中访问 scholar.google.com 完成验证后再试。",
      );
    }

    const parsed = this.parseHTML(html, query);
    // 若未解析到总数（GS 某些视图不显示），用当前页结果数估算一个保守值，
    // 确保分页按钮可用（让用户能尝试翻页）。
    if (parsed.total === 0 && parsed.entries.length > 0) {
      // 假设至少有 100 条，避免 total=0 导致分页失效
      parsed.total = Math.max(100, page * GS_PAGE_SIZE + 1);
    }
    log.api.info(
      `Google Scholar result: total=${parsed.total}, entries=${parsed.entries.length}`,
    );

    return parsed;
  }

  /** 限速：确保两次请求间隔至少 RATE_LIMIT_MS 毫秒 */
  private async applyRateLimit(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestTs;
    if (elapsed < RATE_LIMIT_MS) {
      const wait = RATE_LIMIT_MS - elapsed;
      // 优先用原生 Promise + setTimeout（Zotero.Promise 未来可能 deprecated）
      await new Promise<void>((resolve) => {
        setTimeout(resolve, wait);
      });
    }
    this.lastRequestTs = Date.now();
  }

  /**
   * 解析 Google Scholar 搜索结果 HTML。
   * 优先使用 Zotero 内置的 HTML 解析器（保证可用性和 href 绝对化），
   * 回退到 DOMParser。
   */
  private parseHTML(html: string, query: string): SearchResult {
    let doc: Document | null = null;
    // 优先用 Zotero 内置的 HTML 解析器（更稳定，且会自动绝对化 href）
    try {
      const zutils = (Zotero as any).Utilities?.Internal;
      if (zutils && typeof zutils.parseHTML === "function") {
        doc = zutils.parseHTML(html);
      }
    } catch (e: any) {
      log.api.warn(`Zotero.Utilities.Internal.parseHTML failed: ${e?.message || e}`);
    }
    // 回退到 DOMParser
    if (!doc) {
      try {
        doc = new DOMParser().parseFromString(html, "text/html");
      } catch (e: any) {
        log.api.warn(`Google Scholar HTML parse failed: ${e?.message || e}`);
        return { total: 0, entries: [] };
      }
    }
    if (!doc) return { total: 0, entries: [] };

    // 解析总数："About 1,230,000 results" 或 "约 1,230,000 条结果"
    const total = this.extractTotal(doc);

    // 提取所有结果卡片（多种 selector 容错，应对 GS 改版）
    const cards = doc.querySelectorAll(
      ".gs_r.gs_or.gs_scl, .gs_r.gs_or, .gs_ri, .gs_r",
    );
    const entries: UnifiedEntry[] = [];

    cards.forEach((card) => {
      const entry = this.parseCard(card as HTMLElement, query);
      if (entry && entry.title) {
        entries.push(entry);
      }
    });

    // 空结果告警：可能是 GS 改版或被反爬拦截
    if (entries.length === 0) {
      log.api.warn(
        `Google Scholar: parsed 0 entries from HTML (length=${html.length}). ` +
        `GS may have changed HTML structure or blocked the request.`,
      );
    }

    // 去重（DOI 优先，标题次之）
    const seen = new Set<string>();
    const unique: UnifiedEntry[] = [];
    for (const e of entries) {
      const key = e.doi
        ? `doi:${e.doi.toLowerCase()}`
        : (e.title || "").toLowerCase().replace(/^\[(pdf|html|book|citation)\]\s*/i, "").trim().slice(0, 200);
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(e);
      }
    }

    return { total, entries: unique };
  }

  /** 从页面中提取结果总数 */
  private extractTotal(doc: Document): number {
    // GS 的总数在 #gs_ab_md > div 或 .gs_ab_mdw 中
    const abMd = doc.querySelector("#gs_ab_md, .gs_ab_mdw");
    if (abMd) {
      const text = abMd.textContent || "";
      // 匹配 "About 1,230,000 results" / "约 1,230,000 条结果" / "Aproximadamente 1.230.000 resultados"
      const m = text.match(/([\d,.]+)\s*(results|条结果|resultados|Ergebnisse|结果)/i);
      if (m) {
        const num = parseInt(m[1].replace(/[,.]/g, ""), 10);
        if (!isNaN(num)) return num;
      }
    }
    // 退化：用结果数 * 估算页数（保守）
    return 0;
  }

  /** 解析单条结果卡片 */
  private parseCard(card: HTMLElement, query: string): UnifiedEntry | null {
    const entry: UnifiedEntry = {
      source: "googleScholar",
    };

    // 1. sourceId：用 data-cid 或 data-rp
    const cid = card.getAttribute("data-cid");
    if (cid) entry.sourceId = cid;

    // 2. 标题与链接：.gs_rt > a
    const titleEl = card.querySelector(".gs_rt") as HTMLElement | null;
    if (titleEl) {
      const link = titleEl.querySelector("a") as HTMLAnchorElement | null;
      if (link) {
        entry.title = (link.textContent || "").trim();
        // href 在 XML 解析下可能不绝对化，用 URL 构造器兜底
        entry.url = this.resolveUrl(link.getAttribute("href"));
      } else {
        entry.title = (titleEl.textContent || "").trim();
      }
    }
    if (!entry.title) return null;

    // 3. 作者/期刊/年份：.gs_a 文本格式 "J Smith, K Lee - Journal Name, 2020 - publisher.com"
    const gsA = card.querySelector(".gs_a") as HTMLElement | null;
    if (gsA) {
      const text = (gsA.textContent || "").trim();
      this.parseAuthorLine(text, entry);
    }

    // 4. 摘要片段：.gs_rs
    const gsRs = card.querySelector(".gs_rs") as HTMLElement | null;
    if (gsRs) {
      entry.abstract = (gsRs.textContent || "").trim();
      // 从摘要中提取 DOI
      if (!entry.doi) {
        const doi = this.extractDOI(entry.abstract);
        if (doi) entry.doi = doi;
      }
    }

    // 5. 被引数：a[href*="cites="] 或文本含 "Cited by N" / "被引 N"
    const citedLink = card.querySelector<HTMLAnchorElement>('a[href*="cites="]');
    if (citedLink) {
      // 文本可能是 "Cited by 1,234" / "被引 1,234" 等，提取首个数字（含千分位）
      const text = (citedLink.textContent || "").trim();
      const m = text.match(/\d[\d,]*/);
      if (m) {
        entry.citedByCount = parseInt(m[0].replace(/,/g, ""), 10);
      }
    }

    // 6. PDF 链接：多种 selector 容错（GS 改版频繁）
    //    .gs_or_ggsm 是历史 class，.gs_ggsd 是较新版，a[href$=".pdf"] 兜底
    //    注意：:contains() 是 jQuery 伪类，非标准 CSS，Gecko 不支持，改用 JS 过滤
    let pdfLink: HTMLAnchorElement | null = card.querySelector<HTMLAnchorElement>(
      '.gs_or_ggsm a, .gs_ggsd a, a[href$=".pdf"]',
    );
    // 兜底：遍历所有 <a>，查找文本含 "PDF" 的链接
    if (!pdfLink) {
      const anchors = card.querySelectorAll<HTMLAnchorElement>("a");
      for (const a of anchors) {
        const text = (a.textContent || "").trim().toUpperCase();
        if (text === "PDF" || text.includes("[PDF]")) {
          pdfLink = a;
          break;
        }
      }
    }
    if (pdfLink) {
      entry.openAccess = true;
    }

    // 7. 从标题/URL 中提取 DOI（部分 GS 结果 URL 包含 DOI）
    if (!entry.doi && entry.url) {
      const doi = this.extractDOI(entry.url);
      if (doi) entry.doi = doi;
    }

    // 8. 文献类型：根据 gs_rt 的 class 判断
    if (titleEl) {
      const rtClass = titleEl.className;
      if (rtClass.includes("gs_rtu")) {
        // 引用（citation）
        entry.subtype = "ab";
      } else if (rtClass.includes("gs_rtc")) {
        // 书籍
        entry.subtype = "bk";
      } else {
        entry.subtype = "ar";
      }
    }

    return entry;
  }

  /**
   * 将相对 URL 解析为绝对 URL。
   * 在 XHTML/XML 解析环境下 link.href 可能不自动绝对化，需手动处理。
   */
  private resolveUrl(href: string | null): string | undefined {
    if (!href) return undefined;
    try {
      return new URL(href, GS_URL).href;
    } catch {
      return href;
    }
  }

  /**
   * 解析作者行：格式 "J Smith, K Lee - Journal Name, 2020 - publisher.com"
   * 三段用 " - "（前后各一个空格的连字符）分隔：作者 / 期刊, 年份 / 出版商
   *
   * 注意：只用 " - "（带空格）作为分隔符，避免误拆作者名中的连字符
   * （如 "Jean-Pierre Dupont"）和期刊名中的连字符（如 "Journal of Hydro-Engineering"）。
   */
  private parseAuthorLine(text: string, entry: UnifiedEntry): void {
    // 仅匹配前后各至少一个空格的连字符，最多分割 3 段
    const parts = text.split(/\s+-\s+/, 3);
    if (parts.length >= 1) {
      // 作者：用逗号分隔
      const authors = parts[0]
        .split(/,\s*/)
        .map((a) => a.trim())
        .filter(Boolean);
      if (authors.length > 0) {
        entry.authors = authors;
        entry.rawAuthors = authors;
      }
    }
    if (parts.length >= 2) {
      // 期刊, 年份
      const mid = parts[1];
      // 年份通常是 4 位数字
      const yearMatch = mid.match(/\b(19|20)\d{2}\b/);
      if (yearMatch) {
        entry.coverDate = yearMatch[0];
        // 期刊名为年份前的部分
        const journal = cleanText(mid.replace(yearMatch[0], "").replace(/[,\s]+$/, "").trim());
        if (journal) entry.publicationName = journal;
      } else {
        // 无年份，整体作为期刊名
        const journal = cleanText(mid.trim());
        if (journal) entry.publicationName = journal;
      }
    }
    if (parts.length >= 3) {
      // 出版商，暂不存储
    }

    // 兜底：如果上述解析未提取到年份，从整个文本中提取
    // （GS 有时 .gs_a 格式异常，无 " - " 分隔符）
    if (!entry.coverDate) {
      const yearMatch = text.match(/\b(19|20)\d{2}\b/);
      if (yearMatch) {
        entry.coverDate = yearMatch[0];
      }
    }
  }

  /** 从文本中提取 DOI（10.xxxx/yyy 格式） */
  private extractDOI(text: string): string | undefined {
    if (!text) return undefined;
    // 使用 CrossRef 推荐正则，避免非贪婪+强制终止符导致截断
    // 参考：https://www.crossref.org/blog/dois-and-matching-regular-expressions/
    const m = text.match(/\b(10\.\d{4,9}\/[-._;()\/:A-Za-z0-9]+)\b/i);
    if (m) {
      let doi = m[1];
      // 清理末尾标点（防御性，正则已严格但仍可能匹配到末尾 . )
      doi = doi.replace(/[).,;]+$/, "");
      return doi;
    }
    return undefined;
  }
}

/**
 * 清理 GS 解析得到的文本字段：
 * - 解码常见 HTML 实体（&amp; &lt; &gt; &quot; &#39; &apos;）
 * - 去除多余空白
 * - 去除首尾引号
 */
function cleanText(s: string): string {
  if (!s) return "";
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, " ")
    .replace(/^["'\s]+|["'\s]+$/g, "")
    .trim();
}

/** 单例实例 */
export const googleScholarSource = new GoogleScholarSearchSource();

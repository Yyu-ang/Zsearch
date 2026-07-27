import { getPref } from "../utils/prefs";
import { log } from "../utils/logger";
import {
  ISearchSource,
  SearchFilters,
  SearchSourceKind,
  SearchResult,
  UnifiedEntry,
} from "./searchSource";

/**
 * PubMed (NCBI E-utilities) 搜索源客户端。
 *
 * 端点（base: https://eutils.ncbi.nlm.nih.gov/entrez/eutils）：
 *  - esearch: 搜索 PubMed，返回 PMID 列表
 *      esearch.fcgi?db=pubmed&term=<query>&retmax=<count>&retstart=<start>&retmode=json
 *  - efetch:  按 PMID 批量获取文献详情（XML）
 *      efetch.fcgi?db=pubmed&id=<pmid1,pmid2,...>&retmode=xml
 *
 * 鉴权：免费，无需 API Key（可选 Key 提升速率）。
 *  - 无 Key：3 次/秒，请求间隔 ≥ 360ms
 *  - 有 Key：10 次/秒，请求间隔 ≥ 100ms
 *
 * 年份过滤：在 term 中加 `AND ("2020"[PDAT] : "2025"[PDAT])`
 * 类型过滤：`AND Journal Article[PT]` / `AND Review[PT]`
 */

const ESEARCH_URL =
  "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi";
const EFETCH_URL =
  "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi";

/** PubMed 文献详情页 URL 模板 */
const PUBMED_URL_TEMPLATE = "https://pubmed.ncbi.nlm.nih.gov/{pmid}/";

/** 限速器：根据当前是否配置 API Key 动态调整最小请求间隔 */
class RateLimiter {
  private lastRequest = 0;
  constructor(private getMinInterval: () => number) {}
  async wait(): Promise<void> {
    const minInterval = this.getMinInterval();
    const now = Date.now();
    const elapsed = now - this.lastRequest;
    if (elapsed < minInterval) {
      await Zotero.Promise.delay(minInterval - elapsed);
    }
    this.lastRequest = Date.now();
  }
}

export class PubMedClient implements ISearchSource {
  id = "pubmed";
  name = "PubMed";
  icon = "🩺";
  kind: SearchSourceKind = "api";
  /** PubMed 不需要 API Key 也能工作 */
  needsApiKey = false;

  /** 限速器：根据 Key 配置动态选择间隔（无 Key 360ms / 有 Key 100ms） */
  private rateLimiter = new RateLimiter(() =>
    this.hasApiKeyConfigured() ? 100 : 360,
  );

  /** 用户配置的 PubMed API Key（可选） */
  private get apiKey(): string {
    return (getPref("pubmedApiKey") as string) || "";
  }

  /** 请求超时（毫秒），复用全局 pref */
  private get timeout(): number {
    return Number(getPref("requestTimeout") || 15000);
  }

  /** 是否实际配置了 API Key */
  private hasApiKeyConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  /** 接口要求：PubMed 无 Key 也可用，始终返回 true */
  hasApiKey(): boolean {
    return true;
  }

  /**
   * 构建 PubMed 查询字符串。
   * 支持年份范围过滤（PDAT）和类型过滤（Publication Type）。
   */
  buildQuery(keywords: string, filters?: SearchFilters): string {
    const kw = (keywords || "").trim();
    if (!kw) return "";
    let q = kw;

    // 年份过滤：("2020"[PDAT] : "2025"[PDAT])
    const from = filters?.yearFrom;
    const to = filters?.yearTo;
    if (from && to) {
      q += ` AND ("${from}"[PDAT] : "${to}"[PDAT])`;
    } else if (from) {
      q += ` AND ("${from}"[PDAT] : "3000"[PDAT])`;
    } else if (to) {
      q += ` AND ("1900"[PDAT] : "${to}"[PDAT])`;
    }

    // 类型过滤：映射统一类型到 PubMed Publication Type
    if (filters?.type) {
      const typeMap: Record<string, string> = {
        ar: "Journal Article[PT]",
        re: "Review[PT]",
      };
      const pt = typeMap[filters.type];
      if (pt) q += ` AND ${pt}`;
    }

    return q;
  }

  /**
   * 执行搜索：先 esearch 获取 PMID 列表，再 efetch 获取详情。
   */
  async search(
    query: string,
    filters: SearchFilters,
    page: number,
    pageSize: number,
  ): Promise<SearchResult> {
    const term = this.buildQuery(query, filters);
    if (!term) {
      return { total: 0, entries: [] };
    }

    const retstart = (Math.max(page, 1) - 1) * pageSize;
    const retmax = pageSize;

    log.api.info(
      `PubMed search: term="${term}", page=${page}, pageSize=${pageSize}`,
    );
    log.search.info(`PubMed 搜索：第 ${page} 页，每页 ${pageSize} 条`);

    // 1. esearch 获取 PMID 列表
    const esearchParams: Record<string, string> = {
      db: "pubmed",
      term,
      retmax: String(retmax),
      retstart: String(retstart),
      retmode: "json",
    };
    if (this.hasApiKeyConfigured()) {
      esearchParams.api_key = this.apiKey;
    }

    let esearchJson: any;
    try {
      const esearchResp = await this.request(ESEARCH_URL, esearchParams);
      esearchJson = JSON.parse(esearchResp);
    } catch (e: any) {
      log.api.warn(`PubMed esearch 失败: ${e.message}`);
      throw e;
    }

    const esearchResult = esearchJson?.esearchresult || {};
    const total = Number(esearchResult.count || 0);
    const idlist: string[] = esearchResult.idlist || [];

    log.api.info(`PubMed esearch 结果: total=${total}, ids=${idlist.length}`);

    if (idlist.length === 0) {
      return { total: 0, entries: [] };
    }

    // 2. efetch 批量获取详情 XML
    const efetchParams: Record<string, string> = {
      db: "pubmed",
      id: idlist.join(","),
      retmode: "xml",
    };
    if (this.hasApiKeyConfigured()) {
      efetchParams.api_key = this.apiKey;
    }

    let xmlText: string;
    try {
      xmlText = await this.request(EFETCH_URL, efetchParams);
    } catch (e: any) {
      log.api.warn(`PubMed efetch 失败: ${e.message}`);
      throw e;
    }

    // 3. 解析 XML 为 UnifiedEntry[]
    const entries = this.parsePubmedXML(xmlText);
    log.api.info(`PubMed efetch 解析完成: ${entries.length} 条`);

    return { total, entries };
  }

  /**
   * 统一 HTTP 请求（带限速），返回响应文本。
   */
  private async request(
    url: string,
    params: Record<string, string>,
  ): Promise<string> {
    await this.rateLimiter.wait();

    const fullUrl = new URL(url);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") {
        fullUrl.searchParams.set(k, v);
      }
    }

    // 日志中隐藏 API Key
    const safeUrl = this.apiKey
      ? fullUrl.toString().replace(this.apiKey, "***")
      : fullUrl.toString();
    log.api.debug(`PubMed 请求: ${safeUrl}`);

    const resp = await Zotero.HTTP.request("GET", fullUrl.toString(), {
      responseType: "text",
      timeout: this.timeout,
      headers: {
        Accept: "text/xml, application/json",
        "User-Agent": "Zsearch/0.1 (zotero-plugin)",
      },
    });

    if (resp.status < 200 || resp.status >= 300) {
      throw new Error(`PubMed HTTP ${resp.status}: ${resp.response?.slice?.(0, 200) ?? ""}`);
    }
    return resp.response;
  }

  /**
   * 解析 efetch 返回的 PubMed XML，提取 PubmedArticle 列表。
   */
  private parsePubmedXML(xmlText: string): UnifiedEntry[] {
    const entries: UnifiedEntry[] = [];
    let doc: Document;
    try {
      doc = new DOMParser().parseFromString(xmlText, "text/xml");
    } catch (e: any) {
      log.api.warn(`PubMed XML 解析失败: ${e.message}`);
      return entries;
    }

    const articles = doc.getElementsByTagName("PubmedArticle");
    for (let i = 0; i < articles.length; i++) {
      try {
        const entry = this.mapArticle(articles[i] as Element);
        if (entry) entries.push(entry);
      } catch (e: any) {
        log.api.warn(`PubMed 第 ${i + 1} 条解析失败: ${e.message}`);
      }
    }
    return entries;
  }

  /**
   * 将单个 PubmedArticle XML 节点映射为 UnifiedEntry。
   */
  private mapArticle(node: Element): UnifiedEntry | null {
    // PMID（MedlineCitation > PMID）
    const pmid = this.getTextByPath(node, "MedlineCitation PMID");
    if (!pmid) return null;

    // 标题（Article > ArticleTitle）
    const title = this.getTextByPath(node, "MedlineCitation Article ArticleTitle");

    // 摘要：可能有多个 AbstractText，带 Label（如 BACKGROUND/METHODS）
    const abstractParts: string[] = [];
    const abstractNodes = node.getElementsByTagName("AbstractText");
    for (let i = 0; i < abstractNodes.length; i++) {
      const label = abstractNodes[i].getAttribute("Label");
      const text = (abstractNodes[i].textContent || "").trim();
      if (text) {
        abstractParts.push(label ? `${label}: ${text}` : text);
      }
    }
    const abstract = abstractParts.length > 0 ? abstractParts.join(" ") : undefined;

    // 作者列表（AuthorList > Author，取 LastName + ForeName）
    const authors: string[] = [];
    const rawAuthors: any[] = [];
    const authorNodes = node.getElementsByTagName("Author");
    for (let i = 0; i < authorNodes.length; i++) {
      const authorEl = authorNodes[i] as Element;
      const lastName = this.getTextByPath(authorEl, "LastName");
      const foreName = this.getTextByPath(authorEl, "ForeName");
      const collectiveName = this.getTextByPath(authorEl, "CollectiveName");
      if (lastName || foreName) {
        const full = [foreName, lastName].filter(Boolean).join(" ").trim();
        authors.push(full);
        rawAuthors.push({ lastName, foreName, fullName: full });
      } else if (collectiveName) {
        authors.push(collectiveName);
        rawAuthors.push({ collectiveName, fullName: collectiveName });
      }
    }

    // 期刊信息（Article > Journal）
    const publicationName = this.getTextByPath(node, "MedlineCitation Article Journal Title");
    const issn = this.getTextByPath(node, "MedlineCitation Article Journal ISSN");
    const volume = this.getTextByPath(node, "MedlineCitation Article Journal JournalIssue Volume");
    const issue = this.getTextByPath(node, "MedlineCitation Article Journal JournalIssue Issue");

    // 出版日期（JournalIssue > PubDate，可能是 Year/Month/Day 或 MedlineDate）
    const { coverDate, coverDisplayDate } = this.parsePubDate(node);

    // 页码（Pagination > MedlinePgn）
    const pageRange = this.getTextByPath(node, "MedlineCitation Article Pagination MedlinePgn");

    // DOI / PII：优先从 ELocationID 取，再从 PubmedData > ArticleIdList 取
    let doi: string | undefined;
    let pii: string | undefined;
    const elocationNodes = node.getElementsByTagName("ELocationID");
    for (let i = 0; i < elocationNodes.length; i++) {
      const eidType = elocationNodes[i].getAttribute("EIdType");
      const val = (elocationNodes[i].textContent || "").trim();
      if (eidType === "doi" && val) doi = val;
    }
    const articleIdNodes = node.getElementsByTagName("ArticleId");
    for (let i = 0; i < articleIdNodes.length; i++) {
      const idType = articleIdNodes[i].getAttribute("IdType");
      const val = (articleIdNodes[i].textContent || "").trim();
      if (idType === "doi" && val && !doi) doi = val;
      if (idType === "pii" && val) pii = val;
      if (idType === "pmc" && val && !pii) {
        // PMC ID 作为备用标识，不覆盖 pii
      }
    }

    // 关键词（KeywordList > Keyword，作者关键词）
    const keywords: string[] = [];
    const keywordNodes = node.getElementsByTagName("Keyword");
    for (let i = 0; i < keywordNodes.length; i++) {
      const kw = (keywordNodes[i].textContent || "").trim();
      if (kw) keywords.push(kw);
    }

    // 文献类型（PublicationTypeList > PublicationType）
    const pubTypes: string[] = [];
    const pubTypeNodes = node.getElementsByTagName("PublicationType");
    for (let i = 0; i < pubTypeNodes.length; i++) {
      const pt = (pubTypeNodes[i].textContent || "").trim();
      if (pt) pubTypes.push(pt);
    }
    const { subtype, subtypeDescription } = this.normalizePubType(pubTypes);

    const entry: UnifiedEntry = {
      sourceId: pmid,
      source: "pubmed",
      title,
      authors: authors.length > 0 ? authors : undefined,
      rawAuthors: rawAuthors.length > 0 ? rawAuthors : undefined,
      publicationName,
      coverDate,
      coverDisplayDate,
      volume,
      issue,
      pageRange,
      doi,
      pii,
      issn,
      abstract,
      subtype,
      subtypeDescription,
      url: PUBMED_URL_TEMPLATE.replace("{pmid}", pmid),
      keywords: keywords.length > 0 ? keywords : undefined,
    };

    return entry;
  }

  /**
   * 解析 PubDate 节点，返回 ISO 日期和显示日期。
   * PubMed PubDate 可能包含 Year/Month/Day，或仅 MedlineDate（如 "2024 Jan-Feb"）。
   */
  private parsePubDate(
    node: Element,
  ): { coverDate?: string; coverDisplayDate?: string } {
    const pubDateEl = this.getFirstByPath(node, "MedlineCitation Article Journal JournalIssue PubDate");
    if (!pubDateEl) return {};

    const year = this.getTextByPath(pubDateEl, "Year");
    const month = this.getTextByPath(pubDateEl, "Month");
    const day = this.getTextByPath(pubDateEl, "Day");
    const medlineDate = this.getTextByPath(pubDateEl, "MedlineDate");

    if (year) {
      // 有 Year，尝试拼成 ISO 日期
      const monthNum = this.monthToNumber(month);
      let coverDate = year;
      let coverDisplayDate = year;
      if (monthNum) {
        coverDate += `-${String(monthNum).padStart(2, "0")}`;
        coverDisplayDate += `-${String(monthNum).padStart(2, "0")}`;
        if (day) {
          coverDate += `-${day.padStart(2, "0")}`;
          coverDisplayDate += `-${day.padStart(2, "0")}`;
        }
      }
      return { coverDate, coverDisplayDate };
    }

    // 仅有 MedlineDate，无法标准化为 ISO，直接用作显示日期
    if (medlineDate) {
      return { coverDisplayDate: medlineDate };
    }

    return {};
  }

  /** 月份名称/缩写转数字（Jan→1, January→1, 1→1），无法识别返回 0 */
  private monthToNumber(month?: string): number {
    if (!month) return 0;
    const n = Number(month);
    if (n >= 1 && n <= 12) return n;
    const months: Record<string, number> = {
      jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
      jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
    };
    return months[month.toLowerCase().slice(0, 3)] || 0;
  }

  /**
   * 将 PubMed PublicationType 归一化为统一 subtype。
   * 常见映射：Journal Article → article，Review → review。
   */
  private normalizePubType(
    pubTypes: string[],
  ): { subtype?: string; subtypeDescription?: string } {
    if (pubTypes.length === 0) return {};
    const desc = pubTypes.join(", ");
    // 按优先级匹配常见类型
    if (pubTypes.some((t) => /review/i.test(t))) {
      return { subtype: "review", subtypeDescription: desc };
    }
    if (pubTypes.some((t) => /journal article/i.test(t))) {
      return { subtype: "article", subtypeDescription: desc };
    }
    if (pubTypes.some((t) => /case reports/i.test(t))) {
      return { subtype: "case", subtypeDescription: desc };
    }
    if (pubTypes.some((t) => /clinical trial/i.test(t))) {
      return { subtype: "trial", subtypeDescription: desc };
    }
    if (pubTypes.some((t) => /conference/i.test(t))) {
      return { subtype: "conference", subtypeDescription: desc };
    }
    // 兜底：用第一个类型的小写形式
    return { subtype: pubTypes[0].toLowerCase(), subtypeDescription: desc };
  }

  /**
   * 按路径（空格分隔的标签序列）查找后代元素的文本内容。
   * 使用 querySelector 实现精确层级匹配，避免 getElementsByTagName 跨层误取。
   */
  private getTextByPath(parent: Element, path: string): string | undefined {
    const el = this.getFirstByPath(parent, path);
    const text = el?.textContent?.trim();
    return text || undefined;
  }

  /** 按 CSS 选择器路径查找第一个匹配元素 */
  private getFirstByPath(parent: Element, path: string): Element | null {
    try {
      return parent.querySelector(path);
    } catch {
      // 某些 XML 上下文 querySelector 可能不可用，降级为 getElementsByTagName
      const tags = path.split(/\s+/).filter(Boolean);
      if (tags.length === 0) return null;
      let scope: Element = parent;
      for (const tag of tags) {
        const found = scope.getElementsByTagName(tag)[0];
        if (!found) return null;
        scope = found;
      }
      return scope;
    }
  }
}

/** 默认单例实例，供搜索源注册直接使用 */
export const pubmedClient = new PubMedClient();

/**
 * 统一搜索源接口和类型定义。
 * 所有学术搜索源客户端（Scopus/PubMed/arXiv/Semantic Scholar/Springer）都实现此接口。
 *
 * 对于无法返回结构化结果的源（Google Scholar/Google/ResearchGate/JSTOR/WoS），
 * 使用 WebSearchSource 类型，选择时在浏览器中打开搜索页。
 */

/** 统一的搜索过滤器 */
export interface SearchFilters {
  yearFrom?: number;
  yearTo?: number;
  sort: string;
  type: string;
}

/** 统一的文献条目格式，跨搜索源通用 */
export interface UnifiedEntry {
  /** 搜索源内部唯一 ID（eid/pmid/arxivId/paperId 等） */
  sourceId?: string;
  /** 搜索源标识：scopus / pubmed / arxiv / semanticscholar / springer */
  source: string;
  /**
   * 聚合搜索时的所有来源列表。
   * 单源搜索时为空数组；聚合搜索时记录所有命中该条目的来源 ID。
   */
  sources?: string[];
  title?: string;
  /** 作者数组，每个元素为 "Surname GivenName" 或 "Surname G." */
  authors?: string[];
  /** 原始作者数据（用于格式化显示，可能是对象数组或字符串） */
  rawAuthors?: any;
  publicationName?: string;
  coverDate?: string;
  coverDisplayDate?: string;
  volume?: string;
  issue?: string;
  pageRange?: string;
  articleNumber?: string;
  doi?: string;
  pii?: string;
  issn?: string;
  eIssn?: string;
  isbn?: string;
  citedByCount?: number;
  openAccess?: boolean;
  abstract?: string;
  /** 文献类型：article/review/conference/preprint 等 */
  subtype?: string;
  subtypeDescription?: string;
  /** 在搜索源网站上的链接 */
  url?: string;
  /** 关键词 */
  keywords?: string[];
}

/** 统一搜索结果 */
export interface SearchResult {
  total: number;
  entries: UnifiedEntry[];
}

/** 搜索源类型 */
export type SearchSourceKind = "api" | "web";

/** API 搜索源接口（返回结构化结果） */
export interface ISearchSource {
  id: string;
  /** 显示名称 */
  name: string;
  /** 图标 emoji */
  icon: string;
  kind: SearchSourceKind;
  /** 是否需要 API Key 才能工作 */
  needsApiKey: boolean;
  /** 当前是否已配置 API Key（不需要 Key 的源始终返回 true） */
  hasApiKey(): boolean;
  /** 执行搜索 */
  search(
    query: string,
    filters: SearchFilters,
    page: number,
    pageSize: number,
  ): Promise<SearchResult>;
  /** 构建查询字符串（用于调试日志） */
  buildQuery?(keywords: string, filters?: SearchFilters): string;
}

/** Web 搜索源（仅浏览器跳转） */
export interface WebSearchSource {
  id: string;
  name: string;
  icon: string;
  kind: SearchSourceKind;
  /** URL 模板，{{query}} 为占位符 */
  urlTemplate: string;
}

/** 所有搜索源的联合类型 */
export type AnySearchSource = ISearchSource | WebSearchSource;

/** PDF 下载渠道接口 */
export interface IPDFDownloadProvider {
  id: string;
  name: string;
  /** 是否可以处理该条目 */
  canHandle(entry: UnifiedEntry): boolean;
  /**
   * 尝试下载 PDF。
   * @param entry 搜索结果条目
   * @param item 已导入的 Zotero 条目
   * @returns 是否成功下载并附加 PDF
   */
  download(entry: UnifiedEntry, item: Zotero.Item): Promise<boolean>;
}

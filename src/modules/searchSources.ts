/**
 * 搜索源注册表。
 * 统一管理所有搜索源（API 源 + Web 跳转源）。
 * 搜索窗口通过此注册表获取下拉列表和当前选中的源。
 */

import { getPref, setPref } from "../utils/prefs";
import { log } from "../utils/logger";
import type { ISearchSource, WebSearchSource, AnySearchSource, UnifiedEntry } from "./searchSource";
import { pubmedClient } from "./pubmedClient";
import { arxivSearchSource } from "./arxivClient";
import { semanticScholarSource } from "./semanticScholarClient";
import { springerClient } from "./springerClient";
import { googleScholarSource } from "./googleScholarClient";
import { ElsevierClient } from "./elsevierClient";

// ===== Scopus 适配器 =====
// 包装现有 ElsevierClient，实现 ISearchSource 接口
class ScopusSearchSource implements ISearchSource {
  id = "scopus";
  name = "Scopus";
  icon = "🔬";
  kind = "api" as const;
  needsApiKey = true;
  private client: ElsevierClient;

  constructor(client: ElsevierClient) {
    this.client = client;
  }

  getClient(): ElsevierClient {
    return this.client;
  }

  hasApiKey(): boolean {
    return this.client.hasApiKey();
  }

  buildQuery(keywords: string, filters?: any): string {
    return this.client.buildQuery(keywords, filters);
  }

  async search(
    query: string,
    filters: any,
    page: number,
    pageSize: number,
  ): Promise<{ total: number; entries: UnifiedEntry[] }> {
    const start = (page - 1) * pageSize;
    const result = await this.client.searchScopus({
      query,
      count: pageSize,
      start,
      sort: filters?.sort || undefined,
    });
    // 将 ScopusEntry 转为 UnifiedEntry
    const entries: UnifiedEntry[] = result.entries.map((e) => ({
      sourceId: e.eid,
      source: "scopus",
      title: e.title,
      rawAuthors: e.authors || e.creator,
      publicationName: e.publicationName,
      coverDate: e.coverDate,
      coverDisplayDate: e.coverDisplayDate,
      volume: e.volume,
      issue: e.issue,
      pageRange: e.pageRange,
      articleNumber: e.articleNumber,
      doi: e.doi,
      pii: e.pii,
      issn: e.issn,
      eIssn: e.eIssn,
      isbn: e.isbn,
      citedByCount: e.citedByCount,
      openAccess: e.openAccess,
      abstract: e.description,
      subtype: e.subtype,
      subtypeDescription: e.subtypeDescription,
      url: e.scopusUrl,
      keywords: e.authKeywords,
    }));
    return { total: result.total, entries };
  }
}

// ===== Web 搜索源（仅浏览器跳转）=====
const webSources: WebSearchSource[] = [
  {
    id: "google",
    name: "Google",
    icon: "🌍",
    kind: "web",
    urlTemplate: "https://www.google.com/search?q={{query}}",
  },
  // googleScholar 已升级为 API 源（HTML 解析），不再作为 web 跳转源
  {
    id: "researchgate",
    name: "ResearchGate",
    icon: "🔬",
    kind: "web",
    urlTemplate: "https://www.researchgate.net/search?q={{query}}",
  },
  {
    id: "jstor",
    name: "JSTOR",
    icon: "📖",
    kind: "web",
    urlTemplate: "https://www.jstor.org/action/doBasicSearch?Query={{query}}",
  },
  {
    id: "ieee",
    name: "IEEE Xplore",
    icon: "⚡",
    kind: "web",
    urlTemplate: "https://ieeexplore.ieee.org/search/searchresult.jsp?queryText={{query}}",
  },
];

// ===== 注册表 =====
let apiSources: ISearchSource[] = [];
let initialized = false;

/**
 * 初始化搜索源注册表。
 * @param elsevierClient 主 Scopus 客户端实例
 */
export function initSearchSources(elsevierClient: ElsevierClient): void {
  if (initialized) return;
  apiSources = [
    new ScopusSearchSource(elsevierClient),
    pubmedClient,
    arxivSearchSource,
    semanticScholarSource,
    springerClient,
    googleScholarSource,
  ];
  initialized = true;
  log.search.info(`Search sources initialized: ${apiSources.map((s) => s.id).join(", ")}`);
}

/** 获取所有 API 搜索源 */
export function getApiSources(): ISearchSource[] {
  return apiSources;
}

/** 获取所有 Web 搜索源 */
export function getWebSources(): WebSearchSource[] {
  return webSources;
}

/** 获取所有搜索源（API + Web），用于下拉列表 */
export function getAllSources(): AnySearchSource[] {
  return [...apiSources, ...webSources];
}

/** 获取当前选中的搜索源 */
export function getActiveSource(): AnySearchSource | null {
  const activeId = (getPref("activeSource") as string) || "scopus";
  const all = getAllSources();
  return all.find((s) => s.id === activeId) || all[0] || null;
}

/** 设置当前搜索源 */
export function setActiveSource(id: string): void {
  setPref("activeSource", id);
  log.search.info(`Active search source set to: ${id}`);
}

/** 根据 ID 获取搜索源 */
export function getSourceById(id: string): AnySearchSource | null {
  return getAllSources().find((s) => s.id === id) || null;
}

/**
 * 获取 Web 搜索源的 URL（替换占位符）
 */
export function getWebSearchUrl(source: WebSearchSource, query: string): string {
  return source.urlTemplate.replace("{{query}}", encodeURIComponent(query));
}

// ===== 聚合搜索 =====

/** 聚合搜索源 ID */
export const AGGREGATE_SOURCE_ID = "aggregate";

/**
 * 创建聚合搜索源（虚拟源，并行调用多个 API 源并合并结果）。
 * 不实现 ISearchSource 接口，由 searchWindow 直接调用 aggregateSearch。
 */

/**
 * 聚合搜索：并行调用所有可用 API 源，按 DOI/标题去重合并。
 * - 仅调用已配置 API Key 的源（needsApiKey=true 但无 Key 的跳过）
 * - 不需要 Key 的源（PubMed/arXiv/Semantic Scholar/Springer/GS）始终调用
 * - 按 DOI 去重（无 DOI 按标题去重）
 * - 合并字段：取第一个非空值，来源记入 sources 数组
 * - 各源仅取第 1 页结果，不翻页
 * @returns 合并后的条目列表（已去重，按命中来源数降序、被引数降序排序）
 */
export async function aggregateSearch(
  query: string,
  filters: any,
  pageSize: number,
): Promise<{ total: number; entries: UnifiedEntry[] }> {
  const available = getApiSources().filter((s) => {
    // 跳过未配置 API Key 的源
    if (s.needsApiKey && !s.hasApiKey()) return false;
    return true;
  });

  log.search.info(
    `aggregateSearch: query="${query}", sources=[${available.map((s) => s.id).join(", ")}]`,
  );

  // 并行调用所有源，每源取 pageSize 条（各源失败不影响其他源）
  const results = await Promise.all(
    available.map(async (src) => {
      try {
        const r = await src.search(query, filters, 1, pageSize);
        log.search.info(`aggregateSearch: ${src.id} returned ${r.entries.length} entries`);
        return { sourceId: src.id, entries: r.entries };
      } catch (e) {
        log.search.warn(`aggregateSearch: ${src.id} failed: ${(e as Error).message}`);
        return { sourceId: src.id, entries: [] as UnifiedEntry[] };
      }
    }),
  );

  // 按 DOI/标题去重合并
  const byDoi = new Map<string, UnifiedEntry>();
  const byTitle = new Map<string, UnifiedEntry>();
  const merged: UnifiedEntry[] = [];

  for (const { sourceId, entries } of results) {
    for (const entry of entries) {
      const doi = (entry.doi || "").trim().toLowerCase();
      const title = (entry.title || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");

      if (doi) {
        const existing = byDoi.get(doi);
        if (existing) {
          // 合并：添加来源，补充缺失字段
          if (!existing.sources) existing.sources = [existing.source];
          if (!existing.sources.includes(sourceId)) existing.sources.push(sourceId);
          mergeEntryFields(existing, entry);
          continue;
        }
      }

      if (title) {
        const existing = byTitle.get(title);
        if (existing) {
          // 标题匹配（可能 DOI 缺失），合并
          if (!existing.sources) existing.sources = [existing.source];
          if (!existing.sources.includes(sourceId)) existing.sources.push(sourceId);
          mergeEntryFields(existing, entry);
          // 如果有 DOI，迁移到 byDoi 映射
          if (doi && !existing.doi) {
            existing.doi = entry.doi;
            byDoi.set(doi, existing);
            byTitle.delete(title);
          }
          continue;
        }
      }

      // 新条目
      const newEntry: UnifiedEntry = { ...entry };
      newEntry.sources = [sourceId];
      merged.push(newEntry);
      if (doi) byDoi.set(doi, newEntry);
      if (title) byTitle.set(title, newEntry);
    }
  }

  // 排序：命中来源数降序 → 被引数降序
  merged.sort((a, b) => {
    const sa = (a.sources?.length || 1);
    const sb = (b.sources?.length || 1);
    if (sb !== sa) return sb - sa;
    return (b.citedByCount || 0) - (a.citedByCount || 0);
  });

  // 截断到 pageSize
  const finalEntries = merged.slice(0, pageSize);
  log.search.info(
    `aggregateSearch: merged ${merged.length} entries (deduped), returning ${finalEntries.length}`,
  );

  return { total: merged.length, entries: finalEntries };
}

/**
 * 合并条目字段：用 other 补充 target 中缺失的字段。
 * target 已有值不覆盖。
 */
function mergeEntryFields(target: UnifiedEntry, other: UnifiedEntry): void {
  if (!target.abstract && other.abstract) target.abstract = other.abstract;
  if (!target.publicationName && other.publicationName) target.publicationName = other.publicationName;
  if (!target.coverDate && other.coverDate) target.coverDate = other.coverDate;
  if (!target.volume && other.volume) target.volume = other.volume;
  if (!target.issue && other.issue) target.issue = other.issue;
  if (!target.pageRange && other.pageRange) target.pageRange = other.pageRange;
  if (!target.doi && other.doi) target.doi = other.doi;
  if (!target.url && other.url) target.url = other.url;
  if (!target.issn && other.issn) target.issn = other.issn;
  if (!target.isbn && other.isbn) target.isbn = other.isbn;
  if (target.citedByCount === undefined && other.citedByCount !== undefined) {
    target.citedByCount = other.citedByCount;
  }
  // 取较大的被引数
  if (target.citedByCount !== undefined && other.citedByCount !== undefined) {
    target.citedByCount = Math.max(target.citedByCount, other.citedByCount);
  }
  // OA 状态：任一源为 OA 即为 OA
  if (other.openAccess) target.openAccess = true;
  if (!target.subtype && other.subtype) target.subtype = other.subtype;
  if (!target.subtypeDescription && other.subtypeDescription) target.subtypeDescription = other.subtypeDescription;
  // 作者：若 target 无，用 other
  if (!target.authors && other.authors) target.authors = other.authors;
  if (!target.rawAuthors && other.rawAuthors) target.rawAuthors = other.rawAuthors;
  if (!target.keywords && other.keywords) target.keywords = other.keywords;
}

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
import { ieeeClient } from "./ieeeClient";
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
  // IEEE Xplore 已升级为 API 源（需要 API Key），不再作为 web 跳转源
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
    ieeeClient,
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

/** 获取当前选中的搜索源 ID（包括虚拟的 aggregate 源） */
export function getActiveSourceId(): string {
  return (getPref("activeSource") as string) || "scopus";
}

/** 获取当前选中的搜索源（不支持虚拟 aggregate 源，回退到首个实际源） */
export function getActiveSource(): AnySearchSource | null {
  const activeId = getActiveSourceId();
  // aggregate 是虚拟源，不在 getAllSources() 中，回退到首个实际源
  if (activeId === AGGREGATE_SOURCE_ID) {
    return getAllSources()[0] || null;
  }
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
 * - 不需要 Key 的源（PubMed/arXiv/Semantic Scholar/Springer/GS/IEEE）始终调用
 * - 按 DOI 去重（无 DOI 按标题去重）
 * - 合并字段：取第一个非空值，来源记入 sources 数组
 * - 各源仅取第 1 页结果，不翻页
 * - 每源设 12 秒超时，慢源不阻塞整体
 * - 每源取 pageSize 条（不再限制为 10），保证结果数量
 * - 流式聚合：每个源完成即调用 onBatch 推送增量结果，先返回的条目立即可见
 * @returns 合并后的条目列表（已去重，按命中来源数降序、被引数降序排序）
 */
export async function aggregateSearch(
  query: string,
  filters: any,
  pageSize: number,
  onProgress?: (done: number, total: number, sourceId: string, count: number) => void,
  onBatch?: (allMerged: UnifiedEntry[], newCount: number, doneSources: number, totalSources: number) => void,
  onComplete?: (byDoi: Map<string, UnifiedEntry>, byTitle: Map<string, UnifiedEntry>) => void,
): Promise<{ total: number; entries: UnifiedEntry[] }> {
  const available = getApiSources().filter((s) => {
    if (s.needsApiKey && !s.hasApiKey()) return false;
    return true;
  });

  // 每源取 pageSize 条，保证结果数量
  const perSource = pageSize;
  // 每源超时 15 秒（更宽容，避免慢源丢结果）
  const SOURCE_TIMEOUT_MS = 15000;

  log.search.info(
    `aggregateSearch: query="${query}", sources=[${available.map((s) => s.id).join(", ")}], perSource=${perSource}`,
  );

  const totalSources = available.length;
  let doneCount = 0;

  // 去重映射（流式聚合共享）
  const byDoi = new Map<string, UnifiedEntry>();
  const byTitle = new Map<string, UnifiedEntry>();
  const merged: UnifiedEntry[] = [];
  let mergeCount = 0;

  /**
   * 将单个源返回的条目增量合并到 merged/byDoi/byTitle。
   * @returns 本次新增的条目数（不含合并到已有的）
   */
  const mergeBatch = (sourceId: string, entries: UnifiedEntry[]): number => {
    let newCount = 0;
    for (const entry of entries) {
      const doi = normalizeDoi(entry.doi);
      const title = normalizeTitle(entry.title);

      if (doi) {
        const existing = byDoi.get(doi);
        if (existing) {
          if (!existing.sources) existing.sources = [existing.source];
          if (!existing.sources.includes(sourceId)) {
            existing.sources.push(sourceId);
            mergeCount++;
            log.search.info(
              `aggregateSearch: DOI 合并 "${entry.title?.slice(0, 50)}" 来源 ${sourceId} → [${existing.sources.join(", ")}]`,
            );
          }
          mergeEntryFields(existing, entry);
          continue;
        }
      }

      if (title) {
        const existing = byTitle.get(title);
        if (existing) {
          if (!existing.sources) existing.sources = [existing.source];
          if (!existing.sources.includes(sourceId)) {
            existing.sources.push(sourceId);
            mergeCount++;
            log.search.info(
              `aggregateSearch: 标题合并 "${entry.title?.slice(0, 50)}" 来源 ${sourceId} → [${existing.sources.join(", ")}]`,
            );
          }
          mergeEntryFields(existing, entry);
          if (doi && !normalizeDoi(existing.doi)) {
            existing.doi = entry.doi;
            byDoi.set(doi, existing);
            byTitle.delete(title);
          }
          continue;
        }
      }

      const newEntry: UnifiedEntry = { ...entry };
      newEntry.sources = [sourceId];
      merged.push(newEntry);
      if (doi) byDoi.set(doi, newEntry);
      if (title) byTitle.set(title, newEntry);
      newCount++;
    }
    return newCount;
  };

  // 并行调用所有源，每源带超时；完成一个就合并一个并推送 onBatch
  await Promise.all(
    available.map(async (src) => {
      try {
        const resultP = src.search(query, filters, 1, perSource);
        const timeoutP = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), SOURCE_TIMEOUT_MS),
        );
        const r = await Promise.race([resultP, timeoutP]);
        log.search.info(`aggregateSearch: ${src.id} returned ${r.entries.length} entries`);
        doneCount++;
        onProgress?.(doneCount, totalSources, src.id, r.entries.length);

        // 流式合并：本源结果立即并入 merged
        const newCount = mergeBatch(src.id, r.entries);
        // 重排序并推送增量更新
        sortMerged(merged);
        onBatch?.(merged, newCount, doneCount, totalSources);
      } catch (e) {
        doneCount++;
        log.search.warn(`aggregateSearch: ${src.id} failed: ${(e as Error).message}`);
        onProgress?.(doneCount, totalSources, src.id, 0);
        // 失败的源不推送 onBatch（无新条目）
      }
    }),
  );

  // 最终排序
  sortMerged(merged);
  log.search.info(
    `aggregateSearch: 共合并 ${mergeCount} 次，最终 ${merged.length} 条`,
  );

  // 传递去重映射供加载更多使用
  onComplete?.(byDoi, byTitle);

  return { total: merged.length, entries: merged };
}

/**
 * 聚合搜索"加载更多"：在已有结果基础上，拉取各源下一页并合并。
 * - 复用已有的 byDoi/byTitle 去重映射（通过参数传入），避免重复条目
 * - 每源取第 `page` 页（从 2 开始，第 1 页由 aggregateSearch 拉取）
 * - 流式合并，每源完成即调用 onBatch 推送增量结果
 * @param existingMerged 已合并的条目列表（会被此函数追加）
 * @param byDoi 已有的 DOI 去重映射（会被追加）
 * @param byTitle 已有的标题去重映射（会被追加）
 * @returns 合并后的全量条目列表
 */
export async function aggregateSearchMore(
  query: string,
  filters: any,
  pageSize: number,
  page: number,
  existingMerged: UnifiedEntry[],
  byDoi: Map<string, UnifiedEntry>,
  byTitle: Map<string, UnifiedEntry>,
  onProgress?: (done: number, total: number, sourceId: string, count: number) => void,
  onBatch?: (allMerged: UnifiedEntry[], newCount: number, doneSources: number, totalSources: number) => void,
): Promise<{ total: number; entries: UnifiedEntry[] }> {
  const available = getApiSources().filter((s) => {
    if (s.needsApiKey && !s.hasApiKey()) return false;
    return true;
  });

  const perSource = pageSize;
  const SOURCE_TIMEOUT_MS = 15000;

  log.search.info(
    `aggregateSearchMore: query="${query}", page=${page}, sources=[${available.map((s) => s.id).join(", ")}]`,
  );

  const totalSources = available.length;
  let doneCount = 0;
  const merged = existingMerged;
  let mergeCount = 0;

  const mergeBatch = (sourceId: string, entries: UnifiedEntry[]): number => {
    let newCount = 0;
    for (const entry of entries) {
      const doi = normalizeDoi(entry.doi);
      const title = normalizeTitle(entry.title);

      if (doi) {
        const existing = byDoi.get(doi);
        if (existing) {
          if (!existing.sources) existing.sources = [existing.source];
          if (!existing.sources.includes(sourceId)) {
            existing.sources.push(sourceId);
            mergeCount++;
          }
          mergeEntryFields(existing, entry);
          continue;
        }
      }

      if (title) {
        const existing = byTitle.get(title);
        if (existing) {
          if (!existing.sources) existing.sources = [existing.source];
          if (!existing.sources.includes(sourceId)) {
            existing.sources.push(sourceId);
            mergeCount++;
          }
          mergeEntryFields(existing, entry);
          if (doi && !normalizeDoi(existing.doi)) {
            existing.doi = entry.doi;
            byDoi.set(doi, existing);
            byTitle.delete(title);
          }
          continue;
        }
      }

      const newEntry: UnifiedEntry = { ...entry };
      newEntry.sources = [sourceId];
      merged.push(newEntry);
      if (doi) byDoi.set(doi, newEntry);
      if (title) byTitle.set(title, newEntry);
      newCount++;
    }
    return newCount;
  };

  await Promise.all(
    available.map(async (src) => {
      try {
        const resultP = src.search(query, filters, page, perSource);
        const timeoutP = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), SOURCE_TIMEOUT_MS),
        );
        const r = await Promise.race([resultP, timeoutP]);
        log.search.info(`aggregateSearchMore: ${src.id} page=${page} returned ${r.entries.length} entries`);
        doneCount++;
        onProgress?.(doneCount, totalSources, src.id, r.entries.length);

        const newCount = mergeBatch(src.id, r.entries);
        sortMerged(merged);
        onBatch?.(merged, newCount, doneCount, totalSources);
      } catch (e) {
        doneCount++;
        log.search.warn(`aggregateSearchMore: ${src.id} failed: ${(e as Error).message}`);
        onProgress?.(doneCount, totalSources, src.id, 0);
      }
    }),
  );

  sortMerged(merged);
  log.search.info(
    `aggregateSearchMore: 共新增合并 ${mergeCount} 次，最终 ${merged.length} 条`,
  );

  return { total: merged.length, entries: merged };
}

/** 聚合结果排序：命中来源数降序 → 被引数降序 */
function sortMerged(merged: UnifiedEntry[]): void {
  merged.sort((a, b) => {
    const sa = (a.sources?.length || 1);
    const sb = (b.sources?.length || 1);
    if (sb !== sa) return sb - sa;
    return (b.citedByCount || 0) - (a.citedByCount || 0);
  });
}

/**
 * DOI 规范化：去掉 URL 前缀、doi: 前缀，转小写。
 * 例：
 *   "https://doi.org/10.1016/j.tbm.2023.05.001" → "10.1016/j.tbm.2023.05.001"
 *   "doi: 10.1109/TBM.2023.123456"             → "10.1109/tbm.2023.123456"
 *   "10.1016/J.TBM.2023.05.001"                 → "10.1016/j.tbm.2023.05.001"
 */
function normalizeDoi(doi: any): string {
  if (!doi) return "";
  let s = String(doi).trim().toLowerCase();
  // 去 URL 前缀
  s = s.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
  // 去 "doi:" 前缀
  s = s.replace(/^doi:\s*/i, "");
  return s.trim();
}

/**
 * 标题归一化：转小写，仅保留字母数字（含 Unicode 字母）。
 * 用于跨源标题匹配，忽略标点、空格、大小写差异。
 * 例："TBM tunnelling: a review!" → "tbmtunnellingareview"
 */
function normalizeTitle(title: any): string {
  if (!title) return "";
  // 转小写后去掉所有非字母数字（保留 Unicode 字母如重音字符、中文）
  return String(title)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // 去重音符号
    .replace(/[^a-z0-9\u4e00-\u9fff]/gi, ""); // 保留字母数字和中文
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

import { getPref } from "../utils/prefs";
import { log } from "../utils/logger";

/**
 * EasyScholar API client + in-memory cache.
 *
 * Endpoint: https://www.easyscholar.cc/open/getPublicationRank
 *   - secretKey: user API key (from https://www.easyscholar.cc/console/user/open)
 *   - publicationName: journal name (URL-encoded)
 *
 * Response field reference (from EasyScholar docs):
 *   sciif             SCI 影响因子 (JCR)
 *   sci               SCI 分区 (JCR, e.g. Q1)
 *   ssci              SSCI 分区 (JCR)
 *   jci               JCI 指数 (JCR)
 *   sciif5            SCI 5 年影响因子 (JCR)
 *   sciBase           SCI 基础版分区 (中科院)
 *   sciUp             SCI 升级版分区 (中科院)
 *   zhongguokejihexin 中国科技核心期刊
 *   eii               EI 检索
 *   cscd              中国科学引文数据库
 *   pku               北大核心
 *   cssci             南大核心
 *   sciwarn           中科院预警
 *
 * Cache strategy: 期刊名（大写归一化）为 key，包含 timestamp；
 * TTL 由 pref cacheTTL 控制（默认 24h）。
 */

const API_URL = "https://www.easyscholar.cc/open/getPublicationRank";

/** 等级条目：一个等级体系 = {label, value, color} */
export interface RankBadge {
  /** 等级体系短标签，如 "JCR Q1"、"中科院1区"、"EI"、"北大核心" */
  label: string;
  /** 原始值，如 "Q1"、"1"、"EI" */
  value: string;
  /** 等级类型 key（用于 CSS class 着色） */
  kind:
    | "jcr"
    | "cas"
    | "ei"
    | "cssci"
    | "pku"
    | "cscd"
    | "chinacore"
    | "jcrif"
    | "warn";
}

/** EasyScholar 原始响应字段 */
export interface EasyScholarRankData {
  sciif?: string;
  sci?: string;
  ssci?: string;
  jci?: string;
  sciif5?: string;
  sciBase?: string;
  sciUp?: string;
  zhongguokejihexin?: string;
  eii?: string;
  cscd?: string;
  pku?: string;
  cssci?: string;
  sciwarn?: string;
  [k: string]: string | undefined;
}

interface CacheEntry {
  data: EasyScholarRankData | null;
  ts: number;
}

/** 全局缓存：normalizedName -> CacheEntry */
const rankCache = new Map<string, CacheEntry>();

/** 进行中的请求去重：normalizedName -> Promise */
const inflight = new Map<string, Promise<EasyScholarRankData | null>>();

export class EasyScholarClient {
  get apiKey(): string {
    return (getPref("easyScholarKey") as string) || "";
  }

  get cacheTTL(): number {
    return Number(getPref("cacheTTL") || 86400000);
  }

  hasApiKey(): boolean {
    return this.apiKey.length > 0;
  }

  /** 归一化期刊名：trim + 大写，作为缓存 key */
  private normalize(name: string): string {
    return (name || "").trim().toUpperCase();
  }

  /**
   * 查询单个期刊等级（带缓存）。
   * 若缓存有效直接返回；否则发起 HTTP 请求并写入缓存。
   * 返回 null 表示未配置 API Key、请求失败、或 EasyScholar 未收录。
   */
  async getRank(publicationName: string): Promise<EasyScholarRankData | null> {
    const key = this.normalize(publicationName);
    if (!key) return null;
    if (!this.hasApiKey()) {
      log.api.warn("EasyScholar getRank: API key not set, skipping");
      return null;
    }

    // 1. 命中缓存
    const cached = rankCache.get(key);
    if (cached && Date.now() - cached.ts < this.cacheTTL) {
      log.api.debug(`EasyScholar cache hit: ${publicationName}`);
      return cached.data;
    }

    // 2. 去重：相同期刊并发请求只发一次
    const existing = inflight.get(key);
    if (existing) return existing;

    const p = this.fetchRank(publicationName, key);
    inflight.set(key, p);
    try {
      return await p;
    } finally {
      inflight.delete(key);
    }
  }

  /**
   * 批量查询期刊等级：去重后并发请求，返回 publicationName(原始) -> rankData 映射。
   * - 未配置 API Key 时返回空 Map（调用方应跳过 UI 渲染）。
   * - 失败的期刊写入 null 缓存，避免反复请求。
   */
  async getRanksBatch(
    publicationNames: string[],
  ): Promise<Map<string, EasyScholarRankData | null>> {
    const result = new Map<string, EasyScholarRankData | null>();
    if (!this.hasApiKey()) return result;

    // 去重：同名只查一次（按归一化 key 去重，但保留原始名用于回填）
    const uniqueNames: string[] = [];
    const seen = new Set<string>();
    for (const name of publicationNames) {
      const norm = this.normalize(name);
      if (!norm || seen.has(norm)) continue;
      seen.add(norm);
      uniqueNames.push(name);
    }

    if (uniqueNames.length === 0) return result;

    // 限并发：最多 4 个同时进行（EasyScholar 限流较严，避免 429）
    const CONCURRENCY = 4;
    const chunks: string[][] = [];
    for (let i = 0; i < uniqueNames.length; i += CONCURRENCY) {
      chunks.push(uniqueNames.slice(i, i + CONCURRENCY));
    }

    for (const chunk of chunks) {
      const settled = await Promise.all(
        chunk.map(async (name) => {
          const data = await this.getRank(name);
          return { name, data };
        }),
      );
      for (const { name, data } of settled) {
        result.set(name, data);
      }
    }
    return result;
  }

  private async fetchRank(
    publicationName: string,
    cacheKey: string,
  ): Promise<EasyScholarRankData | null> {
    // 手动拼接 URL，避免 URL 构造函数在某些上下文不可用
    const url =
      API_URL +
      "?secretKey=" + encodeURIComponent(this.apiKey) +
      "&publicationName=" + encodeURIComponent(publicationName);

    log.api.info(`EasyScholar requesting: ${publicationName} (url key hidden)`);
    try {
      const resp = await Zotero.HTTP.request("GET", url, {
        headers: {
          Accept: "application/json",
          "User-Agent": "Zsearch/0.1 (zotero-plugin)",
        },
        responseType: "text",
        timeout: 15000,
      });

      if (resp.status < 200 || resp.status >= 300) {
        log.api.warn(
          `EasyScholar ${publicationName} HTTP ${resp.status}`,
        );
        rankCache.set(cacheKey, { data: null, ts: Date.now() });
        return null;
      }

      const body = resp.response;
      // 记录原始响应前 500 字符用于调试
      const bodyPreview = typeof body === "string"
        ? body.slice(0, 500)
        : JSON.stringify(body).slice(0, 500);
      log.api.info(`EasyScholar raw response for "${publicationName}": ${bodyPreview}`);

      const data = this.parseResponse(body);
      rankCache.set(cacheKey, { data, ts: Date.now() });
      if (data) {
        log.api.info(
          `EasyScholar hit: ${publicationName} -> sci=${data.sci || "-"}, sciUp=${data.sciUp || "-"}, eii=${data.eii || "-"}`,
        );
      } else {
        log.api.info(`EasyScholar miss (no rank data): ${publicationName}`);
      }
      return data;
    } catch (e: any) {
      log.api.warn(`EasyScholar request failed: ${publicationName}: ${e?.message || e}`);
      // 网络错误不缓存（避免短暂故障后 24h 不能重试），仅在 4xx 时短缓存
      if (e && /4\d\d/.test(String(e.status || ""))) {
        rankCache.set(cacheKey, { data: null, ts: Date.now() });
      }
      return null;
    }
  }

  /**
   * 解析 EasyScholar 响应。
   *
   * 实际响应格式（来自官方文档）：
   * {
   *   "code": 200,
   *   "msg": "SUCCESS",
   *   "data": {
   *     "customRank": { "rankInfo": [...], "rank": [...] },
   *     "officialRank": {
   *       "all": {
   *         "sci": "Q1", "sciif": "8.5", "sciUp": "1区",
   *         "eii": "EI", "pku": "核心", "cssci": "...",
   *         "ssci": "...", "cscd": "...", ...
   *       },
   *       "select": { ... }
   *     }
   *   }
   * }
   *
   * 错误响应：{ "code": 40002, "msg": "Key错误", "data": null }
   */
  private parseResponse(body: any): EasyScholarRankData | null {
    if (!body) return null;
    let obj: any = body;
    // responseType:"text" 返回字符串，需要手动解析
    if (typeof obj === "string") {
      try {
        obj = JSON.parse(obj);
      } catch {
        log.api.warn("EasyScholar response is not valid JSON");
        return null;
      }
    }
    if (typeof obj !== "object") return null;

    // 检查业务状态码
    if (obj.code !== undefined && obj.code !== 200) {
      log.api.warn(`EasyScholar API error: code=${obj.code}, msg=${obj.msg || "-"}`);
      return null;
    }

    // 主路径：data.officialRank.all
    const all = obj?.data?.officialRank?.all;
    if (all && typeof all === "object") {
      log.api.debug(`EasyScholar parsed from officialRank.all: keys=${Object.keys(all).join(",")}`);
      return this.pickFields(all);
    }

    // 兜底1：data 直接包含字段（某些旧版 API）
    if (obj.data && typeof obj.data === "object") {
      if (obj.data.sci !== undefined || obj.data.sciif !== undefined) {
        return this.pickFields(obj.data);
      }
    }

    // 兜底2：根对象直接包含字段
    if (obj.sci !== undefined || obj.sciif !== undefined || obj.ssci !== undefined) {
      return this.pickFields(obj);
    }

    log.api.warn(`EasyScholar response structure not recognized. Top-level keys: ${Object.keys(obj).join(",")}`);
    return null;
  }

  private pickFields(src: any): EasyScholarRankData {
    return {
      sciif: this.asStr(src.sciif),
      sci: this.asStr(src.sci),
      ssci: this.asStr(src.ssci),
      jci: this.asStr(src.jci),
      sciif5: this.asStr(src.sciif5),
      sciBase: this.asStr(src.sciBase),
      sciUp: this.asStr(src.sciUp),
      zhongguokejihexin: this.asStr(src.zhongguokejihexin),
      eii: this.asStr(src.eii),
      cscd: this.asStr(src.cscd),
      pku: this.asStr(src.pku),
      cssci: this.asStr(src.cssci),
      sciwarn: this.asStr(src.sciwarn),
    };
  }

  private asStr(v: any): string | undefined {
    if (v === undefined || v === null) return undefined;
    const s = String(v).trim();
    return s === "" ? undefined : s;
  }

  /** 清空缓存（测试/调试用） */
  clearCache(): void {
    rankCache.clear();
  }
}

/**
 * 将 EasyScholar 原始等级数据转换为 UI 徽章数组。
 * 只输出非空字段，按重要性排序。
 * kind 用于 CSS 着色；label 是用户可见的短文本。
 */
export function rankDataToBadges(data: EasyScholarRankData | null): RankBadge[] {
  if (!data) return [];
  const badges: RankBadge[] = [];

  // JCR 分区（sci/ssci）—— 最高优先级
  if (data.sci) {
    badges.push({
      label: `JCR ${data.sci}`,
      value: data.sci,
      kind: "jcr",
    });
  }
  if (data.ssci) {
    badges.push({
      label: `SSCI ${data.ssci}`,
      value: data.ssci,
      kind: "jcr",
    });
  }

  // 中科院升级版分区
  if (data.sciUp) {
    badges.push({
      label: `中科院${data.sciUp}`,
      value: data.sciUp,
      kind: "cas",
    });
  }
  // 中科院基础版分区（与升级版重复时只显示升级版）
  if (data.sciBase && !data.sciUp) {
    badges.push({
      label: `中科院${data.sciBase}`,
      value: data.sciBase,
      kind: "cas",
    });
  }

  // 影响因子
  if (data.sciif) {
    badges.push({
      label: `IF ${data.sciif}`,
      value: data.sciif,
      kind: "jcrif",
    });
  }

  // EI 检索
  if (data.eii) {
    badges.push({
      label: "EI",
      value: data.eii,
      kind: "ei",
    });
  }

  // 中文核心体系
  if (data.cssci) {
    badges.push({
      label: "CSSCI",
      value: data.cssci,
      kind: "cssci",
    });
  }
  if (data.pku) {
    badges.push({
      label: "北大核心",
      value: data.pku,
      kind: "pku",
    });
  }
  if (data.cscd) {
    badges.push({
      label: "CSCD",
      value: data.cscd,
      kind: "cscd",
    });
  }
  if (data.zhongguokejihexin) {
    badges.push({
      label: "中国科技核心",
      value: data.zhongguokejihexin,
      kind: "chinacore",
    });
  }

  // 预警期刊（红色，放在最后）
  if (data.sciwarn) {
    badges.push({
      label: `预警 ${data.sciwarn}`,
      value: data.sciwarn,
      kind: "warn",
    });
  }

  return badges;
}

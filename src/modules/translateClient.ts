/**
 * 翻译客户端。
 * 通过 zotero-pdf-translate 插件（windingwind/zotero-pdf-translate）暴露的全局 API
 * `Zotero.PDFTranslate.api.translate` 实现标题翻译。
 *
 * 调用约定（参考 https://github.com/windingwind/zotero-pdf-translate#readme）：
 * - 全局对象：Zotero.PDFTranslate
 * - 翻译函数：Zotero.PDFTranslate.api.translate(raw, { pluginID, ... })
 * - 返回 Promise<TranslateTask>，task.status === "success" 时 task.result 为译文
 * - pluginID 必填（自 v1.1.0-23 起强制）
 *
 * 插件未安装时所有接口返回 null，调用方需做空值处理。
 */

import { config } from "../../package.json";
import { getPref } from "../utils/prefs";
import { log } from "../utils/logger";

/** 本插件的 addonID（用作 pluginID 参数） */
const PLUGIN_ID = config.addonID;

/**
 * 标题翻译缓存：title -> translated title。
 * 跨搜索、跨卡片重建复用，避免同一标题被重复翻译（节省翻译服务配额）。
 * 仅在内存中，插件重启后清空。
 */
const translateCache = new Map<string, string>();

/**
 * 正在进行中的翻译任务：title -> Promise。
 * 用于合并并发的相同标题翻译请求（同一标题只发一次 API 调用）。
 */
const inflight = new Map<string, Promise<string | null>>();

/** 翻译任务返回结构（仅声明用到的字段） */
interface TranslateTask {
  status: "waiting" | "processing" | "success" | "fail";
  result: string;
  raw: string;
  service?: string;
  langfrom?: string;
  langto?: string;
}

/** PDFTranslate 插件暴露的全局 API 形状 */
interface PDFTranslateAPI {
  translate: (
    raw: string,
    options: {
      pluginID: string;
      service?: string | string[];
      itemID?: number;
      langfrom?: string;
      langto?: string;
    },
  ) => Promise<TranslateTask>;
  getServices?: () => Array<{ id: string; type: string }>;
  getVersion?: () => string;
}

interface PDFTranslateAddon {
  api?: PDFTranslateAPI;
}

/**
 * 检查 zotero-pdf-translate 插件是否安装且 API 可用。
 */
export function isPDFTranslateAvailable(): boolean {
  const addon = (Zotero as any).PDFTranslate as PDFTranslateAddon | undefined;
  return Boolean(addon?.api?.translate);
}

/**
 * 获取用户在 pdf-translate 插件中配置的翻译引擎。
 * 通过直接读 Zotero 偏好获取（不依赖插件内部对象）。
 * @returns 服务 id（如 "google" / "deepl"），未配置时返回空字符串
 */
export function getConfiguredTranslateService(): string {
  try {
    return String(
      (Zotero as any).Prefs.get(
        "extensions.zotero.ZoteroPDFTranslate.translateSource",
        true,
      ) || "",
    );
  } catch {
    return "";
  }
}

/**
 * 获取用户在 pdf-translate 插件中配置的目标语言。
 * @returns BCP 47 语言代码（如 "zh-CN" / "en-US"），未配置时回退到本插件设置的 translateTargetLang
 */
export function getConfiguredTargetLanguage(): string {
  // 优先用本插件设置的目标语言
  const localPref = getPref("translateTargetLang") as string;
  if (localPref && localPref.trim()) return localPref.trim();
  // 回退到 pdf-translate 插件的全局配置
  try {
    const lang = String(
      (Zotero as any).Prefs.get(
        "extensions.zotero.ZoteroPDFTranslate.targetLanguage",
        true,
      ) || "",
    );
    if (lang) return lang;
  } catch {
    /* ignore */
  }
  // 最终回退：Zotero 界面语言
  try {
    return String((Zotero as any).Prefs.get("intl.locale.requested") || "en-US");
  } catch {
    return "en-US";
  }
}

/**
 * 翻译文本。
 * @param raw 原文
 * @param options 可选参数
 *   - langfrom: 源语言；不传由 pdf-translate 自动检测
 *   - langto: 目标语言；不传用 getConfiguredTargetLanguage()
 *   - itemID: Zotero item id，用于语言自动检测
 * @returns 翻译结果；失败或插件未安装时返回 null
 */
export async function translateText(
  raw: string,
  options: { langfrom?: string; langto?: string; itemID?: number } = {},
): Promise<string | null> {
  if (!raw || !raw.trim()) return null;
  if (!isPDFTranslateAvailable()) {
    log.translate.warn("translateText: zotero-pdf-translate not installed or API unavailable");
    return null;
  }
  // 1. 命中缓存直接返回
  const cached = translateCache.get(raw);
  if (cached !== undefined) return cached;
  // 2. 合并并发相同请求
  const existing = inflight.get(raw);
  if (existing) return existing;
  // 3. 发起新翻译
  const p = (async () => {
    const addon = (Zotero as any).PDFTranslate as PDFTranslateAddon;
    const langto = options.langto || getConfiguredTargetLanguage();
    try {
      log.translate.info(`translateText: translating ${raw.length} chars to "${langto}"`);
      const task = await addon.api!.translate(raw, {
        pluginID: PLUGIN_ID,
        langfrom: options.langfrom,
        langto,
        itemID: options.itemID,
      });
      if (task.status === "success" && task.result) {
        log.translate.info(`translateText: success, result length=${task.result.length}`);
        translateCache.set(raw, task.result);
        return task.result;
      }
      log.translate.warn(`translateText: task status=${task.status}, result=${task.result}`);
      return null;
    } catch (e) {
      log.translate.error("translateText failed", e);
      return null;
    } finally {
      inflight.delete(raw);
    }
  })();
  inflight.set(raw, p);
  return p;
}

/**
 * 翻译文献标题。
 * 对翻译结果做后处理：去除可能的多余引号、去除末尾句号、合并多余空白。
 * @param title 原标题
 * @param options 同 translateText
 * @returns 翻译后的标题；失败返回 null
 */
export async function translateTitle(
  title: string,
  options: { langfrom?: string; langto?: string; itemID?: number } = {},
): Promise<string | null> {
  const translated = await translateText(title, options);
  if (!translated) return null;
  // 后处理：去除首尾引号、末尾句号、合并空白
  let cleaned = translated.trim();
  cleaned = cleaned.replace(/^["'""「『]+|["'""」』]+$/g, "");
  cleaned = cleaned.replace(/\.+$/, "");
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  return cleaned || null;
}

/**
 * 批量翻译标题（并发控制，避免触发翻译服务限流）。
 * @param titles 原标题数组
 * @param concurrency 并发数（默认 3）
 * @param options 同 translateText
 * @returns 翻译结果数组（与 titles 等长，失败项为 null）
 */
export async function translateTitlesBatch(
  titles: string[],
  concurrency: number = 3,
  options: { langfrom?: string; langto?: string } = {},
): Promise<(string | null)[]> {
  if (titles.length === 0) return [];
  if (!isPDFTranslateAvailable()) {
    return titles.map(() => null);
  }
  const results: (string | null)[] = new Array(titles.length).fill(null);
  let cursor = 0;
  const workers: Promise<void>[] = [];
  const workerCount = Math.min(concurrency, titles.length);
  for (let w = 0; w < workerCount; w++) {
    workers.push(
      (async () => {
        while (cursor < titles.length) {
          const idx = cursor++;
          results[idx] = await translateTitle(titles[idx], options);
        }
      })(),
    );
  }
  await Promise.all(workers);
  return results;
}

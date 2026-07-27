/* eslint-disable no-undef */
/* Default preferences for Zsearch. Prefixed by zotero-plugin-scaffold with prefsPrefix. */
pref("extensions.zotero.zsearch.apiKey", "");
pref("extensions.zotero.zsearch.insttoken", "");
pref("extensions.zotero.zsearch.easyScholarKey", "");
pref("extensions.zotero.zsearch.springerKey", "");
pref("extensions.zotero.zsearch.semanticScholarKey", "");
pref("extensions.zotero.zsearch.pubmedApiKey", "");
pref("extensions.zotero.zsearch.ieeeKey", "");
pref("extensions.zotero.zsearch.defaultCollection", "");
pref("extensions.zotero.zsearch.autoDownloadPDF", true);
// 搜索时自动翻译标题为目标语言，显示在标题下一行（依赖 zotero-pdf-translate 插件）
pref("extensions.zotero.zsearch.autoTranslateTitle", false);
// 翻译目标语言（BCP 47 代码，如 zh-CN / en-US / ja）；留空则用 pdf-translate 插件的全局设置
pref("extensions.zotero.zsearch.translateTargetLang", "zh-CN");
pref("extensions.zotero.zsearch.pageSize", 25);
pref("extensions.zotero.zsearch.defaultSort", "");
pref("extensions.zotero.zsearch.requestTimeout", 30000);
pref("extensions.zotero.zsearch.maxRetries", 3);
pref("extensions.zotero.zsearch.cacheTTL", 86400000);
// 搜索源：scopus / pubmed / arxiv / semanticscholar / springer
pref("extensions.zotero.zsearch.activeSource", "scopus");
// PDF 下载渠道优先级（JSON 数组，元素为渠道 ID）
// 渠道：unpaywall / scihub / zotero_builtin / scopus
pref("extensions.zotero.zsearch.pdfDownloadOrder", '["unpaywall","scihub","zotero_builtin","scopus"]');
// Unpaywall email（免费 API，仅需 email）
pref("extensions.zotero.zsearch.unpaywallEmail", "");
// SciHub 地址（用户可自定义镜像）
pref("extensions.zotero.zsearch.scihubUrl", "https://sci-hub.ru/");
// 搜索历史（JSON 数组，最近 10 条搜索词）
pref("extensions.zotero.zsearch.searchHistory", "[]");
// 阅读队列/收藏（JSON 数组，最多 200 条）
pref("extensions.zotero.zsearch.starredEntries", "[]");

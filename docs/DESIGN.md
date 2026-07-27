# Zsearch 插件设计资料

> 基于 Elsevier API 的 Zotero 文献搜索/导入/PDF 下载插件，面向 Zotero 7/8/9。
> 界面遵循 Google 搜索风格（Google Material Design 视觉语言）。

---

## 一、总体目标

在 Zotero 内集成 Elsevier（Scopus / ScienceDirect）学术数据库能力，提供类 Google Scholar 的检索体验：

1. **文献搜索窗口** — 关键词/字段化检索 Scopus，结果即时呈现
2. **导入 Zotero 条目** — 一键/批量将检索结果转为 Zotero 文献条目
3. **PDF 下载** — 对已存在条目按 DOI/PII 经 Article Retrieval API 下载全文 PDF 附件
4. **辅助功能** — 引用数列、相关文献、开放获取标识、期刊指标等学术工作流增强

---

## 二、技术栈与基线

| 维度 | 选型 | 说明 |
|---|---|---|
| 插件模板 | `zotero-plugin-template` v3.1.0 | windingwind 维护，社区标准脚手架 |
| 构建工具 | `zotero-plugin-scaffold` ^0.8.2 | 取代旧 `zotero-plugin-toolkit` CLI |
| 工具库 | `zotero-plugin-toolkit` ^5.1.0-beta | 提供 `ztoolkit`（Menu/ProgressWindow/UI/Keyboard/Prompt） |
| 类型 | `zotero-types` ^4.1.0-beta | Zotero 全对象 TS 类型 |
| 语言 | TypeScript 5 + esbuild | 目标 `firefox115` |
| UI 渲染 | 原生 DOM + CSS（`ztoolkit.UI.createElement`） | 不引入 React，规避打包复杂度，保证 Google 风格精细控制 |
| 国际化 | Mozilla Fluent (.ftl) | en-US / zh-CN |
| 目标版本 | Zotero 7+（`strict_min_version: 6.999`, `strict_max_version: 9.*`） | 用户本地为 Zotero 7 |

**插件标识**
- `addonID`: `zsearch@zotero-plugin.dev`
- `addonName`: `Zsearch`
- `addonRef`: `zsearch`
- `addonInstance`: `Zsearch`
- `prefsPrefix`: `extensions.zotero.zsearch`

---

## 三、核心功能设计

### 3.1 文献搜索窗口

**入口**
- 主菜单 `Tools → Zsearch Search…`
- 工具栏按钮（位于 `#zotero-items-toolbar`）
- 快捷键 `Ctrl+Shift+S`（macOS `Cmd+Shift+S`）

**窗口形态**：独立 XUL `<window>` 对话框（`window.openDialog`），内嵌 HTML 容器，全 DOM 构建。

**布局（Google 风格）**

```
┌──────────────────────────────────────────────────────────┐
│  Zsearch                                          [×]    │  顶栏（白底，48px）
├──────────────────────────────────────────────────────────┤
│            ┌──────────────────────────────┐  [🔍 Search] │  搜索区（居中，max-width 720px）
│            │  deep learning tunneling     │              │  大圆角输入框，Google #f1f3f4 底
│            └──────────────────────────────┘              │
│   Year: [2015]-[2025]  Sort: [Citations▾]  Type: [All▾]  │  过滤器（灰字，36px 高）
├──────────────────────────────────────────────────────────┤
│  About 12,340 results (0.42 seconds)                     │  结果计数（小字灰）
├─────────────────────────────────────────────────── 3px ──┤
│  Deep learning-based tunneling ...                       │  标题（#1a0dab，20px，可点击）
│  Wang A., Li B., Zhang C. — Tunnelling and Underground   │  作者/期刊/年（#4d5156，14px）
│  Space Technology, 2024, vol.120(3), 104512              │
│  https://doi.org/10.1016/j.tust.2024.104512              │  DOI（#006621，13px）
│  Abstract: This paper proposes a novel DL approach ...   │  摘要片段（#4d5156，14px，截断）
│  [Cited: 42]  [OA]                    [Import] [PDF ⬇]   │  徽章+操作按钮（右对齐）
├──────────────────────────────────────────────────────────┤
│  ... 更多结果 ...                                        │
├──────────────────────────────────────────────────────────┤
│              < Prev   Page 1/494   Next >                │  分页（居中）
└──────────────────────────────────────────────────────────┘
```

**视觉规范（Google 风格）**
- 字体：`Roboto, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif`
- 主色：Google Blue `#4285f4`（按钮/链接强调）、`#1a0dab`（标题链接）
- 次色：`#006621`（URL 绿）、`#4d5156`（正文灰）、`#70757a`（次要文字）
- 背景：`#ffffff`（卡片）/ `#f8f9fa`（页面）/ `#f1f3f4`（输入框）
- 圆角：搜索框 24px、按钮 8px、卡片 0（分隔线代替）
- 间距：结果间 16px 上下、24px 左右；标题与元数据 4px
- 按钮：主按钮蓝底白字 `#4285f4`，次按钮白底蓝字蓝框；hover 轻微阴影
- 徽章：引用数灰底 `#e8eaed` + 深灰字；OA 绿底 `#e6f4ea` + `#137333` 字
- 分隔线：1px `#dadce0`
- 阴影：仅对话框/下拉，结果列表用分隔线

**交互**
- 回车触发搜索；输入框聚焦时显示搜索按钮
- 搜索中显示 spinner + "Searching..."
- 点击标题链接 → 在默认浏览器打开 Scopus/DOI 页面
- 单条 Import：立即创建条目，按钮变为 "✓ Imported"
- 单条 PDF：先检查 entitlement，可下载则下载并附加；无权限灰显并 tooltip 提示
- 批量：顶部 "Import all on page" / 选中多条后批量操作
- 分页：每页 25 条，跟随 Scopus `start` 参数
- 排序选项：Relevance（默认）、Cited（被引降序）、Date（新→旧）
- 过滤器：年份区间、文献类型（Article/Review/Conference）、开放获取

**Scopus 查询构造**
用户输入自由关键词 → `TITLE-ABS-KEY("<keywords>")`，叠加过滤器：
- 年份：`AND PUBYEAR >= 2015 AND PUBYEAR <= 2025`
- 类型：`AND DOCTYPE(ar)` 等
- OA：`AND openaccess(1)`（在结果端过滤更稳）

请求参数：`field=dc:title,dc:creator,prism:doi,prism:coverDate,citedby-count,eid,prism:publicationName,prism:volume,prism:issueIdentifier,prism:pageRange,openaccess,openaccessFlag,authkeywords,dc:description,prism:pii`，`count=25`，`start=(page-1)*25`，`view=STANDARD`，`sort=-citedby-count` 或空。

### 3.2 导入 Zotero 条目

**数据映射（Scopus entry → Zotero journalArticle）**

| Scopus 字段 | Zotero 字段 | 处理 |
|---|---|---|
| `dc:title` | `title` | 直传 |
| `dc:creator` / `author` | `creators` | `author` 字符串形如 "Smith, J.; Liu, W."，按 `; ` 拆分，每项按 `, ` 拆姓/名，`creatorType: "author"` |
| `prism:publicationName` | `publicationTitle` | 直传 |
| `prism:coverDate` | `date` | 取 `YYYY-MM-DD` 或 `YYYY` |
| `prism:volume` | `volume` | 直传 |
| `prism:issueIdentifier` | `issue` | 直传 |
| `prism:pageRange` | `pages` | 直传 |
| `prism:doi` | `DOI` | 直传 |
| `prism:url`/scopus link | `url` | 用 Scopus inward record URI 或 doi.org URL |
| `authkeywords` | `tags` | 按 `\|` 拆分，`addTag` |
| `dc:description` | `abstractNote` | 去掉 `<p>`/`<br>` 标签 |
| `prism:issn`/`prism:eIssn` | `ISSN` | 优先 eISSN |
| `subtypeDescription` | `itemType` 判定 | ar/re → journalArticle；cp → conferencePaper；ch → bookSection |
| `citedby-count` | `extra` | 写入 `Cited by: N`（便于引用列读取） |
| `eid`/`pii` | `extra` | 追加 `Scopus EID: ...` / `PII: ...` |

**导入流程**
1. 用户点击 Import（单条或批量）
2. 调 `Abstract Citation API`（按 DOI/PII/scopus_id）补全摘要与完整作者列表（搜索结果作者字符串常被截断，需补全）
3. 构造 `new Zotero.Item(itemType)`，`setField`/`setCreators`/`addTag`
4. 若用户选中目标 Collection，`setCollections([colID])`
5. `await item.saveTx()`
6. 若勾选"同时下载 PDF"，调用 PDF 下载流程
7. `ProgressWindow` 反馈进度，完成后刷新

**去重**：导入前用 `Zotero.Search` 按 DOI 查询是否已存在；已存在则跳过并提示，避免重复。

**集合选择**：批量导入前弹 `Zotero.Collection` 选择器（复用 Zotero 内置 picker）。

### 3.3 PDF 下载

**入口**
- 搜索结果列表每条的 "PDF ⬇" 按钮
- 选中条目右键菜单 `Zsearch → Download PDF (Elsevier)`
- 偏好设置可开启"导入时自动下载 PDF"

**流程**
1. 取条目 DOI（优先）或 PII/EID（从 `extra` 解析）
2. 调 `Entitlements API`：`GET /content/article/entitlement/doi/{DOI}`
3. 若 `entitled: true`：
   - 调 `GET /content/article/doi/{DOI}?httpAccept=application/pdf`，二进制流
   - 写入临时文件 `Zotero.getTempDirectory()/zsearch-<doi>.pdf`
   - `Zotero.Attachments.importFromFile({ file, parentItemID, contentType: "application/pdf" })`
   - 可选 `renameIfAllowed: true` 按父条目命名
4. 若 `entitled: false`：
   - 若 OA（`openaccessFlag`），仍尝试直接下载（部分 OA 无需 entitlement）
   - 否则灰显按钮 + tooltip "No entitlement (需机构订阅)"，并在 `extra` 标注
5. 错误处理：429 退避重试；404 提示"未找到全文"；超时重试 1 次

**节流**：串行下载，每篇间隔 ≥600ms（遵守 2 req/s）；批量用队列。

**权限提示**：首次使用若无 `insttoken`，弹提示引导用户在偏好填写（否则仅元数据可用）。

---

## 四、辅助功能设计（Elsevier API 其他联动）

基于 Elsevier API 能力，设计与 Zotero 联动的辅助功能：

### 4.1 引用数自定义列（Custom Column）
- `Zotero.ItemTreeManager.registerColumns` 注册 `zsearch-citations` 列
- `dataProvider`：从 `item.getField("extra")` 解析 `Cited by: N`；若无则异步查 Abstract Citation API 并缓存（写入 extra）
- 排序支持；图标用引文图标
- 用户可在列管理器显示/隐藏

### 4.2 相关文献（Related Articles）
- 选中条目右键 `Zsearch → Find Related (Scopus)`
- 调 `Scopus Search API`：`query=REF(<scopus_id>)` 取参考文献，`query=citedby_scopus_id(<id>)` 取施引文献
- 结果在搜索窗口"Related"标签页展示，可一键导入

### 4.3 开放获取标识列
- 列显示 OA 状态（基于 extra 中缓存的 `openaccess` 字段）
- 绿色锁图标表示 OA

### 4.4 期刊指标信息行（ItemPane InfoRow）
- `Zotero.ItemPaneManager.registerInfoRow` 注册 "Journal Metrics" 行
- 通过 ISSN 调 `Serial Title API`：`GET /content/serial/title/issn/{ISSN}`
- 显示 CiteScore、SJR、SNIP、H-index；缓存到 extra 避免重复请求

### 4.5 作者 H-index 查询（ItemPane Section）
- `registerSection` 注册 "Author Metrics" 区块
- 解析条目作者，调 `Scopus Author Search`：`query=AUTHLASTNAME(x) AND AUTHFIRSTNAME(y)`
- 显示作者 Scopus H-index、文献数、当前机构

### 4.6 批量引用数更新
- 工具菜单 `Zsearch → Update Citation Counts`
- 遍历选中条目（或全库 journalArticle），并发查 Abstract Citation API，更新 `extra` 的 `Cited by`
- 进度条反馈；节流 2 req/s

### 4.7 DOI 补全/校验
- 右键 `Zsearch → Lookup DOI`
- 用标题调 Scopus Search 取 DOI，写回条目

### 4.8 偏好设置面板（Preference Pane）
- API Key（必填，密码框）
- Insttoken（选填，密码框）
- 默认导入集合
- 导入时自动下载 PDF（开关）
- 默认排序、每页条数
- 请求超时、重试次数
- 缓存 TTL

**辅助功能优先级**：4.1（引用列）、4.4（期刊指标）、4.6（批量更新）为首批实现；4.2/4.5/4.7 为二期。

---

## 五、模块架构

```
src/
├── index.ts                     # 入口：创建 Addon，挂载全局
├── addon.ts                     # Addon 类（data/hooks/api）
├── hooks.ts                     # 生命周期分发
├── modules/
│   ├── elsevierClient.ts        # Elsevier API 客户端（搜索/摘要/权限/PDF）
│   ├── searchWindow.ts          # 搜索窗口构建与交互
│   ├── importer.ts              # Scopus entry → Zotero Item
│   ├── pdfDownloader.ts         # PDF 下载与附件
│   ├── menu.ts                  # 菜单/工具栏/快捷键注册
│   ├── citationColumn.ts        # 引用数自定义列
│   ├── journalMetrics.ts        # 期刊指标 InfoRow
│   ├── batchUpdate.ts           # 批量引用数更新
│   └── preferenceScript.ts      # 偏好面板脚本
├── utils/
│   ├── locale.ts                # 国际化
│   ├── prefs.ts                 # 偏好读写
│   ├── window.ts                # 窗口工具
│   └── ztoolkit.ts              # ztoolkit 初始化
typings/
├── global.d.ts
├── i10n.d.ts                    # FTL 消息 ID 类型（构建生成）
└── prefs.d.ts                   # 偏好键类型（构建生成）
addon/
├── bootstrap.js                 # 生命周期入口（普通 JS）
├── manifest.json                # 清单（占位符构建时替换）
├── prefs.js                     # 默认偏好
├── content/
│   ├── preferences.xhtml        # 偏好面板
│   ├── searchWindow.xhtml       # 搜索窗口 XUL
│   ├── zsearch.css              # Google 风格样式
│   └── icons/                   # 图标
└── locale/{en-US,zh-CN}/{addon,mainWindow,preferences}.ftl
```

**数据流**
```
用户操作 → menu/shortcut → hooks.onDialogEvents("search")
  → searchWindow.open() → elsevierClient.search() → 渲染结果
  → Import 按钮 → importer.importEntry() → item.saveTx()
  → PDF 按钮 → pdfDownloader.download() → Attachments.importFromFile()
```

---

## 六、Elsevier API 客户端设计（`elsevierClient.ts`）

```ts
class ElsevierClient {
  // 配置（从 prefs 读取）
  apiKey, insttoken, timeout, baseURL = "https://api.elsevier.com"

  // 统一请求（带速率限制、重试、错误转换）
  private async request(path, params, extraHeaders?): Promise<any>

  // Scopus 搜索
  async searchScopus(opts: {
    query: string; field?: string; count?: number; start?: number;
    sort?: string; view?: "STANDARD"|"COMPLETE"; date?: string;
  }): Promise<{ total: number; entries: ScopusEntry[]; nextHref?: string }>

  // Abstract Citation（补全摘要/作者）
  async getAbstract(idType: "doi"|"pii"|"scopus_id"|"eid", id: string): Promise<AbstractData>

  // Entitlements 检查
  async getEntitlement(idType, id): Promise<boolean>

  // PDF 下载（流）
  async downloadPDF(idType, id): Promise<Uint8Array>

  // Serial Title（期刊指标）
  async getSerialTitle(issn: string): Promise<SerialData>

  // Author Search
  async searchAuthor(query: string): Promise<AuthorData[]>
}
```

**速率限制**：内置 token bucket（2 req/s），`request` 前 await。
**重试**：429/500/502/503 指数退避，最多 3 次，尊重 `Retry-After`。
**错误**：统一抛 `ElsevierAPIError`（status, message, retryable）。

---

## 七、配置与偏好

`addon/prefs.js` 默认值（键前缀 `extensions.zotero.zsearch.`）：
- `apiKey`：`""`
- `insttoken`：`""`
- `defaultCollection`：`""`
- `autoDownloadPDF`：`false`
- `pageSize`：`25`
- `defaultSort`：`""`（relevance）
- `requestTimeout`：`30000`
- `maxRetries`：`3`
- `cacheTTL`：`86400000`（1 天）

---

## 八、国际化

`addon.ftl` 消息键（前缀 `zsearch-`）：
- `menu-search`, `menu-download-pdf`, `menu-related`, `menu-update-citations`
- `search-placeholder`, `search-button`, `searching`, `no-results`, `results-count`
- `filter-year`, `filter-sort`, `filter-type`
- `result-import`, `result-imported`, `result-pdf`, `result-cited`, `result-oa`
- `prefs-title`, `prefs-apikey`, `prefs-insttoken`, `prefs-autodownload`, ...
- `col-citations`, `col-oa`
- `err-no-apikey`, `err-no-entitlement`, `err-rate-limit`, `err-not-found`

---

## 九、调试与测试

- **开发模式**：`.env` 配置 `ZOTERO_PLUGIN_ZOTERO_BIN_PATH=C:\DDL\note\参考文献集\文献集中\Zotero7_win-x64\zotero.exe`，`npm start` 热重载
- **日志**：`ztoolkit.log` + `Zotero.debug`，开发环境输出到终端
- **Run JavaScript**：`Zotero.Zsearch.api.elsevier.searchScopus(...)` 手动验证
- **测试用例**：
  1. 无 API Key → 弹提示
  2. 关键词搜索 → 返回结果列表
  3. 单条 Import → Zotero 出现新条目，字段完整
  4. 重复 Import → 跳过提示
  5. PDF 下载（无 insttoken）→ 灰显 + 提示
  6. 引用列显示
  7. 429 退避

---

## 十、风险与限制

| 风险 | 影响 | 缓解 |
|---|---|---|
| 无 insttoken 无法下载 PDF | 核心功能受限 | UI 明确提示；OA 文章仍可下载；引导获取 insttoken |
| Scopus 作者字符串截断 | 导入作者不全 | 导入时调 Abstract API 补全完整作者列表 |
| 速率限制 2 req/s | 批量操作慢 | token bucket + 进度反馈；批量更新可后台异步 |
| 单 query 上限 5000 条 | 深度检索受限 | 按年份/学科切片多次查询 |
| Zotero 9 API 变更 | 兼容性 | 用 ztoolkit 抽象层；版本检测兜底 |
| `extra` 字段污染 | 与其他插件冲突 | 用 `Zsearch:` 前缀键值，如 `Zsearch Cited by: 42` |

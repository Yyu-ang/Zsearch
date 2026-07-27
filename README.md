# Zsearch

> 在 Zotero 内一站式检索 Scopus / PubMed / arXiv / Semantic Scholar / Springer / Google Scholar 等学术数据库，类 Google 的搜索体验，支持一键导入、PDF 下载、期刊分区徽章、引用数列、批量导出等科研工作流增强。

面向 Zotero 7 / 8 / 9，遵循 Google Material Design 视觉风格。

---

## 核心功能

### 文献搜索

- **多源检索**：Scopus、PubMed、arXiv、Semantic Scholar、Springer 等 API 源 + Google Scholar、IEEE Xplore、JSTOR、ResearchGate 等 Web 跳转源
- **高级搜索语法**：搜索框下方提供 `TITLE-ABS-KEY()` / `AUTHOR-NAME()` / `AFFIL()` / `PUBYEAR > 2020` / `AND` / `OR` / `NOT` / `LIMIT-TO()` 等语法快捷按钮，点击即可插入并自动定位光标
- **关键词高亮**：搜索结果标题与摘要中匹配词自动高亮
- **搜索历史**：自动记录最近 10 条搜索词，点击即可快速重搜
- **DOI/arXiv ID 直接定位**：在搜索框输入 DOI（如 `10.1016/j.tust.2023.105734`）或 arXiv ID（如 `2301.12345`），自动识别并在浏览器打开对应文献页面，无需手动复制到浏览器
- **键盘快捷键**：`Enter` 搜索 / `Ctrl+Enter` 搜索 / `Esc` 清空输入框

### 结果展示

- **期刊分区徽章**：标题下方彩色矩形显示 JCR 分区、中科院分区、影响因子 IF、EI、CSSCI、北大核心、CSCD、中国科技核心、预警期刊等（基于 EasyScholar 数据，异步加载不阻塞渲染）
- **完整元信息**：作者（前 3 位 + et al.）、期刊、年份、卷期页码、DOI、被引数、开放获取标识
- **悬浮提示**：鼠标悬停显示完整作者列表、标题、期刊、日期、卷期、DOI、被引数、OA 状态、摘要
- **已导入标记**：通过 Zotero 数据库精确匹配 DOI（`LOWER(value) = ?`，非 `LIKE`），检测库中是否已存在相同 DOI 的条目，避免重复导入
- **DOI 复制按钮**：每条结果 DOI 旁附一键复制按钮，点击即复制到剪贴板并显示 ✓/✗ 反馈
- **收藏星标**：每张卡片左侧 ☆/★ 按钮一键加入阅读队列，已收藏条目以金色 ★ 标记

### 结果筛选

- **基础过滤器**：年份范围、排序（相关度 / 被引降序 / 日期最新）、文献类型（全部 / 论文 / 综述 / 会议）
- **二次筛选条**：对当前页结果即时过滤，无需重新请求 API
  - `全部` / `OA` / `被引≥50` / `被引≥100` / `近3年` / `近5年` / `综述`
  - 右侧实时显示 `已显示 / 总数` 计数

### 导入与下载

- **单条导入**：点击结果卡片中的"导入"按钮
- **批量导入**：点击"导入本页全部"批量导入当前页所有结果
- **PDF 下载链**：自动按 `Unpaywall → SciHub → Zotero 内置 → Scopus` 顺序尝试下载 PDF
  - SciHub 镜像地址可在设置中配置（默认 `https://sci-hub.ru/`）
  - 使用 iPhone User-Agent 避免 SciHub 403 错误
  - 自动识别验证码页面和"文章未找到"错误页
- **来源标记**：导入的条目 `libraryCatalog` 字段自动标记来源（Scopus / PubMed / arXiv / Google Scholar），便于追溯
- **导入反馈**：用右下角 toast 通知替代 alert，显示成功/失败详情，3 秒自动消失

### 批量导出

- **多选导出**：每张卡片左侧 checkbox + 顶部"全选"复选框
- **三种格式**：
  - **BibTeX** (`.bib`)：自动转义 `& % $ # _ { } ~ ^ \` 等特殊字符，citekey 自动去重
  - **RIS**：文献类型映射（`JOUR` / `CONF`），页码拆分为 `SP` / `EP`
  - **CSV**：含 UTF-8 BOM，Excel 打开中文不乱码
- **找相关文献**：每张卡片"找相关"按钮，自动从标题提取关键词（去停用词，取前 4 个实词）构造 `TITLE-ABS-KEY()` 查询，非 Scopus 源会自动切换

### 引用格式预览

每张卡片"引用"按钮，弹窗显示引用格式，支持一键复制：

- **使用 Zotero 内置引用样式**：调用 Zotero 的 citeproc 引擎生成引用，格式准确性与 Zotero 引出参考文献一致
- **下拉框选择样式**：弹窗顶部下拉框列出 Zotero 已安装的所有引用样式，切换即实时重新生成
- **默认样式优先级**：GB/T 7714-2015（数字式）→ APA → MLA → Chicago → IEEE
- **支持的所有样式**：包括但不限于
  - GB/T 7714-2015（数字式 / 注释式）
  - APA 6th / 7th
  - MLA 8th / 9th
  - Chicago（作者-日期 / 注释）
  - IEEE / Vancouver / Nature / Science
  - 用户在 Zotero 首选项中安装的其他样式
- **如需更多样式**：在 Zotero → 编辑 → 首选项 → 引用 → 样式管理器 中安装

### 阅读队列/收藏

- **一键收藏**：点击结果卡片左侧 ☆ 按钮加入阅读队列，金色 ★ 标记已收藏
- **队列管理**：搜索框下方 `★ 收藏` 按钮打开阅读队列弹窗
  - 列表显示标题、DOI、收藏时间
  - 点击标题在浏览器打开（优先使用 DOI 链接）
  - 单条移除 / 清空全部
- **本地存储**：最多保存 200 条，跨会话持久化
- **精确匹配**：移除时严格按 DOI 匹配（无 DOI 时按标题），避免误删其他条目

### 搜索结果统计

搜索框下方 `📊 统计` 按钮打开当前页结果统计面板：

- **总览**：开放获取占比、含 DOI 占比、含摘要占比
- **年份分布**：横向柱状图，按年份降序
- **被引次数分布**：分桶统计 `0` / `1-9` / `10-49` / `50-99` / `100+`
- **数据来源**：基于当前页所有结果，实时计算

### 辅助功能

- **引用数列**：在 Zotero 条目列表中显示被引数列
- **开放获取列**：标记 OA 状态
- **批量更新引用数**：菜单 `Tools → Zsearch → 更新引用数`
- **期刊指标行**：在条目详情中显示 Scopus 期刊指标
- **作者指标**：显示作者指标（Scopus）

---

## 安装

### 方式一：下载预构建 XPI

1. 下载 [build/zsearch.xpi](build/zsearch.xpi)
2. Zotero → `工具` → `附加组件` → 齿轮图标 → `Install Add-on From File...`
3. 选择下载的 `.xpi` 文件

### 方式二：从源码构建

```bash
git clone https://github.com/zotero-plugin-dev/zsearch.git
cd zsearch
npm install
node node_modules/zotero-plugin-scaffold/bin/zotero-plugin.mjs build
```

构建产物位于 `.scaffold/build/zsearch.xpi`，同时会复制一份到 `build/zsearch.xpi`。

---

## 配置

安装后请在 `工具 → 附加组件 → Zsearch → 首选项` 中配置：

### 必填

| 配置项 | 说明 | 获取方式 |
|---|---|---|
| **Elsevier API Key** | Scopus 搜索必需 | [https://dev.elsevier.com](https://dev.elsevier.com) 免费注册 |

### 可选

| 配置项 | 说明 | 默认值 |
|---|---|---|
| Institution Token (Insttoken) | 全文 PDF 下载必需，向所在机构图书馆索取 | 空 |
| Auto-download PDF when importing | 导入时是否自动下载 PDF | 关闭 |
| Results per page | 每页结果数 | 25 |
| Default sort | 默认排序方式 | Relevance |
| Request timeout (ms) | 请求超时 | 30000 |
| Max retries | 最大重试次数 | 3 |
| SciHub mirror | SciHub 镜像地址（必须以 `/` 结尾） | `https://sci-hub.ru/` |

### 连接测试

首选项页提供 **Test All Connections** 按钮，一次性测试所有 API 连接（Scopus / PubMed / Semantic Scholar / Springer / Unpaywall / SciHub），实时显示进度（1/6, 2/6...），结果以弹窗形式展示 `✓ 正常` / `✗ 失败` / `– 跳过` 指示符和汇总统计。

> 注：Semantic Scholar、PubMed、Unpaywall 即使未配置 API Key/Email 也会进行测试。

---

## 使用指南

### 基本搜索流程

1. 通过以下任一方式打开搜索窗口：
   - 菜单 `Tools → Zsearch Search…`
   - 工具栏 Zsearch 按钮
   - 快捷键 `Ctrl+Shift+S`（macOS `Cmd+Shift+S`）
2. 在搜索框输入关键词
3. 选择搜索源（默认 Scopus）
   - **Scopus**：结构化字段最完整，推荐首选
   - **Google Scholar**：覆盖面广，但可能触发反爬
   - **PubMed / arXiv / Semantic Scholar / Springer**：领域专用源
4. 可选：使用语法快捷按钮构造高级查询（仅 Scopus 支持高级语法）
5. 可选：设置年份范围、排序、类型过滤器
6. 按 `Enter` 或点击 Search 按钮

> **跨源搜索提示**：使用"找相关"按钮时，若当前源非 Scopus，会自动切换到 Scopus 以支持 `TITLE-ABS-KEY()` 高级语法。

### 高级查询示例

```
TITLE-ABS-KEY(deep learning AND tunneling)
AUTHOR-NAME(Wang) AND AFFIL(Tsinghua)
PUBYEAR > 2020 AND TITLE-ABS-KEY(geology)
TITLE-ABS-KEY(machine learning) AND LIMIT-TO(DOCTYPE,"ar")
TITLE-ABS-KEY(open access) AND LIMIT-TO(OA,"all")
```

### 导出文献

1. 在搜索结果中勾选要导出的条目（左侧 checkbox）
2. 可选：点击"全选"勾选当前页所有可见条目
3. 可选：使用二次筛选条缩小范围（如仅显示 OA 文献）
4. 点击 `Export BibTeX` / `Export RIS` / `Export CSV`
5. 在弹出的文件保存对话框中选择保存位置

### 找相关文献

在任意结果卡片上点击"找相关"按钮：
- 自动从该文章标题中提取关键词（去停用词，取前 4 个实词）
- 构造 `TITLE-ABS-KEY(keyword1 AND keyword2 AND ...)` 查询
- 若当前非 Scopus 源，自动切换到 Scopus 并提示
- 立即执行搜索

### 收藏与阅读队列

1. 在结果卡片上点击左侧 ☆ 按钮，金色 ★ 表示已收藏
2. 点击搜索框下方 `★ 收藏` 按钮打开阅读队列
3. 在队列中可点击标题直接在浏览器打开文献，或点击"移除"取消收藏
4. 队列最多保存 200 条，跨会话持久化

### 查看结果统计

1. 执行搜索后，点击搜索框下方 `📊 统计` 按钮
2. 弹窗显示当前页结果的年份分布、被引分布、OA 占比等统计信息
3. 点击"关闭"或遮罩层关闭弹窗

### DOI/arXiv ID 快速定位

直接在搜索框粘贴 DOI 或 arXiv ID（如 `10.1016/j.tust.2023.105734` 或 `2301.12345`），按 Enter：
- 自动识别为标识符（非搜索关键词）
- 在默认浏览器中打开对应文献页面
- 状态栏显示 `检测到 DOI/arXiv：xxx，已在浏览器打开`

> 注：仅当输入长度接近标识符长度时才触发，避免误判含 DOI 的复杂查询。

---

## 搜索源

### API 源（支持结果直接导入）

| 源 | 图标 | 需要 API Key | 说明 |
|---|---|---|---|
| Scopus | 🔬 | 是（Elsevier API Key） | 主源，支持完整元数据与 Abstract API 富化 |
| PubMed | 🏥 | 否（可选配置 email 提高限额） | 生物医学领域 |
| arXiv | 📄 | 否 | 预印本，3 秒限速 |
| Semantic Scholar | 🧠 | 否（可选配置 API Key 提高限额） | AI 驱动的学术搜索 |
| Springer | 📚 | 否（可选配置 API Key） | Springer Link 期刊 |
| **Google Scholar** | 📚 | 否 | **HTML 解析源**，结果以结构化卡片展示 |

#### Google Scholar 解析源说明

Google Scholar 没有公开 API，本插件通过抓取搜索结果页 HTML 并解析为结构化条目展示：

- **字段提取**：标题、链接、作者、期刊、年份、摘要片段、被引数、开放获取标记、DOI
- **DOI 提取**：从摘要片段和 URL 中正则匹配（使用 CrossRef 推荐正则，正确处理含句点的 DOI）
- **被引数**：支持千分位解析（如 `Cited by 1,234`）
- **作者行解析**：用 ` - `（带空格）分隔，避免误拆作者名/期刊名中的连字符（如 `Jean-Pierre Dupont`）
- **反爬限制**：Zotero 基于 Gecko 引擎，User-Agent 被 GS 识别为非浏览器流量，可能触发 429/验证码
- **限速策略**：请求间隔至少 5 秒，429/503 错误后退避 60 秒
- **使用建议**：
  1. 首次使用前先在浏览器中访问 [scholar.google.com](https://scholar.google.com) 完成可能的验证码
  2. 若返回 429，等待几分钟后再试，或使用 Scopus/PubMed 等结构化源
  3. GS 不提供卷/期/页码等字段，这些字段在卡片中为空
  4. DOI 命中率约 60-80%（取决于 GS 页面是否暴露 DOI）

### Web 跳转源（在浏览器中打开）

| 源 | 图标 |
|---|---|
| Google | 🌍 |
| ResearchGate | 🔬 |
| JSTOR | 📖 |
| IEEE Xplore | ⚡ |

---

## 快捷键

| 快捷键 | 功能 |
|---|---|
| `Ctrl+Shift+S`（macOS `Cmd+Shift+S`） | 打开搜索窗口 |
| `Enter` | 执行搜索 |
| `Ctrl+Enter` | 执行搜索 |
| `Esc` | 清空搜索框 |

---

## 技术细节

### PDF 下载链

按以下顺序尝试下载 PDF：

1. **Unpaywall** — 优先尝试开放获取版本
2. **SciHub** — 使用配置的镜像地址，iPhone User-Agent
3. **Zotero 内置** — 调用 Zotero 自带的 PDF 查找器
4. **Scopus** — 通过 Elsevier Article Retrieval API（需要 Insttoken）

任意一个源成功即停止，所有源失败时显示错误提示。

### 期刊分区数据来源

期刊分区徽章通过 [EasyScholar](https://www.easyscholar.cc) API 获取：
- API：`GET https://www.easyscholar.cc/open/getPublicationRank?secretKey=KEY&publicationName=NAME`
- 缓存键：期刊名转为大写
- 缓存 TTL：默认 24 小时（由 `cacheTTL` 偏好控制）
- 并发：4（避免触发速率限制）
- 失败缓存：避免短时间内重复请求失败查询

### 视觉规范

- 字体：`Roboto, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif`
- 主色：Google Blue `#4285f4`
- 标题链接：`#1a0dab`
- 期刊徽章颜色：
  - JCR Q1 / 中科院 1 区：深红 `#d93025` / `#b31412`
  - Q2 / 2 区：橙 `#e8710a`
  - Q3 / 3 区：黄褐 `#c5a000`
  - Q4 / 4 区：绿 `#137333`
  - 影响因子 IF：紫 `#681da8`
  - EI：蓝 `#1a73e8`
  - 预警期刊：深红闪烁动画

---

## 国际化

支持中文（zh-CN）和英文（en-US）双语界面，自动跟随 Zotero 语言设置。

---

## 兼容性

- Zotero 7 / 8 / 9（`strict_min_version: 6.999`, `strict_max_version: 9.*`）
- Windows / macOS / Linux

---

## 开发

### 项目结构

```
zsearch/
├── addon/                  # 插件资源（构建输入）
│   ├── content/            # XHTML 窗口、CSS、图标
│   ├── locale/             # FTL 国际化文件
│   ├── bootstrap.js        # 插件入口
│   ├── manifest.json       # 插件清单
│   └── prefs.js            # 偏好默认值
├── src/                    # TypeScript 源码
│   ├── modules/            # 功能模块
│   │   ├── searchWindow.ts # 搜索窗口主逻辑
│   │   ├── searchSources.ts# 搜索源注册表
│   │   ├── searchSource.ts # 统一搜索源接口与类型定义
│   │   ├── elsevierClient.ts
│   │   ├── pubmedClient.ts
│   │   ├── arxivClient.ts
│   │   ├── semanticScholarClient.ts
│   │   ├── springerClient.ts
│   │   ├── googleScholarClient.ts # GS HTML 解析源
│   │   ├── scihubClient.ts
│   │   ├── unpaywallClient.ts
│   │   ├── pdfDownloadChain.ts
│   │   ├── pdfDownloader.ts
│   │   ├── easyScholarClient.ts
│   │   ├── importer.ts
│   │   ├── citationColumn.ts
│   │   ├── journalMetrics.ts
│   │   ├── menu.ts
│   │   ├── preferenceScript.ts
│   │   └── batchUpdate.ts
│   ├── utils/              # 工具函数
│   └── hooks.ts            # 生命周期钩子
├── typings/                # 类型定义
├── docs/                   # 设计文档
├── build/                  # 构建产物
│   └── zsearch.xpi
└── package.json
```

### 构建命令

```bash
# 构建 XPI
node node_modules/zotero-plugin-scaffold/bin/zotero-plugin.mjs build

# 开发模式（热重载）
npm start

# 类型检查（不输出文件）
npx tsc --noEmit

# 代码格式化
npm run lint:fix
```

### 技术栈

| 维度 | 选型 |
|---|---|
| 构建工具 | `zotero-plugin-scaffold` ^0.8.2 |
| 工具库 | `zotero-plugin-toolkit` ^5.1.0-beta |
| 类型 | `zotero-types` ^4.1.0-beta |
| 语言 | TypeScript 5 + esbuild |
| UI 渲染 | 原生 DOM + CSS |
| 国际化 | Mozilla Fluent (.ftl) |

---

## 许可证

[AGPL-3.0-or-later](LICENSE)

---

## 反馈与问题

- 提交 Issue：[GitHub Issues](https://github.com/zotero-plugin-dev/zsearch/issues)
- 设计文档：[docs/DESIGN.md](docs/DESIGN.md)

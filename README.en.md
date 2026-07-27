# Zsearch

> One-stop literature search inside Zotero across Scopus / PubMed / arXiv / Semantic Scholar / Springer / IEEE Xplore / Google Scholar, with a Google-like search experience. Supports aggregated search, one-click import, PDF download chain, journal rank badges, citation-count column, batch export, and auto-translating titles during search.

Built for Zotero 7 / 8 / 9, following Google Material Design visual style.

[简体中文](README.md) | **English**

---

## Core Features

### Literature Search

- **Multi-source search**: Scopus, PubMed, arXiv, Semantic Scholar, Springer, IEEE Xplore API sources + Google Scholar HTML parsing source + JSTOR, ResearchGate web jump sources
- **Aggregated search**: Select "Aggregated" mode to query all configured API sources in parallel; results are deduplicated by DOI/title and each entry is annotated with its sources (multi-source hits show a combined badge, e.g. `🔬 Scopus + 🏥 PubMed + ⚡ IEEE`), dramatically improving recall
- **Streaming incremental loading**: In aggregated search, each source's results are merged and pushed as soon as it completes — no need to wait for all sources; entries with results are returned first
- **Load more**: The "Load more" button at the bottom of the results fetches the next page by **appending new cards incrementally** rather than rebuilding the list, preserving the user's current scroll position with a progress placeholder during loading
- **Advanced search syntax**: Syntax shortcut buttons below the search box for `TITLE-ABS-KEY()` / `AUTHOR-NAME()` / `AFFIL()` / `PUBYEAR > 2020` / `AND` / `OR` / `NOT` / `LIMIT-TO()` — click to insert and auto-position the cursor
- **Keyword highlighting**: Matched words in titles and abstracts are auto-highlighted
- **Search history**: Automatically records the last 10 search queries; click to re-run
- **DOI/arXiv ID direct lookup**: Entering a DOI (e.g. `10.1016/j.tust.2023.105734`) or arXiv ID (e.g. `2301.12345`) in the search box is auto-detected and opened in the browser — no need to manually copy to a browser
- **Auto-translate title on search**: Optional; the translation is displayed directly below the title in search results (depends on the [zotero-pdf-translate](https://github.com/windingwind/zotero-pdf-translate#readme) plugin; built-in caching and concurrent request deduplication reuse cached translations when cards are rebuilt)
- **Keyboard shortcuts**: `Enter` to search / `Ctrl+Enter` to search / `Esc` to clear the input

### Result Display

- **Journal rank badges**: Colored rectangles below the title show JCR quartile, CAS quartile, Impact Factor IF, EI, CSSCI, Peking University Core, CSCD, China Science and Technology Core, warning journals, etc. (based on EasyScholar data, loaded asynchronously without blocking rendering)
- **Complete metadata**: Authors (first 3 + et al.), journal, year, volume/issue/pages, DOI, citation count, open access indicator
- **Hover tooltip**: Mouse hover shows full author list, title, journal, date, volume/issue, DOI, citation count, OA status, abstract
- **Already-imported indicator**: Precisely matches DOI against the Zotero database (`LOWER(value) = ?`, not `LIKE`) to detect whether an entry with the same DOI already exists in the library, avoiding duplicate imports
- **DOI copy button**: One-click copy button next to each result's DOI; copies to clipboard with ✓/✗ feedback
- **Star bookmark**: The ☆/★ button on the left of each card adds the entry to the reading queue; starred entries are marked with a gold ★

### Result Filtering

- **Basic filters**: Year range, sort (relevance / cited desc / newest), document type (all / article / review / conference)
- **Refine bar**: Instant filtering of the current page's results without re-requesting the API
  - `All` / `OA` / `Cited≥50` / `Cited≥100` / `Last 3y` / `Last 5y` / `Review`
  - Right side shows real-time `shown / total` count
- **Journal rank filter**: Multi-criteria combined filter based on EasyScholar journal rank data
  - The `🎖 Journal Rank` button in the toolbar opens the filter dialog
  - Check any combination of common high-quality ranks (JCR Q1/Q2, CAS 1/2, EI, CSSCI, Peking University Core, etc.)
  - Only entries matching any checked rank are shown; entries without a matching rank are hidden
  - Previously queried journal rank data is reused when loading more, avoiding repeat EasyScholar API requests
- **Filter state preservation**: All current filter states (OA / journal rank / refine bar) are preserved when loading more results — no reset

### Import & Download

- **Single import**: Click the "Import" button in a result card
- **Batch import**: Click "Import all on page" to batch-import all results on the current page
- **PDF download chain**: Automatically tries downloading PDF in the order `Unpaywall → SciHub → Zotero built-in → Scopus`
  - Download order is draggable in settings
  - SciHub mirror URL is configurable in settings (default `https://sci-hub.ru/`)
  - Uses iPhone User-Agent to avoid SciHub 403 errors
  - Auto-detects CAPTCHA pages and "article not found" error pages
- **Source tagging**: Imported items have their `libraryCatalog` field auto-tagged with the source (Scopus / PubMed / arXiv / Google Scholar / IEEE / Springer / Semantic Scholar) for traceability
- **Translate title button**: The "Translate" button on the right of each card manually triggers title translation; the translation is shown below the title (depends on the zotero-pdf-translate plugin)
- **Import feedback**: Toast notifications in the bottom-right corner replace alerts, showing success/failure details and auto-dismissing after 3 seconds

### Batch Export

- **Multi-select export**: Checkbox on the left of each card + "Select all" checkbox at the top
- **Three formats**:
  - **BibTeX** (`.bib`): Auto-escapes special characters `& % $ # _ { } ~ ^ \`, auto-deduplicates citekeys
  - **RIS**: Document type mapping (`JOUR` / `CONF`), splits page range into `SP` / `EP`
  - **CSV**: Includes UTF-8 BOM so Chinese characters don't garble in Excel
- **Find related**: The "Related" button on each card auto-extracts keywords from the title (removes stop words, takes the first 4 content words) to build a `TITLE-ABS-KEY()` query; auto-switches if the current source is not Scopus

### Citation Preview

The "Cite" button on each card opens a dialog showing the citation format with one-click copy:

- **Uses Zotero's built-in citation styles**: Calls Zotero's citeproc engine to generate citations, ensuring format accuracy consistent with Zotero's bibliography output
- **Dropdown style selector**: The dropdown at the top of the dialog lists all citation styles installed in Zotero; switching regenerates in real time
- **Default style priority**: GB/T 7714-2015 (numeric) → APA → MLA → Chicago → IEEE
- **Supported styles** include but are not limited to:
  - GB/T 7714-2015 (numeric / note)
  - APA 6th / 7th
  - MLA 8th / 9th
  - Chicago (author-date / note)
  - IEEE / Vancouver / Nature / Science
  - Other styles installed by the user in Zotero preferences
- **For more styles**: Install them in Zotero → Edit → Preferences → Cite → Style Manager

### Reading Queue / Bookmarks

- **One-click bookmark**: Click the ☆ button on the left of a result card to add it to the reading queue; a gold ★ marks starred entries
- **Queue management**: The `★ Bookmarks` button below the search box opens the reading queue dialog
  - List shows title, DOI, bookmark time
  - Click title to open in browser (prefers DOI link)
  - Remove single / clear all
- **Local storage**: Up to 200 entries, persisted across sessions
- **Precise matching**: Removal strictly matches by DOI (or title if no DOI) to avoid accidentally deleting other entries

### Search Result Statistics

The `📊 Stats` button below the search box opens a statistics panel for the current page's results:

- **Overview**: Open access ratio, DOI coverage, abstract coverage
- **Year distribution**: Horizontal bar chart, descending by year
- **Citation distribution**: Bucketed `0` / `1-9` / `10-49` / `50-99` / `100+`
- **Data source**: Computed in real time from all results on the current page

### Auxiliary Features

- **Citation count column**: Shows a citation-count column in the Zotero items list
- **Open access column**: Marks OA status
- **Batch update citations**: Menu `Tools → Zsearch → Update Citation Counts`
- **Journal metrics row**: Shows Scopus journal metrics in item details
- **Author metrics**: Shows author metrics (Scopus)

---

## Installation

### Option 1: Download prebuilt XPI

1. Download [build/zsearch.xpi](build/zsearch.xpi)
2. Zotero → `Tools` → `Add-ons` → gear icon → `Install Add-on From File...`
3. Select the downloaded `.xpi` file

### Option 2: Build from source

```bash
git clone https://github.com/zotero-plugin-dev/zsearch.git
cd zsearch
npm install
node node_modules/zotero-plugin-scaffold/bin/zotero-plugin.mjs build
```

The build output is at `.scaffold/build/zsearch.xpi`, and a copy is also placed at `build/zsearch.xpi`.

---

## Configuration

After installation, configure in `Tools → Add-ons → Zsearch → Preferences`:

### Required

| Setting | Description | How to obtain |
|---|---|---|
| **Elsevier API Key** | Required for Scopus search | Register for free at [https://dev.elsevier.com](https://dev.elsevier.com) |
| **IEEE API Key** | Required for IEEE Xplore search source | Apply at [https://developer.ieee.org](https://developer.ieee.org) |

### Optional API Keys

| Setting | Description | How to obtain |
|---|---|---|
| EasyScholar API Key | Displays journal rank badges (JCR / CAS / EI / CSSCI, etc.) | [https://www.easyscholar.cc/console/user/open](https://www.easyscholar.cc/console/user/open) |
| Springer API Key | Required for Springer search source | Free at [https://dev.springernature.com](https://dev.springernature.com) |
| Semantic Scholar API Key | Recommended; without a key, 403 anti-bot may trigger; with a key ~1 req/sec | [https://www.semanticscholar.org/product/api](https://www.semanticscholar.org/product/api) |
| PubMed API Key | Optional; without key 3 req/sec, with key 10 req/sec | [https://www.ncbi.nlm.nih.gov/account/settings/](https://www.ncbi.nlm.nih.gov/account/settings/) |
| Unpaywall Email | For OA PDF lookup (free, no key) | Any valid email; your real email is recommended for fair-use quota |
| Institution Token (Insttoken) | Required for full-text PDF download; obtain from your institution library | Institution library |

### Translation

| Setting | Description | Default |
|---|---|---|
| Auto-translate title when searching | Auto-translates the title during search; translation appears below the title | Off |
| Translation target language | Target language (BCP 47 code, e.g. `zh-CN` / `en-US` / `ja`) | `zh-CN` |

> The translation feature depends on the [zotero-pdf-translate](https://github.com/windingwind/zotero-pdf-translate#readme) plugin and reuses its engine and target language settings. If the target language is empty, it falls back to the pdf-translate plugin's global setting, then to the Zotero UI language.

### Other

| Setting | Description | Default |
|---|---|---|
| Auto-download PDF when importing | Whether to auto-download PDF when importing | Off |
| Results per page | Results per page | 25 |
| Default sort | Default sort order | Relevance |
| Request timeout (ms) | Request timeout | 30000 |
| Max retries | Max retries | 3 |
| SciHub mirror | SciHub mirror URL (must end with `/`) | `https://sci-hub.ru/` |

### Connection Test

The preferences page provides a **Test All Connections** button that tests all API connections at once (Scopus / PubMed / Semantic Scholar / Springer / IEEE / Unpaywall / SciHub), showing real-time progress (1/7, 2/7...) and a popup with `✓ OK` / `✗ Failed` / `– Skipped` indicators and summary statistics.

> Note: Semantic Scholar, PubMed, and Unpaywall are tested even without an API Key/Email configured.

### 403 Error Troubleshooting

Some APIs return 403 Forbidden under specific conditions. This addon handles 403s from different sources with fine-grained messaging:

| Source | Possible 403 causes | Solution |
|---|---|---|
| **Semantic Scholar** | Anti-bot limit without an API Key (transient or persistent) | Configure the Semantic Scholar API Key; the addon already retries once after a 2-second delay on the first 403 |
| **IEEE** | Inactive API Key account (`ERR_403_DEVELOPER_INACTIVE`) / quota exhausted (`ERR_403_OVER_RATE_LIMIT`) / invalid key | Go to [https://developer.ieee.org/my-account](https://developer.ieee.org/my-account) to reactivate the account or apply for a new key; common reasons for inactive accounts: unused for 30+ days / disabled / activation not completed |
| **SciHub** | User-Agent identified as a bot | The addon already uses an iPhone User-Agent to bypass this; if 403 persists, try a different mirror URL |

> The addon uses the `successCodes: null` option for all API requests, ensuring 4xx/5xx status codes are correctly identified and handled rather than being generically classified as "network errors".

---

## Usage Guide

### Basic Search Flow

1. Open the search window via any of:
   - Menu `Tools → Zsearch Search…`
   - Toolbar Zsearch button
   - Shortcut `Ctrl+Shift+S` (macOS `Cmd+Shift+S`)
2. Enter keywords in the search box
3. Choose a search source (default Scopus)
   - **Scopus**: Most complete structured fields, recommended as primary
   - **Aggregated**: Queries all configured API sources in parallel; highest recall
   - **Google Scholar**: Broad coverage, but may trigger anti-bot
   - **PubMed / arXiv / Semantic Scholar / Springer / IEEE Xplore**: Domain-specific sources
4. Optional: Use syntax shortcut buttons to build an advanced query (only Scopus supports advanced syntax)
5. Optional: Set year range, sort, type filters
6. Press `Enter` or click the Search button
7. For more results, click the "Load more" button at the bottom; new results are appended to the end of the list without disrupting your current reading position

> **Cross-source tip**: When using the "Related" button, if the current source is not Scopus, it auto-switches to Scopus to support the `TITLE-ABS-KEY()` advanced syntax.

### Aggregated Search

Aggregated mode queries all configured API sources in parallel (Scopus / PubMed / arXiv / Semantic Scholar / Springer / IEEE Xplore) and merges results by DOI/title deduplication:

- **Streaming incremental loading**: Each source's results are merged and pushed as soon as it completes — no need to wait for all sources; entries with results are returned first
- **Multi-source badges**: Each result shows a source badge on the left; multi-source hits show a combined badge (e.g. `🔬 Scopus + 🏥 PubMed + ⚡ IEEE`)
- **Load more**: The "Load more" button at the bottom fetches the next page from each source, deduplicates, and appends incrementally; previously queried journal rank data is reused to avoid repeat requests
- **Filter preservation**: All current filter states (OA / journal rank / refine bar) are preserved when loading more — no reset
- **Search state management**: Single-source and aggregated search modes are managed independently; switching automatically cleans up state to avoid conflicts

### Advanced Query Examples

```
TITLE-ABS-KEY(deep learning AND tunneling)
AUTHOR-NAME(Wang) AND AFFIL(Tsinghua)
PUBYEAR > 2020 AND TITLE-ABS-KEY(geology)
TITLE-ABS-KEY(machine learning) AND LIMIT-TO(DOCTYPE,"ar")
TITLE-ABS-KEY(open access) AND LIMIT-TO(OA,"all")
```

### Exporting Literature

1. Check the entries to export in the search results (left checkbox)
2. Optional: Click "Select all" to check all visible entries on the current page
3. Optional: Use the refine bar to narrow the scope (e.g. show only OA literature)
4. Click `Export BibTeX` / `Export RIS` / `Export CSV`
5. Choose a save location in the file save dialog

### Find Related Literature

Click the "Related" button on any result card:
- Auto-extracts keywords from the article title (removes stop words, takes the first 4 content words)
- Builds a `TITLE-ABS-KEY(keyword1 AND keyword2 AND ...)` query
- If the current source is not Scopus, auto-switches to Scopus with a notification
- Immediately executes the search

### Bookmarks & Reading Queue

1. Click the ☆ button on the left of a result card; a gold ★ indicates it is bookmarked
2. Click the `★ Bookmarks` button below the search box to open the reading queue
3. In the queue, click a title to open the literature in the browser, or click "Remove" to unbookmark
4. The queue stores up to 200 entries, persisted across sessions

### Viewing Result Statistics

1. After performing a search, click the `📊 Stats` button below the search box
2. The popup shows the current page's year distribution, citation distribution, OA ratio, and more
3. Click "Close" or the backdrop to close the popup

### DOI/arXiv ID Quick Lookup

Paste a DOI or arXiv ID (e.g. `10.1016/j.tust.2023.105734` or `2301.12345`) directly into the search box and press Enter:
- Auto-detected as an identifier (not a search keyword)
- Opens the corresponding literature page in the default browser
- Status bar shows `Detected DOI/arXiv: xxx, opened in browser`

> Note: This only triggers when the input length is close to an identifier length, to avoid misjudging complex queries containing DOIs.

---

## Search Sources

### API Sources (support direct import of results)

| Source | Icon | API Key Required | Description |
|---|---|---|---|
| Scopus | 🔬 | Yes (Elsevier API Key) | Primary source; supports full metadata and Abstract API enrichment |
| PubMed | 🏥 | No (optional email for higher quota) | Biomedical domain |
| arXiv | 📄 | No | Preprints; 3-second rate limit |
| Semantic Scholar | 🧠 | No (optional API Key for higher quota) | AI-powered academic search |
| Springer | 📚 | Yes (Springer API Key) | Springer Link journals |
| IEEE Xplore | ⚡ | Yes (IEEE API Key) | 6M+ journal/conference/standards metadata records |
| **Google Scholar** | 📚 | No | **HTML parsing source**; results shown as structured cards |

#### Google Scholar Parsing Source Notes

Google Scholar has no public API; this addon fetches the search results page HTML and parses it into structured entries:

- **Field extraction**: Title, link, authors, journal, year, abstract snippet, citation count, open access flag, DOI
- **DOI extraction**: Regex-matched from abstract snippets and URLs (uses CrossRef-recommended regex; correctly handles DOIs containing periods)
- **Citation count**: Supports thousands separators (e.g. `Cited by 1,234`)
- **Author line parsing**: Split by ` - ` (with spaces) to avoid mis-splitting hyphens in author/journal names (e.g. `Jean-Pierre Dupont`)
- **Anti-bot limits**: Zotero is Gecko-based; its User-Agent is identified by GS as non-browser traffic and may trigger 429/CAPTCHA
- **Rate limit strategy**: Request interval at least 5 seconds; back off 60 seconds on 429/503
- **Usage tips**:
  1. Before first use, visit [scholar.google.com](https://scholar.google.com) in a browser to complete any CAPTCHA
  2. On 429, wait a few minutes and retry, or use structured sources like Scopus/PubMed
  3. GS does not provide volume/issue/pages fields; these are empty in the cards
  4. DOI hit rate is about 60-80% (depending on whether GS exposes the DOI)

### Web Jump Sources (open in browser)

| Source | Icon |
|---|---|
| Google | 🌍 |
| ResearchGate | 🔬 |
| JSTOR | 📖 |

---

## Keyboard Shortcuts

| Shortcut | Function |
|---|---|
| `Ctrl+Shift+S` (macOS `Cmd+Shift+S`) | Open search window |
| `Enter` | Execute search |
| `Ctrl+Enter` | Execute search |
| `Esc` | Clear search box |

---

## Technical Details

### PDF Download Chain

By default, PDF download is attempted in the following order:

1. **Unpaywall** — Tries the open access version first
2. **SciHub** — Uses the configured mirror URL; iPhone User-Agent
3. **Zotero built-in** — Calls Zotero's built-in PDF finder
4. **Scopus** — Via Elsevier Article Retrieval API (requires Insttoken)

The chain stops as soon as one source succeeds; if all sources fail, an error is shown.

> **Order is adjustable**: In Zsearch preferences, under the "PDF Download Order" section, drag rows to reorder providers. For example, drag SciHub to position 1 to try SciHub first.

### Journal Rank Data Source

Journal rank badges are fetched from the [EasyScholar](https://www.easyscholar.cc) API:
- API: `GET https://www.easyscholar.cc/open/getPublicationRank?secretKey=KEY&publicationName=NAME`
- Cache key: journal name uppercased
- Cache TTL: 24 hours by default (controlled by the `cacheTTL` pref)
- Concurrency: 4 (to avoid triggering rate limits)
- Failure caching: Avoids repeating failed queries in a short window
- **Reuse across load-more**: In aggregated search load-more, previously queried journal rank data is persisted in `searchWindowState.aggregateRankedJournals` for reuse, avoiding repeat requests that could trigger 429

### Translation

Title translation is implemented via the global API of the [zotero-pdf-translate](https://github.com/windingwind/zotero-pdf-translate#readme) plugin:

- Call convention: `Zotero.PDFTranslate.api.translate(raw, { pluginID, langfrom, langto, itemID })`
- Returns `Promise<TranslateTask>`; `task.result` is the translation when `task.status === "success"`
- **Cache**: Reused across searches and card rebuilds, avoiding repeated translations of the same title (saves translation service quota)
- **Concurrent deduplication**: Merges concurrent translation requests for the same title; only one API call is made per title
- **Trigger timing**: Auto-triggered when search results render (not at import time); translation appears below the title
- **Target language priority**: This addon's `translateTargetLang` pref → pdf-translate plugin global setting → Zotero UI language

### Error Handling

- All API requests use the `successCodes: null` option, ensuring 4xx/5xx status codes are correctly identified and handled
- IEEE API returns errors via the Mashery proxy; the addon reads the `X-Mashery-Error-Code` and `X-Error-Detail-Header` response headers to identify the specific error type (`ERR_403_DEVELOPER_INACTIVE` / `ERR_403_OVER_RATE_LIMIT`, etc.)
- Semantic Scholar and IEEE 403 errors retry once after a 2-second delay on the first failure (to handle transient anti-bot false positives); account and quota issues throw immediately without retrying

### Visual Spec

- Font: `Roboto, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif`
- Primary color: Google Blue `#4285f4`
- Title link: `#1a0dab`
- Journal badge colors:
  - JCR Q1 / CAS 1: dark red `#d93025` / `#b31412`
  - Q2 / CAS 2: orange `#e8710a`
  - Q3 / CAS 3: yellow-brown `#c5a000`
  - Q4 / CAS 4: green `#137333`
  - Impact Factor IF: purple `#681da8`
  - EI: blue `#1a73e8`
  - Warning journals: dark red blinking animation

---

## Internationalization

Supports Chinese (zh-CN) and English (en-US) bilingual UI, automatically following the Zotero language setting.

---

## Compatibility

- Zotero 7 / 8 / 9 (`strict_min_version: 6.999`, `strict_max_version: 9.*`)
- Windows / macOS / Linux

---

## Development

### Project Structure

```
zsearch/
├── addon/                  # Addon resources (build input)
│   ├── content/            # XHTML windows, CSS, icons
│   ├── locale/             # FTL i18n files
│   ├── bootstrap.js        # Addon entry
│   ├── manifest.json       # Addon manifest
│   └── prefs.js            # Preference defaults
├── src/                    # TypeScript source
│   ├── modules/            # Feature modules
│   │   ├── searchWindow.ts # Search window main logic
│   │   ├── searchSources.ts# Search source registry
│   │   ├── searchSource.ts # Unified search source interface & types
│   │   ├── elsevierClient.ts
│   │   ├── pubmedClient.ts
│   │   ├── arxivClient.ts
│   │   ├── semanticScholarClient.ts
│   │   ├── springerClient.ts
│   │   ├── googleScholarClient.ts # GS HTML parsing source
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
│   ├── utils/              # Utilities
│   └── hooks.ts            # Lifecycle hooks
├── typings/                # Type definitions
├── docs/                   # Design docs
├── build/                  # Build output
│   └── zsearch.xpi
└── package.json
```

### Build Commands

```bash
# Build XPI
node node_modules/zotero-plugin-scaffold/bin/zotero-plugin.mjs build

# Dev mode (hot reload)
npm start

# Type check (no output)
npx tsc --noEmit

# Code formatting
npm run lint:fix
```

### Tech Stack

| Dimension | Choice |
|---|---|
| Build tool | `zotero-plugin-scaffold` ^0.8.2 |
| Toolkit | `zotero-plugin-toolkit` ^5.1.0-beta |
| Types | `zotero-types` ^4.1.0-beta |
| Language | TypeScript 5 + esbuild |
| UI rendering | Native DOM + CSS |
| i18n | Mozilla Fluent (.ftl) |

---

## License

[AGPL-3.0-or-later](LICENSE)

---

## Feedback & Issues

- File an issue: [GitHub Issues](https://github.com/zotero-plugin-dev/zsearch/issues)
- Design doc: [docs/DESIGN.md](docs/DESIGN.md)

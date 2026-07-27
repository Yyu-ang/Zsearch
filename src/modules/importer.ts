import {
  ScopusEntry,
  AbstractData,
  AbstractAuthor,
} from "./elsevierClient";

/**
 * Convert Scopus entry / Abstract data to a Zotero Item.
 *
 * `extra` field convention (Zsearch-prefixed to avoid collisions):
 *   Zsearch Cited by: 42
 *   Zsearch Scopus EID: 2-s2.0-85123456789
 *   Zsearch PII: S0925231223001001
 *   Zsearch OA: true
 */

const ZS = "Zsearch";

export function buildExtra(fields: {
  citedBy?: number;
  eid?: string;
  pii?: string;
  oa?: boolean;
  existingExtra?: string;
}): string {
  const lines: string[] = [];
  if (fields.citedBy !== undefined) lines.push(`${ZS} Cited by: ${fields.citedBy}`);
  if (fields.eid) lines.push(`${ZS} Scopus EID: ${fields.eid}`);
  if (fields.pii) lines.push(`${ZS} PII: ${fields.pii}`);
  if (fields.oa !== undefined) lines.push(`${ZS} OA: ${fields.oa}`);

  if (lines.length === 0) return fields.existingExtra || "";
  const prefix = lines.join("\n");
  if (!fields.existingExtra) return prefix;
  // Remove any existing Zsearch lines to avoid duplicates, then append.
  const cleaned = fields.existingExtra
    .split("\n")
    .filter((l) => !l.startsWith(`${ZS} `))
    .join("\n");
  return cleaned ? `${prefix}\n${cleaned}` : prefix;
}

export function parseExtraCitedBy(extra: string | undefined): number | undefined {
  if (!extra) return undefined;
  const m = extra.match(/Zsearch Cited by: (\d+)/);
  if (m) return Number(m[1]);
  // fallback for older "Cited by:" style
  const m2 = extra.match(/Cited by:?\s*(\d+)/);
  return m2 ? Number(m2[1]) : undefined;
}

export function parseExtraField(
  extra: string | undefined,
  key: string,
): string | undefined {
  if (!extra) return undefined;
  const re = new RegExp(`${ZS} ${key}: (.+)`);
  const m = extra.match(re);
  return m ? m[1] : undefined;
}

export function parseExtraDOI(item: Zotero.Item): string | undefined {
  const doi = String(item.getField("DOI") || "").trim();
  if (doi) return doi;
  const extra = String(item.getField("extra") || "");
  return parseExtraField(extra, "DOI");
}

function subtypeToItemType(subtype?: string): string {
  switch (subtype) {
    case "ar":
    case "re":
    case "no":
    case "er":
    case "le":
    case "sh":
    case "tb":
    case "ab":
      return "journalArticle";
    case "cp":
      return "conferencePaper";
    case "ch":
      return "bookSection";
    case "bk":
      return "book";
    default:
      return "journalArticle";
  }
}

/**
 * Parse author data from various search sources into Zotero creator objects.
 *
 * 支持的输入格式：
 *  1. 字符串: "Smith, J.; Liu, W.; Zhang, C." (Scopus / 通用)
 *  2. AbstractAuthor[]: { surname, givenName, fullName } (Scopus Abstract API)
 *  3. Scopus 搜索结果: { authname, surname, "given-name" } (注意连字符字段名)
 *  4. PubMed: { lastName, foreName, fullName }
 *  5. Semantic Scholar: { authorId, name }
 *  6. Springer: { creator: "Full Name" }
 *  7. arXiv: 字符串数组 ["John Smith", "Jane Doe"]
 *
 * 当只有全名（无 surname/givenName 拆分）时，启发式拆分：
 *  - "Smith, John" → lastName=Smith, firstName=John
 *  - "John Smith" → firstName=John, lastName=Smith
 *  - "J. Smith" → firstName=J., lastName=Smith
 */
export function parseAuthors(
  source: string | any[] | undefined,
): Array<{ creatorType: string; firstName: string; lastName: string }> {
  if (!source) return [];

  // 数组格式：各搜索源的对象数组，或字符串数组
  if (Array.isArray(source)) {
    return source
      .map((a) => parseSingleAuthor(a))
      .filter((c) => c.lastName || c.firstName) as Array<{
      creatorType: string;
      firstName: string;
      lastName: string;
    }>;
  }

  // 字符串格式：按分号分割后逐个解析
  const s = String(source);
  return s
    .split(/\s*;\s*/)
    .filter(Boolean)
    .map((part) => splitFullName(part.trim()));
}

/**
 * 解析单个作者对象（来自不同搜索源）。
 * 统一提取 surname + givenName，回退到全名启发式拆分。
 */
function parseSingleAuthor(a: any): {
  creatorType: string;
  firstName: string;
  lastName: string;
} {
  // 字符串数组元素（arXiv）
  if (typeof a === "string") {
    return { creatorType: "author", ...splitFullName(a) };
  }

  if (!a || typeof a !== "object") {
    return { creatorType: "author", firstName: "", lastName: "" };
  }

  // 1. 优先使用已拆分的 surname + givenName（各源字段名不同）
  //    - Scopus Abstract: surname / givenName
  //    - Scopus Search:   surname / "given-name" (连字符)
  //    - PubMed:          lastName / foreName
  //    - ce: 前缀:        "ce:surname" / "ce:given-name"
  const surname =
    a.surname || a.lastName || a["ce:surname"] || a["family"] || "";
  const given =
    a.givenName ||
    a.foreName ||
    a["given-name"] ||
    a["ce:given-name"] ||
    a["given"] ||
    a.firstName ||
    "";

  if (surname && given) {
    return {
      creatorType: "author",
      firstName: String(given).trim(),
      lastName: String(surname).trim(),
    };
  }

  // 2. 只有 surname（无 givenName）
  if (surname) {
    return {
      creatorType: "author",
      firstName: "",
      lastName: String(surname).trim(),
    };
  }

  // 3. 只有 givenName（少见，作为全名处理）
  if (given) {
    return {
      creatorType: "author",
      ...splitFullName(String(given).trim()),
    };
  }

  // 4. 回退到全名字段（各源字段名不同）
  const fullName =
    a.fullName ||
    a.name ||
    a.authname ||
    a.creator ||
    a.display_name ||
    "";
  if (fullName) {
    return {
      creatorType: "author",
      ...splitFullName(String(fullName).trim()),
    };
  }

  return { creatorType: "author", firstName: "", lastName: "" };
}

/**
 * 启发式拆分全名为 firstName + lastName。
 * 规则：
 *  - "Smith, John"  → lastName=Smith, firstName=John
 *  - "Smith, J."    → lastName=Smith, firstName=J.
 *  - "John Smith"   → firstName=John, lastName=Smith
 *  - "J. Smith"     → firstName=J., lastName=Smith
 *  - "Smith"        → lastName=Smith, firstName=""
 *  - "John Jacob Smith" → firstName=John Jacob, lastName=Smith
 */
function splitFullName(
  raw: string,
): { firstName: string; lastName: string } {
  const name = raw.trim();
  if (!name) return { firstName: "", lastName: "" };

  // "LastName, FirstName" 格式
  const commaMatch = name.match(/^(.+?),\s*(.+)$/);
  if (commaMatch) {
    return {
      lastName: commaMatch[1].trim(),
      firstName: commaMatch[2].trim(),
    };
  }

  // 无逗号：最后一个词作为 lastName，前面作为 firstName
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length === 1) {
    return { firstName: "", lastName: parts[0] };
  }

  // 特殊处理：首词含点（如 "J."）说明是缩写名
  // "J. Smith" → firstName=J., lastName=Smith
  const lastName = parts[parts.length - 1];
  const firstName = parts.slice(0, -1).join(" ");
  return { firstName, lastName };
}

function pickDate(coverDate?: string): string {
  if (!coverDate) return "";
  const d = String(coverDate).trim();
  // YYYY-MM-DD or YYYY-MM or YYYY
  if (/^\d{4}-\d{2}-\d{2}/.test(d)) return d.slice(0, 10);
  if (/^\d{4}-\d{2}/.test(d)) return d.slice(0, 7);
  if (/^\d{4}/.test(d)) return d.slice(0, 4);
  return d;
}

export interface ImportOptions {
  collectionID?: number;
  withAbstract?: boolean; // fetch Abstract API for full authors + abstract
  autoPDF?: boolean;
  /** 翻译后的标题；若提供则覆盖原标题写入 Zotero 条目的 title 字段 */
  translatedTitle?: string;
}

export interface ImportResult {
  item?: Zotero.Item;
  skipped: boolean;
  reason?: string;
}

/**
 * Find an existing item with the same DOI in the user library.
 */
export async function findExistingByDOI(doi: string): Promise<Zotero.Item | undefined> {
  if (!doi) return undefined;
  const s = new Zotero.Search({
    name: "zsearch-doi-lookup",
    libraryID: Zotero.Libraries.userLibraryID,
  });
  s.addCondition("DOI", "is", doi);
  s.addCondition("itemType", "isNot", "attachment");
  const ids = await s.search();
  if (ids && ids.length > 0) {
    return (await Zotero.Items.getAsync(ids[0])) as Zotero.Item;
  }
  return undefined;
}

/**
 * Create a Zotero Item from a ScopusEntry, optionally enriching via Abstract API.
 */
export async function importEntry(
  entry: ScopusEntry,
  client: import("./elsevierClient").ElsevierClient,
  opts: ImportOptions = {},
): Promise<ImportResult> {
  const doi = entry.doi;
  if (doi) {
    const existing = await findExistingByDOI(doi);
    if (existing) {
      return { skipped: true, reason: "Duplicate DOI", item: existing };
    }
  }

  // Optionally enrich with Abstract API for complete author list + abstract.
  let abstractData: AbstractData | undefined;
  if (opts.withAbstract) {
    try {
      const idType = entry.doi
        ? "doi"
        : entry.pii
        ? "pii"
        : entry.scopusId
        ? "scopus_id"
        : "eid";
      const id = entry.doi || entry.pii || entry.scopusId || entry.eid;
      if (id) abstractData = await client.getAbstract(idType as any, id);
    } catch (e) {
      ztoolkit.log("Abstract enrichment failed, falling back to search entry", e);
    }
  }

  const subtype = abstractData?.subtype || entry.subtype;
  const itemType = subtypeToItemType(subtype);

  const item = new Zotero.Item(itemType as any);

  // 优先使用翻译后的标题（若调用方提供），否则用 Abstract API 富化的标题，最后回退到 entry.title
  const title = opts.translatedTitle || abstractData?.title || entry.title;
  if (title) item.setField("title", title);

  const authors = abstractData?.authors?.length
    ? abstractData.authors
    : entry.authors || entry.creator;
  const creators = parseAuthors(authors as any);
  if (creators.length) item.setCreators(creators as any);

  const pub = abstractData?.publicationName || entry.publicationName;
  if (pub) item.setField("publicationTitle", pub);

  const date = pickDate(abstractData?.coverDate || entry.coverDate);
  if (date) item.setField("date", date);

  const volume = abstractData?.volume || entry.volume;
  if (volume) item.setField("volume", volume);
  const issue = abstractData?.issue || entry.issue;
  if (issue) item.setField("issue", issue);
  const pages = abstractData?.pageRange || entry.pageRange;
  if (pages) item.setField("pages", pages);

  if (doi) item.setField("DOI", doi);

  const issn = abstractData?.issn || entry.eIssn || entry.issn;
  if (issn) item.setField("ISSN", issn);

  const abstract = abstractData?.description || entry.description;
  if (abstract) item.setField("abstractNote", abstract);

  const url = entry.scopusUrl || (doi ? `https://doi.org/${doi}` : "");
  if (url) item.setField("url", url);

  // libraryCatalog 标记来源：Scopus / PubMed / arXiv / Google Scholar 等
  // 通过 scopusUrl 协议或 entry 字段判断（GS 条目 scopusUrl 是 scholar.google.com）
  let catalog = "Scopus";
  if (url.includes("scholar.google.com")) catalog = "Google Scholar";
  else if (url.includes("pubmed") || url.includes("ncbi.nlm.nih.gov")) catalog = "PubMed";
  else if (url.includes("arxiv.org")) catalog = "arXiv";
  item.setField("libraryCatalog", catalog);

  // Keywords as tags
  const kws = abstractData?.authKeywords || entry.authKeywords || [];
  for (const kw of kws) {
    try {
      item.addTag(kw);
    } catch {
      /* ignore tag errors */
    }
  }

  // extra
  const citedBy =
    abstractData?.citedByCount !== undefined
      ? abstractData.citedByCount
      : entry.citedByCount;
  item.setField(
    "extra",
    buildExtra({
      citedBy,
      eid: entry.eid,
      pii: entry.pii,
      oa: entry.openAccess,
    }),
  );

  if (opts.collectionID) {
    item.setCollections([opts.collectionID]);
  }

  await item.saveTx();

  return { item, skipped: false };
}

/**
 * Update an existing item's citation count / scopus metadata in extra.
 */
export async function updateItemMetadata(
  item: Zotero.Item,
  abstractData: AbstractData,
): Promise<void> {
  const existingExtra = String(item.getField("extra") || "");
  const citedBy = abstractData.citedByCount;
  const eid = abstractData.eid;
  const pii = abstractData.pii;
  const newExtra = buildExtra({
    citedBy,
    eid,
    pii,
    existingExtra,
  });
  item.setField("extra", newExtra);
  if (abstractData.doi && !item.getField("DOI")) {
    item.setField("DOI", abstractData.doi);
  }
  if (abstractData.description && !item.getField("abstractNote")) {
    item.setField("abstractNote", abstractData.description);
  }
  await item.saveTx();
}

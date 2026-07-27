import { getPref } from "../utils/prefs";

/**
 * Elsevier API client.
 *
 * Endpoints (base: https://api.elsevier.com):
 *  - Scopus Search:        /content/search/scopus
 *  - ScienceDirect Search: /content/search/sciencedirect
 *  - Abstract Citation:    /content/abstract/{doi|pii|scopus_id|eid|pubmed_id}/{id}
 *  - Article Retrieval:    /content/article/{doi|pii|eid|scopus_id|pubmed_id}/{id}
 *  - Entitlements:         /content/article/entitlement/{doi|pii}/{id}
 *  - Serial Title:         /content/serial/title/issn/{issn}
 *  - Author Search:        /content/search/author
 *
 * Auth: X-ELS-APIKey (required) + X-ELS-Insttoken (optional, needed for PDF).
 * Rate limit: ~2 req/s, 10000 req/week. Backoff on 429.
 */

const BASE_URL = "https://api.elsevier.com";

export type IdType = "doi" | "pii" | "scopus_id" | "eid" | "pubmed_id";

export interface ScopusEntry {
  eid?: string;
  doi?: string;
  pii?: string;
  scopusId?: string;
  title?: string;
  creator?: string;
  authors?: string;
  publicationName?: string;
  coverDate?: string;
  coverDisplayDate?: string;
  volume?: string;
  issue?: string;
  pageRange?: string;
  articleNumber?: string;
  issn?: string;
  eIssn?: string;
  isbn?: string;
  citedByCount?: number;
  citedByCountStr?: string;
  openAccess?: boolean;
  openAccessFlag?: boolean;
  authKeywords?: string[];
  description?: string;
  subtype?: string;
  subtypeDescription?: string;
  aggregationType?: string;
  scopusUrl?: string;
}

export interface ScopusSearchResult {
  total: number;
  entries: ScopusEntry[];
  nextHref?: string;
}

export interface AbstractAuthor {
  seq?: number;
  auid?: string;
  surname?: string;
  givenName?: string;
  fullName?: string;
  orcid?: string;
  affiliation?: string;
}

export interface AbstractData {
  doi?: string;
  pii?: string;
  scopusId?: string;
  eid?: string;
  title?: string;
  description?: string;
  authors: AbstractAuthor[];
  publicationName?: string;
  coverDate?: string;
  volume?: string;
  issue?: string;
  pageRange?: string;
  issn?: string;
  citedByCount?: number;
  authKeywords?: string[];
  subtype?: string;
}

export interface SerialData {
  title?: string;
  issn?: string;
  eIssn?: string;
  publisher?: string;
  citeScore?: number;
  sjr?: number;
  snip?: number;
  hIndex?: number;
  subjectArea?: string;
}

export interface AuthorData {
  auId?: string;
  preferredName?: string;
  documentCount?: number;
  citedByCount?: number;
  hIndex?: number;
  affiliationCurrent?: string;
}

export class ElsevierAPIError extends Error {
  status: number;
  retryable: boolean;
  constructor(status: number, message: string, retryable = false) {
    super(message);
    this.name = "ElsevierAPIError";
    this.status = status;
    this.retryable = retryable;
  }
}

// Simple token-bucket rate limiter (~2 req/s).
class RateLimiter {
  private minInterval: number;
  private lastRequest = 0;
  constructor(requestsPerSecond = 2) {
    this.minInterval = 1000 / requestsPerSecond;
  }
  async wait(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequest;
    if (elapsed < this.minInterval) {
      await Zotero.Promise.delay(this.minInterval - elapsed);
    }
    this.lastRequest = Date.now();
  }
}

export class ElsevierClient {
  private rateLimiter = new RateLimiter(2);
  private baseURL = BASE_URL;

  get apiKey(): string {
    return (getPref("apiKey") as string) || "";
  }
  get insttoken(): string {
    return (getPref("insttoken") as string) || "";
  }
  get timeout(): number {
    return Number(getPref("requestTimeout") || 30000);
  }
  get maxRetries(): number {
    return Number(getPref("maxRetries") || 3);
  }

  hasApiKey(): boolean {
    return this.apiKey.length > 0;
  }

  hasInsttoken(): boolean {
    return this.insttoken.length > 0;
  }

  private buildHeaders(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = {
      "X-ELS-APIKey": this.apiKey,
      Accept: "application/json",
      "User-Agent": "Zsearch/0.1 (zotero-plugin)",
      ...extra,
    };
    if (this.insttoken) {
      h["X-ELS-Insttoken"] = this.insttoken;
    }
    return h;
  }

  /**
   * Unified GET with rate-limit + retry. Returns parsed JSON (or text).
   */
  private async request(
    path: string,
    params: Record<string, string> = {},
    options: {
      method?: "GET" | "POST";
      headers?: Record<string, string>;
      responseType?: "json" | "text" | "arraybuffer";
      body?: string;
    } = {},
  ): Promise<any> {
    if (!this.hasApiKey()) {
      throw new ElsevierAPIError(401, "API Key not configured", false);
    }
    await this.rateLimiter.wait();

    const url = new URL(this.baseURL + path);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
    }
    const headers = this.buildHeaders(options.headers);
    const responseType = options.responseType || "json";

    let attempt = 0;
    let lastErr: any;
    while (attempt <= this.maxRetries) {
      try {
        const resp = await Zotero.HTTP.request(
          options.method || "GET",
          url.toString(),
          {
            headers,
            body: options.body,
            responseType,
            timeout: this.timeout,
          },
        );

        if (resp.status >= 200 && resp.status < 300) {
          return resp.response;
        }

        // Retryable statuses
        if (resp.status === 429 || resp.status === 500 || resp.status === 502 || resp.status === 503) {
          lastErr = new ElsevierAPIError(
            resp.status,
            `Elsevier API ${resp.status}: ${this.extractError(resp.response)}`,
            true,
          );
          const retryAfter = Number(resp.getResponseHeader("Retry-After") || 0);
          const backoff = retryAfter > 0
            ? retryAfter * 1000
            : Math.min(8000, 1000 * Math.pow(2, attempt));
          ztoolkit.log(`Elsevier ${resp.status}, retry ${attempt + 1} after ${backoff}ms`);
          await Zotero.Promise.delay(backoff);
          attempt++;
          continue;
        }

        // Non-retryable
        throw new ElsevierAPIError(
          resp.status,
          `Elsevier API ${resp.status}: ${this.extractError(resp.response)}`,
          false,
        );
      } catch (e: any) {
        // Zotero.HTTP may reject on network/timeout
        if (e instanceof ElsevierAPIError) {
          if (e.retryable && attempt < this.maxRetries) {
            attempt++;
            continue;
          }
          throw e;
        }
        lastErr = e;
        // Network errors: retry
        if (attempt < this.maxRetries) {
          ztoolkit.log(`Elsevier network error, retry ${attempt + 1}: ${e.message}`);
          await Zotero.Promise.delay(1000 * Math.pow(2, attempt));
          attempt++;
          continue;
        }
        throw new ElsevierAPIError(0, `Network error: ${e.message}`, false);
      }
    }
    throw lastErr || new ElsevierAPIError(0, "Max retries exceeded", false);
  }

  private extractError(resp: any): string {
    try {
      if (typeof resp === "string") {
        const j = JSON.parse(resp);
        const msg =
          j?.["service-error"]?.status?.statusText ||
          j?.["search-results"]?.entry?.[0]?.error ||
          resp.slice(0, 200);
        return String(msg);
      }
      if (resp && typeof resp === "object") {
        return String(
          resp?.["service-error"]?.status?.statusText ||
            resp?.message ||
            JSON.stringify(resp).slice(0, 200),
        );
      }
    } catch {
      /* ignore */
    }
    return "Unknown error";
  }

  /**
   * Scopus Search.
   */
  async searchScopus(opts: {
    query: string;
    field?: string;
    count?: number;
    start?: number;
    sort?: string;
    view?: "STANDARD" | "COMPLETE";
    date?: string;
  }): Promise<ScopusSearchResult> {
    const field =
      opts.field ||
      "dc:title,dc:creator,author,prism:doi,prism:pii,prism:coverDate,prism:coverDisplayDate,citedby-count,eid,prism:publicationName,prism:volume,prism:issueIdentifier,prism:pageRange,prism:issn,prism:eIssn,prism:isbn,prism:aggregationType,openaccess,openaccessFlag,authkeywords,dc:description,subtype,subtypeDescription,article-number";
    const params: Record<string, string> = {
      query: opts.query,
      field,
      count: String(opts.count ?? 25),
      start: String(opts.start ?? 0),
      // 关键：用 COMPLETE 视图才能拿到完整作者列表（author 字段）
      // STANDARD 视图只有 dc:creator（第一作者）
      view: opts.view || "COMPLETE",
    };
    if (opts.sort) params.sort = opts.sort;
    if (opts.date) params.date = opts.date;

    const data = await this.request("/content/search/scopus", params);
    const sr = data?.["search-results"] || {};
    const total = Number(sr["opensearch:totalResults"] || 0);
    const rawEntries = sr.entry || [];
    // When no results, Scopus returns a single entry with error
    const entries: ScopusEntry[] = (Array.isArray(rawEntries) ? rawEntries : [rawEntries])
      .filter((e: any) => e && e.eid && !e.error)
      .map(this.mapEntry);

    let nextHref: string | undefined;
    if (Array.isArray(sr.link)) {
      const next = sr.link.find((l: any) => l["@ref"] === "next");
      if (next) nextHref = next["@href"];
    }
    return { total, entries, nextHref };
  }

  private mapEntry = (e: any): ScopusEntry => {
    const eid: string | undefined = e.eid;
    const doi: string | undefined = e["prism:doi"];
    const pii: string | undefined = e["prism:pii"];
    const ident: string | undefined = e["dc:identifier"]; // e.g. SCOPUS_ID:xxx
    const scopusId = ident ? ident.replace(/^SCOPUS_ID:/, "") : undefined;
    let scopusUrl: string | undefined;
    if (Array.isArray(e.link)) {
      const s = e.link.find((l: any) => l["@ref"] === "scopus");
      if (s) scopusUrl = s["@href"];
    }
    const citedStr: string | undefined = e["citedby-count"];
    return {
      eid,
      doi,
      pii,
      scopusId,
      title: e["dc:title"],
      creator: e["dc:creator"],
      // COMPLETE 视图返回 author 字段（完整作者对象数组）
      // STANDARD 视图只有 dc:creator（第一作者字符串）
      authors: e.author || e["dc:author"] || e["dc:creator"],
      publicationName: e["prism:publicationName"],
      coverDate: e["prism:coverDate"],
      coverDisplayDate: e["prism:coverDisplayDate"],
      volume: e["prism:volume"],
      issue: e["prism:issueIdentifier"],
      pageRange: e["prism:pageRange"],
      articleNumber: e["article-number"],
      issn: e["prism:issn"],
      eIssn: e["prism:eIssn"],
      isbn: e["prism:isbn"],
      citedByCountStr: citedStr,
      citedByCount: citedStr ? Number(citedStr) : undefined,
      openAccess: e.openaccess === "1" || e.openaccessFlag === true,
      openAccessFlag: e.openaccessFlag === true || e.openaccess === "1",
      authKeywords: e.authkeywords
        ? String(e.authkeywords)
            .split("|")
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
      description: this.cleanDescription(e["dc:description"]),
      subtype: e.subtype,
      subtypeDescription: e.subtypeDescription,
      aggregationType: e["prism:aggregationType"],
      scopusUrl,
    };
  };

  private cleanDescription(desc: any): string | undefined {
    if (!desc) return undefined;
    let s = String(desc);
    // Scopus abstracts may contain simple tags
    s = s.replace(/<\/?(p|br|b|i|strong|em|span|div)[^>]*>/gi, "");
    s = s.replace(/&lt;[^&gt;]+&gt;/gi, "");
    s = s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
    return s.trim();
  }

  /**
   * Build a Scopus query string from user input + filters.
   */
  buildQuery(
    keywords: string,
    filters?: {
      yearFrom?: number;
      yearTo?: number;
      type?: string; // ar/re/cp
      oaOnly?: boolean;
    },
  ): string {
    const kw = (keywords || "").trim();
    if (!kw) return "";
    let q = `TITLE-ABS-KEY(${this.quote(kw)})`;
    // Scopus 不支持 >= / <=，用 > 和 < 代替
    if (filters?.yearFrom) q += ` AND PUBYEAR > ${filters.yearFrom - 1}`;
    if (filters?.yearTo) q += ` AND PUBYEAR < ${filters.yearTo + 1}`;
    if (filters?.type) q += ` AND DOCTYPE(${filters.type})`;
    return q;
  }

  private quote(s: string): string {
    // If user already uses field operators, keep as-is; else wrap as phrase
    if (/[()]/.test(s) || /\b(AND|OR|NOT)\b/i.test(s)) return s;
    return `"${s.replace(/"/g, '\\"')}"`;
  }

  /**
   * Abstract Citation API — fetch full abstract + complete author list.
   */
  async getAbstract(idType: IdType, id: string): Promise<AbstractData> {
    const data = await this.request(
      `/content/abstract/${idType}/${encodeURIComponent(id)}`,
      { view: "META_ABS", httpAccept: "application/json" },
    );
    const ar = data?.["abstracts-retrieval-response"];
    if (!ar) {
      throw new ElsevierAPIError(404, "Abstract not found", false);
    }
    const coredata = ar.coredata || {};
    const head = ar?.item?.bibrecord?.head || {};
    const authorNodes = head?.authors?.author || [];
    const authors: AbstractAuthor[] = (Array.isArray(authorNodes)
      ? authorNodes
      : [authorNodes]
    )
      .filter((a: any) => a)
      .map((a: any) => ({
        seq: a["@seq"] ? Number(a["@seq"]) : undefined,
        auid: a["@auid"] || a.auid,
        surname: a["ce:surname"] || a.surname,
        givenName: a["ce:given-name"] || a.givenName,
        fullName:
          a["ce:indexed-name"] || a["ce:indexedName"] || a.fullname,
        orcid: a["@orcid"] || a.orcid,
        affiliation: a.affiliation?.["@id"] || a.affiliation?.["ce:name"],
      }));
    const citedStr = coredata["citedby-count"];
    return {
      doi: coredata["prism:doi"],
      pii: coredata["prism:pii"],
      scopusId: (coredata["dc:identifier"] || "").replace(/^SCOPUS_ID:/, ""),
      eid: coredata.eid,
      title: coredata["dc:title"],
      description: this.cleanDescription(coredata["dc:description"]),
      authors,
      publicationName: coredata["prism:publicationName"],
      coverDate: coredata["prism:coverDate"],
      volume: coredata["prism:volume"],
      issue: coredata["prism:issueIdentifier"],
      pageRange: coredata["prism:pageRange"],
      issn: coredata["prism:issn"],
      citedByCount: citedStr ? Number(citedStr) : undefined,
      authKeywords: coredata.authkeywords
        ? String(coredata.authkeywords)
            .split("|")
            .map((s: string) => s.trim())
            .filter(Boolean)
        : [],
      subtype: coredata.subtype,
    };
  }

  /**
   * Entitlements check — can we download full text?
   */
  async getEntitlement(idType: "doi" | "pii", id: string): Promise<boolean> {
    try {
      const data = await this.request(
        `/content/article/entitlement/${idType}/${encodeURIComponent(id)}`,
        {},
      );
      const entitled =
        data?.["entitlement-response"]?.["document-entitlement"]?.entitled;
      return entitled === true || entitled === "true";
    } catch (e) {
      if (e instanceof ElsevierAPIError && e.status === 404) {
        return false;
      }
      throw e;
    }
  }

  /**
   * Download PDF as binary (Uint8Array). Caller must have entitlement or OA.
   */
  async downloadPDF(idType: IdType, id: string): Promise<Uint8Array> {
    const data = await this.request(
      `/content/article/${idType}/${encodeURIComponent(id)}`,
      { httpAccept: "application/pdf" },
      { responseType: "arraybuffer" },
    );
    // data is an ArrayBuffer when responseType=arraybuffer
    return new Uint8Array(data);
  }

  /**
   * Serial Title API — journal metrics by ISSN.
   */
  async getSerialTitle(issn: string): Promise<SerialData> {
    try {
      const data = await this.request(
        `/content/serial/title/issn/${encodeURIComponent(issn)}`,
        { view: "STANDARD" },
      );
      const entry =
        data?.["serial-metadata-response"]?.entry?.[0] ||
        data?.["serial-metadata-response"]?.entry;
      if (!entry) throw new ElsevierAPIError(404, "Serial not found", false);
      const snapYear =
        entry?.["SNIPList"]?.SNIP?.[0]?.["$"] ||
        entry?.["SNIPList"]?.SNIP?.$;
      const sjrValue =
        entry?.["SJRList"]?.SJR?.[0]?.["$"] || entry?.["SJRList"]?.SJR?.$;
      const citeScore =
        entry?.citeScoreYearInfoList?.citeScoreYearInfo?.[0]?.citeScore ||
        entry?.citeScoreYearInfoList?.citeScoreYearInfo?.citeScore;
      return {
        title: entry["dc:title"],
        issn: entry["prism:issn"],
        eIssn: entry["prism:eIssn"],
        publisher: entry["dc:publisher"],
        citeScore: citeScore ? Number(citeScore) : undefined,
        sjr: sjrValue ? Number(sjrValue) : undefined,
        snip: snapYear ? Number(snapYear) : undefined,
        subjectArea: Array.isArray(entry["subject-area"])
          ? entry["subject-area"].map((s: any) => s.$).join(", ")
          : entry["subject-area"]?.$,
      };
    } catch (e) {
      if (e instanceof ElsevierAPIError && e.status === 404) {
        return {};
      }
      throw e;
    }
  }

  /**
   * Author Search.
   */
  async searchAuthor(query: string): Promise<AuthorData[]> {
    const data = await this.request("/content/search/author", {
      query,
    });
    const entries = data?.["search-results"]?.entry || [];
    return (Array.isArray(entries) ? entries : [entries])
      .filter((e: any) => e && e["dc:identifier"])
      .map((e: any) => ({
        auId: (e["dc:identifier"] || "").replace(/^AUTHOR_ID:/, ""),
        preferredName:
          e["preferred-name"]?.["given-name"]
            ? `${e["preferred-name"]["given-name"]} ${e["preferred-name"]["surname"]}`
            : e["preferred-name"]?.name,
        documentCount: Number(e["document-count"] || 0),
        citedByCount: Number(e["cited-by-count"] || 0),
        hIndex: Number(e["h-index"] || 0),
        affiliationCurrent: e["affiliation-current"]?.affiliation?.["affilname"],
      }));
  }
}

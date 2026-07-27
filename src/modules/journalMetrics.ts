import { config } from "../../package.json";
import { getString, getLocaleID } from "../utils/locale";
import { parseExtraField } from "./importer";

/**
 * Register an InfoRow showing Scopus journal metrics (CiteScore/SJR/SNIP)
 * by looking up the item's ISSN via Serial Title API. Results cached in extra.
 */

export function registerJournalMetricsRow(): void {
  try {
    Zotero.ItemPaneManager.registerInfoRow({
      rowID: "zsearch-journal-metrics",
      pluginID: config.addonID,
      editable: false,
      label: {
        l10nID: getLocaleID("info-row-journal-metrics"),
      },
      position: "end",
      onGetData: ({ item }) => {
        if (!item || item.isAttachment() || item.isNote()) return "";
        // Try cached value in extra first
        const extra = String(item.getField("extra") || "");
        const cached = parseExtraField(extra, "Journal Metrics");
        if (cached) return cached;
        // Async populate (fire and forget) — onGetData must be sync.
        populateJournalMetrics(item).catch((e) =>
          ztoolkit.log("Journal metrics populate failed", e),
        );
        return "";
      },
      onSetData: () => {
        /* read-only */
      },
    });
  } catch (e) {
    ztoolkit.log("registerJournalMetricsRow failed", e);
  }
}

async function populateJournalMetrics(item: Zotero.Item): Promise<void> {
  const issn = String(item.getField("ISSN") || "").trim();
  if (!issn) return;
  // Avoid duplicate work: check cache flag
  const extra = String(item.getField("extra") || "");
  if (extra.includes("Zsearch Journal Metrics:")) return;

  try {
    const data = await addon.api.elsevier.getSerialTitle(issn);
    if (!data || (data.citeScore === undefined && data.sjr === undefined)) return;
    const parts: string[] = [];
    if (data.citeScore !== undefined) parts.push(`CiteScore ${data.citeScore}`);
    if (data.sjr !== undefined) parts.push(`SJR ${data.sjr}`);
    if (data.snip !== undefined) parts.push(`SNIP ${data.snip}`);
    if (data.hIndex !== undefined) parts.push(`H ${data.hIndex}`);
    if (parts.length === 0) return;
    const metricsStr = parts.join(" · ");
    // Append to extra
    const cleaned = extra
      .split("\n")
      .filter((l) => !l.startsWith("Zsearch Journal Metrics:"))
      .join("\n");
    const newExtra = `Zsearch Journal Metrics: ${metricsStr}${
      cleaned ? "\n" + cleaned : ""
    }`;
    item.setField("extra", newExtra);
    await item.saveTx();
  } catch (e) {
    ztoolkit.log("Serial title lookup failed", e);
  }
}

// keep getString used (for future expansion)
void getString;

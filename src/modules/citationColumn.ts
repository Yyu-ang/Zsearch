import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { parseExtraCitedBy } from "./importer";

/**
 * Register a custom "Citations" column in the items tree.
 * Reads cached value from item.extra ("Zsearch Cited by: N").
 */

export async function registerCitationColumn(): Promise<void> {
  await Zotero.ItemTreeManager.registerColumns({
    pluginID: config.addonID,
    dataKey: "zsearch-citations",
    label: getString("col-citations"),
    dataProvider: (item: Zotero.Item, _dataKey: string) => {
      if (item.isAttachment() || item.isNote()) return "";
      if ((item as any).isFeedItem) return "";
      const extra = String(item.getField("extra") || "");
      const n = parseExtraCitedBy(extra);
      return n !== undefined ? String(n) : "";
    },
    renderCell(index, data, column, isFirstColumn, doc) {
      const span = doc.createElement("span");
      span.className = `cell ${column.className}`;
      span.style.color = data ? "#1a73e8" : "#9aa0a6";
      span.style.fontVariantNumeric = "tabular-nums";
      span.textContent = data || "—";
      return span;
    },
    iconPath: "chrome://zotero/skin/16/universal/cite.svg",
  });
}

export async function registerOAColumn(): Promise<void> {
  await Zotero.ItemTreeManager.registerColumns({
    pluginID: config.addonID,
    dataKey: "zsearch-oa",
    label: getString("col-oa"),
    dataProvider: (item: Zotero.Item, _dataKey: string) => {
      if (item.isAttachment() || item.isNote()) return "";
      const extra = String(item.getField("extra") || "");
      return /Zsearch OA: true/i.test(extra) ? "OA" : "";
    },
    renderCell(index, data, column, isFirstColumn, doc) {
      const span = doc.createElement("span");
      span.className = `cell ${column.className}`;
      if (data === "OA") {
        span.style.color = "#137333";
        span.style.background = "#e6f4ea";
        span.style.borderRadius = "4px";
        span.style.padding = "1px 6px";
      }
      span.textContent = data || "";
      return span;
    },
  });
}

import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { ElsevierClient } from "./elsevierClient";
import { parseExtraDOI, parseExtraField, buildExtra } from "./importer";

/**
 * Batch update citation counts for selected items by querying
 * the Abstract Citation API. Throttled by the client's rate limiter.
 */
export async function updateCitationCountsForItems(
  client: ElsevierClient,
  items: Zotero.Item[],
): Promise<{ updated: number; failed: number; skipped: number }> {
  if (!client.hasApiKey()) {
    alert(getString("err-no-apikey"));
    return { updated: 0, failed: 0, skipped: 0 };
  }

  const pw = new ztoolkit.ProgressWindow(config.addonName, {
    closeOnClick: true,
  });
  pw.createLine({
    text: getString("batch-update-citations"),
    type: "default",
    progress: 0,
  }).show();

  let updated = 0;
  let failed = 0;
  let skipped = 0;
  let done = 0;
  const total = items.length;

  for (const item of items) {
    try {
      const doi = parseExtraDOI(item);
      const pii = parseExtraField(String(item.getField("extra") || ""), "PII");
      const eid = parseExtraField(String(item.getField("extra") || ""), "Scopus EID");

      let idType: "doi" | "pii" | "eid" | "scopus_id" | null = null;
      let id = "";
      if (doi) {
        idType = "doi";
        id = doi;
      } else if (pii) {
        idType = "pii";
        id = pii;
      } else if (eid) {
        idType = "eid";
        id = eid;
      }

      if (!idType) {
        // Try lookup by title
        const title = String(item.getField("title") || "").trim();
        if (title) {
          const q = client.buildQuery(title);
          const res = await client.searchScopus({ query: q, count: 1 });
          if (res.entries.length > 0) {
            const e = res.entries[0];
            const citedBy = e.citedByCount;
            if (citedBy !== undefined) {
              const existingExtra = String(item.getField("extra") || "");
              item.setField(
                "extra",
                buildExtra({
                  citedBy,
                  eid: e.eid,
                  pii: e.pii,
                  oa: e.openAccess,
                  existingExtra,
                }),
              );
              if (e.doi && !item.getField("DOI")) item.setField("DOI", e.doi);
              await item.saveTx();
              updated++;
              done++;
              pw.changeLine({
                progress: Math.round((done / total) * 100),
                text: getString("batch-progress", {
                  args: { done: String(done), total: String(total) },
                }),
              });
              continue;
            }
          }
        }
        skipped++;
        done++;
        continue;
      }

      const abstract = await client.getAbstract(idType as any, id);
      const citedBy = abstract.citedByCount;
      if (citedBy === undefined) {
        skipped++;
      } else {
        const existingExtra = String(item.getField("extra") || "");
        item.setField(
          "extra",
          buildExtra({
            citedBy,
            eid: abstract.eid || eid,
            pii: abstract.pii || pii,
            existingExtra,
          }),
        );
        if (abstract.doi && !item.getField("DOI")) item.setField("DOI", abstract.doi);
        if (abstract.description && !item.getField("abstractNote")) {
          item.setField("abstractNote", abstract.description);
        }
        await item.saveTx();
        updated++;
      }
    } catch (e) {
      ztoolkit.log("Citation update failed for item", item.id, e);
      failed++;
    }
    done++;
    pw.changeLine({
      progress: Math.round((done / total) * 100),
      text: getString("batch-progress", {
        args: { done: String(done), total: String(total) },
      }),
    });
  }

  pw.changeLine({
    progress: 100,
    text: `Done: ${updated} updated, ${skipped} skipped, ${failed} failed`,
    type: failed === 0 ? "success" : "default",
  });
  pw.startCloseTimer(5000);

  return { updated, failed, skipped };
}

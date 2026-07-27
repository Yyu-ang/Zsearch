import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { log } from "../utils/logger";

export { registerPreferences };

/**
 * Register the preference pane with Zotero.
 * 仿 zotero-mcp-plus 的 BasicExampleFactory.registerPrefs()。
 */
function registerPreferences(): void {
  try {
    log.prefs.info("registering preference pane...");
    Zotero.PreferencePanes.register({
      pluginID: config.addonID,
      src: rootURI + "content/preferences.xhtml",
      label: getString("prefs-title" as any),
      image: `chrome://${config.addonRef}/content/icons/favicon.png`,
    });
    log.prefs.info("preference pane registered");
  } catch (e) {
    log.prefs.error("preference pane registration failed", e);
  }
}

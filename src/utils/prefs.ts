import { config } from "../../package.json";
import { PrefKey } from "../../typings/prefs";

export { getPref, setPref, clearPref, getPrefGlobalName };

function getPrefGlobalName(key: PrefKey): string {
  return `${config.prefsPrefix}.${String(key)}`;
}

function getPref(key: PrefKey): any {
  return Zotero.Prefs.get(getPrefGlobalName(key), true);
}

function setPref(key: PrefKey, value: any): void {
  Zotero.Prefs.set(getPrefGlobalName(key), value, true);
}

function clearPref(key: PrefKey): void {
  Zotero.Prefs.clear(getPrefGlobalName(key), true);
}

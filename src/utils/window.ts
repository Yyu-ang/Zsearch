import { config } from "../../package.json";

export { openInBrowser, getMainWindow, isWindowAlive };

function openInBrowser(url: string): void {
  const zp = Zotero.getActiveZoteroPane();
  if (zp && zp.loadURI) {
    zp.loadURI(url);
  } else {
    Zotero.launchURL(url);
  }
}

function getMainWindow(): Window {
  return Zotero.getMainWindow();
}

function isWindowAlive(win: Window | undefined): boolean {
  return !!win && !win.closed && !!win.document;
}

export function getChromeURL(path: string): string {
  return `chrome://${config.addonRef}/content/${path}`;
}

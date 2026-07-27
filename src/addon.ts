import { config } from "../package.json";
import { DialogHelper } from "zotero-plugin-toolkit";
import hooks from "./hooks";
import { createZToolkit } from "./utils/ztoolkit";
import { ElsevierClient } from "./modules/elsevierClient";
import { EasyScholarClient } from "./modules/easyScholarClient";
import { initSearchSources } from "./modules/searchSources";

class Addon {
  public data: {
    alive: boolean;
    config: typeof config;
    env: "development" | "production";
    initialized?: boolean;
    ztoolkit: ZToolkit;
    locale?: {
      current: any;
    };
    prefs?: {
      window: Window;
    };
    dialog?: DialogHelper;
    searchWindow?: Window;
  };

  public hooks: typeof hooks;

  public api: {
    elsevier: ElsevierClient;
    easyScholar: EasyScholarClient;
  };

  constructor() {
    this.data = {
      alive: true,
      config,
      env: __env__,
      initialized: false,
      ztoolkit: createZToolkit(),
    };
    this.hooks = hooks;
    const elsevier = new ElsevierClient();
    this.api = {
      elsevier,
      easyScholar: new EasyScholarClient(),
    };
    // 初始化搜索源注册表
    initSearchSources(elsevier);
  }
}

export default Addon;

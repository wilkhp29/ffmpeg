export type GotoAction = {
  action: 'goto';
  url: string;
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit';
};

export type ClickAction = {
  action: 'click';
  selector: string;
  delayMs?: number;
};

export type FillAction = {
  action: 'fill';
  selector: string;
  text: string;
};

export type PressAction = {
  action: 'press';
  selector: string;
  key: string;
};

export type WaitForAction = {
  action: 'waitFor';
  selector?: string;
  state?: 'attached' | 'detached' | 'visible' | 'hidden';
  timeoutMs?: number;
};

export type UploadAction = {
  action: 'upload';
  selector: string;
  path: string;
};

export type UploadFromUrlAction = {
  action: 'uploadFromUrl';
  selector: string;
  url: string;
};

export type ScreenshotAction = {
  action: 'screenshot';
  name: string;
  fullPage?: boolean;
};

export type ExtractTextAction = {
  action: 'extractText';
  selector: string;
  key: string;
};

export type ExtractAttrAction = {
  action: 'extractAttr';
  selector: string;
  attr: string;
  key: string;
};

export type SaveStorageAction = {
  action: 'saveStorage';
  session: string;
};

export type EvaluateAction = {
  action: 'evaluate';
  script: string;
  arg?: any;
  key?: string;
};

export type PlaywrightAction =
  | GotoAction
  | ClickAction
  | FillAction
  | PressAction
  | WaitForAction
  | UploadAction
  | UploadFromUrlAction
  | ScreenshotAction
  | ExtractTextAction
  | ExtractAttrAction
  | SaveStorageAction
  | EvaluateAction;

export type PlaywrightRunRequest = {
  session?: string;
  timeoutMs: number;
  proxy?: {
    server: string;
    username?: string;
    password?: string;
  };
  blockResources?: ('stylesheet' | 'image' | 'font')[];
  userAgent?: string;
  viewport?: {
    width: number;
    height: number;
  };
  actions: PlaywrightAction[];
};

export type PlaywrightRunnerConfig = {
  allowDomains: string[];
  storageDir: string;
  outputDir: string;
  tmpDir: string;
  artifactsRoutePrefix: string;
  defaultTimeoutMs: number;
  maxUploadBytes: number;
  maxUploadDownloadTimeoutMs: number;
};

export type PlaywrightArtifact = {
  name: string;
  filename: string;
  url: string;
};

export type PlaywrightStorageOutput = {
  session: string;
  file: string;
};

export type PlaywrightJobOutputs = {
  artifacts: PlaywrightArtifact[];
  extracted: Record<string, string>;
  storage: PlaywrightStorageOutput[];
};

export type PlaywrightRunResult = {
  ok: true;
  jobId: string;
  tookMs: number;
  outputs: PlaywrightJobOutputs;
  logs: string[];
};

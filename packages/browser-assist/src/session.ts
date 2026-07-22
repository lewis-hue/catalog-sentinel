import { chromium, type Browser, type BrowserContext, type LaunchOptions } from 'playwright';
import { installReadOnlyGuard, type ReadOnlyGuard } from './read-only-guard';

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export interface SessionOptions {
  /** Headless for public reads (Audiomack); headed for attended login (DistroKid). */
  headless?: boolean;
  /** Slow down actions for visibility during attended flows. */
  slowMo?: number;
  userAgent?: string;
  locale?: string;
  /** Override the Chromium binary (e.g. inside a container). */
  executablePath?: string;
  nowIso?: () => string;
}

/**
 * A guarded browser session. Every context created here has the read-only guard
 * installed, so mutation-shaped requests are blocked regardless of caller code.
 */
export class BrowserSession {
  private browser: Browser | null = null;
  context: BrowserContext | null = null;
  guard: ReadOnlyGuard | null = null;

  constructor(private readonly opts: SessionOptions = {}) {}

  async start(): Promise<BrowserContext> {
    const launch: LaunchOptions = {
      headless: this.opts.headless ?? true,
      slowMo: this.opts.slowMo,
      executablePath: this.opts.executablePath,
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
    };
    this.browser = await chromium.launch(launch);
    this.context = await this.browser.newContext({
      userAgent: this.opts.userAgent ?? DEFAULT_UA,
      locale: this.opts.locale ?? 'en-US',
      viewport: { width: 1366, height: 900 },
    });
    this.guard = await installReadOnlyGuard(this.context, { nowIso: this.opts.nowIso });
    return this.context;
  }

  enterExtractionMode(): void {
    this.guard?.enterExtractionMode();
  }

  async close(): Promise<void> {
    // Ephemeral by default: contexts/cookies are discarded on close.
    await this.guard?.dispose().catch(() => undefined);
    await this.context?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
    this.guard = null;
    this.context = null;
    this.browser = null;
  }
}

import { BrowserContext } from 'playwright';
import { Logger } from '@readable-web/observability';
/** Only article images are fetched, through the job's validating browser proxy. */
export declare function embedArticleImages(html: string, baseUrl: string, context: BrowserContext, logger: Logger, admitRequest: () => boolean): Promise<string>;
//# sourceMappingURL=images.d.ts.map
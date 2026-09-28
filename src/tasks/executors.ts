/**
 * 任务执行器注册表：把各工具抽取出的共享执行逻辑挂到 TaskManager。
 *
 * 服务启动时（index.ts）调用一次；执行器与同步回调共用同一函数，
 * 保证 defer 任务完成后的返回内容与同步调用完全一致。
 * web_research 为纯异步工具，只经此处注册（无同步路径）。
 */
import { taskManager } from './manager.js';
import { runSearchAndFetch } from '../tools/search-and-fetch.js';
import type { SearchAndFetchRunInput } from '../tools/search-and-fetch.js';
import { runWebSearchAnswer } from '../tools/web-search-answer.js';
import type { WebSearchAnswerRunInput } from '../tools/web-search-answer.js';
import { runWebFetchAnswer } from '../tools/web-fetch-answer.js';
import type { WebFetchAnswerRunInput } from '../tools/web-fetch-answer.js';
import { runWebFetchRender } from '../tools/web-fetch-render.js';
import type { WebFetchRenderRunInput } from '../tools/web-fetch-render.js';
import { runWebResearch } from '../research/pipeline.js';
import type { WebResearchRunInput } from '../research/pipeline.js';

export function registerTaskExecutors(): void {
  taskManager.register(
    'web_search_and_fetch',
    (params, ctx) => runSearchAndFetch(params as SearchAndFetchRunInput, ctx),
  );
  taskManager.register(
    'web_search_answer',
    (params, ctx) => runWebSearchAnswer(params as WebSearchAnswerRunInput, ctx),
  );
  taskManager.register(
    'web_fetch_answer',
    (params, ctx) => runWebFetchAnswer(params as WebFetchAnswerRunInput, ctx),
  );
  taskManager.register(
    'web_fetch_render',
    (params, ctx) => runWebFetchRender(params as WebFetchRenderRunInput, ctx),
  );
  taskManager.register(
    'web_research',
    (params, ctx) => runWebResearch(params as WebResearchRunInput, ctx),
  );
}

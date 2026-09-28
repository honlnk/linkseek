/**
 * web_research 深度研究流水线（Perplexica 式完整复刻，按 depth 控制深度）。
 *
 * 流程：
 * 1. 预处理（1 次 LLM，温度 0）：独立问题改写 + 生成 1-3 条关键词查询（可建议搜索参数）
 * 2. 多轮循环（fast 1 轮 / standard 3 轮 / deep 5 轮）：
 *    a. 本轮查询并行搜索（复用 searchWithFallback 降级链）
 *    b. LLM 筛选值得抓取的候选（解析失败 → 按排序取前 N）
 *    c. 并行抓取选中页面（复用 WAF 自动降级渲染）
 *    d. 分块蒸馏（standard/deep；fast 直接截断）——要点电报式、保留原始数字
 *    e. LLM 充分性判断（解析失败 → 视为充分）→ 不足则用 followUpQueries 进下一轮
 * 3. 综合回答（1 次 LLM）：输出格式与 web_search_answer 同构（回答 + 来源列表）
 *
 * 全轮皆空 → buildEmptyReport（诊断汇总各轮尝试）。
 * 除综合步骤外，任何 LLM/解析失败都降级继续，不让整个任务 fail。
 * 任务跑在 TaskManager 的 ALS 上下文中，LLM 用量经 accumulateAiUsage 聚合记账。
 */
import { searchWithFallback } from '../search/fallback.js';
import type { SearchDiagnostics, SearchOutcome } from '../search/provider.js';
import { buildEmptyReport } from '../search/empty-hint.js';
import { fetchSourceMarkdown } from '../fetch/fetch-source.js';
import { stripTrailingSourceSection } from '../tools/web-search-answer.js';
import { resolveProvider, toConnectionConfig } from '../llm/provider-store.js';
import type { ProviderConfig } from '../llm/provider-store.js';
import { getAdapter, AiError } from '../llm/index.js';
import type { ProviderAdapter } from '../llm/types.js';
import type { ConnectionConfig, ChatMessage } from '../llm/types.js';
import { accumulateAiUsage } from '../utils/request-context.js';
import { estimateStepCost, round6 } from '../utils/cost.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import type { TaskRunContext, TaskToolResult } from '../tasks/manager.js';

export type ResearchDepth = 'fast' | 'standard' | 'deep';

/** runWebResearch 的输入（工具 schema 的推断类型） */
export interface WebResearchRunInput {
  question: string;
  depth?: ResearchDepth;
  model?: string;
}

interface DepthConfig {
  /** 最大搜索轮数 */
  rounds: number;
  /** 累计抓取来源上限 */
  sources: number;
  /** 是否 LLM 分块蒸馏（fast 直接截断） */
  distill: boolean;
  /** 蒸馏分块大小（字符） */
  chunkChars: number;
  /** 每来源最多蒸馏块数（成本护栏：100KB 长文不会拆出几十次调用） */
  maxChunksPerSource: number;
}

const DEPTH_CONFIG: Record<ResearchDepth, DepthConfig> = {
  fast: { rounds: 1, sources: 3, distill: false, chunkChars: 4000, maxChunksPerSource: 1 },
  standard: { rounds: 3, sources: 5, distill: true, chunkChars: 4000, maxChunksPerSource: 4 },
  deep: { rounds: 5, sources: 8, distill: true, chunkChars: 4000, maxChunksPerSource: 4 },
};

/** 研究来源登记项 */
interface ResearchSource {
  id: number;
  title: string;
  url: string;
  snippet: string;
  /** 抓取的正文（可能为空） */
  content: string;
  /** 蒸馏后的要点（fast 档为截断正文） */
  notes: string;
  fetchOk: boolean;
}

interface PreprocessResult {
  standaloneQuestion: string;
  queries: string[];
  language?: string;
  categories?: string;
  timeRange?: 'day' | 'month' | 'year';
}

/** 从 LLM 输出中宽松解析 JSON 对象（剥代码围栏、截取首尾大括号） */
function parseLooseJson<T>(raw: string): T | null {
  const text = raw.replace(/```(?:json)?/g, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

/** 单次 LLM 调用 + 用量累加（温度由调用方定：结构化步骤 0，综合 0.3） */
async function callLlm(
  adapter: ProviderAdapter,
  conn: ConnectionConfig,
  provider: ProviderConfig,
  messages: ChatMessage[],
  temperature: number,
): Promise<string> {
  const result = await adapter.chatComplete({ messages, conn, temperature, timeout: config.LLM_TIMEOUT });
  accumulateAiUsage({
    providerId: provider.id,
    model: provider.model,
    usage: result.usage,
    cost: round6(estimateStepCost(result.usage, provider.pricing)),
  });
  return result.content;
}

function chunkText(text: string, chunkChars: number, maxChunks: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length && chunks.length < maxChunks; i += chunkChars) {
    chunks.push(text.slice(i, i + chunkChars));
  }
  return chunks;
}

/**
 * 共享执行逻辑：只作为异步任务执行器运行（web_research 是纯异步工具，无同步路径）。
 */
export async function runWebResearch(
  input: WebResearchRunInput,
  ctx: TaskRunContext,
): Promise<TaskToolResult> {
  const { question, depth = 'standard', model } = input;
  const cfg = DEPTH_CONFIG[depth] ?? DEPTH_CONFIG.standard;

  // 0. 解析 Provider（整条流水线共用）
  const provider = await resolveProvider(model);
  if (!provider) {
    const hint = model
      ? `指定的模型「${model}」不存在或已禁用。请调 list_models 查看可用模型，确认正确的名称后重试。`
      : '当前未配置默认 AI 模型。请在后台管理中配置 LLM Provider，或调 list_models 查看可用选项。';
    return { isError: true, content: [{ type: 'text', text: hint }] };
  }
  const conn = toConnectionConfig(provider);
  const adapter = getAdapter(provider.protocol);

  // 1. 预处理：独立问题改写 + 关键词查询（温度 0 防发散）
  ctx.setProgress('预处理研究问题');
  let pre: PreprocessResult = { standaloneQuestion: question, queries: [question] };
  try {
    const raw = await callLlm(
      adapter,
      conn,
      provider,
      [
        {
          role: 'system',
          content:
            '你是搜索研究预处理助手。把用户输入改写为自包含的研究问题，并生成搜索查询。' +
            '只输出 JSON，不要输出其他文字。',
        },
        {
          role: 'user',
          content:
            `用户输入：${question}\n\n` +
            '输出 JSON：{"standaloneQuestion":"补全上下文后的自包含研究问题","queries":["关键词式查询1","查询2"],' +
            '"language":"可选，仅当问题明确限定单一语言时","categories":"可选，general/it/science/news 之一，仅当明确匹配时","timeRange":"可选，day/month/year 之一，仅当问题明确要求时效时"}\n' +
            '要求：\n' +
            '- queries 1-3 条，空格分隔的关键词，不是句子；不要用引号 / OR / AND / site: 等搜索运算符\n' +
            '- 查询先宽后窄：第一条覆盖问题主面，后续条更具体\n' +
            '- 可选字段不需要就不输出或输出 null',
        },
      ],
      0,
    );
    const parsed = parseLooseJson<Partial<PreprocessResult>>(raw);
    if (parsed?.standaloneQuestion || Array.isArray(parsed?.queries)) {
      pre = {
        standaloneQuestion: parsed.standaloneQuestion?.trim() || question,
        queries:
          (parsed.queries ?? [])
            .filter((q): q is string => typeof q === 'string' && q.trim().length > 0)
            .slice(0, 3) || [question],
        language: typeof parsed.language === 'string' && parsed.language ? parsed.language : undefined,
        categories:
          typeof parsed.categories === 'string' && parsed.categories ? parsed.categories : undefined,
        timeRange:
          parsed.timeRange === 'day' || parsed.timeRange === 'month' || parsed.timeRange === 'year'
            ? parsed.timeRange
            : undefined,
      };
      if (pre.queries.length === 0) pre.queries = [question];
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'research 预处理失败，降级用原始问题');
  }

  // 2. 多轮循环
  const sources = new Map<string, ResearchSource>();
  let nextSourceId = 1;
  const allDiagnostics: SearchDiagnostics = { attempts: [], unresponsiveEngines: [] };
  const seenResultUrls = new Set<string>();
  let roundQueries = pre.queries;

  for (let round = 1; round <= cfg.rounds; round++) {
    if (sources.size >= cfg.sources) break;
    ctx.setProgress(`第 ${round}/${cfg.rounds} 轮搜索（${roundQueries.join('；')}）`);

    // a. 并行搜索本轮查询
    const outcomes = await Promise.allSettled(
      roundQueries.slice(0, 3).map((q) =>
        searchWithFallback(q, {
          maxResults: 10,
          language: pre.language,
          categories: pre.categories,
          timeRange: pre.timeRange,
        }),
      ),
    );
    const roundResults = [] as SearchOutcome['results'];
    for (const o of outcomes) {
      if (o.status === 'fulfilled') {
        roundResults.push(...o.value.results);
        allDiagnostics.attempts.push(...o.value.diagnostics.attempts);
        for (const e of o.value.diagnostics.unresponsiveEngines) {
          if (!allDiagnostics.unresponsiveEngines.includes(e)) allDiagnostics.unresponsiveEngines.push(e);
        }
      } else {
        logger.warn({ reason: o.reason instanceof Error ? o.reason.message : String(o.reason) }, 'research 单查询失败');
      }
    }
    // URL 去重（跨轮累计）
    const candidates = roundResults.filter((r) => {
      if (seenResultUrls.has(r.url) || sources.has(r.url)) return false;
      seenResultUrls.add(r.url);
      return true;
    });

    // 本轮抓取预算：累计来源上限 - 已有，单轮最多 3 条（Perplexica 同款）
    const budget = Math.min(3, cfg.sources - sources.size);
    if (candidates.length === 0 || budget <= 0) {
      if (round === cfg.rounds || budget <= 0) break;
      roundQueries = [pre.standaloneQuestion];
      continue;
    }

    // b. LLM 筛选（解析失败 → 按搜索排序取前 N）
    let picked: typeof candidates = candidates.slice(0, budget);
    ctx.setProgress(`第 ${round}/${cfg.rounds} 轮筛选（${candidates.length} 条候选）`);
    try {
      const candList = candidates
        .slice(0, 20)
        .map((r, i) => `${i + 1}. ${r.title} | ${r.snippet} | ${r.url}`)
        .join('\n');
      const raw = await callLlm(
        adapter,
        conn,
        provider,
        [
          {
            role: 'system',
            content: '你是搜索结果筛选助手。只输出 JSON，不要输出其他文字。',
          },
          {
            role: 'user',
            content:
              `研究问题：${pre.standaloneQuestion}\n\n候选结果：\n${candList}\n\n` +
              `选出最值得抓取全文的最多 ${budget} 条：相关性优先，兼顾来源权威性与站点多样性（避免同一站点重复）。\n` +
              `只输出 JSON：{"selected":[编号数组]}`,
          },
        ],
        0,
      );
      const parsed = parseLooseJson<{ selected?: unknown[] }>(raw);
      const idx = (parsed?.selected ?? [])
        .filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= Math.min(candidates.length, 20));
      if (idx.length > 0) {
        picked = [...new Set(idx)].slice(0, budget).map((n) => candidates[n - 1]);
      }
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'research 筛选失败，降级取前 N');
    }

    // c. 并行抓取选中页面
    let fetched = 0;
    ctx.setProgress(`第 ${round}/${cfg.rounds} 轮抓取（0/${picked.length}）`);
    const contents = await Promise.all(
      picked.map(async (r) => {
        const content = await fetchSourceMarkdown(r.url);
        fetched++;
        ctx.setProgress(`第 ${round}/${cfg.rounds} 轮抓取（${fetched}/${picked.length}）`);
        return content;
      }),
    );

    // d. 蒸馏（或 fast 截断）+ 登记来源
    ctx.setProgress(`第 ${round}/${cfg.rounds} 轮蒸馏`);
    for (let i = 0; i < picked.length; i++) {
      const r = picked[i];
      const content = contents[i];
      const fetchOk = content.trim().length > 0;
      let notes = '';
      if (fetchOk && cfg.distill) {
        const chunks = chunkText(content, cfg.chunkChars, cfg.maxChunksPerSource);
        const noteParts = await Promise.all(
          chunks.map(async (chunk, ci) => {
            try {
              return await callLlm(
                adapter,
                conn,
                provider,
                [
                  {
                    role: 'system',
                    content:
                      '你是信息抽取助手。从网页片段中提取与研究问题相关的要点。只输出要点，不要客套。',
                  },
                  {
                    role: 'user',
                    content:
                      `研究问题：${pre.standaloneQuestion}\n\n网页片段（第 ${ci + 1}/${chunks.length} 块）：\n${chunk}\n\n` +
                      '提取要点：\n' +
                      '- 电报式短句，每条一个事实\n' +
                      '- 保留原始数字、日期、版本号、人名、机构名，不要改写或约简数字\n' +
                      '- 与问题无关的内容直接跳过；整块无关就输出「（无相关要点）」',
                  },
                ],
                0,
              );
            } catch (err) {
              logger.warn({ url: r.url, err: err instanceof Error ? err.message : String(err) }, 'research 蒸馏单块失败，保留原文截断');
              return chunk.slice(0, 2000);
            }
          }),
        );
        notes = noteParts.filter((p) => p.trim().length > 0).join('\n');
      } else if (fetchOk) {
        notes = content.slice(0, cfg.chunkChars);
      }
      sources.set(r.url, {
        id: nextSourceId++,
        title: r.title,
        url: r.url,
        snippet: r.snippet,
        content,
        notes,
        fetchOk,
      });
    }

    // e. 充分性判断（最后一轮或预算已满时跳过）
    if (round === cfg.rounds || sources.size >= cfg.sources) break;
    ctx.setProgress(`第 ${round}/${cfg.rounds} 轮充分性评估`);
    const notesDigest = [...sources.values()].map((s) => `### 来源${s.id} ${s.title}\n${s.notes || s.snippet}`).join('\n\n');
    let followUps: string[] = [];
    try {
      const raw = await callLlm(
        adapter,
        conn,
        provider,
        [
          { role: 'system', content: '你是研究充分性评估助手。只输出 JSON，不要输出其他文字。' },
          {
            role: 'user',
            content:
              `研究问题：${pre.standaloneQuestion}\n\n已收集要点：\n${notesDigest}\n\n` +
              '判断现有要点能否支撑一个具体、有依据的回答。\n' +
              '只输出 JSON：{"sufficient":true或false,"followUpQueries":["补充查询1","查询2"]}\n' +
              '不足时 followUpQueries 给 1-3 条关键词查询：先宽后窄或换角度，不要重复已搜过的查询',
          },
        ],
        0,
      );
      const parsed = parseLooseJson<{ sufficient?: boolean; followUpQueries?: unknown[] }>(raw);
      if (parsed?.sufficient === true) break;
      followUps = (parsed?.followUpQueries ?? [])
        .filter((q): q is string => typeof q === 'string' && q.trim().length > 0)
        .slice(0, 3);
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'research 充分性判断失败，视为充分');
      break;
    }
    if (followUps.length === 0) break;
    roundQueries = followUps;
  }

  // 全轮皆空 → 空结果报告（诊断汇总各轮尝试）
  if (sources.size === 0) {
    return { content: [{ type: 'text', text: buildEmptyReport(question, allDiagnostics) }] };
  }

  // 3. 综合回答（输出格式与 web_search_answer 同构）
  ctx.setProgress('综合中');
  const orderedSources = [...sources.values()].sort((a, b) => a.id - b.id);
  const contextParts = orderedSources.map((s) => {
    const head = `## 来源 ${s.id}: ${s.title}\nURL: ${s.url}`;
    if (s.fetchOk && s.notes.trim().length > 0) {
      return `${head}\n\n${s.notes}`;
    }
    return `${head}\n摘要: ${s.snippet}\n（正文获取失败，仅有上述摘要）`;
  });

  try {
    const rawAnswer = await callLlm(
      adapter,
      conn,
      provider,
      [
        {
          role: 'system',
          content:
            '你是一个搜索问答助手。根据以下从网络多轮搜索、蒸馏得到的来源要点，准确回答用户的研究问题。' +
            '回答要综合多个来源的信息，简洁、准确、信息密度高；如要点间有冲突，指出分歧而不是擅自取舍。' +
            '在关键信息后标注来源编号（如 [1] [2]）。如果内容无法回答问题，请明确说明。' +
            '回答使用中文（除非用户用英文提问）。\n\n' +
            '重要：只输出回答正文，不要在回答末尾生成「来源」「参考资料」「Sources」等独立列表，也不要重复列出 URL；' +
            '来源编号对应的完整 URL 列表会由系统统一追加。',
        },
        {
          role: 'user',
          content: `以下是研究「${pre.standaloneQuestion}」收集的来源要点：\n\n${contextParts.join('\n\n---\n\n')}\n\n---\n\n问题：${question}`,
        },
      ],
      0.3,
    );

    logger.info(
      { question, depth, provider: provider.name, sources: orderedSources.length, rounds: cfg.rounds },
      'web_research 完成',
    );

    const cleanedAnswer = stripTrailingSourceSection(rawAnswer);
    const sourceList = orderedSources.map((s) => {
      const mark = s.fetchOk ? '' : '（正文获取失败，仅有摘要）';
      return `[${s.id}] ${s.title} (${s.url})${mark ? ' ' + mark : ''}`;
    });
    const text = `${cleanedAnswer}\n\n---\n**来源：**\n${sourceList.join('\n')}`;
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    const reason = err instanceof AiError
      ? `LLM 调用失败 (${err.status}): ${err.message}`
      : `LLM 调用失败: ${err instanceof Error ? err.message : String(err)}`;
    logger.error({ question, provider: provider.name, err: reason }, 'web_research 综合失败');
    return {
      isError: true,
      content: [
        { type: 'text', text: `${reason}\n\n可调 list_models 查看其他可用模型，或在 model 参数中指定其他 Provider 重试。` },
      ],
    };
  }
}

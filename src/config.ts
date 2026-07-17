import { z } from 'zod';

/**
 * 单个 API Key 的定义（从环境变量反序列化）。
 * 仅 EnvKeyStore 使用；PrismaKeyStore 从数据库读取。
 */
export interface KeyRecord {
  /** Key 的名称，用于日志与统计，如「我的 Claude Code」 */
  name: string;
  /** 明文 Key，仅在启动时用于计算哈希；内存中只保留哈希 */
  key: string;
  /** 是否启用，默认 true */
  enabled?: boolean;
}

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().optional(),
  ADMIN_PASSWORD: z.string().optional(),
  SESSION_SECRET: z.string().optional(),
  API_KEYS: z.string().default('').transform((val, ctx): KeyRecord[] => {
    const trimmed = val.trim();
    if (trimmed.length === 0) return [];
    try {
      const parsed = JSON.parse(trimmed);
      const result = z
        .array(
          z.object({
            name: z.string().min(1),
            key: z.string().min(8),
            enabled: z.boolean().optional().default(true),
          }),
        )
        .safeParse(parsed);
      if (!result.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `API_KEYS 格式错误: ${result.error.message}`,
        });
        return z.NEVER;
      }
      return result.data;
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'API_KEYS 必须是合法的 JSON 数组',
      });
      return z.NEVER;
    }
  }),
  SEARXNG_URL: z.string().url().default('http://localhost:8080'),
  // ---- 浏览器渲染获取（web_fetch_render）----
  // Browserless 容器地址（CDP 端点）；未部署时设 BROWSER_FETCH_ENABLED=false 关闭工具
  BROWSER_FETCH_URL: z.string().default('ws://localhost:3000'),
  // 渲染超时（毫秒）；Browserless 托管实例池，无需再含浏览器冷启动开销
  BROWSER_FETCH_TIMEOUT: z.coerce.number().int().positive().default(30_000),
  // 开关：设 'false' 关闭（不注册 web_fetch_render 工具）；默认启用
  BROWSER_FETCH_ENABLED: z
    .string()
    .optional()
    .transform((v) => v !== 'false'),
  FETCH_TIMEOUT: z.coerce.number().int().positive().default(30_000),
  MAX_RESPONSE_SIZE: z.coerce.number().int().positive().default(5_242_880),
  MAX_REDIRECTS: z.coerce.number().int().positive().default(5),
  SSRF_STRICT: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
    .default('info'),
  LOG_PRETTY: z
    .string()
    .optional()
    .transform((v) => v !== 'false'),
  NODE_ENV: z.string().optional(),
  COOKIE_SECURE: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ 环境变量配置错误：\n' + JSON.stringify(parsed.error.format(), null, 2));
  process.exit(1);
}

export const config = parsed.data;
export type AppConfig = typeof config;

/** 是否为生产环境 */
export const isProduction = config.NODE_ENV === 'production';

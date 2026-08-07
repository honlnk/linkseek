/**
 * 适配器公共工具：错误类、baseUrl 规范化、错误体读取。
 * 各协议适配器复用这些能力。
 */

/** LLM 调用错误（带 HTTP 状态码，便于上层判断） */
export class AiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'AiError';
    this.status = status;
  }
}

/** 规范化 baseUrl：去除尾部斜杠 */
export function trimBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

/**
 * 读取上游错误响应体（容错）。
 * 失败时返回空串，不抛错（让调用方构造错误信息）。
 */
export async function readErrorBody(resp: Response): Promise<string> {
  try {
    return await resp.text();
  } catch {
    return '';
  }
}

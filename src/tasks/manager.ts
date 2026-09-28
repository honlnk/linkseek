/**
 * 异步任务管理器（defer 脱手模式的核心）。
 *
 * 职责：
 * - submit(kind, params, keyId) 入队并立即返回任务 ID（排队不设上限，并发上限只管「开始执行」）
 * - 并发调度：每 Key / 全局上限从 SystemSetting 热读取，改完即时生效
 * - 任务执行包裹在独立的 requestContext（ALS）中运行——抽取出的工具执行逻辑
 *   无需感知同步/异步差异，照常通过 accumulateAiUsage 回写用量；
 *   任务完成时由这里读出聚合用量，写一条 UsageLog（keyId 归提交任务的 Key）
 * - TTL：完成态（done/failed）保留 60 分钟，过期后 get 返回「已过期」；
 *   过期任务 ID 进墓碑集合（有界），用于区分「已过期」与「不存在」
 *
 * 状态机：queued → running → done | failed
 *   - done：执行器正常返回（result 可能带 isError:true，对应同步工具的软失败，格式一致）
 *   - failed：执行器抛错（基础设施级故障）
 */
import { randomBytes } from 'node:crypto';
import { logger } from '../utils/logger.js';
import { recordUsage } from '../utils/usage.js';
import { requestContext } from '../utils/request-context.js';
import type { RequestContext } from '../utils/request-context.js';
import { getTaskConcurrency } from '../lib/settings.js';

/** 任务类型；值同时是 MCP 工具名 */
export type TaskKind =
  | 'web_search_and_fetch'
  | 'web_search_answer'
  | 'web_fetch_answer'
  | 'web_fetch_render'
  | 'web_research';

export type TaskStatus = 'queued' | 'running' | 'done' | 'failed';

/** 工具执行结果（与 MCP CallToolResult 的 text content 部分同构）。
 *  用 type 别名而非 interface：别名有隐式索引签名，可直接作为 registerTool 回调返回值 */
export type TaskToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

/** 执行器运行上下文 */
export interface TaskRunContext {
  /** 更新进度文案（queued/running 态可见；状态流转后忽略） */
  setProgress(text: string): void;
}

/**
 * 任务执行器：各工具从 registerTool 回调中抽取出的共享执行逻辑。
 * 返回值原样存为任务结果，get_result 完成态返回的内容与同步工具一致。
 */
export type TaskExecutor = (params: unknown, ctx: TaskRunContext) => Promise<TaskToolResult>;

export interface TaskSnapshot {
  id: string;
  kind: TaskKind;
  status: TaskStatus;
  /** 进度文案（queued/running 态） */
  progress?: string;
  /** 执行结果（done 态） */
  result?: TaskToolResult;
  /** 失败原因（failed 态） */
  error?: string;
  createdAt: Date;
  startedAt?: Date;
  finishedAt?: Date;
}

interface TaskRecord {
  id: string;
  kind: TaskKind;
  keyId?: string;
  params: unknown;
  status: TaskStatus;
  progress?: string;
  result?: TaskToolResult;
  error?: string;
  createdAt: Date;
  startedAt?: Date;
  finishedAt?: Date;
}

/** get_result 对已过期 / 不存在的返回形态 */
export interface TaskExpired {
  status: 'expired';
}
export interface TaskNotFound {
  status: 'not_found';
}

/** 完成态保留时长（默认 60 分钟） */
const DEFAULT_TTL_MS = 60 * 60 * 1000;
/** 清扫间隔 */
const SWEEP_INTERVAL_MS = 60_000;
/** 过期 ID 墓碑容量（区分「已过期」与「不存在」；FIFO 淘汰） */
const TOMBSTONE_LIMIT = 2000;

export class TaskManager {
  private readonly executors = new Map<TaskKind, TaskExecutor>();
  private readonly tasks = new Map<string, TaskRecord>();
  /** 排队中的任务 ID（FIFO） */
  private queue: string[] = [];
  private runningGlobal = 0;
  private readonly runningByKey = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly expiredIds = new Set<string>();
  private expiredOrder: string[] = [];
  /** 调度合并：await 读配置期间新触发的事件合并到下一轮 */
  private scheduling = false;
  private pendingTrigger = false;
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(ttlMs: number = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  /** 注册执行器（服务启动时各工具模块调用） */
  register(kind: TaskKind, executor: TaskExecutor): void {
    this.executors.set(kind, executor);
  }

  /** 启动定时清扫（幂等；interval unref 不阻止进程退出） */
  start(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweeper.unref();
  }

  /** 入队并调度；立即返回任务 ID */
  async submit(kind: TaskKind, params: unknown, keyId?: string): Promise<string> {
    const executor = this.executors.get(kind);
    if (!executor) {
      throw new Error(`任务类型 ${kind} 未注册执行器`);
    }
    const id = `task_${randomBytes(6).toString('hex')}`;
    const task: TaskRecord = {
      id,
      kind,
      keyId,
      params,
      status: 'queued',
      createdAt: new Date(),
    };
    this.tasks.set(id, task);
    this.queue.push(id);
    logger.info({ taskId: id, kind, keyId }, '任务入队');
    this.triggerSchedule();
    return id;
  }

  /**
   * 查询任务。
   * 返回快照 / { status: 'expired' }（曾存在、已过保留期）/ { status: 'not_found' }。
   */
  get(taskId: string): TaskSnapshot | TaskExpired | TaskNotFound {
    const task = this.tasks.get(taskId);
    if (!task) {
      return this.expiredIds.has(taskId) ? { status: 'expired' } : { status: 'not_found' };
    }
    if (this.isExpirable(task) && Date.now() - task.finishedAt!.getTime() > this.ttlMs) {
      this.expire(task);
      return { status: 'expired' };
    }
    const { params: _params, keyId: _keyId, ...snapshot } = task;
    return snapshot;
  }

  /** 当前运行态统计（日志/调试用） */
  stats(): { queued: number; running: number; globalLimit: number } {
    return { queued: this.queue.length, running: this.runningGlobal, globalLimit: -1 };
  }

  // ---- 调度 ----

  private triggerSchedule(): void {
    this.pendingTrigger = true;
    void this.drainSchedule();
  }

  /**
   * 串行化调度：并发上限每次现读 SystemSetting（改完即时生效），
   * await 期间的新触发事件合并进下一轮循环，避免两个并发调度同时启动任务导致超发。
   */
  private async drainSchedule(): Promise<void> {
    if (this.scheduling) return;
    this.scheduling = true;
    try {
      while (this.pendingTrigger) {
        this.pendingTrigger = false;
        const limits = await getTaskConcurrency();
        this.startEligible(limits);
      }
    } finally {
      this.scheduling = false;
    }
  }

  /** 同步扫描队列，启动所有「Key 有余量 且 全局有余量」的排队任务（跨 Key 不互相阻塞） */
  private startEligible(limits: { perKey: number; global: number }): void {
    const remaining: string[] = [];
    let globalSlots = limits.global - this.runningGlobal;
    for (const id of this.queue) {
      const task = this.tasks.get(id);
      if (!task || task.status !== 'queued') continue; // 已被清理的跳过
      const keyRunning = task.keyId ? (this.runningByKey.get(task.keyId) ?? 0) : 0;
      if (globalSlots > 0 && keyRunning < limits.perKey) {
        this.startTask(task);
        globalSlots--;
      } else {
        remaining.push(id);
      }
    }
    this.queue = remaining;
  }

  private startTask(task: TaskRecord): void {
    const executor = this.executors.get(task.kind)!;
    task.status = 'running';
    task.startedAt = new Date();
    this.runningGlobal++;
    if (task.keyId) {
      this.runningByKey.set(task.keyId, (this.runningByKey.get(task.keyId) ?? 0) + 1);
    }
    logger.info({ taskId: task.id, kind: task.kind }, '任务开始执行');

    // 独立 ALS 上下文：执行器内的 AI 用量回写走与同步路径相同的通道
    const ctxStore: RequestContext = { keyId: task.keyId };
    void requestContext.run(ctxStore, async () => {
      const runCtx: TaskRunContext = {
        setProgress: (text: string) => {
          if (task.status === 'running') task.progress = text;
        },
      };
      try {
        task.result = await executor(task.params, runCtx);
        task.status = 'done';
        logger.info({ taskId: task.id, kind: task.kind }, '任务完成');
      } catch (err) {
        task.status = 'failed';
        task.error = err instanceof Error ? err.message : String(err);
        logger.warn({ taskId: task.id, kind: task.kind, err: task.error }, '任务执行失败');
      } finally {
        task.finishedAt = new Date();
        this.runningGlobal--;
        if (task.keyId) {
          const n = (this.runningByKey.get(task.keyId) ?? 1) - 1;
          if (n > 0) this.runningByKey.set(task.keyId, n);
          else this.runningByKey.delete(task.keyId);
        }
        // 聚合记账：一条 UsageLog，keyId/toolName 归提交任务的 Key 与工具。
        // success 语义与同步路径对齐：done（含 isError 软失败）= true，failed = false
        if (task.keyId) {
          recordUsage(task.keyId, task.kind, task.status === 'done', ctxStore.ai);
        }
        this.triggerSchedule();
      }
    });
  }

  // ---- TTL ----

  private isExpirable(task: TaskRecord): task is TaskRecord & { finishedAt: Date } {
    return (task.status === 'done' || task.status === 'failed') && task.finishedAt instanceof Date;
  }

  private expire(task: TaskRecord): void {
    this.tasks.delete(task.id);
    this.expiredIds.add(task.id);
    this.expiredOrder.push(task.id);
    if (this.expiredOrder.length > TOMBSTONE_LIMIT) {
      const evict = this.expiredOrder.shift()!;
      this.expiredIds.delete(evict);
    }
  }

  private sweep(): void {
    const now = Date.now();
    for (const task of this.tasks.values()) {
      if (this.isExpirable(task) && now - task.finishedAt.getTime() > this.ttlMs) {
        this.expire(task);
      }
    }
  }
}

/** 全局单例（服务进程内共享；测试可自行 new TaskManager(短 TTL)） */
export const taskManager = new TaskManager();

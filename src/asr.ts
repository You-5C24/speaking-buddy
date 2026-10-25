/**
 * 语音 → 文本（faster-whisper，本地）。
 *
 * 关键约束：Python 进程必须常驻。
 * 实测冷启动加载模型 77.3 秒，热加载 0.96–1.36 秒。
 * 每轮 spawn 的话第一轮要等 77 秒。
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'asr.py');
const VENV_PY = join(REPO_ROOT, '.venv', 'bin', 'python');

export type Word = {
  /** 词 */
  w: string;
  /** 起点，秒 */
  start: number;
  /** 终点，秒 */
  end: number;
  /** 置信度 0–1 */
  p: number;
};

export type AsrResult = {
  text: string;
  words: Word[];
  /** 本段音频的推理耗时（毫秒），不含模型加载 */
  asrMs: number;
};

type Pending = {
  resolve: (r: AsrResult) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
};

class WhisperWorker {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private rl: Interface | null = null;
  private queue: Pending[] = [];
  private starting: Promise<void> | null = null;
  /** 模型加载中：第一轮会等很久，调用方据此给用户提示 */
  ready = false;

  private pythonPath(): string {
    if (existsSync(VENV_PY)) return VENV_PY;
    return 'python3';
  }

  /** 启动并等待 READY 行。并发调用共享同一个启动 Promise。 */
  private async ensureStarted(): Promise<void> {
    if (this.ready) return;
    if (this.starting) return this.starting;

    this.starting = new Promise<void>((resolve, reject) => {
      const proc = spawn(this.pythonPath(), ['-I', SCRIPT], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, HF_ENDPOINT: process.env.HF_ENDPOINT ?? 'https://hf-mirror.com' },
      });
      this.proc = proc;

      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        this.cleanup();
        reject(err);
      };

      this.rl = createInterface({ input: proc.stdout });
      this.rl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;

        if (trimmed === 'READY') {
          this.ready = true;
          if (!settled) {
            settled = true;
            resolve();
          }
          return;
        }

        // 每行一个任务的结果
        const pending = this.queue.shift();
        if (!pending) return;
        clearTimeout(pending.timer);

        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch (err) {
          pending.reject(new Error(`ASR 返回非 JSON: ${trimmed.slice(0, 200)}`));
          return;
        }

        if (typeof parsed === 'object' && parsed && 'error' in parsed) {
          pending.reject(new Error(String((parsed as { error: unknown }).error)));
          return;
        }

        pending.resolve(parsed as AsrResult);
      });

      proc.stderr.on('data', (buf: Buffer) => {
        const text = buf.toString().trim();
        if (text) console.error(`[asr] ${text}`);
      });

      proc.on('error', fail);
      proc.on('exit', (code, signal) => {
        const wasReady = this.ready;
        this.cleanup();
        if (!settled) {
          fail(new Error(`ASR 进程退出 code=${code} signal=${signal}`));
          return;
        }
        if (wasReady) {
          console.error(`[asr] 进程意外退出 code=${code}，下一个请求会重启`);
        }
        // 把排队中的请求全部拒绝，让调用方决定兜底
        for (const p of this.queue.splice(0)) {
          clearTimeout(p.timer);
          p.reject(new Error('ASR 进程已退出'));
        }
      });
    });

    return this.starting;
  }

  private cleanup(): void {
    this.ready = false;
    this.starting = null;
    this.rl?.close();
    this.rl = null;
    this.proc = null;
  }

  async transcribe(wavPath: string, timeoutMs = 30_000): Promise<AsrResult> {
    await this.ensureStarted();
    if (!this.proc) throw new Error('ASR 进程不可用');

    return new Promise<AsrResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        // 超时就把整个进程杀掉，避免后续结果错位（队列是一对一配对的）
        reject(new Error(`ASR 超时 ${timeoutMs}ms`));
        this.proc?.kill('SIGKILL');
      }, timeoutMs);

      this.queue.push({ resolve, reject, timer });
      this.proc!.stdin.write(JSON.stringify({ wav: wavPath }) + '\n');
    });
  }

  /** 预热：应用启动时调用，把 77 秒的加载挪到用户发第一条语音之前 */
  async warmUp(): Promise<void> {
    await this.ensureStarted();
  }

  shutdown(): void {
    this.proc?.kill('SIGTERM');
    this.cleanup();
  }
}

export const asr = new WhisperWorker();

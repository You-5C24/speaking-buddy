/**
 * MiniMax t2a_v2 → opus，并读出真实时长（飞书发语音必须带 duration，单位毫秒）。
 *
 * Edge TTS（msedge-tts）在 2026-10-25 本机已不可用：
 * wss://api.msedgeservices.com 回空 HTTP 200，speech.platform.bing.com 被重置。
 * 短句走 speech-2.8-hd，音色默认 English_Gentle-voiced_man，语速 1.0。
 * libopus 内部固定 48kHz，-ar 16000 会被静默忽略（不影响播放）。
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import ffprobeStatic from 'ffprobe-static';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');

/**
 * 只有 ffmpeg 走 vendor/：`ffmpeg-static` 的 postinstall 要从 GitHub 下二进制，
 * 本机装不上。ffprobe 不在这里——`ffprobe-static` 是普通 npm 包，
 * 二进制直接发在 registry 上，能正常装，而且带 arm64 原生版本。
 */
function ffmpegPath(): string {
  const vendored = join(REPO_ROOT, 'vendor', 'ffmpeg');
  if (existsSync(vendored)) return vendored;
  throw new Error('找不到 ffmpeg：请把二进制放到 vendor/ffmpeg');
}

/** ffprobe-static 自带二进制（darwin/arm64 原生），不需要 vendor/ 里那份 */
function ffprobePath(): string {
  return ffprobeStatic.path;
}

function run(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (b: Buffer) => (stdout += b.toString()));
    p.stderr.on('data', (b: Buffer) => (stderr += b.toString()));
    p.on('error', reject);
    p.on('close', (code) =>
      code === 0
        ? resolve({ stdout, stderr })
        : reject(new Error(`${cmd} exit ${code}: ${stderr.slice(0, 300)}`))
    );
  });
}

export type SpeakResult = {
  /** opus 文件路径（调用方负责清理所在临时目录） */
  path: string;
  /** 毫秒，用于飞书 files 上传和 message 发送 */
  durationMs: number;
  bytes: number;
  /** 临时目录，用完要 rm */
  dir: string;
};

export type SpeakOptions = {
  voice?: string;
  /** 相对语速，如 '-10%'。会换成 MiniMax 的 speed 倍数。 */
  rate?: string;
};

const DEFAULT_VOICE = 'English_Gentle-voiced_man';

/** 场景里沿用的 "-10%"，MiniMax 要的是 0.9 这种倍数。 */
function speedFromRate(rate?: string): number {
  if (!rate) return 1;
  const matched = /^([+-]?\d+(?:\.\d+)?)%$/.exec(rate.trim());
  if (!matched) return 1;
  const speed = 1 + Number(matched[1]) / 100;
  if (!Number.isFinite(speed)) return 1;
  return Math.min(2, Math.max(0.5, Math.round(speed * 100) / 100));
}

function resolveVoice(voice?: string): string {
  if (voice && !/Neural$/i.test(voice)) return voice;
  return process.env.MINIMAX_VOICE || DEFAULT_VOICE;
}

type MiniMaxTtsResponse = {
  data?: { audio?: string | null };
  extra_info?: { audio_length?: number };
  base_resp?: { status_code?: number; status_msg?: string };
};

async function minimaxMp3(text: string, opts: SpeakOptions): Promise<Buffer> {
  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey) throw new Error('缺少环境变量 MINIMAX_API_KEY');

  const base = (process.env.MINIMAX_TTS_BASE_URL ?? 'https://api.minimax.cn').replace(/\/$/, '');
  const res = await fetch(`${base}/v1/t2a_v2`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.MINIMAX_TTS_MODEL ?? 'speech-2.8-hd',
      text,
      stream: false,
      output_format: 'hex',
      voice_setting: {
        voice_id: resolveVoice(opts.voice),
        speed: speedFromRate(opts.rate),
        vol: 1,
        pitch: 0,
      },
      audio_setting: {
        sample_rate: 32000,
        bitrate: 128000,
        format: 'mp3',
        channel: 1,
      },
    }),
  });

  const json = (await res.json().catch(() => ({}))) as MiniMaxTtsResponse;
  const status = json.base_resp?.status_code;
  if (!res.ok || status !== 0) {
    const msg = json.base_resp?.status_msg || `HTTP ${res.status}`;
    throw new Error(`MiniMax TTS 失败：${msg}`);
  }

  const hex = json.data?.audio ?? '';
  if (!hex) throw new Error('MiniMax TTS 返回空音频');
  return Buffer.from(hex, 'hex');
}

export async function speak(
  text: string,
  opts: SpeakOptions = {}
): Promise<SpeakResult> {
  const dir = await mkdtemp(join(tmpdir(), 'sb-tts-'));

  try {
    const mp3 = await minimaxMp3(text, opts);

    const mp3Path = join(dir, 'reply.mp3');
    await writeFile(mp3Path, mp3);

    const opusPath = join(dir, 'reply.opus');
    await run(ffmpegPath(), [
      '-y',
      '-loglevel', 'error',
      '-i', mp3Path,
      '-c:a', 'libopus',
      '-b:a', '24k',
      '-ac', '1',
      opusPath,
    ]);

    const durationMs = await readDurationMs(opusPath);
    const opus = await readFile(opusPath);

    return { path: opusPath, durationMs, bytes: opus.length, dir };
  } catch (err) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

/** 读真实时长。ffprobe 不可用时退回 ffmpeg -i 的 Duration 行。 */
export async function readDurationMs(opusPath: string): Promise<number> {
  try {
    const { stdout } = await run(ffprobePath(), [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'csv=p=0',
      opusPath,
    ]);
    const secs = Number.parseFloat(stdout.trim());
    if (Number.isFinite(secs) && secs > 0) return Math.round(secs * 1000);
  } catch {
    // 继续走退路
  }

  const { stderr } = await run(ffmpegPath(), ['-i', opusPath]).catch(
    (err: Error) => ({ stdout: '', stderr: err.message })
  );
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  if (!m) throw new Error('读不到音频时长');
  const [, h, mm, ss] = m;
  const secs = Number(h) * 3600 + Number(mm) * 60 + Number(ss);
  return Math.round(secs * 1000);
}

/** 入链路：飞书给的 opus → 16k 单声道 wav，给 whisper */
export async function toWav16k(opusPath: string, outPath: string): Promise<void> {
  await run(ffmpegPath(), [
    '-y',
    '-loglevel', 'error',
    '-i', opusPath,
    '-ar', '16000',
    '-ac', '1',
    '-c:a', 'pcm_s16le',
    outPath,
  ]);
}

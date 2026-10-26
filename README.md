# speaking-buddy

飞书里的英语口语陪练。语音进，语音出，每次练习结束给一张逐句复盘卡片。

**当前阶段：MVP 已跑通（2026-10-25）。v1.1 单聊和群话题收发已接线，真机还没验——见 [TODO](TODO.md)。**

---

## 先看这一页

| 你想知道 | 看 |
|---|---|
| **现在做到哪、下一步干什么** | [TODO](TODO.md) ← 每次开工先看这个 |
| **v1.1 要做什么、怎么改** | [06-v1.1-开发方案](docs/06-v1.1-开发方案.md) ← 从头读 |
| 用什么工具、为什么选它、怎么装 | [01-技术选型](docs/01-技术选型.md) |
| 飞书怎么接、权限怎么配 | [02-飞书接入](docs/02-飞书接入.md) |
| 指标怎么算、复盘怎么组织 | [03-指标与复盘](docs/03-指标与复盘.md) |
| 教学法为什么这么做 | [04-教学法](docs/04-教学法.md) |

**已归档**（`docs/archive/`，不作为实施依据，冲突时以 06 为准）：

| 文件 | 是什么 | 现状 |
|---|---|---|
| [00-MVP-已完成](docs/archive/00-MVP-已完成.md) | 第一版实施方案 | 验收已达成 |
| [05-验证清单-v1](docs/archive/05-验证清单-v1.md) | v1 阻塞项 | 已重写进 06 §十 |
| [01-产品与教学法](docs/archive/01-产品与教学法.md) | v2 时代的产品设计 | 被 04 + 06 取代 |
| [02-飞书流转](docs/archive/02-飞书流转.md) | v2 时代的完整生命周期 | 被 02 + 06 §二 取代 |
| [03-会话状态机](docs/archive/03-会话状态机.md) | v2 的状态机 | 明确不做，用 meta 五个字段代替 |
| [04-数据与落盘](docs/archive/04-数据与落盘.md) | v2 的目录与 JSON | 被 06 §八 取代 |
| [05-待验证问题](docs/archive/05-待验证问题.md) | 上线前要测的 5 件事 | 已逐条验证完 |
| [06-验证结果](docs/archive/06-验证结果.md) | ASR 会不会自动纠错的实验记录 | 结论已写进 01 §三 |
| [README-v1](docs/archive/README-v1.md) | v1 时代的 README | 被当前 README 取代 |

**判断大部分是对的，只是不是现在的清单。** 01 / 02 / 03 是 v2 规格，读了会以为要做 8 个场景 + 状态机；
06-验证结果 那篇的实验方法和结论仍然值得看（它证明了 ASR 不会自动纠错）。

---

## 一句话定位

> 这不是一个「会说英语的聊天对象」，是一个**有目标、有推进、有复盘**的练习系统。

---

## 这个 MVP 要验证什么

只有一个问题：

> **你会不会想练第 4 次。**

技术跑通不代表产品成立。如果练完 3 次不想再练，说明教学法假设有问题，代码写得再好也没用。

所以 MVP 砍到只剩：一条语音进、一条语音出、一张复盘卡片。

---

## 快速开始

```bash
# 1. Node 依赖
pnpm add @larksuiteoapi/node-sdk ffprobe-static zod dotenv

# ffmpeg 用 vendor/ 里的二进制：ffmpeg-static 的 postinstall 要访问 GitHub，本机装不上。
#   vendor/ffmpeg
# ffprobe 不用放：ffprobe-static 是普通 npm 包，装得上，且自带 arm64 原生二进制。

# 2. Python ASR（注意锁 av 版本，否则装不上）
python3 -m venv .venv
.venv/bin/pip install --prefer-binary \
  -i https://mirrors.aliyun.com/pypi/simple/ \
  --trusted-host mirrors.aliyun.com \
  "av==15.1.0" faster-whisper

# 3. 环境变量：照 .env.example 填
```

---

## 工具一览（全部本机实测）

| 环节 | 用什么 |
|---|---|
| 语音 → 文本 | faster-whisper `small.en`（本地，带词级时间戳） |
| 文本 → 语音 | MiniMax `speech-2.8-hd` / `English_Gentle-voiced_man` |
| 转码 / 时长 | `vendor/ffmpeg`（只这一个）+ `ffprobe-static` |
| 对话模型 | Moonshot `kimi-k2.6`（`thinking` 关掉） |
| 飞书接入 | `@larksuiteoapi/node-sdk` WS 长连接 |

**三个反直觉的事实，写在选型文档里，先知道能省一天：**

1. 开着思考的 Kimi（`kimi-k3`，以及没关思考的 `k2.6`）一次回复要十几秒。在线对话用 `kimi-k2.6` 且 `thinking.type=disabled`。`kimi-k2.7-code-highspeed` 关不掉思考，prompt 一长就会到 5–10 秒。
2. `av` 必须锁 `15.1.0`，否则本机（macOS 13）装不上 faster-whisper。
3. `-ar 16000` 对 opus 无效；读时长用 `ffprobe-static`，读不到才退回 `ffmpeg -i` 解析 `Duration:` 行。

---

## 结构

```
speaking-buddy/
├── config/scenarios/         # 场景 v2：index.json、cafe-1、free-1
├── data/sessions/            # 一次练习一个目录，原始音频保留
├── scripts/asr.py            # 唯一的 Python，常驻进程
├── vendor/                   # ffmpeg / ffprobe 二进制
├── src/
│   ├── index.ts              # WS 接入、去重、串行
│   ├── lark.ts               # 飞书收发（v1.1 加群/话题支持）
│   ├── pipeline.ts           # 一轮的编排
│   ├── asr.ts                # 常驻 asr.py worker
│   ├── tts.ts                # MiniMax → opus
│   ├── llm.ts                # Moonshot + zod
│   └── review.ts             # 复盘卡片
└── docs/
```

现状与 v1.1 的目标结构差异见 [06-v1.1-开发方案 §九](docs/06-v1.1-开发方案.md)。

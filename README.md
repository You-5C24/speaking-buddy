# speaking-buddy

飞书里的英语口语陪练。语音进，语音出，每次练习结束给一张逐句复盘卡片。

**当前阶段：MVP 已跑通，判分改成 `/end` 冷读重做完了（2026-10-26）。等真机跑几天攒数据——见 [TODO](TODO.md)。**

---

## 先看这一页

| 你想知道 | 看 |
|---|---|
| **现在做到哪、这几天要观察什么** | [05-当前状态与下一步](docs/05-当前状态与下一步.md) ← 每次开工先看这个 |
| 指标怎么算、判分怎么做、复盘怎么组织 | [03-指标与复盘](docs/03-指标与复盘.md) |
| 用什么工具、为什么选它、怎么装 | [01-技术选型](docs/01-技术选型.md) |
| 飞书怎么接、权限怎么配 | [02-飞书接入](docs/02-飞书接入.md) |
| 教学法为什么这么做 | [04-教学法](docs/04-教学法.md) |

**已归档**（`docs/archive/`，不作为实施依据）：

| 文件 | 是什么 | 为什么归档 |
|---|---|---|
| [06-v1.1-开发方案](docs/archive/06-v1.1-开发方案.md) | v1.1 的完整方案（1421 行） | §〇 进度表、§五 flags/rewrite、§六 卡片模板都已作废。**§一（问题证据）、§二（话题模型）、§四（场景配置 v2）、§4.5（场景生成）仍然有效** |
| [07-指标与复盘-v1](docs/archive/07-指标与复盘-v1.md) | 上一版指标与卡片 | 判分结构改了，`postmortem.json` 字段和卡片模板都和代码对不上；现行版本是 [03](docs/03-指标与复盘.md) |
| [00-MVP-已完成](docs/archive/00-MVP-已完成.md) | 第一版实施方案 | 验收已达成，里程碑记录 |
| [05-验证清单-v1](docs/archive/05-验证清单-v1.md) | v1 阻塞项 | 已重写进 06 §十 |
| [01-产品与教学法](docs/archive/01-产品与教学法.md) | v2 时代的产品设计 | 被 04 取代 |
| [02-飞书流转](docs/archive/02-飞书流转.md) | v2 时代的完整生命周期 | 被 02 + 06 §二 取代 |
| [03-会话状态机](docs/archive/03-会话状态机.md) | v2 的状态机 | 明确不做，用 meta 五个字段代替 |
| [04-数据与落盘](docs/archive/04-数据与落盘.md) | v2 的目录与 JSON | 被 06 §八 取代 |
| [05-待验证问题](docs/archive/05-待验证问题.md) | 上线前要测的 5 件事 | 已逐条验证完 |
| [06-验证结果](docs/archive/06-验证结果.md) | ASR 会不会自动纠错的实验记录 | 结论已写进 01 §三 |
| [README-v1](docs/archive/README-v1.md) | v1 时代的 README | 被当前 README 取代 |

**归档不等于没用。** 06-验证结果 的实验方法仍然值得看（它证明了 ASR 不会自动纠错）；
01 / 02 / 03 是 v2 规格，读了会以为要做 8 个场景 + 状态机，别照着做。

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

# ffmpeg：装系统版本就行（brew install ffmpeg）。
#   不装 ffmpeg-static，它的 postinstall 要访问 GitHub，本机装不上。
#   vendor/ffmpeg 是可选的：想锁死版本时放一份过去，代码会优先用它。
# ffprobe：不用单独装，ffprobe-static 自带 arm64 原生二进制。

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
├── vendor/                   # 可选：锁死版本的 ffmpeg（不进 git）
├── src/
│   ├── index.ts              # WS 接入、去重、串行
│   ├── lark.ts               # 飞书收发（v1.1 加群/话题支持）
│   ├── pipeline.ts           # 一轮的编排
│   ├── asr.ts                # 常驻 asr.py worker
│   ├── tts.ts                # MiniMax → opus
│   ├── grading.ts            # 逐句评分（/end 时跑，不带角色）
│   ├── llm.ts                # 对话轮：只出 say
│   └── review.ts             # 复盘数据 + 卡片文案
└── docs/
```

判分和复盘为什么这么拆，见 [03-指标与复盘 §一–§三](docs/03-指标与复盘.md)。

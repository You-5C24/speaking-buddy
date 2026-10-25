# 00 · MVP 实施方案

**目标**：用 5 天跑通「语音进 → 语音出 → 一张复盘卡片」，然后**用 3 次真实练习回答一个问题：你会不会想练第 4 次。**

这是唯一要验证的事。其余设计（8 个场景、状态机、飞书文档、复习队列）全部推迟到验证之后再谈，原文见 [`archive/`](.)。

---

## 一、MVP 边界

### 做

| 项 | 具体 |
|---|---|
| 输入 | 飞书单聊里发一条语音 |
| 输出 | bot 回一条语音（1–3 句，≤30 词），**对话中不发文字** |
| 上下文 | 内存里的轮次数组，进程重启就丢（可接受） |
| 结束 | 用户发 `/end`，或 10 轮自动收尾 |
| 复盘 | **一张卡片**，列出 3 句「你说 / 表达 / 更自然」 |
| 落盘 | 每轮 `user.opus` + `asr.json` + `llm.json`，以及 `postmortem.json` |
| 指标 | 只算 3 个：`wpm`、`longPausePerMin`、`fillerPer100w` |

### 不做（明确砍掉，附理由）

| 砍掉 | 理由 |
|---|---|
| 飞书文档 | 要额外 2 个权限 + 一个未验证的音频嵌入问题。卡片够用 |
| 场景选择 / 8 个场景 | 前 3 次练习只会用 1 个场景。固定一个写死 |
| 状态机持久化 / 断点续传 / 幂等键 | 单进程单用户，崩了重发一句就行 |
| 复习队列 / 用户档案 / SRS | 12 次会话之前没有队列可言 |
| 跟读关卡 / 发音评分 | 第二周的事，且依赖第一周的数据 |
| 多维表格 | JSON 够 |
| 错误率指标 | **定义不可靠，见 [03-指标与复盘](../03-指标与复盘.md)** |
| 卡片按钮 / 卡片回调 | 第一版卡片只展示，不交互 |

> **一条原则**：任何「用户看不到、也不影响这次练习体验」的东西，一律不做。

---

## 二、技术栈（全部已验证，见 [01-技术选型](../01-技术选型.md)）

| 环节 | 用什么 | 状态 |
|---|---|---|
| 飞书接入 | `@larksuiteoapi/node-sdk` + WS 长连接 | ✅ 照抄 `agent-os/src/im/lark.ts:407` |
| 语音 → 文本 | **faster-whisper**（Python，本地） | ⚠️ 装法有坑，见下 |
| 文本 → 语音 | **MiniMax `t2a_v2`**（`speech-2.8-hd`，音色 `English_Gentle-voiced_man`） | ✅ Edge TTS 于 2026-10-25 握手失败后改用 MiniMax。语速 1.0 |
| 转码 / 读时长 | **ffmpeg-static** + **ffprobe-static**（npm） | ✅ 实测可用 |
| 对话模型 | **kimi-k2.7-code-highspeed** | ✅ 0.86–1.69s |
| 结构化校验 | **zod** | 必需，见下 |
| 运行时 | Node 24 + tsx watch | ✅ 已装 |
| 存储 | 目录 + JSON | — |

### ASR 的安装（唯一的坑）

**不要用 `brew install whisper.cpp`** —— 本机拉不到 GitHub raw，会失败。
**不要用 `@huggingface/transformers`** —— 依赖 `onnxruntime-node`，要求 macOS 14，本机是 13.5.1，`dlopen` 直接失败。

用 Python + faster-whisper，但**必须锁 `av==15.1.0`**：

```bash
# 本机 python3 的 CA 证书有问题，pip 要走镜像
python3 -m venv .venv
.venv/bin/pip install --prefer-binary \
  -i https://mirrors.aliyun.com/pypi/simple/ \
  --trusted-host mirrors.aliyun.com \
  "av==15.1.0" faster-whisper
```

原因：`av` 从 16.x 起只发 `macosx_14_0` 的 wheel，本机装不了会自动去编译源码，然后卡在 `pkg-config is required for building PyAV`。`15.1.0` 有 `macosx_13_0_arm64` 的预编译包。

模型用 `small.en`，首次运行自动从 hf-mirror 下载（约 480MB）：

```bash
export HF_ENDPOINT=https://hf-mirror.com
```

> **为什么不用云端 ASR**：SiliconFlow 余额为 0；且 06 已验证它返回不了词级时间戳，而停顿和卡壳点两个核心指标全靠时间戳。

---

## 三、代码结构

只有 6 个文件。任何超出这个结构的想法，先问「这次练习需要吗」。

```
speaking-buddy/
├── config/
│   └── scenario.json          # 写死一个场景
├── data/
│   └── sessions/<session_id>/
│       ├── meta.json
│       ├── turns/001/{user.opus, asr.json, llm.json, reply.opus}
│       └── postmortem.json
├── scripts/
│   └── asr.py                 # 唯一的 Python：调 faster-whisper，stdin/stdout JSON
└── src/
    ├── index.ts               # WS 接入、去重、按 chat_id 串行
    ├── pipeline.ts            # 一轮的编排
    ├── asr.ts                 # spawn scripts/asr.py
    ├── tts.ts                 # MiniMax → opus → ffprobe 读时长
    ├── llm.ts                 # Moonshot + zod 校验 + 重试
    └── review.ts              # 拼复盘卡片
```

### `scripts/asr.py` 的契约

Node 只看 JSON，不关心 Python 内部。用 `-I` 启动，避免工作目录下的同名模块污染。

```python
# 输入: argv[1] = wav 路径
# 输出: stdout 一行 JSON
from faster_whisper import WhisperModel
import json, sys

model = WhisperModel("small.en", device="cpu", compute_type="int8")
segments, info = model.transcribe(sys.argv[1], language="en", word_timestamps=True)

words = []
for seg in segments:
    for w in seg.words:
        words.append({
            "w": w.word.strip(),
            "start": round(w.start, 3),
            "end": round(w.end, 3),
            "p": round(w.probability, 3),
        })

text = " ".join(x["w"] for x in words)
print(json.dumps({"text": text, "words": words}, ensure_ascii=False))
```

**Python 进程必须常驻，不能每轮 spawn。** 实测：冷启动加载模型 **77.3 秒**，热加载 0.96–1.36 秒。每轮 spawn 的话第一轮要等 77 秒。

做法：启动时一个常驻 worker，逐行从 stdin 读任务、往 stdout 写一行 JSON。

```
# Node 侧
worker.stdin.write(JSON.stringify({ wav: "/path/turn.wav" }) + "\n");
const line = await nextLine(worker.stdout);   // 一行 = 一轮结果
```

进程挂了要能自动重启，并记住「模型正在加载中」这个状态，期间给用户一句「稍等」。

### 实测基线（M1 Pro / small.en / int8）

| 项 | 值 |
|---|---|
| 模型加载（冷） | 77.3s |
| 模型加载（热） | 0.96–1.36s |
| 转录 1.4s 音频 | 1.36s |
| 词级时间戳 | ✅ `start` / `end` / `probability` 都有 |
| 自动纠错 | ❌ 无（`I very like` 原样返回） |

---

## 四、单轮时序

```
用户语音
  │
  ├─ ① 事件去重（event_id）+ 加 👀 reaction + 入队     < 100ms
  ├─ ② 下载 opus → ffmpeg 转 16k wav                   ~300ms
  ├─ ③ faster-whisper（small.en, 词级时间戳）          1–2s
  ├─ ④ 算 3 个指标（纯本地，<10ms）
  ├─ ⑤ Moonshot 出 {say, flags}                       0.9–1.7s
  ├─ ⑥ MiniMax TTS → mp3                              ~0.9s
  ├─ ⑦ ffmpeg → opus + 读时长                          ~100ms
  └─ ⑧ 上传 files → 发 audio 消息                      ~300ms
```

**p50 目标 ≤ 5s。** 超过 8 秒就该先砍回复长度，而不是换引擎。

### 三个实现细节，写错会浪费一天

1. **`-ar 16000` 对 opus 无效。** libopus 内部固定 48kHz，ffmpeg 会静默忽略 16k。发出去的 opus 就是 48k，不用纠结；但**入链路给 ASR 的 wav 必须是 16k**。
2. **不需要 ffprobe 也能读时长**：`ffmpeg -i x.opus 2>&1 | grep Duration`。但装 `ffprobe-static` 更省事，输出可直接解析。二进制缺失时再退到这个办法。
3. **`duration` 必须按毫秒整数填**，读写真实时长，不要用字符数估算。

---

## 五、LLM 的输出契约

用 Moonshot 的 `response_format: {"type": "json_object"}`，再用 zod 校验。**校验失败重试一次，仍失败就用固定话术兜底**，不要让这一轮卡死。

```ts
const Reply = z.object({
  say: z.string().max(200),
  flags: z.array(z.object({
    said: z.string(),
    better: z.string(),
    type: z.enum(['grammar', 'collocation', 'vocab', 'fluency']),
    severity: z.number().int().min(1).max(3),
    at: z.string().optional(),   // 原句里的片段，用于回溯
  })).max(5),
});
```

### System prompt（直接抄）

```
You are an English speaking partner playing: a barista at a coffee shop.

Rules:
- Reply with 1-3 sentences, under 30 words. Never write more.
- ALWAYS make one move that pushes the conversation forward: ask, or add new information.
- Do NOT summarize what the user said.
- If the user makes an error that hurts understanding, work the correct form
  naturally into your reply. Never point out the error.
- Never say "Great!" "Excellent!" or similar empty praise.
- No text formatting, no lists, no emoji.

Return ONLY this JSON:
{"say": "...", "flags": [{"said": "...", "better": "...", "type": "grammar|collocation|vocab|fluency", "severity": 1}]}

flags = errors you noticed this turn. Empty array if none. severity 1 = doesn't affect meaning,
2 = slightly, 3 = affects understanding. Keep flags to what actually matters.
```

**为什么 flags 单独存而不靠事后重算**：事后重算需要重放全部上下文，贵且结果会漂移。当时记下来最准。

---

## 六、复盘卡片

结束时发**一张**卡片。不超过一屏。

```
🎯 点单 · 8 轮 · 语速 112 wpm

最该改的一点
  你说：I very like this coffee
  改：  I really like this coffee
  为什么：very 不能直接修饰动词，用 really

━━━━━━━━━━━━━━━━━━━━━

第 2 轮
  你说：I want one latte with... um... oat milk
  发音：latte 重音在前，你读成了 la-TTE
  更自然：Could I get an oat milk latte, please?

第 5 轮
  你说：I very like this coffee
  表达：very → really（搭配问题，不是语法）
  更自然：I'm really into this coffee.

━━━━━━━━━━━━━━━━━━━━━

今天卡住 2 次 · 长停顿 5 次
[ 原始音频在 data/sessions/<id>/turns/ ]
```

**只挑 3 句。** 9 轮全列出来没人看。挑法：`severity >= 2` 优先，不够就补最早的两轮。

### 卡壳点怎么来（MVP 的简化版）

原文设计里卡壳点要识别「说不出来」，MVP 只做两个廉价信号，**从词级时间戳直接算**：

| 信号 | 判定 | 含义 |
|---|---|---|
| 长停顿 | 相邻词间隔 > 1.5s | 检索卡了 |
| 轮首长静音 | 音频开头到首词 > 2s | 想不起来怎么开头 |

`self_repair` / `topic_switch` 需要 LLM 参与，第一版不做。

---

## 七、五天的切分

| 天 | 交付 | 验收 |
|---|---|---|
| **D0** | 装依赖。ASR 跑通一条样例音频，拿到 `words[]` | `asr.py` 吐出带 start/end 的 JSON |
| **D1** | TTS 出 opus，**在手机上**收到能播、时长正确的语音 | 05 文档第 1 条，桌面端不算 |
| **D2** | ASR + LLM + TTS 串成一条无状态管线 | 发语音 → 收语音，5 秒内 |
| **D3** | 加轮次上下文、flags 落盘、`/end` | 连对 5 轮不串台 |
| **D4** | 复盘卡片 + 3 个指标 | 卡片一屏看完，数字对得上 |
| **D5** | **自己练 3 次** | 想不想练第 4 次 |

D5 之后再看：加第二个场景？加跟读？还是推翻重来。

---

## 八、验收标准

D2 那天的标准就是整套系统的验收：

> 我在飞书里发一条语音「I very like this coffee」，
> 5 秒内收到一条语音，里面自然地用了 `really like`，
> 且 `turns/001/llm.json` 里记下了这条 flag。

D5 的标准只有一个：

> 我想不想明天再练一次。

第二个标准答「不想」，说明教学法假设有问题，代码再好也没用。

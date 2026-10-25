"""常驻 ASR worker：stdin 逐行读 {wav: path}，stdout 逐行写结果 JSON。

启动时先输出一行 READY，之后每读一个任务输出一行结果。
模型只加载一次 —— 冷启动约 77 秒，热加载 1 秒左右。
"""

import json
import sys
import time

from faster_whisper import WhisperModel

MODEL = "small.en"


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    t0 = time.time()
    model = WhisperModel(MODEL, device="cpu", compute_type="int8")
    load_ms = round((time.time() - t0) * 1000)

    # 第一行必须是 READY，Node 侧据此判断可以开始投递任务
    emit({"ready": True, "model": MODEL, "load_ms": load_ms})
    sys.stdout.write("READY\n")
    sys.stdout.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as exc:  # noqa: BLE001
            emit({"error": f"bad request: {exc}"})
            continue

        wav = req.get("wav")
        if not wav:
            emit({"error": "missing wav"})
            continue

        try:
            t1 = time.time()
            segments, _info = model.transcribe(
                wav, language="en", word_timestamps=True
            )
            words = []
            for seg in segments:
                for w in seg.words:
                    words.append(
                        {
                            "w": w.word.strip(),
                            "start": round(w.start, 3),
                            "end": round(w.end, 3),
                            "p": round(w.probability, 3),
                        }
                    )
            emit(
                {
                    "text": " ".join(x["w"] for x in words),
                    "words": words,
                    "asrMs": round((time.time() - t1) * 1000),
                }
            )
        except Exception as exc:  # noqa: BLE001
            emit({"error": str(exc)})


if __name__ == "__main__":
    main()

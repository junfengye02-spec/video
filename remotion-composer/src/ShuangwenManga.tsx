import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

type CharacterName = "hero" | "villain" | "heroine";

type Beat = {
  start: number;
  end: number;
  title: string;
  line: string;
  tag: string;
  mood: "fall" | "rise" | "reveal" | "crush" | "ending";
  focus: CharacterName[];
};

const FPS = 30;

const beats: Beat[] = [
  {
    start: 0,
    end: 5,
    title: "少主被废",
    line: "订婚宴上，林烬被夺走灵骨，逐出家门。",
    tag: "第一集 · 弃子",
    mood: "fall",
    focus: ["hero", "villain", "heroine"],
  },
  {
    start: 5,
    end: 10,
    title: "雨夜入狱",
    line: "所有人都以为他完了，只有她把药塞进他掌心。",
    tag: "她说：活下去",
    mood: "fall",
    focus: ["hero", "heroine"],
  },
  {
    start: 10,
    end: 15,
    title: "黑塔三年",
    line: "锁链磨断骨头，也磨出了新的王座。",
    tag: "等级重置中",
    mood: "rise",
    focus: ["hero"],
  },
  {
    start: 15,
    end: 20,
    title: "归来当天",
    line: "全城跪迎新任殿主，却没人认出那个弃子。",
    tag: "身份反转",
    mood: "reveal",
    focus: ["hero", "villain"],
  },
  {
    start: 20,
    end: 25,
    title: "一纸婚书",
    line: "反派举杯冷笑，下一秒，他的封地被当众收回。",
    tag: "打脸开始",
    mood: "crush",
    focus: ["hero", "villain"],
  },
  {
    start: 25,
    end: 31,
    title: "旧债清算",
    line: "林烬没有怒吼，只把名单放上金殿。",
    tag: "下一集：满门震怖",
    mood: "ending",
    focus: ["hero", "heroine", "villain"],
  },
];

const palette = {
  ink: "#080910",
  night: "#10131f",
  gold: "#f7c75b",
  red: "#d9483b",
  blue: "#42c7ff",
  cream: "#fff1cf",
  muted: "#aeb6c9",
  panel: "#f7efe2",
};

const progressForBeat = (frame: number, beat: Beat) => {
  const local = frame - beat.start * FPS;
  const duration = (beat.end - beat.start) * FPS;
  return Math.max(0, Math.min(1, local / duration));
};

const currentBeat = (seconds: number) =>
  beats.find((beat) => seconds >= beat.start && seconds < beat.end) ??
  beats[beats.length - 1];

const Character: React.FC<{
  name: CharacterName;
  x: number;
  y: number;
  scale: number;
  active: boolean;
  pose?: "front" | "side" | "kneel";
}> = ({ name, x, y, scale, active, pose = "front" }) => {
  const frame = useCurrentFrame();
  const bob = Math.sin(frame / 14 + x) * (active ? 7 : 3);
  const glow = active ? 1 : 0.35;

  const config = {
    hero: {
      hair: "#dfe8ff",
      coat: "#171b2b",
      trim: palette.blue,
      skin: "#f0c8ad",
      eye: palette.blue,
      name: "林烬",
    },
    villain: {
      hair: "#2a1b16",
      coat: "#7f1d1d",
      trim: palette.gold,
      skin: "#d9a27b",
      eye: palette.red,
      name: "萧玄",
    },
    heroine: {
      hair: "#f6dfb8",
      coat: "#f3f6ff",
      trim: "#9fd7ff",
      skin: "#f1c7b5",
      eye: "#6aa8ff",
      name: "沈微澜",
    },
  }[name];

  const kneel = pose === "kneel";
  const side = pose === "side";

  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y + bob,
        width: 240,
        height: 430,
        transform: `translate(-50%, -50%) scale(${scale}) ${side ? "scaleX(-1)" : ""}`,
        filter: `drop-shadow(0 0 ${24 * glow}px ${config.trim}66) drop-shadow(0 24px 26px rgba(0,0,0,0.35))`,
        opacity: active ? 1 : 0.72,
      }}
    >
      <svg viewBox="0 0 240 430" width="240" height="430">
        <ellipse cx="120" cy="398" rx="78" ry="22" fill="rgba(0,0,0,0.28)" />
        <path
          d={kneel ? "M78 224 C52 270 54 342 92 382 L148 382 C186 342 188 270 162 224 Z" : "M68 214 C50 280 42 342 60 390 L180 390 C198 342 190 280 172 214 Z"}
          fill={config.coat}
          stroke={config.trim}
          strokeWidth="5"
        />
        <path d="M84 224 L120 330 L156 224" fill="none" stroke={palette.cream} strokeWidth="7" opacity="0.9" />
        <path d="M70 250 C34 284 30 330 52 354" fill="none" stroke={config.coat} strokeWidth="28" strokeLinecap="round" />
        <path d="M170 250 C206 284 210 330 188 354" fill="none" stroke={config.coat} strokeWidth="28" strokeLinecap="round" />
        <circle cx="120" cy="132" r="58" fill={config.skin} stroke="#321d19" strokeWidth="5" />
        <path
          d="M64 126 C68 62 104 38 146 52 C184 64 194 98 176 142 C166 104 138 94 110 96 C88 98 76 110 64 126 Z"
          fill={config.hair}
          stroke="#211a19"
          strokeWidth="5"
        />
        <path d="M72 123 C92 97 112 84 142 78" fill="none" stroke="rgba(255,255,255,0.55)" strokeWidth="7" strokeLinecap="round" />
        <path d="M91 136 L107 132" stroke="#1a1515" strokeWidth="5" strokeLinecap="round" />
        <path d="M133 132 L149 136" stroke="#1a1515" strokeWidth="5" strokeLinecap="round" />
        <circle cx="100" cy="146" r="5" fill={config.eye} />
        <circle cx="140" cy="146" r="5" fill={config.eye} />
        <path d="M101 173 C114 184 130 184 143 173" fill="none" stroke="#51251f" strokeWidth="5" strokeLinecap="round" />
        <path d="M88 214 C102 236 138 236 152 214" fill={palette.cream} opacity="0.96" />
        <path d="M84 384 L78 420" stroke="#1a1515" strokeWidth="18" strokeLinecap="round" />
        <path d="M156 384 L162 420" stroke="#1a1515" strokeWidth="18" strokeLinecap="round" />
        {name === "hero" && (
          <>
            <path d="M182 260 L218 148" stroke={palette.blue} strokeWidth="8" strokeLinecap="round" />
            <path d="M210 152 L226 126 L224 160 Z" fill={palette.blue} />
          </>
        )}
        {name === "villain" && (
          <path d="M88 232 C110 252 130 252 152 232" fill="none" stroke={palette.gold} strokeWidth="10" strokeLinecap="round" />
        )}
      </svg>
      <div
        style={{
          position: "absolute",
          left: 30,
          right: 30,
          bottom: -8,
          textAlign: "center",
          color: config.trim,
          fontSize: 28,
          fontWeight: 900,
          fontFamily: "Noto Sans SC, Microsoft YaHei, sans-serif",
          textShadow: "0 3px 8px rgba(0,0,0,0.65)",
        }}
      >
        {config.name}
      </div>
    </div>
  );
};

const SpeedLines: React.FC<{ color: string; intensity: number }> = ({
  color,
  intensity,
}) => {
  const frame = useCurrentFrame();
  return (
    <>
      {Array.from({ length: 34 }).map((_, i) => {
        const offset = (frame * (2 + intensity * 4) + i * 71) % 1380;
        const top = 70 + ((i * 97) % 1620);
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: offset - 220,
              top,
              width: 190 + (i % 4) * 90,
              height: 4,
              background: `linear-gradient(90deg, transparent, ${color}, transparent)`,
              opacity: 0.12 + intensity * 0.18,
              transform: `rotate(${-8 + (i % 6)}deg)`,
            }}
          />
        );
      })}
    </>
  );
};

const MangaPanel: React.FC<{ beat: Beat }> = ({ beat }) => {
  const frame = useCurrentFrame();
  const p = progressForBeat(frame, beat);
  const entrance = spring({
    frame: frame - beat.start * FPS,
    fps: FPS,
    config: { damping: 16, stiffness: 95 },
  });
  const shake =
    beat.mood === "crush" || beat.mood === "reveal"
      ? Math.sin(frame * 0.9) * 8 * (1 - Math.min(1, p * 2))
      : 0;

  const bg =
    beat.mood === "fall"
      ? `radial-gradient(circle at 50% 20%, #29304a 0%, ${palette.night} 48%, #05060a 100%)`
      : beat.mood === "rise"
        ? "radial-gradient(circle at 50% 46%, #29391f 0%, #0c1112 58%, #05060a 100%)"
        : beat.mood === "crush"
          ? "radial-gradient(circle at 52% 46%, #521515 0%, #170a0d 52%, #05060a 100%)"
          : "radial-gradient(circle at 50% 38%, #493913 0%, #111019 56%, #05060a 100%)";

  const heroPose = beat.mood === "fall" ? "kneel" : "front";
  const villainActive = beat.focus.includes("villain");
  const heroineActive = beat.focus.includes("heroine");
  const heroActive = beat.focus.includes("hero");

  return (
    <AbsoluteFill style={{ background: bg, overflow: "hidden" }}>
      <SpeedLines
        color={beat.mood === "crush" ? palette.red : beat.mood === "rise" ? palette.gold : palette.blue}
        intensity={beat.mood === "fall" ? 0.35 : 0.78}
      />
      <div
        style={{
          position: "absolute",
          inset: 34,
          border: "9px solid #05060a",
          boxShadow: "inset 0 0 0 6px rgba(255,255,255,0.85), 0 30px 80px rgba(0,0,0,0.55)",
          background:
            "linear-gradient(135deg, rgba(255,255,255,0.07), rgba(255,255,255,0.01))",
          transform: `scale(${interpolate(entrance, [0, 1], [0.96, 1])}) translateX(${shake}px)`,
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          transform: `scale(${1.03 + p * 0.04})`,
        }}
      >
        <Character
          name="hero"
          x={beat.mood === "fall" ? 520 : beat.mood === "ending" ? 540 : 500}
          y={beat.mood === "fall" ? 1120 : 1020}
          scale={beat.mood === "reveal" ? 1.32 : 1.08}
          active={heroActive}
          pose={heroPose}
        />
        <Character
          name="villain"
          x={beat.mood === "ending" ? 790 : 760}
          y={beat.mood === "crush" ? 1040 + p * 60 : 1010}
          scale={beat.mood === "crush" ? 1.0 - p * 0.08 : 1.0}
          active={villainActive}
          pose="front"
        />
        <Character
          name="heroine"
          x={beat.mood === "fall" ? 320 : 300}
          y={beat.mood === "ending" ? 1040 : 1010}
          scale={0.9}
          active={heroineActive}
          pose="side"
        />
      </div>
      <div
        style={{
          position: "absolute",
          top: 92,
          left: 74,
          right: 74,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div
          style={{
            color: palette.gold,
            fontSize: 30,
            fontWeight: 900,
            fontFamily: "Noto Sans SC, Microsoft YaHei, sans-serif",
            padding: "12px 22px",
            border: `3px solid ${palette.gold}`,
            background: "rgba(0,0,0,0.45)",
          }}
        >
          {beat.tag}
        </div>
        <div
          style={{
            color: "rgba(255,255,255,0.72)",
            fontSize: 24,
            fontWeight: 800,
            fontFamily: "Space Grotesk, sans-serif",
          }}
        >
          {String(beats.indexOf(beat) + 1).padStart(2, "0")} / {beats.length}
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          left: 72,
          right: 72,
          bottom: 86,
          padding: "30px 34px 34px",
          background: "rgba(247,239,226,0.95)",
          border: "7px solid #0a0a0d",
          boxShadow: "12px 12px 0 rgba(0,0,0,0.7)",
          transform: `translateY(${interpolate(entrance, [0, 1], [80, 0])}px)`,
        }}
      >
        <div
          style={{
            color: "#101010",
            fontSize: 72,
            lineHeight: 1.05,
            fontWeight: 1000,
            fontFamily: "Noto Sans SC, Microsoft YaHei, sans-serif",
            marginBottom: 16,
          }}
        >
          {beat.title}
        </div>
        <div
          style={{
            color: "#141414",
            fontSize: 42,
            lineHeight: 1.35,
            fontWeight: 800,
            fontFamily: "Noto Sans SC, Microsoft YaHei, sans-serif",
          }}
        >
          {beat.line}
        </div>
      </div>
      {beat.mood === "crush" && (
        <div
          style={{
            position: "absolute",
            top: 520,
            left: 96,
            transform: `rotate(-12deg) scale(${interpolate(entrance, [0, 1], [0.6, 1])})`,
            color: "#fff",
            background: palette.red,
            border: "8px solid #0a0a0d",
            fontSize: 92,
            fontWeight: 1000,
            fontFamily: "Noto Sans SC, Microsoft YaHei, sans-serif",
            padding: "18px 32px",
            boxShadow: "10px 12px 0 rgba(0,0,0,0.65)",
          }}
        >
          退婚？先退你全族封地
        </div>
      )}
      {beat.mood === "ending" && (
        <div
          style={{
            position: "absolute",
            top: 420,
            right: 72,
            width: 340,
            minHeight: 340,
            borderRadius: 999,
            background: "#fff8e8",
            border: "8px solid #08090f",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            textAlign: "center",
            color: "#0d0d10",
            fontSize: 44,
            lineHeight: 1.18,
            fontWeight: 1000,
            fontFamily: "Noto Sans SC, Microsoft YaHei, sans-serif",
            boxShadow: "0 18px 0 rgba(0,0,0,0.5)",
          }}
        >
          三年前的账
          <br />
          今晚开始还
        </div>
      )}
    </AbsoluteFill>
  );
};

export const ShuangwenManga: React.FC = () => {
  const frame = useCurrentFrame();
  const seconds = frame / FPS;
  const beat = currentBeat(seconds);
  const flash = beats.some((b) => Math.abs(seconds - b.start) < 0.12);

  return (
    <AbsoluteFill style={{ background: palette.ink }}>
      <MangaPanel beat={beat} />
      <div
        style={{
          position: "absolute",
          inset: 0,
          pointerEvents: "none",
          boxShadow: "inset 0 0 140px rgba(0,0,0,0.9)",
        }}
      />
      {flash && (
        <AbsoluteFill
          style={{
            background: "rgba(255,255,255,0.38)",
          }}
        />
      )}
    </AbsoluteFill>
  );
};


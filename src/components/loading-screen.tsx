export function LoadingScreen({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex h-full min-h-[320px] w-full flex-col items-center justify-center gap-6">
      <div className="relative flex h-[88px] w-[88px] items-center justify-center">
        <div
          className="absolute inset-0 rounded-full border-[3px] border-border"
          style={{ borderTopColor: "var(--primary)", animation: "gfSpin 0.9s linear infinite" }}
        />
        <div className="flex h-14 w-14 items-center justify-center rounded-[16px] bg-primary font-heading text-[28px] font-bold text-white shadow-[0_6px_18px_rgba(47,93,58,.28)]">
          G
        </div>
      </div>

      <div className="flex flex-col items-center gap-3">
        <div className="text-center text-[16px] font-semibold tracking-[-0.01em] text-foreground">
          {label}
        </div>
        <div className="flex gap-[7px]">
          {[0, 0.18, 0.36].map((delay) => (
            <span
              key={delay}
              className="h-2 w-2 rounded-full bg-primary"
              style={{ animation: `gfPulse 1.1s ease-in-out infinite`, animationDelay: `${delay}s` }}
            />
          ))}
        </div>
      </div>

      <div className="relative h-[3px] w-[200px] overflow-hidden rounded-full bg-border">
        <div
          className="absolute top-0 h-full w-2/5 rounded-full bg-primary"
          style={{ animation: "gfBar 1.3s ease-in-out infinite" }}
        />
      </div>
    </div>
  );
}

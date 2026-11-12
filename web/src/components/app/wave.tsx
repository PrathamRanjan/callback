/** Callback's motif: a voice waveform. Bars breathe while someone is talking; still when calm mode or reduced motion is on. Decorative. */
export function Wave({ bars = 28, live = true, className = "" }: { bars?: number; live?: boolean; className?: string }) {
  return (
    <span className={`cb-wave ${live ? "is-live" : ""} ${className}`} aria-hidden="true">
      {Array.from({ length: bars }, (_, i) => (
        <i key={i} style={{ ["--h" as string]: `${22 + Math.round(70 * Math.abs(Math.sin(i * 1.7) * Math.cos(i * 0.45)))}%`, ["--d" as string]: `${(i % 7) * 90}ms` }} />
      ))}
    </span>
  );
}

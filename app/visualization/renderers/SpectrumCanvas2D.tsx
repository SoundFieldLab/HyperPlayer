import { useCallback } from "react";
import { useResponsiveCanvas } from "./canvas";

export interface SpectrumStyle {
  color?: string;
  floorDb?: number;
  ceilingDb?: number;
  gapRatio?: number;
}

export function drawSpectrumCanvas2D(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  bins: ArrayLike<number>,
  style: SpectrumStyle = {},
): void {
  if (bins.length === 0 || width <= 0 || height <= 0) return;
  const floorDb = style.floorDb ?? -90;
  const ceilingDb = style.ceilingDb ?? 0;
  const range = Math.max(1, ceilingDb - floorDb);
  const step = width / bins.length;
  const gap = step * Math.max(0, Math.min(0.8, style.gapRatio ?? 0.18));
  context.fillStyle = style.color ?? "#3f55f9";

  for (let index = 0; index < bins.length; index += 1) {
    const value = Number.isFinite(bins[index]) ? bins[index] : floorDb;
    const normalized = Math.max(0, Math.min(1, (value - floorDb) / range));
    const barHeight = normalized * height;
    context.fillRect(index * step + gap / 2, height - barHeight, Math.max(1, step - gap), barHeight);
  }
}

export interface SpectrumCanvas2DProps extends SpectrumStyle {
  bins: ArrayLike<number>;
  className?: string;
  ariaLabel?: string;
}

export function SpectrumCanvas2D({
  bins,
  className,
  ariaLabel = "频谱",
  color,
  floorDb,
  ceilingDb,
  gapRatio,
}: SpectrumCanvas2DProps): React.JSX.Element {
  const draw = useCallback((context: CanvasRenderingContext2D, width: number, height: number) => {
    drawSpectrumCanvas2D(context, width, height, bins, { color, floorDb, ceilingDb, gapRatio });
  }, [bins, ceilingDb, color, floorDb, gapRatio]);
  const ref = useResponsiveCanvas(draw);
  return <canvas ref={ref} className={className} role="img" aria-label={ariaLabel} />;
}

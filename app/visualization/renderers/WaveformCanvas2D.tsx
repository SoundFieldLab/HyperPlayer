import { useCallback } from "react";
import type { WaveformBin } from "../telemetry";
import { useResponsiveCanvas } from "./canvas";

export interface WaveformStyle {
  leftColor?: string;
  rightColor?: string;
  centerColor?: string;
  lineWidth?: number;
}

export function drawWaveformCanvas2D(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  bins: readonly WaveformBin[],
  style: WaveformStyle = {},
): void {
  if (bins.length === 0 || width <= 0 || height <= 0) return;
  const halfHeight = height / 2;
  const channelHeight = Math.max(0, halfHeight - 2);
  const step = width / bins.length;

  context.strokeStyle = style.centerColor ?? "rgba(127, 127, 127, 0.22)";
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(0, halfHeight);
  context.lineTo(width, halfHeight);
  context.stroke();

  const drawChannel = (channel: "left" | "right", color: string, center: number) => {
    context.strokeStyle = color;
    context.lineWidth = style.lineWidth ?? Math.max(1, Math.min(3, step * 0.68));
    context.beginPath();
    for (let index = 0; index < bins.length; index += 1) {
      const bin = bins[index];
      const minimum = Math.max(-1, Math.min(1, channel === "left" ? bin.leftMin : bin.rightMin));
      const maximum = Math.max(-1, Math.min(1, channel === "left" ? bin.leftMax : bin.rightMax));
      const x = (index + 0.5) * step;
      context.moveTo(x, center - maximum * channelHeight * 0.5);
      context.lineTo(x, center - minimum * channelHeight * 0.5);
    }
    context.stroke();
  };

  drawChannel("left", style.leftColor ?? "#3f55f9", halfHeight * 0.5);
  drawChannel("right", style.rightColor ?? "#ff761c", halfHeight * 1.5);
}

export interface WaveformCanvas2DProps extends WaveformStyle {
  bins: readonly WaveformBin[];
  className?: string;
  ariaLabel?: string;
}

export function WaveformCanvas2D({
  bins,
  className,
  ariaLabel = "立体声波形",
  leftColor,
  rightColor,
  centerColor,
  lineWidth,
}: WaveformCanvas2DProps): React.JSX.Element {
  const draw = useCallback((context: CanvasRenderingContext2D, width: number, height: number) => {
    drawWaveformCanvas2D(context, width, height, bins, { leftColor, rightColor, centerColor, lineWidth });
  }, [bins, centerColor, leftColor, lineWidth, rightColor]);
  const ref = useResponsiveCanvas(draw);
  return <canvas ref={ref} className={className} role="img" aria-label={ariaLabel} />;
}

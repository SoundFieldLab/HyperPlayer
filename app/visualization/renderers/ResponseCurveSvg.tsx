export interface ResponseCurvePoint {
  frequencyHz: number;
  gainDb: number;
}

export interface ResponseCurveSvgProps {
  points: readonly ResponseCurvePoint[];
  minFrequencyHz?: number;
  maxFrequencyHz?: number;
  minGainDb?: number;
  maxGainDb?: number;
  className?: string;
  ariaLabel?: string;
  stroke?: string;
}

export function responseCurvePath(
  points: readonly ResponseCurvePoint[],
  width: number,
  height: number,
  minFrequencyHz = 20,
  maxFrequencyHz = 20_000,
  minGainDb = -24,
  maxGainDb = 24,
): string {
  if (points.length === 0 || minFrequencyHz <= 0 || maxFrequencyHz <= minFrequencyHz || maxGainDb <= minGainDb) return "";
  const logMin = Math.log10(minFrequencyHz);
  const logRange = Math.log10(maxFrequencyHz) - logMin;
  return points.map((point, index) => {
    const frequency = Math.max(minFrequencyHz, Math.min(maxFrequencyHz, point.frequencyHz));
    const gain = Math.max(minGainDb, Math.min(maxGainDb, point.gainDb));
    const x = ((Math.log10(frequency) - logMin) / logRange) * width;
    const y = ((maxGainDb - gain) / (maxGainDb - minGainDb)) * height;
    return `${index === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`;
  }).join(" ");
}

export function ResponseCurveSvg({
  points,
  minFrequencyHz = 20,
  maxFrequencyHz = 20_000,
  minGainDb = -24,
  maxGainDb = 24,
  className,
  ariaLabel = "频率响应曲线",
  stroke = "#3f55f9",
}: ResponseCurveSvgProps): React.JSX.Element {
  const width = 1000;
  const height = 240;
  const zeroY = Math.max(0, Math.min(height, (maxGainDb / (maxGainDb - minGainDb)) * height));
  const path = responseCurvePath(points, width, height, minFrequencyHz, maxFrequencyHz, minGainDb, maxGainDb);
  return (
    <svg className={className} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={ariaLabel}>
      <line x1="0" y1={zeroY} x2={width} y2={zeroY} stroke="currentColor" opacity="0.18" vectorEffect="non-scaling-stroke" />
      {path && <path d={path} fill="none" stroke={stroke} strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />}
    </svg>
  );
}

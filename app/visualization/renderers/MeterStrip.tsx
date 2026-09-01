import type { CSSProperties } from "react";
import type { TelemetryMeters } from "../telemetry";

export interface MeterStripProps {
  meters: TelemetryMeters | null;
  className?: string;
}

interface MeterDefinition {
  key: "peakLeft" | "peakRight" | "rmsLeft" | "rmsRight";
  label: string;
  unit: string;
  minimum: number;
  maximum: number;
}

const DEFINITIONS: readonly MeterDefinition[] = [
  { key: "rmsLeft", label: "左声道 RMS", unit: "dBFS", minimum: -90, maximum: 0 },
  { key: "rmsRight", label: "右声道 RMS", unit: "dBFS", minimum: -90, maximum: 0 },
  { key: "peakLeft", label: "左声道采样峰值", unit: "dBFS", minimum: -90, maximum: 3 },
  { key: "peakRight", label: "右声道采样峰值", unit: "dBFS", minimum: -90, maximum: 3 },
];

const stripStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
  gap: 8,
};

const meterStyle: CSSProperties = { minWidth: 0 };
const trackStyle: CSSProperties = { display: "block", width: "100%", height: 6 };
const labelStyle: CSSProperties = { display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };

function displayValue(value: number | null | undefined): number | undefined {
  if (value === null || value === undefined || !Number.isFinite(value)) return undefined;
  return value > 0 ? 20 * Math.log10(value) : -90;
}

function formatMeter(value: number | undefined): string {
  return value === undefined ? "--" : value.toFixed(1);
}

export function MeterStrip({ meters, className }: MeterStripProps): React.JSX.Element {
  return (
    <div className={className} style={stripStyle} role="group" aria-label="RMS 和峰值仪表">
      {DEFINITIONS.map((definition) => {
        const value = displayValue(meters?.[definition.key]);
        const normalized = value === undefined
          ? 0
          : Math.max(0, Math.min(1, (value - definition.minimum) / (definition.maximum - definition.minimum)));
        return (
          <div key={definition.key} style={meterStyle} role="meter" aria-label={definition.label} aria-valuemin={definition.minimum} aria-valuemax={definition.maximum} aria-valuenow={value}>
            <svg style={trackStyle} viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true">
              <rect width="100" height="6" rx="3" fill="currentColor" opacity="0.12" />
              <rect width={normalized * 100} height="6" rx="3" fill="#3f55f9" />
            </svg>
            <span style={labelStyle}>{definition.label}</span>
            <strong>{formatMeter(value)}</strong> <small>{definition.unit}</small>
          </div>
        );
      })}
    </div>
  );
}

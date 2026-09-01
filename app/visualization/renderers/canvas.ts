import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from "react";

export type CanvasDraw = (context: CanvasRenderingContext2D, width: number, height: number) => void;

export function useResponsiveCanvas(draw: CanvasDraw): RefObject<HTMLCanvasElement | null> {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawRef = useRef(draw);
  drawRef.current = draw;

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, rect.width || canvas.clientWidth || 1);
    const height = Math.max(1, rect.height || canvas.clientHeight || 1);
    const dpr = Math.min(2, Math.max(1, globalThis.devicePixelRatio || 1));
    const pixelWidth = Math.max(1, Math.round(width * dpr));
    const pixelHeight = Math.max(1, Math.round(height * dpr));
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;

    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);
    drawRef.current(context, width, height);
  }, []);

  useLayoutEffect(() => {
    render();
  }, [draw, render]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(render);
      observer.observe(canvas);
      return () => observer.disconnect();
    }
    globalThis.addEventListener("resize", render);
    return () => globalThis.removeEventListener("resize", render);
  }, [render]);

  return canvasRef;
}

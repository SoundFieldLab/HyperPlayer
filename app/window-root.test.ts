import { describe, expect, it } from "vitest";
import { windowRoot } from "./window-root";

describe("window root routing", () => {
  it("selects each auxiliary root from the location query", () => {
    expect(windowRoot("?window=mini-player")).toBe("main"); // 迷你播放器已按用户定调移除（D36 后续）
    expect(windowRoot("?window=desktop-lyrics")).toBe("desktop-lyrics");
  });

  it("falls back to the main application for unknown or missing values", () => {
    expect(windowRoot("")).toBe("main");
    expect(windowRoot("?window=unknown")).toBe("main");
  });
});

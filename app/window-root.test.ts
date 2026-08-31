import { describe, expect, it } from "vitest";
import { windowRoot } from "./window-root";

describe("window root routing", () => {
  it("selects each auxiliary root from the location query", () => {
    expect(windowRoot("?window=mini-player")).toBe("mini-player");
    expect(windowRoot("?window=desktop-lyrics")).toBe("desktop-lyrics");
  });

  it("falls back to the main application for unknown or missing values", () => {
    expect(windowRoot("")).toBe("main");
    expect(windowRoot("?window=unknown")).toBe("main");
  });
});

import { describe, expect, it } from "vitest";
import { remoteFailure, remoteSuccess } from "./remote";

describe("remote page states", () => {
  it("keeps unavailable distinct from operational errors", () => {
    expect(remoteFailure({ code: "unavailable", message: "not configured" })).toEqual({ status: "unavailable", message: "not configured" });
    expect(remoteFailure(new Error("offline"))).toEqual({ status: "error", message: "offline" });
  });

  it("represents empty successful responses explicitly", () => {
    expect(remoteSuccess([], true)).toEqual({ status: "empty", data: [] });
    expect(remoteSuccess([1])).toEqual({ status: "ready", data: [1] });
  });
});

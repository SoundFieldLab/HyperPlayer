import { bridgeError } from "./bridge";

export type RemoteState<T> =
  | { status: "idle" | "loading" }
  | { status: "ready"; data: T }
  | { status: "empty"; data: T }
  | { status: "error" | "unavailable"; message: string };

export function remoteSuccess<T>(data: T, empty = false): RemoteState<T> {
  return empty ? { status: "empty", data } : { status: "ready", data };
}

export function remoteFailure(error: unknown): RemoteState<never> {
  const detail = bridgeError(error);
  return { status: detail.unavailable ? "unavailable" : "error", message: detail.message };
}

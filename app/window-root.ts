export type WindowRoot = "main" | "mini-player" | "desktop-lyrics";

export function windowRoot(search: string): WindowRoot {
  const kind = new URLSearchParams(search).get("window");
  return kind === "mini-player" || kind === "desktop-lyrics" ? kind : "main";
}

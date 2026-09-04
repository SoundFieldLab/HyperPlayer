export type WindowRoot = "main" | "desktop-lyrics";

export function windowRoot(search: string): WindowRoot {
  const kind = new URLSearchParams(search).get("window");
  return kind === "desktop-lyrics" ? kind : "main";
}

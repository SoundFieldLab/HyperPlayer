import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const rustLib = readFileSync(resolve(root, "src-tauri/src/lib.rs"), "utf8");
const rustEvents = readFileSync(resolve(root, "src-tauri/src/events.rs"), "utf8");
const bridgeSource = readFileSync(resolve(here, "index.ts"), "utf8");

const handlerBody = rustLib.match(/generate_handler!\s*\[([\s\S]*?)\]/)?.[1];
if (!handlerBody) {
  throw new Error("Unable to find tauri::generate_handler! in src-tauri/src/lib.rs");
}

const registered = new Set(
  [...handlerBody.matchAll(/(?:\w+::)+(\w+)/g)].map((match) => match[1]),
);

const literalInvokes = [...bridgeSource.matchAll(/invoke(?:<[^>]+>)?\(\s*["']([^"']+)["']/g)].map(
  (match) => match[1],
);
const manifestBody = bridgeSource.match(/export const TAURI_COMMANDS\s*=\s*\{([\s\S]*?)\}\s*as const/);
const manifestCommands = manifestBody
  ? [...manifestBody[1].matchAll(/:\s*["']([^"']+)["']/g)].map((match) => match[1])
  : [];
const frontendCommands = new Set([...literalInvokes, ...manifestCommands]);

if (frontendCommands.size === 0) {
  throw new Error("No frontend Tauri commands found in app/bridge/index.ts");
}

const missing = [...frontendCommands].filter((command) => !registered.has(command));
if (missing.length > 0) {
  console.error(`Frontend invokes unregistered Tauri commands: ${missing.join(", ")}`);
  process.exit(1);
}

const backendEvents = new Set(
  [...rustEvents.matchAll(/pub const \w+: &str = "([^"]+)";/g)].map((match) => match[1]),
);
const eventManifestBody = bridgeSource.match(/export const TAURI_EVENTS\s*=\s*\{([\s\S]*?)\}\s*as const/);
const frontendEvents = new Set(
  eventManifestBody
    ? [...eventManifestBody[1].matchAll(/:\s*["']([^"']+)["']/g)].map((match) => match[1])
    : [],
);
const missingEvents = [...backendEvents].filter((event) => !frontendEvents.has(event));
const unknownEvents = [...frontendEvents].filter((event) => !backendEvents.has(event));
if (missingEvents.length > 0 || unknownEvents.length > 0) {
  console.error(`IPC event manifest mismatch. Missing: ${missingEvents.join(", ") || "none"}; unknown: ${unknownEvents.join(", ") || "none"}`);
  process.exit(1);
}

console.log(`IPC contract valid: ${frontendCommands.size} commands registered and ${frontendEvents.size} events matched.`);

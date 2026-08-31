import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const pnpmCommand = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "pnpm";
const pnpmArguments = process.platform === "win32"
  ? ["/d", "/s", "/c", "pnpm licenses list --prod --json"]
  : ["licenses", "list", "--prod", "--json"];

const allowedLicenses = new Set([
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "MIT",
  "OFL-1.0",
  "OFL-1.1",
  "Unicode-3.0",
  "Zlib",
]);

const report = JSON.parse(
  execFileSync(pnpmCommand, pnpmArguments, {
    encoding: "utf8",
  }),
);

const rejected = [];
const packages = [];

for (const [expression, entries] of Object.entries(report)) {
  const identifiers = expression
    .replace(/[()]/g, " ")
    .split(/\s+(?:AND|OR)\s+/u)
    .map((identifier) => identifier.trim())
    .filter(Boolean);

  if (identifiers.length === 0 || identifiers.some((id) => !allowedLicenses.has(id))) {
    rejected.push(expression);
  }

  for (const entry of entries) {
    packages.push(entry.name);
  }
}

if (rejected.length > 0) {
  throw new Error(`Rejected or unreviewed production licenses: ${rejected.join(", ")}`);
}

const notices = readFileSync(new URL("../THIRD_PARTY_NOTICES.md", import.meta.url), "utf8");
const missingNotices = [...new Set(packages)].filter(
  (packageName) => !notices.includes(`\`${packageName}\``),
);

if (missingNotices.length > 0) {
  throw new Error(`Production packages missing from THIRD_PARTY_NOTICES.md: ${missingNotices.join(", ")}`);
}

console.log(`Accepted ${packages.length} production package license records.`);

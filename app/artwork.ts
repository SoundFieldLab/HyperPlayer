const palettes = [
  ["#172246", "#f19a72", "#6d4c96"],
  ["#182b53", "#d7c38c", "#416b88"],
  ["#e8e1d5", "#d85e51", "#222b3b"],
  ["#14262d", "#ee8e62", "#327b78"],
  ["#d7e6df", "#51776b", "#25483f"],
  ["#4b294f", "#f0b05f", "#234d66"],
] as const;

function hash(value: string): number {
  return [...value].reduce((total, character) => total + character.charCodeAt(0), 0);
}

export function fallbackCover(seed: string): string {
  const [background, accent, motif] = palettes[hash(seed) % palettes.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 700 700"><rect width="700" height="700" fill="${background}"/><circle cx="520" cy="170" r="150" fill="${accent}" opacity=".82"/><path d="M-40 540 Q180 300 350 520 T760 420 V760 H-40Z" fill="${motif}"/><path d="M40 590 Q210 410 370 560 T700 490" fill="none" stroke="white" stroke-width="12" opacity=".45"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export interface BilibiliMvDeclaration {
  songKey: string
  bvid: string
  songTitle: string
  artists: readonly string[]
  album?: string
  videoTitle: string
  uploader: string
  duration: number
  note?: string
  verifiedAt: string
}

export const BILIBILI_MV_DECLARATION_VERSION = '2026-09-06-1'

export const BILIBILI_MV_DECLARATIONS: readonly BilibiliMvDeclaration[] = [
  {
    songKey: 'qq:612279399',
    bvid: 'BV18A4m1N7Hc',
    songTitle: 'Villain (Take the Shot)',
    artists: ['无畏契约', 'Barns Courtney', 'ARB4'],
    album: 'VALORANT Sounds Vol. 1',
    videoTitle: 'VILLAIN (TAKE THE SHOT) // 2024VCT EMEA主题曲',
    uploader: 'ACG_Planck',
    duration: 191,
    note: '开发者人工核验：VCT EMEA 主题曲视频。',
    verifiedAt: '2026-09-06',
  },
]

const BVID_RE = /^BV[0-9A-Za-z]{10}$/

function buildDeclarationMap(declarations: readonly BilibiliMvDeclaration[]): ReadonlyMap<string, BilibiliMvDeclaration> {
  const result = new Map<string, BilibiliMvDeclaration>()
  for (const declaration of declarations) {
    if (!declaration.songKey.trim()) throw new Error('Developer MV declaration has an empty songKey')
    if (!BVID_RE.test(declaration.bvid)) throw new Error(`Developer MV declaration has an invalid BVID: ${declaration.bvid}`)
    if (result.has(declaration.songKey)) throw new Error(`Duplicate developer MV declaration: ${declaration.songKey}`)
    result.set(declaration.songKey, Object.freeze({ ...declaration }))
  }
  return result
}

export const BILIBILI_MV_DECLARATION_MAP = buildDeclarationMap(BILIBILI_MV_DECLARATIONS)

export function getDeveloperBilibiliMvDeclaration(songKey: string): BilibiliMvDeclaration | null {
  return BILIBILI_MV_DECLARATION_MAP.get(songKey) || null
}

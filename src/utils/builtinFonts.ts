/**
 * 内置字体的按需注入（性能优化计划 1.0 §6.3）。
 *
 * 此前两款内置字体经 fonts.css 全局 @font-face 静态注册（约 9.4 MB woff2 全量打进
 * dist），而默认字体栈并不包含它们——只有字体下拉预览、或用户选中内置字体
 * （含老配置恢复：桌面歌词窗启动即应用所选字体）时才真正需要。
 * 改为运行期 new FontFace(...) + document.fonts.add() 按需注入：
 * - 字体文件本身与 OFL 1.1 许可不变（src/assets/fonts/ 下 woff2 + 许可文本）
 * - 已加载/加载中的族名去重，重复调用共享同一在途 Promise
 * - 加载失败静默回退系统字体栈（与 @font-face 加载失败的表现一致），下次调用重试
 */

export interface BuiltinFontFace {
  family: string
  url: string
  weight: string
  style: string
}

export const BUILTIN_FONT_FACES: BuiltinFontFace[] = [
  // 霞鹜文楷（LXGW WenKai）— 基于 Klee One 的开源楷体，衍生自 FONTWORKS
  // 许可文本见 src/assets/fonts/OFL-LXGWWenKai.txt；仅转换为完整字符集 WOFF2，未子集化
  {
    family: 'LXGW WenKai',
    url: new URL('../assets/fonts/LXGWWenKai-Regular.woff2', import.meta.url).href,
    weight: '400',
    style: 'normal',
  },
  // 得意黑（Smiley Sans）— atelierAnchor 出品的斜体黑体
  // 许可文本见 src/assets/fonts/OFL-SmileySans.txt
  {
    family: 'Smiley Sans',
    url: new URL('../assets/fonts/SmileySans-Oblique.ttf.woff2', import.meta.url).href,
    weight: '400',
    style: 'oblique 0deg',
  },
]

const loadedFamilies = new Set<string>()
const pendingLoads = new Map<string, Promise<void>>()

/** 是否为需要按需注入的内置字体族名 */
export function isBuiltinFontFamily(family: string): boolean {
  const name = (family || '').trim()
  return BUILTIN_FONT_FACES.some((f) => f.family === name)
}

/** 注入一款内置字体；非内置族名直接 resolve，重复调用共享同一在途加载 */
export function ensureBuiltinFont(family: string): Promise<void> {
  const name = (family || '').trim()
  const face = BUILTIN_FONT_FACES.find((f) => f.family === name)
  if (!face || loadedFamilies.has(name)) return Promise.resolve()
  const inflight = pendingLoads.get(name)
  if (inflight) return inflight
  const task = (async () => {
    const fontFace = new FontFace(face.family, `url(${face.url})`, {
      weight: face.weight,
      style: face.style,
      display: 'swap',
    })
    await fontFace.load()
    document.fonts.add(fontFace)
    loadedFamilies.add(face.family)
  })()
    .catch((error) => {
      console.warn(`[builtinFonts] 内置字体加载失败，回退系统字体栈: ${face.family}`, error)
    })
    .finally(() => { pendingLoads.delete(name) })
  pendingLoads.set(name, task)
  return task
}

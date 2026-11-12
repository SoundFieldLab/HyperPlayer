'use strict'

// 只操作产品现有控件；定位失败写失败样本，不能把未执行的功能计为通过。
async function exerciseScenarios({ page, conditions, run }) {
  async function searchEntry() {
    if (await page.getByPlaceholder(/搜索.*歌曲/).count()) return
    if (conditions.mode === 'minimal') {
      const bar = page.locator('.home-bottom-bar')
      if (await bar.count()) await bar.hover()
      await page.getByTitle('搜索音乐', { exact: true }).click()
    } else if (conditions.mode === 'traditional') await page.getByRole('button', { name: /^(打开搜索|搜索)$/ }).first().click()
    else if (conditions.mode === 'explore') await page.getByRole('button', { name: '搜索', exact: true }).click()
    else {
      const bar = page.getByLabel('显示歌单', { exact: true })
      if (await bar.count()) await bar.hover()
      await page.locator('button:has(svg.lucide-search)').first().click()
    }
  }
  const input = () => page.getByPlaceholder(/搜索.*歌曲/).first()
  const searchSurface = () => conditions.mode === 'traditional' ? input().locator('xpath=ancestor::div[contains(@class,"flex-col")][1]') : page.getByRole('heading', { name: '搜索音乐', exact: true }).locator('..').locator('..').locator('..')
  const firstSong = () => searchSurface().getByText('基准歌曲 001', { exact: true }).first()
  async function enterPlayer() {
    if (await page.getByRole('button', { name: '打开歌词显示样式', exact: true }).count()) return
    const traditional = page.getByTitle('进入播放页', { exact: true }).first()
    if (await traditional.count()) await traditional.click()
    else {
      const floatingCover = page.locator('div.fixed.bottom-6.right-6').locator('img').last()
      if (await floatingCover.count()) await floatingCover.click()
      else await page.locator('[data-desktop-interactive].cursor-pointer').filter({ visible: true }).first().click()
    }
  }
  async function searchSongs() {
    await searchEntry()
    await input().fill('基准')
    await input().press('Enter')
    await firstSong().waitFor()
  }
  await run('search', searchSongs)
  await run('search-scroll', async () => {
    await firstSong().waitFor()
    await firstSong().hover()
    for (let i = 0; i < 20; i++) { await page.mouse.wheel(0, i < 10 ? 220 : -220); await page.waitForTimeout(40) }
  })
  await run('artist-tabs', async () => {
    await firstSong().click({ button: 'right' })
    await page.getByText('查看歌手', { exact: true }).click()
    await page.getByRole('button', { name: '专辑', exact: true }).last().click()
    await page.getByText('基准专辑 001', { exact: true }).filter({ visible: true }).first().waitFor()
    const video = page.getByRole('button', { name: '视频', exact: true })
    const artistSurface = conditions.mode === 'traditional' ? page.getByRole('button', { name: '热门歌曲', exact: true }).locator('xpath=ancestor::main[1]') : page.getByRole('button', { name: '精选', exact: true }).locator('xpath=ancestor::div[contains(@class,"fixed")][1]')
    if (await video.count()) {
      await video.click()
      await artistSurface.getByText('基准歌曲 001', { exact: true }).first().waitFor()
    } else {
      await page.getByRole('button', { name: '热门歌曲', exact: true }).click()
      await artistSurface.getByText('基准歌曲 001', { exact: true }).first().waitFor()
    }
    if (conditions.mode === 'traditional') await page.keyboard.press('Escape')
    else await artistSurface.locator('button:has(svg.lucide-x)').first().click()
    if (conditions.mode !== 'traditional') await firstSong().waitFor()
    else await input().waitFor()
  })
  await run('playlist-open', async () => {
    await searchEntry()
    await page.getByRole('button', { name: conditions.mode === 'traditional' ? '歌单' : '搜歌单', exact: true }).click()
    await input().fill('基准')
    await input().press('Enter')
    await searchSurface().getByText('基准歌单', { exact: true }).first().click()
    await page.getByRole('button', { name: conditions.mode === 'traditional' ? /^播放$/ : /播放全部/ }).first().waitFor()
    await page.getByText('基准歌曲 001', { exact: true }).filter({ visible: true }).first().waitFor()
  })
  async function waitAudio() {
    await page.waitForFunction(() => [...(window.__loadingProbe?.audio || []), ...document.querySelectorAll('audio,video')].some(a => !a.paused && a.readyState >= 2 && a.currentTime > 0), undefined, { timeout: 8000 })
  }
  await run('playlist-play-all', async () => {
    await page.getByRole('button', { name: conditions.mode === 'traditional' ? /^播放$/ : /播放全部/ }).first().click()
    await waitAudio()
  })
  await run('continuous-play', async () => {
    await enterPlayer()
    for (let i = 0; i < 3; i++) {
      await page.mouse.move(400, 300)
      const slider = page.locator('input.progress-slider').filter({ visible: true }).first()
      await slider.waitFor()
      const pill = slider.locator('xpath=ancestor::div[contains(@class,"backdrop-blur-3xl")][1]')
      await pill.hover()
      const before = await page.evaluate(() => window.__loadingProbe.playing.length)
      await pill.locator('button:has(svg.lucide-skip-forward)').click()
      await page.waitForFunction(n => window.__loadingProbe.playing.length > n, before, { timeout: 8000 })
      await waitAudio()
    }
  })
  await run('mv-toggle', async () => {
    const modeTrigger = page.getByRole('button', { name: '打开歌词显示样式', exact: true })
    if (!await modeTrigger.count()) await enterPlayer()
    await modeTrigger.click()
    await page.getByRole('button', { name: '看歌', exact: true }).click()
    await page.locator('[data-watch-surface]').waitFor()
    await page.waitForTimeout(1000)
    await modeTrigger.click()
    await page.getByRole('button', { name: '现代', exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('[data-watch-surface]') || getComputedStyle(document.querySelector('[data-watch-surface]')).display === 'none')
  })
}
module.exports = { exerciseScenarios }

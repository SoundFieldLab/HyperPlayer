/** @vitest-environment jsdom */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ImmersiveControls from '../src/components/ImmersiveControls'

let tvMode = false
let remoteCursorMode = false

vi.mock('../src/tv/tvCore', () => ({
  useTvMode: () => tvMode,
  useRemoteCursorMode: () => remoteCursorMode,
}))

vi.mock('../src/components/QuickSettings', () => ({
  default: () => <button type="button" aria-label="快速设置" />,
}))

const baseProps = {
  onHomeClick: vi.fn(),
  onTranslationToggle: vi.fn(),
  translationEnabled: false,
  hasTranslation: true,
  onRomanToggle: vi.fn(),
  romanEnabled: false,
  hasRoman: true,
  onMvBackgroundToggle: vi.fn(),
}

beforeEach(() => {
  tvMode = false
  remoteCursorMode = false
})

afterEach(cleanup)

describe('ImmersiveControls', () => {
  it('lays out feature rows and places quick settings after them', () => {
    const { container } = render(<ImmersiveControls {...baseProps} />)

    // 三个功能行：翻译 / 罗马音 / MV 背景；快速设置紧随其后
    expect(screen.getByRole('button', { name: 'MV 背景' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '快速设置' }).parentElement?.style.top).toBe('16rem')
    expect((container.firstElementChild as HTMLElement).style.height).toBe('364px')
  })

  it('omits optional rows when their feature is unavailable', () => {
    render(<ImmersiveControls {...baseProps} hasTranslation={false} hasRoman={false} onMvBackgroundToggle={undefined} />)

    expect(screen.queryByRole('button', { name: 'MV 背景' })).toBeNull()
    expect(screen.getByRole('button', { name: '快速设置' }).parentElement?.style.top).toBe('4rem')
  })

  it('uses compact TV row spacing and trigger sizing', () => {
    tvMode = true
    const { container } = render(<ImmersiveControls {...baseProps} />)

    expect(screen.getByRole('button', { name: '快速设置' }).parentElement?.style.top).toBe('12.8rem')
    expect((container.firstElementChild as HTMLElement).style.height).toBe('272px')
  })
})

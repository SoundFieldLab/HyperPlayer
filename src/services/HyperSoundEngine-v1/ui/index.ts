/**
 * HyperPlayer HSE 调音室 UI —— 公共出口
 *
 * 导出：主面板 HSEMixingStudio、引擎桥（createHSEUiBridge + 类型）、
 * 设计语言（useHSELegacyTheme）、参数 hooks（useHSEParams/DeepPartial/deepMerge）。
 * 融合侧只 import 本文件即可。
 */

export { default as HSEMixingStudio } from './HSEMixingStudio'
export type { HSEMixingStudioProps } from './HSEMixingStudio'
export { createHSEUiBridge, MAX_MY_SCENES } from './bridge'
export type { HSEUiBridge, HSEHearingSession } from './bridge'
export { useHSELegacyTheme } from './theme'
export type { HSELegacyTheme } from './theme'
export { useHSEParams, deepMerge } from './hooks'
export type { DeepPartial, HSEParamsController } from './hooks'
export { autoBoostAtVolume, COMP_PRESETS, CUSTOM_BAND_FREQUENCIES } from './modalsLoudness'
export { REVERB_TYPES, HARMONIC_TYPES } from './modalsSpatial'
export { IEQ_CURVES } from './modalsDynamics'
export { EqCurveEditor } from './eqCurveEditor'
export type { EqPoint } from './eqCurveEditor'

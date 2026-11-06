/**
 * 行为等价性断言工具。
 *
 * 迁移类改动的真实风险是「新 module 与旧分散实现语义不同」——本轮两个候选就各自
 * 出现过一次（QQ 歌曲去重、FIFO 重写位置）。这里的做法是：**把旧实现字面复刻**
 * 成 `legacy`，与新 module 在表格化用例上逐一比较，保证同输入同输出。
 *
 * 复刻版必须保持"看起来愚蠢但忠实"，不要为了好看去重构它——它的价值就在于
 * 是旧行为的可执行证据。
 */

export interface EquivalenceCase<TInput, TExpected> {
  /** 用例说明；失败时直接显示，便于定位是哪条行为漂移。 */
  name: string
  input: TInput
  /** 可选：额外断言旧实现的输出等于它（防止复刻版本身写错）。 */
  expected?: TExpected
}

export interface EquivalenceResult<TOutput> {
  name: string
  legacy: TOutput
  current: TOutput
}

/**
 * 对每个用例分别跑旧实现与新实现，返回两组输出供断言。
 * 由调用方自己 `expect(current).toEqual(legacy)`——保持本工具与测试框架解耦。
 */
export function runEquivalence<TInput, TOutput>(
  cases: Array<EquivalenceCase<TInput, TOutput>>,
  legacy: (input: TInput) => TOutput,
  current: (input: TInput) => TOutput,
): Array<EquivalenceResult<TOutput>> {
  return cases.map(item => ({
    name: item.name,
    legacy: legacy(item.input),
    current: current(item.input),
  }))
}

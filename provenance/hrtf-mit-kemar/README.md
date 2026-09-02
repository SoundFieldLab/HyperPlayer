# MIT KEMAR HRTF 资产 provenance（切片 08 资产门禁）

> 状态：已审计、已入库（2026-09-03）
> 该记录满足 `stage/08-hse-stage-22-spatial-hrtf.md` 的阻塞门禁：数据来源、
> 版本、许可证、分发义务、hash 与 provenance 全部落档。

## 资产

| 项 | 值 |
|---|---|
| 文件 | `assets/hrtf/mit-kemar-normal-pinna.sofa` |
| 字节数 | 1,171,764 |
| SHA-256 | `e7035994f5fd754058424c061380ee92b1d5ed58fccef2887a4266916616acdf` |
| SOFA 约定 | SimpleFreeFieldHRIR（hrtf-core `sofa.rs` 唯一支持的约定） |
| 内容 | MIT KEMAR 人工头 HRTF，710 个空间位置（仰角 -40°…+90°），普通耳廓版本 |
| 原生采样率 | 44.1 kHz（hrtf-core 按 44.1/48/96 kHz 支持并 Kaiser-sinc 重采样） |

## 来源链

1. **原始测量**：Bill Gardner & Keith Martin，MIT Media Lab，1994-05，
   Perceptual Computing Technical Report #280。
   官方页：https://sound.media.mit.edu/resources/KEMAR.html
2. **SOFA 转换版**：SOFA conventions 数据库 `mit` 条目（sofacoustics.org 托管），
   `mit_kemar_normal_pinna.sofa`，页面标注 2020-03-24。
   下载页：https://sofacoustics.org/data/database/mit/
   下载 URL：https://sofacoustics.org/data/database/mit/mit_kemar_normal_pinna.sofa
3. **入库**：HyperPlayer 于 2026-09-03 从上述 URL 下载，逐字节未修改；
   SHA-256 与下载时一致（见上表）。

## 许可证与分发义务

- 原始条款（MIT Media Lab 页面原文）："provided free with no restrictions on
  use, provided the authors are cited when the data is used in any research or
  commercial application"——允许任意用途与再分发，唯一义务是引用作者。
- 版权：`This data is Copyright 1994 by the MIT Media Laboratory.`
- 引用义务履行位置：`third_party_licenses/MIT-KEMAR-HRTF.txt`（随发行包
  分发）、`THIRD_PARTY_NOTICES.md`「HRTF 数据资产」章节、应用关于页。
- 兼容性：条款为「版权 + 引用条件」形式，非标准 OSS 许可证；已按
  `AGENTS.md` 的合规评估流程单独记录，与 Apache-2.0 项目分发不冲突。

## 校验门禁

- `HSE_TEST_SOFA=assets/hrtf/mit-kemar-normal-pinna.sofa cargo test -p
  hyperplayer-hrtf-core --lib -- --ignored`：通过
  （`accepts_real_simple_free_field_hrir_asset`，完整 710 方向网格解析 +
  重采样验证）。
- 运行时门禁：engine 侧资源加载必须经 `hrtf_core::resource::
  load_verified_resource`（SHA-256 + SimpleFreeFieldHRIR 校验 + 失败回退），
  期望 hash 即本记录所列值；hash 不匹配时拒绝加载并回退旁路。

## 变更纪律

- 替换或更新该资产必须：重新核验上游许可证、更新本记录与 hash、重跑
  校验门禁、并在 `THIRD_PARTY_NOTICES.md` 同步修订。
- 不允许捆绑本记录之外的任何 SOFA/HRTF 数据。

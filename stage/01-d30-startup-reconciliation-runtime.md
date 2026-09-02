# Stage 01：D30 启动 reconciliation runtime

状态：已完成

## 当前基础与目标

engine 已有 reconciliation planner、repository object snapshot/apply、CAS scan 与安全删除；Tauri 尚无生产调用者。本切片新增单实例、可取消的 cache runtime supervisor，在启动时幂等处理过期 partial、orphan 和 DB missing object，并保持 lease/recent 保护。

非目标：周期 quota、Windows 资源探针、album-fill 下载和 Settings UI。

## 前置门禁

- 复用 schema v7 和现有 planner，不建立第二套缓存状态模型。
- 所有路径限制在私有 CAS root；路径穿越、symlink、非普通文件 fail closed。
- 磁盘 IO 不得在持有 repository/runtime 锁时执行。

## 预计修改

新增 `src-tauri/src/cache_runtime.rs`；修改 `lifecycle.rs`、`ports.rs`、`adapters.rs`；必要时小幅扩展 engine 的 `cache_policy.rs`、`repository.rs`、`cache.rs`。

## 实施任务

1. 定义 supervisor handle、取消协议、运行原因和只读状态快照。
2. 把 scan、plan、文件操作、repository apply 组织成可重入 executor。
3. 明确每类动作的文件系统/数据库顺序和崩溃恢复语义。
4. setup 时启动一次，退出时取消并有限等待；禁止重复实例。
5. IO 失败保留诊断结果，不能将失败动作写成成功。

## 测试与验收

覆盖 expired partial、orphan、missing object、leased missing object、路径攻击、步骤失败后重跑收敛、幂等、单实例和退出取消。通过 Tauri fmt、strict Clippy、相关测试及 workspace tests。

不得据此宣称 quota、album-fill 或 D30 产品闭环。建议 runtime + tests + 文档为一个提交。

## 完成后同步

更新 `handover.md`、`tests/ACCEPTANCE_MATRIX.md` 和本文件状态。

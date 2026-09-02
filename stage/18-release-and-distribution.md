# Stage 18：发布与分发闭环

状态：待选择

## 当前基础与目标

Tauri bundler、NSIS/MSI 基础和 GitHub Actions 已存在；updater 密钥、公钥托管、Authenticode、第三方许可证归档、完整安装/升级路径和资源指标尚未闭环。本切片建立可复现、可签名、可升级的 Windows 发布流程。

非目标：在功能/数据迁移未稳定前发布正式版本，或把私钥写入仓库/普通 CI 日志。

## 前置门禁

产品 schema/config 迁移稳定；所有 production dependencies 许可证通过；签名和 updater 密钥由安全外部 secret 管理；发布操作需用户明确授权。

## 预计修改与任务

修改 Tauri config/updater、GitHub Actions、bundle resources、license notices、版本/发布脚本、安装器配置和发布文档。

1. 完成 production dependency/字体/HRTF/素材许可证归档。
2. 设计 updater key 轮换、公钥内置和 artifact provenance。
3. 接 Authenticode 签名与 timestamp，保护证书/密钥。
4. 构建 NSIS/MSI，验证安装、卸载、覆盖升级和降级拒绝。
5. 验证用户数据/schema/config/cache 保留与回滚策略。
6. 在 M6 实测冷启动、空闲/播放内存、安装体积，不预设硬指标。

## 测试与验收

干净 Windows VM 和已安装旧版路径；签名验证、hash、SBOM/notices、updater 正常/损坏/离线、权限/UAC、卸载残留、文件关联和 crash recovery。CI 绿不能替代已签 artifact 的人工发布验收。

不得在私钥、证书或发布渠道未就绪时伪造正式发布完成。

## 完成后同步

更新 handover、验收矩阵、发布 runbook、许可证归档和版本说明。

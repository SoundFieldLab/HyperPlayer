# 调研报告：Stage 16 任务 1 — 网易云「TS oracle 覆盖 vs Rust 已实现」差距清单

> 调研日期：2026-09-03。只读调研，未修改任何代码。依据：`docs/音源-网易云-行为规范.md`（行为参考）、`src/audio-source/netease/`（TS oracle，11 文件 115 函数）、`crates/hyperplayer-source-netease/`（Rust，11 文件约 5950 行）、`src-tauri/` 与 `app/`（接线层）。
> 标注：**缺失** = Rust 完全没有；**行为差异** = oracle 有但 Rust 行为不同；**等价** = 函数名不同但语义覆盖。

## 一、Rust 各源文件职责与完成度

| 文件 | 行数 | 完成度 | 结论 |
|---|---|---|---|
| `crypto.rs` | 374 | 完整实现 | eapi（AES-128-ECB）+ xeapi 全套（HMAC 签名、静态 AES-256-ECB、X25519 ECDH + 自实现 GCM、双层 AES-128-ECB + XOR 旋转、响应 AES-ECB+gzip 解密、公钥密文 hex/base64 双格式解码）。**缺失：encrypt_weapi 未保留（行为差异，规范注明「weapi ⛔ 已绕行 eapi，算法保留备用」）** |
| `domains.rs` | 1243 | 部分实现 | 搜索/首页/歌单/专辑/艺人/推荐/榜单/MV/DJ/收藏/评论/云盘/足迹/社交核心已实现（约 40 方法） |
| `service.rs` | 1703 | 部分实现 | 播放/歌词/QR/引导/防作弊/写保护主干已通；StdSleeper 用 std::thread::sleep（阻塞 async 线程） |
| `mv.rs` | 384 | 部分实现 | mv_play_url（分辨率白名单）/similar/top 有；**缺 getMvSublist** |
| `session.rs` | 165 | 完整实现 | 设备 ID/公钥/会话键/匿名 token/用户 cookie；DPAPI 在 src-tauri credential_vault.rs |
| `transport.rs` | 246 | 部分实现 | 无重试/限流（重试在 service 层，与 oracle 同构）；错误不泄密 |
| `dto.rs` | 452 | 完整 | 全部产品 DTO，camelCase；无 cookie/token 字段 |
| `mapping.rs` | 224 | 完整 | map_track/map_playlist_detail/map_play_info/lyric；免费试听 url 置空 |
| `route.rs` | 1127 | 仅登记 | 115 条 RouteSpec + 契约测试 |
| `error.rs`/`lib.rs` | 7/13 | 完整 | 9 种错误枚举；模块导出 |

crate 内公共方法约 93 个，51 个测试。

## 二、已实现 vs 115 条 RouteSpec 对照

### 直接实现（约 61 条）
searchSongs、getSongDetail、getPlaylistDetail、getPlaylistTracks、getSongPlayInfo、getSongUrl、getLyric、manipulatePlaylistTracks、createLoginQrKey、checkLoginQrState、getRecommendSongs、getRecommendPlaylists、getPersonalizedPlaylists、getPersonalFm、getPersonalFmBatched、trashFmSong、getToplistDetail、getNewSongs、getAlbumDetail、subscribeAlbum、getTopAlbums、getArtistOverview、getArtistSongs、subscribeArtist、getTopArtists、getMvDetail、getMvAll、getMvPlayInfo、getSimilarMvs、getTopMvs、subscribeMv、getHotDjRadios、getDjPrograms、subscribeDjRadio、createPlaylist、deletePlaylist、updatePlaylist、subscribePlaylist、getTopPlaylists、getUserAccount、getUserDetail、getUserPlaylists、getVipInfo、getUserEvents、getFollowedEvents、getMsgNotices、getUserFollows、followUser、getComments、addComment、replyComment、likeComment、deleteComment、likeSong、getLikeList、getCloudDiskSongs、getCloudSongUrl、deleteCloudSong、getListenDataTotal、getListenDataReport、getListenDataSongRank、getQualityCandidates、getLoginQrImageUrl 等。

### 关键缺失（RouteSpec 登记、crate 无 handler，约 42 条）
- 搜索：searchHot、searchSuggest
- 歌曲：getSongQualityLevels、getSongWiki、getSimilarSongs、getSongRelatedBlogs、getSongDetailEnriched
- 播放：getPlaymodeIntelligenceList
- 歌单：getPlaylistCategories、getHighQualityPlaylists、getSimilarPlaylists、getSimilarPlaylistsBySong、getRelatedPlaylists、updatePlaylistCover（NOS 上传）、getAlbumCoversBatch
- 推荐：getPersonalizedNewSongs、dislikeRecommendSong
- 专辑：getAlbumSublist
- 艺人：getArtistAlbums、getArtistMvs、getArtistList、getArtistSublist
- MV：getMvSublist
- DJ：getDjCategories、getDjProgramToplist、getDjRecommend、getDjSublist、getPersonalizedDjRadios
- 社交：checkSongsLiked、getCommentFloor、getHotComments、getMsgComments、getUserFolloweds
- 用户：getRecentPlays、getUserPlayRecord、getUserLevel、getUserSubcount、getStylePreference、getLoginStatus
- 足迹：getListenDataToday、getJourneyOverview
- 杂项：getBanner
- 打卡：scrobble（clientlog 通道，全栈缺失）

### 语义等价
- getToplistSongs/getRankSongs → 用 playlist_detail 打开榜单歌单

## 三、行为差异清单

1. **响应 code 判定**：TS 接受 code===0 与 SPECIAL_OK_CODES={201,302,400,502,800,801,802,803}；Rust 只接受 200。
2. **设备 Cookie 画像**：TS 发 __remember_me/ntes_kaola_ad/_ntes_nuid/_ntes_nnid/WNMCID/WEVNSM/osver/os/channel/appver/deviceId/NMTID/MUSIC_A；Rust 只有 os/deviceId(+MUSIC_U|MUSIC_A)。xeapi 请求头 TS 发 x-aeapi/x-os/x-osver/x-appver/x-sdeviceid/x-buildver/x-music-u；Rust 仅 X-Client-Enc-State/x-deviceid/Cookie。
3. **weapi 算法未保留**（备用缺失）。
4. **探索聚合**：oracle getExploreNetease/getExploreNext 是 8/10/5 项 allSettled 并行带渠道模型；Rust public_explore 4 分区无渠道模型、无 explore-next。
5. **歌单详情参数**：Rust {id,n:100000,s:8} vs 规范 {id,n:1000}+trackIds 二次拉取。
6. **StdSleeper 阻塞 sleep**。
7. **评论翻阅**：Rust pageNo+cursor+sortType:99 vs TS pageTime 游标；getHotComments/getCommentFloor 缺失。
8. 匿名注册种子（os.tmpdir()/anonymous_token）两侧均未实现（一致）。

## 四、TS oracle 能力组（按文件）
config.ts（域名/密钥/SPECIAL_OK_CODES/榜单 ID/评论前缀）、crypto.ts（weapi 备用/eapi/xeapi 全套）、session.ts、request.ts（三通道/设备画像/ensureNetworkReady/匿名注册/withRetry/clientlog）、client-core.ts（搜索/歌曲/音质/播放/歌词/歌单/推荐/榜单/专辑）、client-catalog.ts（专辑/艺人/MV/DJ/歌单发现与写）、client-social.ts（like/评论×6/动态/消息/关注）、client-user.ts（账号/QR/详情/歌单/听歌记录/scrobble/足迹/云盘/VIP）、client-explore.ts（explore 聚合）、index/types.ts。

## 五、接线层现状

### src-tauri/src/commands/netease.rs（30 command 全部注册）
覆盖 status/search/mvs/mv_detail/dj_radios/dj_programs/charts/new_songs/listen_total/listen_report/listen_song_rank/followed_events/user_events/notices/home/album_detail/playlist_detail/artist_detail/personal_fm/account/favorites/comments/follows/cloud/image/prepare_mutation/commit_mutation/start_qr_login/poll_qr_login/logout。
缺失：searchHot/suggest/banner/歌单目录/相似/艺人专辑列表/热评/楼中楼/scrobble/封面更新/不喜欢/checkSongsLiked/等级/足迹聚合等。

### adapters.rs NeteaseAdapter
- 会话：DPAPI 持久化（credential_vault.rs：WindowsDpapiVault + entropy + 原子替换 + zeroize）、TTL 过期删除、DeviceIdRng 恢复
- 登录：LoginState + generation 防竞态 + QR 轮询 803 cookie 捕获
- 权益：EntitlementProvider（账号级缓存 + fail-closed）
- 播放：resolve_official（VIP 校验 + 预算 12s + TrustedMediaUrl）、netease_image 代理
- 写操作：prepare_mutation/commit_mutation（18 种 mutation，确认式）

### app/ 前端
- 已接：home（匿名/登录态）、search（仅歌曲 tab）、library（favorites/account/cloud/follows）、discover（charts/newSongs/MV 列表/DJ）、album/artist/playlist 详情、account（QR 登录）、settings（neteaseEnabled）、navigation 双域
- 占位/缺失：MessagesView「此功能当前不可用」、足迹无页面、MV 播放标注「后端尚未提供」、搜索子 tab 缺口、评论只读无写 UI、Banner/热词/联想、歌单分类/精选/相似、艺人专辑/MV 列表、热评/楼中楼、scrobble 无调用

## 六、敏感信息暴露风险点
1. 当前无已确证泄露路径（crate 零日志、DTO 无 cookie、序列化防泄露测试齐全）
2. Session::current_user_cookie() 是 pub API——未来 command 不得透传 Session
3. eapi 请求体内嵌明文 MUSIC_U——若加 reqwest trace 日志即泄露，日志必须脱敏
4. dpapi 文件为 DPAPI 用户级保护（同用户任意进程可解）；应确认位置在 app_data_dir
5. authorized_cookie 匹配任何 803 响应——建议收口到登录路径

## 七、Top 10 关键差距（按产品闭环影响排序）
1. scrobble 听歌打卡全栈缺失
2. updatePlaylistCover 缺失（NOS 上传）
3. 探索聚合行为差异（无渠道模型/无 explore-next）
4. 歌单发现面缺失（categories/highquality/similar×2/related 五条）
5. 搜索补全缺失（searchHot/searchSuggest + 前端只有歌曲 tab）
6. 评论只读闭环（hot/floor/checkSongsLiked + 前端无写 UI）
7. 艺人/专辑收藏闭环（artist albums/mvs/list/sublist、album sublist）
8. Banner 缺失
9. 个人中心/足迹不完整
10. 行为差异组（code 判定、设备画像、xeapi 头、weapi 备用）——需联网对拍验证

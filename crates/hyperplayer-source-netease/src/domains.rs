use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashSet},
    time::Duration,
};

use crate::{
    dto::*,
    mapping::array,
    service::{NeteaseService, PublicExplore, PublicExploreSection, Sleeper},
    transport::Transport,
    Error, Result,
};

impl<T: Transport, S: Sleeper> NeteaseService<T, S> {
    pub async fn album_detail(&self, id: u64) -> Result<AlbumDetail> {
        positive_id(id)?;
        let body = self
            .eapi(
                &format!("/api/v1/album/{id}"),
                json!({}),
                Duration::from_secs(12),
            )
            .await?;
        let album = body.get("album").unwrap_or(&Value::Null);
        if !album.is_object() {
            return Err(Error::InvalidResponse("缺少 album".into()));
        }
        Ok(AlbumDetail {
            album: map_album(album, id),
            description: text(album, "description"),
            publish_time_ms: number(album, "publishTime"),
            artist: album
                .get("artist")
                .filter(|v| v.is_object())
                .map(map_artist),
            tracks: values(&body, "songs").map(map_track).collect(),
        })
    }

    pub async fn top_albums(&self, area: &str, page: PageRequest) -> Result<Vec<Album>> {
        let page = page.bounded(100);
        let body = self
            .eapi(
                "/api/discovery/new/albums/area",
                json!({"area": non_empty(area, "专辑地区")?, "limit":page.limit, "offset":page.offset, "type":"new", "total":false, "rcmd":true}),
                Duration::from_secs(12),
            )
            .await?;
        Ok(values(&body, "albums").map(|v| map_album(v, 0)).collect())
    }

    pub async fn subscribe_album(&self, id: u64, subscribe: bool) -> Result<MutationResult> {
        positive_id(id)?;
        let action = if subscribe { "sub" } else { "unsub" };
        self.protected_write(&format!("/api/album/{action}"), json!({"id":id}), false)
            .await?;
        Ok(success())
    }

    pub async fn top_playlists(
        &self,
        category: &str,
        order: &str,
        page: PageRequest,
    ) -> Result<Vec<PlaylistSummary>> {
        if !matches!(order, "hot" | "new") {
            return Err(Error::Validation("歌单排序仅支持 hot/new".into()));
        }
        let page = page.bounded(100);
        let body = self
            .eapi(
                "/api/playlist/list",
                json!({"cat":non_empty(category, "歌单分类")?, "order":order, "limit":page.limit, "offset":page.offset, "total":true}),
                Duration::from_secs(12),
            )
            .await?;
        Ok(values(&body, "playlists").map(map_playlist).collect())
    }

    pub async fn user_playlists(
        &self,
        user_id: u64,
        page: PageRequest,
    ) -> Result<Vec<PlaylistSummary>> {
        positive_id(user_id)?;
        let page = page.bounded(100);
        let body = self
            .eapi(
                "/api/user/playlist",
                json!({"uid":user_id,"limit":page.limit,"offset":page.offset,"includeVideo":true}),
                Duration::from_secs(12),
            )
            .await?;
        Ok(values(&body, "playlist").map(map_playlist).collect())
    }

    pub async fn create_playlist(&self, name: &str, private: bool) -> Result<PlaylistSummary> {
        Self::validate_create_playlist(name)?;
        let body = self
            .protected_write(
                "/api/playlist/create",
                json!({"name":name.trim(),"privacy":if private {"10"} else {"0"},"type":"NORMAL"}),
                false,
            )
            .await?;
        body.get("playlist")
            .filter(|value| value.is_object())
            .map(map_playlist)
            .ok_or_else(|| Error::InvalidResponse("创建歌单响应缺少 playlist".into()))
    }

    pub async fn delete_playlist(&self, id: u64) -> Result<MutationResult> {
        positive_id(id)?;
        self.protected_write(
            "/api/playlist/remove",
            json!({"ids":format!("[{id}]")}),
            false,
        )
        .await?;
        Ok(success())
    }

    pub async fn update_playlist(
        &self,
        id: u64,
        name: Option<&str>,
        description: &str,
        tags: &[String],
    ) -> Result<MutationResult> {
        positive_id(id)?;
        Self::validate_update_playlist(name, description)?;
        if tags.len() > 3 || tags.iter().any(|tag| tag.trim().is_empty()) {
            return Err(Error::Validation("歌单标签最多 3 个且不能为空".into()));
        }
        let name = name.unwrap_or_default();
        let tags = tags.join(";");
        self.protected_write(
            "/api/batch",
            json!({
                "/api/playlist/desc/update":json!({"id":id,"desc":description}).to_string(),
                "/api/playlist/tags/update":json!({"id":id,"tags":tags}).to_string(),
                "/api/playlist/update/name":json!({"id":id,"name":name}).to_string()
            }),
            false,
        )
        .await?;
        Ok(success())
    }

    pub async fn subscribe_playlist(&self, id: u64, subscribe: bool) -> Result<MutationResult> {
        positive_id(id)?;
        let action = if subscribe {
            "subscribe"
        } else {
            "unsubscribe"
        };
        self.protected_write(&format!("/api/playlist/{action}"), json!({"id":id}), true)
            .await?;
        Ok(success())
    }

    pub async fn artist_overview(&self, id: u64) -> Result<ArtistOverview> {
        positive_id(id)?;
        let base = self
            .eapi(
                &format!("/api/v1/artist/{id}"),
                json!({}),
                Duration::from_secs(12),
            )
            .await?;
        let artist_value = base.get("artist").unwrap_or(&Value::Null);
        if !artist_value.is_object() {
            return Err(Error::InvalidResponse("缺少 artist".into()));
        }
        let mut artist = map_artist_summary(artist_value);
        let hot_songs = values(&base, "hotSongs").map(map_track).collect();
        let (detail, description, followers) = futures::join!(
            self.eapi(
                "/api/artist/head/info/get",
                json!({"id":id}),
                Duration::from_secs(12),
            ),
            self.eapi(
                "/api/artist/introduction",
                json!({"id":id}),
                Duration::from_secs(12),
            ),
            self.eapi(
                "/api/artist/follow/count/get",
                json!({"id":id}),
                Duration::from_secs(12),
            ),
        );
        if let Ok(detail) = detail {
            artist.brief_description =
                text(detail.get("data").unwrap_or(&Value::Null), "briefDesc")
                    .or(artist.brief_description);
        }
        let introduction = description.ok().and_then(|body| {
            let joined = values(&body, "introduction")
                .filter_map(|item| text(item, "txt"))
                .collect::<Vec<_>>()
                .join("\n");
            (!joined.is_empty()).then_some(joined)
        });
        let fans_count = followers
            .ok()
            .and_then(|body| number(body.get("data").unwrap_or(&Value::Null), "fansCnt"));
        Ok(ArtistOverview {
            artist,
            hot_songs,
            introduction,
            fans_count,
        })
    }

    pub async fn artist_songs(
        &self,
        id: u64,
        order: &str,
        page: PageRequest,
    ) -> Result<Vec<Track>> {
        positive_id(id)?;
        if !matches!(order, "hot" | "time") {
            return Err(Error::Validation("歌手歌曲排序仅支持 hot/time".into()));
        }
        let page = page.bounded(500);
        let body = self
            .eapi(
                "/api/v1/artist/songs",
                json!({"id":id,"private_cloud":"true","work_type":1,"order":order,"limit":page.limit,"offset":page.offset}),
                Duration::from_secs(12),
            )
            .await?;
        Ok(values(&body, "songs").map(map_track).collect())
    }

    pub async fn subscribe_artist(&self, id: u64, subscribe: bool) -> Result<MutationResult> {
        positive_id(id)?;
        let action = if subscribe { "sub" } else { "unsub" };
        self.protected_write(
            &format!("/api/artist/{action}"),
            json!({"artistId":id,"artistIds":format!("[{id}]")}),
            false,
        )
        .await?;
        Ok(success())
    }

    pub async fn recommend_songs(&self) -> Result<Vec<Track>> {
        let body = self
            .eapi(
                "/api/v3/discovery/recommend/songs",
                json!({}),
                Duration::from_secs(12),
            )
            .await?;
        let data = body.get("data").unwrap_or(&Value::Null);
        Ok(values(data, "dailySongs").map(map_track).collect())
    }

    pub async fn recommend_playlists(&self) -> Result<Vec<PlaylistSummary>> {
        let body = self
            .eapi(
                "/api/v1/discovery/recommend/resource",
                json!({}),
                Duration::from_secs(12),
            )
            .await?;
        Ok(values(&body, "recommend").map(map_playlist).collect())
    }

    /// 电台分类（oracle：weapi `/api/djradio/category/get`）。
    pub async fn dj_categories(&self) -> Result<Vec<PlaylistCategory>> {
        let body = self
            .eapi(
                "/api/djradio/category/get",
                json!({}),
                Duration::from_secs(12),
            )
            .await?;
        Ok(values(&body, "categories")
            .map(|item| PlaylistCategory {
                name: string(item, "name"),
                id: string(item, "id"),
            })
            .collect())
    }

    /// 电台推荐（oracle：weapi `/api/djradio/personalize/rcmd`）。
    pub async fn dj_recommend(&self, limit: usize) -> Result<Vec<DjRadio>> {
        let body = self
            .eapi(
                "/api/djradio/personalize/rcmd",
                json!({"limit": limit.min(100)}),
                Duration::from_secs(12),
            )
            .await?;
        Ok(values(&body, "djRadios").map(map_dj_radio).collect())
    }

    /// 电台节目榜（oracle：weapi `/api/program/toplist/v1`）。
    pub async fn dj_program_toplist(&self, page: PageRequest) -> Result<Vec<DjProgram>> {
        let page = page.bounded(100);
        let body = self
            .eapi(
                "/api/program/toplist/v1",
                json!({"limit": page.limit, "offset": page.offset}),
                Duration::from_secs(12),
            )
            .await?;
        Ok(values(&body, "toplist")
            .chain(values(&body, "programs"))
            .map(map_dj_program)
            .collect())
    }

    /// 我订阅的电台（oracle：weapi `/api/djradio/get/subed`）。
    pub async fn dj_sublist(&self, page: PageRequest) -> Result<Vec<DjRadio>> {
        let page = page.bounded(100);
        let body = self
            .eapi(
                "/api/djradio/get/subed",
                json!({"limit": page.limit, "offset": page.offset, "total": true}),
                Duration::from_secs(12),
            )
            .await?;
        Ok(values(&body, "djRadios").map(map_dj_radio).collect())
    }

    /// 个性化电台（oracle：weapi `/api/personalized/djprogram`）。
    pub async fn personalized_dj_radios(&self, limit: usize) -> Result<Vec<DjRadio>> {
        let body = self
            .eapi(
                "/api/personalized/djprogram",
                json!({"limit": limit.min(100)}),
                Duration::from_secs(12),
            )
            .await?;
        Ok(values(&body, "result").map(map_dj_radio).collect())
    }

    /// 歌曲百科（oracle：eapi `/api/song/play/about/block/page`）。
    pub async fn song_wiki(&self, id: u64) -> Result<Value> {
        positive_id(id)?;
        self.eapi(
            "/api/song/play/about/block/page",
            json!({"songId": id}),
            Duration::from_secs(12),
        )
        .await
    }

    /// 歌曲相关播客（oracle：公开 POST `/api/album/blog`，无加密）。
    pub async fn song_related_blogs(&self, album_id: u64, page: u64, count: u64) -> Result<Value> {
        positive_id(album_id)?;
        self.public_post_form(
            "/api/album/blog",
            &[
                ("albumId", album_id.to_string()),
                ("page", page.max(1).to_string()),
                ("count", count.clamp(1, 50).to_string()),
                ("csrf_token", String::new()),
            ],
        )
        .await
    }

    /// 歌曲详情聚合：详情 + 音质档位 + 专辑扩展（oracle `getSongDetailEnriched` 语义）。
    pub async fn song_detail_enriched(&self, id: u64) -> Result<EnrichedSong> {
        positive_id(id)?;
        let detail = self
            .song_detail(&[id])
            .await?
            .into_iter()
            .find(|item| item.id == id)
            .ok_or_else(|| Error::InvalidResponse("歌曲不存在".into()))?;
        let quality_levels = self.song_quality_levels(id).await.unwrap_or_default();
        let album_extra = if detail.album.id > 0 {
            self.album_detail(detail.album.id)
                .await
                .ok()
                .map(|album| AlbumExtra {
                    company: album.description.unwrap_or_default(),
                    publish_time_ms: album.publish_time_ms,
                })
        } else {
            None
        };
        Ok(EnrichedSong {
            track: detail,
            quality_levels,
            album_extra,
        })
    }

    /// 智能播放列表（oracle：eapi `/api/playmode/intelligence/list`）。
    pub async fn playmode_intelligence_list(
        &self,
        song_id: u64,
        playlist_id: u64,
        count: usize,
    ) -> Result<Vec<Track>> {
        positive_id(song_id)?;
        positive_id(playlist_id)?;
        let body = self
            .eapi(
                "/api/playmode/intelligence/list",
                json!({
                    "songId": song_id,
                    "type": "fromPlayOne",
                    "playlistId": playlist_id,
                    "startMusicId": song_id,
                    "count": count.clamp(1, 100)
                }),
                Duration::from_secs(12),
            )
            .await?;
        // oracle 返回原始 body；`data` 为歌曲对象数组（智能播放列表语义）。
        Ok(values(&body, "data").map(map_track).collect())
    }

    /// 相关歌单（oracle：公开网页解析 `/playlist?id=` HTML）。
    pub async fn related_playlists(&self, playlist_id: u64) -> Result<Vec<PlaylistSummary>> {
        positive_id(playlist_id)?;
        let html = self
            .public_get_text(&format!("/playlist?id={playlist_id}"))
            .await?;
        Ok(parse_related_playlists(&html))
    }

    /// 批量专辑封面（oracle：逐张 album_detail 聚合；searchSongs 封面补齐按
    /// 批 3 并发 + 100/200ms 间隔限流，本串行实现以 300ms 等效节流防风控）。
    pub async fn album_covers_batch(&self, ids: &[u64]) -> Result<Vec<AlbumCover>> {
        let mut out = Vec::new();
        for (index, id) in ids.iter().enumerate() {
            if index > 0 {
                self.sleep(Duration::from_millis(300)).await;
            }
            if let Ok(album) = self.album_detail(*id).await {
                out.push(AlbumCover {
                    id: *id,
                    cover_url: album.album.pic_url,
                });
            }
        }
        Ok(out)
    }

    /// 相似艺人（oracle：weapi `/api/discovery/simiArtist`）。
    pub async fn similar_artists(&self, id: u64) -> Result<Vec<ArtistSummary>> {
        positive_id(id)?;
        let body = self
            .eapi(
                "/api/discovery/simiArtist",
                json!({"artistid": id}),
                Duration::from_secs(12),
            )
            .await?;
        Ok(values(&body, "artists").map(map_artist_summary).collect())
    }

    /// 更新歌单封面（oracle：NOS 上传 `/api/nos/token/alloc` → 裸传 → cover/update）。
    pub async fn update_playlist_cover(
        &self,
        playlist_id: u64,
        image_bytes: &[u8],
        mime_type: &str,
    ) -> Result<MutationResult> {
        positive_id(playlist_id)?;
        if image_bytes.is_empty() || image_bytes.len() > 10 * 1024 * 1024 {
            return Err(Error::Validation("封面图片无效或体积过大".into()));
        }
        let body = self
            .protected_write(
                "/api/nos/token/alloc",
                json!({
                    "bucket": "yyimgs",
                    "ext": "jpg",
                    "filename": format!("playlist-{playlist_id}.jpg"),
                    "local": false,
                    "nos_product": 0,
                    "return_body": "{\"code\":200,\"size\":\"$(ObjectSize)\"}",
                    "type": "other",
                }),
                false,
            )
            .await?;
        let result = body.get("result").unwrap_or(&Value::Null);
        let object_key = string(result, "objectKey");
        let token = string(result, "token");
        let doc_id = string(result, "docId");
        if object_key.is_empty() || token.is_empty() || doc_id.is_empty() {
            return Err(Error::InvalidResponse("封面上传凭证获取失败".into()));
        }
        let mut headers = BTreeMap::new();
        headers.insert("x-nos-token".into(), token);
        headers.insert("Content-Type".into(), mime_type.into());
        let upload_url = format!(
            "https://nosup-hz1.127.net/yyimgs/{object_key}?offset=0&complete=true&version=1.0"
        );
        self.raw_post_bytes(&upload_url, &headers, image_bytes.to_vec())
            .await
            .map_err(|_| Error::Transport("封面上传失败".into()))?;
        self.protected_write(
            "/api/playlist/cover/update",
            json!({"id": playlist_id, "coverImgId": doc_id}),
            false,
        )
        .await?;
        Ok(success())
    }

    /// 无限推荐下一批（oracle `getExploreNext` 语义：批次轮换地区 + 去重补池）。
    pub async fn explore_next(
        &self,
        count: usize,
        batch: usize,
        exclude: &[u64],
    ) -> Result<ExploreNextResult> {
        let count = count.clamp(10, 60);
        let area_ids = [0_u16, 7, 96, 8, 16];
        let area = area_ids[(batch.saturating_sub(1)) % area_ids.len()];
        let logged_in = self.session().is_logged_in();

        let mut candidates: Vec<Track> = Vec::new();
        if logged_in {
            if let Ok(tracks) = self.personal_fm_batched(count, 6).await {
                candidates.extend(tracks);
            }
            if let Ok(tracks) = self.recommend_songs().await {
                candidates.extend(tracks);
            }
        }
        if let Ok(tracks) = self.personalized_new_songs(100).await {
            candidates.extend(tracks);
        }
        if let Ok(tracks) = self.new_songs(area).await {
            candidates.extend(tracks);
        }
        if let Ok(playlists) = self
            .personalized_playlists(PageRequest {
                limit: 30,
                offset: 0,
            })
            .await
        {
            let rotated = if playlists.is_empty() {
                Vec::new()
            } else {
                let start = (batch * 3) % playlists.len();
                playlists
                    .iter()
                    .cycle()
                    .skip(start)
                    .take(4)
                    .cloned()
                    .collect::<Vec<_>>()
            };
            for playlist in rotated {
                if let Ok(tracks) = self
                    .playlist_tracks(
                        playlist.id,
                        PageRequest {
                            limit: 80,
                            offset: 0,
                        },
                    )
                    .await
                {
                    candidates.extend(tracks);
                }
            }
        }

        let mut seen: HashSet<u64> = exclude.iter().copied().collect();
        let mut songs = Vec::new();
        for track in candidates {
            if track.id == 0 || seen.contains(&track.id) {
                continue;
            }
            seen.insert(track.id);
            songs.push(track);
            if songs.len() >= count {
                break;
            }
        }
        Ok(ExploreNextResult {
            songs,
            batch,
            has_more: true,
        })
    }

    /// 聚合未登录即可访问的发现内容。单个上游失败只标记对应分区；全部失败时返回错误。
    pub async fn public_explore(&self) -> Result<PublicExplore> {
        let page = PageRequest {
            limit: 30,
            offset: 0,
        };
        let (playlists, new_songs, charts, popular_artists) = futures::join!(
            self.personalized_playlists(page),
            self.new_songs(0),
            self.charts(),
            self.popular_artists(page),
        );

        let mut unavailable_sections = Vec::new();
        let playlists = degrade_section(
            playlists,
            PublicExploreSection::Playlists,
            &mut unavailable_sections,
        );
        let new_songs = degrade_section(
            new_songs,
            PublicExploreSection::NewSongs,
            &mut unavailable_sections,
        );
        let charts = degrade_section(
            charts,
            PublicExploreSection::Charts,
            &mut unavailable_sections,
        );
        let popular_artists = degrade_section(
            popular_artists,
            PublicExploreSection::PopularArtists,
            &mut unavailable_sections,
        );

        if unavailable_sections.len() == 4 {
            return Err(Error::Transport("网易云公共发现内容暂不可用".into()));
        }

        Ok(PublicExplore {
            playlists,
            new_songs,
            charts,
            popular_artists,
            unavailable_sections,
        })
    }

    /// 热搜词（oracle：eapi `/api/search/hot` `{type:1111}`）。
    pub async fn search_hot(&self) -> Result<Vec<HotWord>> {
        let body = self
            .eapi(
                "/api/search/hot",
                json!({"type":1111}),
                Duration::from_secs(12),
            )
            .await?;
        Ok(body
            .get("data")
            .filter(|data| data.is_object())
            .map(|data| {
                array(data, "hots")
                    .map(|item| HotWord {
                        word: string(item, "first"),
                        score: number(item, "score").unwrap_or(0),
                    })
                    .collect()
            })
            .unwrap_or_default())
    }

    /// 搜索建议（oracle：weapi `/api/search/suggest/keyword`；crate 统一 eapi 通道）。
    pub async fn search_suggest(&self, keywords: &str) -> Result<SearchSuggestions> {
        let body = self
            .eapi(
                "/api/search/suggest/keyword",
                json!({"s": non_empty(keywords, "搜索关键词")?}),
                Duration::from_secs(12),
            )
            .await?;
        let result = body.get("result").unwrap_or(&Value::Null);
        let order = values(result, "order")
            .filter_map(|item| item.as_str().map(str::to_owned))
            .collect();
        Ok(SearchSuggestions {
            songs: values(result, "songs")
                .map(|item| SuggestSong {
                    id: number(item, "id").unwrap_or(0),
                    name: string(item, "name"),
                    artists: values(item, "artists").map(map_artist).collect(),
                    album: item
                        .get("album")
                        .filter(|v| v.is_object())
                        .map(|v| map_album(v, 0))
                        .unwrap_or_else(|| Album {
                            id: 0,
                            name: String::new(),
                            pic_url: None,
                        }),
                })
                .collect(),
            artists: values(result, "artists").map(map_artist).collect(),
            albums: values(result, "albums").map(|v| map_album(v, 0)).collect(),
            playlists: values(result, "playlists").map(map_playlist).collect(),
            order,
        })
    }

    /// 首页轮播（oracle：weapi `/api/v2/banner/get` `{clientType:"iphone"}`）。
    pub async fn banner(&self) -> Result<Vec<BannerItem>> {
        let body = self
            .eapi(
                "/api/v2/banner/get",
                json!({"clientType":"iphone"}),
                Duration::from_secs(12),
            )
            .await?;
        Ok(values(&body, "banners")
            .map(|item| BannerItem {
                id: number(item, "targetId").unwrap_or(0),
                title: string(item, "title"),
                image_url: string(item, "imageUrl"),
                target_url: string(item, "url"),
                target_type: number(item, "targetType").unwrap_or(0),
            })
            .collect())
    }

    /// 歌单分类目录（oracle：eapi `/api/playlist/catalogue`）。
    pub async fn playlist_categories(&self) -> Result<Vec<PlaylistCategory>> {
        let body = self
            .eapi(
                "/api/playlist/catalogue",
                json!({}),
                Duration::from_secs(12),
            )
            .await?;
        let mut out = Vec::new();
        for key in ["sub", "categories"] {
            out.extend(values(&body, key).map(|item| PlaylistCategory {
                name: string(item, "name"),
                id: string(item, "id"),
            }));
        }
        Ok(out)
    }

    /// 精品歌单（oracle：weapi `/api/playlist/highquality/list`）。
    pub async fn high_quality_playlists(
        &self,
        category: &str,
        page: PageRequest,
    ) -> Result<Vec<PlaylistSummary>> {
        let page = page.bounded(100);
        let body = self
            .eapi(
                "/api/playlist/highquality/list",
                json!({"cat": non_empty(category, "歌单分类")?, "limit":page.limit, "offset":page.offset, "total":true}),
                Duration::from_secs(12),
            )
            .await?;
        Ok(values(&body, "playlists").map(map_playlist).collect())
    }

    /// 相似歌单（oracle：eapi `/api/discovery/simiPlaylist` `{songid}`）。
    pub async fn similar_playlists(
        &self,
        song_id: u64,
        limit: usize,
    ) -> Result<Vec<PlaylistSummary>> {
        positive_id(song_id)?;
        let body = self
            .eapi(
                "/api/discovery/simiPlaylist",
                json!({"songid": song_id, "limit": limit.min(100), "offset": 0}),
                Duration::from_secs(12),
            )
            .await?;
        Ok(values(&body, "playlists").map(map_playlist).collect())
    }

    /// 相似歌单（按歌单 id 关联；oracle：eapi `/api/discovery/simiPlaylist`，id 语义兼容）。
    pub async fn similar_playlists_by_playlist(
        &self,
        playlist_id: u64,
        limit: usize,
    ) -> Result<Vec<PlaylistSummary>> {
        positive_id(playlist_id)?;
        let body = self
            .eapi(
                "/api/discovery/simiPlaylist",
                json!({"songid": playlist_id, "limit": limit.min(100), "offset": 0}),
                Duration::from_secs(12),
            )
            .await?;
        Ok(values(&body, "playlists").map(map_playlist).collect())
    }

    /// 艺人专辑（oracle：公开 GET `/api/artist/albums/{id}`；crate 统一 eapi 通道）。
    pub async fn artist_albums(&self, artist_id: u64, page: PageRequest) -> Result<Vec<Album>> {
        positive_id(artist_id)?;
        let page = page.bounded(100);
        let body = self
            .eapi(
                &format!("/api/artist/albums/{artist_id}"),
                json!({"limit": page.limit, "offset": page.offset, "total": true}),
                Duration::from_secs(12),
            )
            .await?;
        Ok(values(&body, "hotAlbums")
            .map(|v| map_album(v, 0))
            .collect())
    }

    /// 艺人 MV（oracle：weapi `/api/artist/mvs`）。
    pub async fn artist_mvs(&self, artist_id: u64, page: PageRequest) -> Result<Vec<MvSummary>> {
        positive_id(artist_id)?;
        let page = page.bounded(100);
        let body = self
            .eapi(
                "/api/artist/mvs",
                json!({"artistId": artist_id, "limit": page.limit, "offset": page.offset, "total": true}),
                Duration::from_secs(12),
            )
            .await?;
        Ok(values(&body, "mvs").map(map_mv_summary).collect())
    }

    /// 艺人列表（oracle：weapi `/api/v1/artist/list`）。
    pub async fn artist_list(
        &self,
        category: u64,
        initial: &str,
        page: PageRequest,
    ) -> Result<Vec<ArtistSummary>> {
        let page = page.bounded(100);
        let body = self
            .eapi(
                "/api/v1/artist/list",
                json!({"type": category, "area": non_empty(initial, "艺人首字母")?, "limit": page.limit, "offset": page.offset, "total": true}),
                Duration::from_secs(12),
            )
            .await?;
        Ok(values(&body, "artists").map(map_artist_summary).collect())
    }

    /// 我收藏的艺人（oracle：weapi `/api/artist/sublist`）。
    pub async fn artist_sublist(&self, page: PageRequest) -> Result<Vec<ArtistSummary>> {
        let page = page.bounded(100);
        let body = self
            .eapi(
                "/api/artist/sublist",
                json!({"limit": page.limit, "offset": page.offset, "total": true}),
                Duration::from_secs(12),
            )
            .await?;
        Ok(values(&body, "artists").map(map_artist_summary).collect())
    }

    /// 我收藏的专辑（oracle：weapi `/api/album/sublist`）。
    pub async fn album_sublist(&self, page: PageRequest) -> Result<Vec<Album>> {
        let page = page.bounded(100);
        let body = self
            .eapi(
                "/api/album/sublist",
                json!({"limit": page.limit, "offset": page.offset, "total": true}),
                Duration::from_secs(12),
            )
            .await?;
        Ok(body
            .get("data")
            .filter(|data| data.is_object())
            .map(|data| array(data, "albums").map(|v| map_album(v, 0)).collect())
            .unwrap_or_default())
    }

    /// 我收藏的 MV（oracle：weapi `/api/cloudvideo/allvideo/sublist`）。
    pub async fn mv_sublist(&self, page: PageRequest) -> Result<Vec<MvSummary>> {
        let page = page.bounded(100);
        let body = self
            .eapi(
                "/api/cloudvideo/allvideo/sublist",
                json!({"limit": page.limit, "offset": page.offset, "total": true}),
                Duration::from_secs(12),
            )
            .await?;
        Ok(body
            .get("data")
            .filter(|data| data.is_object())
            .map(|data| array(data, "sublist").map(map_mv_summary).collect())
            .unwrap_or_default())
    }

    /// 个性化推荐新歌（oracle：weapi `/api/personalized/newsong`）。
    pub async fn personalized_new_songs(&self, limit: usize) -> Result<Vec<Track>> {
        let body = self
            .eapi(
                "/api/personalized/newsong",
                json!({"limit": limit.min(100), "areaId": 0}),
                Duration::from_secs(12),
            )
            .await?;
        Ok(body
            .get("result")
            .filter(|result| result.is_object())
            .map(|result| array(result, "songs").map(map_track).collect())
            .unwrap_or_default())
    }

    /// 不喜欢推荐（写操作；oracle：weapi `/api/v2/discovery/recommend/dislike`）。
    pub async fn dislike_recommend_song(&self, id: u64) -> Result<MutationResult> {
        positive_id(id)?;
        self.protected_write(
            "/api/v2/discovery/recommend/dislike",
            json!({"id": id}),
            false,
        )
        .await?;
        Ok(success())
    }

    /// 检查歌曲是否已喜欢（oracle：eapi `/api/song/like/check`，参数键 trackIds）。
    pub async fn check_songs_liked(&self, ids: &[u64]) -> Result<Vec<LikedState>> {
        if ids.is_empty() {
            return Ok(vec![]);
        }
        let ids_json = ids.iter().map(u64::to_string).collect::<Vec<_>>().join(",");
        let body = self
            .eapi(
                "/api/song/like/check",
                json!({"trackIds": format!("[{ids_json}]")}),
                Duration::from_secs(12),
            )
            .await?;
        Ok(values(&body, "ids")
            .zip(ids.iter())
            .map(|(item, id)| LikedState {
                song_id: *id,
                liked: item.as_i64().is_some_and(|v| v != 0),
            })
            .collect())
    }

    /// 热评（oracle：weapi `/api/v1/resource/hotcomments/{prefix}{id}`）。
    pub async fn hot_comments(
        &self,
        resource: CommentResource,
        id: u64,
        page: PageRequest,
    ) -> Result<HotCommentPage> {
        positive_id(id)?;
        let page = page.bounded(100);
        let rid = format!("{}{}", resource.prefix(), id);
        let body = self
            .eapi(
                &format!("/api/v1/resource/hotcomments/{rid}"),
                json!({"rid": rid, "limit": page.limit, "offset": page.offset}),
                Duration::from_secs(12),
            )
            .await?;
        Ok(HotCommentPage {
            comments: values(&body, "hotComments").map(map_comment).collect(),
            total: number(&body, "total").unwrap_or(0),
        })
    }

    /// 评论楼中楼（oracle：weapi `/api/resource/comment/floor/get`）。
    pub async fn comment_floor(
        &self,
        resource: CommentResource,
        id: u64,
        parent_comment_id: u64,
        page: PageRequest,
    ) -> Result<CommentFloor> {
        positive_id(id)?;
        positive_id(parent_comment_id)?;
        let page = page.bounded(100);
        let rid = format!("{}{}", resource.prefix(), id);
        let body = self
            .eapi(
                "/api/resource/comment/floor/get",
                json!({"parentCommentId": parent_comment_id, "rid": rid, "limit": page.limit, "time": page.offset, "type": 1}),
                Duration::from_secs(12),
            )
            .await?;
        Ok(CommentFloor {
            floor: number(&body, "floorCount").unwrap_or(0),
            comments: body
                .get("data")
                .filter(|data| data.is_object())
                .map(|data| array(data, "comments").map(map_comment).collect())
                .unwrap_or_default(),
        })
    }

    /// 我的评论（oracle：weapi `/api/v1/user/comments/{uid}`）。
    pub async fn msg_comments(&self, user_id: u64, page: PageRequest) -> Result<Vec<Comment>> {
        positive_id(user_id)?;
        let page = page.bounded(100);
        let body = self
            .eapi(
                &format!("/api/v1/user/comments/{user_id}"),
                json!({"uid": user_id, "limit": page.limit, "offset": page.offset}),
                Duration::from_secs(12),
            )
            .await?;
        Ok(values(&body, "comments").map(map_comment).collect())
    }

    /// 我的粉丝（oracle：weapi `/api/user/getfolloweds/{uid}`）。
    pub async fn user_followeds(
        &self,
        user_id: u64,
        page: PageRequest,
    ) -> Result<Vec<UserAccount>> {
        positive_id(user_id)?;
        let page = page.bounded(100);
        let body = self
            .eapi(
                &format!("/api/user/getfolloweds/{user_id}"),
                json!({"uid": user_id, "limit": page.limit, "offset": page.offset}),
                Duration::from_secs(12),
            )
            .await?;
        Ok(values(&body, "followeds").map(map_user_account).collect())
    }

    /// 用户等级（oracle：weapi `/api/user/level`）。
    pub async fn user_level(&self) -> Result<UserLevel> {
        let body = self
            .eapi("/api/user/level", json!({}), Duration::from_secs(12))
            .await?;
        let data = body.get("data").unwrap_or(&Value::Null);
        Ok(UserLevel {
            level: number(data, "level").unwrap_or(0),
            next_level_experience: data
                .get("nextLevel")
                .and_then(|v| v.get("nextLevelExp"))
                .and_then(Value::as_u64),
        })
    }

    /// 收藏统计（oracle：weapi `/api/subcount`）。
    pub async fn user_subcount(&self) -> Result<UserSubcount> {
        let body = self
            .eapi("/api/subcount", json!({}), Duration::from_secs(12))
            .await?;
        Ok(UserSubcount {
            playlists: number(&body, "playlistCount").unwrap_or(0),
            albums: number(&body, "albumCount").unwrap_or(0),
            artists: number(&body, "artistCount").unwrap_or(0),
            mvs: number(&body, "mvCount").unwrap_or(0),
            dj_radios: number(&body, "djRadioCount").unwrap_or(0),
        })
    }

    /// 风格偏好（oracle：weapi `/api/tag/my/preference/get`）。
    pub async fn style_preference(&self) -> Result<StylePreference> {
        let body = self
            .eapi(
                "/api/tag/my/preference/get",
                json!({}),
                Duration::from_secs(12),
            )
            .await?;
        let data = body.get("data").unwrap_or(&Value::Null);
        Ok(StylePreference {
            tag_ids: values(data, "tags")
                .filter_map(|v| v.get("id").and_then(Value::as_u64))
                .collect(),
            tag_names: values(data, "tags")
                .filter_map(|v| v.get("name").and_then(Value::as_str).map(str::to_owned))
                .collect(),
        })
    }

    /// 登录状态（oracle：weapi `/api/w/nuser/account/get` 语义）。
    pub async fn login_status(&self) -> Result<LoginStatus> {
        let body = self
            .eapi(
                "/api/w/nuser/account/get",
                json!({}),
                Duration::from_secs(12),
            )
            .await?;
        let profile = body.get("profile").unwrap_or(&Value::Null);
        Ok(LoginStatus {
            logged_in: profile.is_object(),
            user_id: profile.get("userId").and_then(Value::as_u64),
            nickname: profile
                .get("nickname")
                .and_then(Value::as_str)
                .map(str::to_owned),
        })
    }

    /// 播放记录（oracle：weapi `/api/v1/play/record`）。
    pub async fn play_record(&self, user_id: u64, limit: usize) -> Result<Vec<RecentPlay>> {
        positive_id(user_id)?;
        let body = self
            .eapi(
                "/api/v1/play/record",
                json!({"uid": user_id, "limit": limit.min(100), "type": 0}),
                Duration::from_secs(12),
            )
            .await?;
        Ok(values(&body, "weekData")
            .chain(values(&body, "allData"))
            .map(map_recent_play)
            .collect())
    }

    /// 今日听歌数据（oracle：eapi `/api/content/activity/listen/data/today`）。
    pub async fn listen_data_today(&self) -> Result<ListenDataToday> {
        let body = self
            .eapi(
                "/api/content/activity/listen/data/today",
                json!({}),
                Duration::from_secs(12),
            )
            .await?;
        let data = body.get("data").unwrap_or(&Value::Null);
        Ok(ListenDataToday {
            listened_ms: number(data, "listenTime").unwrap_or(0),
            play_count: number(data, "songPlayCount").unwrap_or(0),
        })
    }

    /// 听歌足迹聚合（oracle：getJourneyOverview 语义；组合已实现的 listen_* 能力）。
    pub async fn journey_overview(&self) -> Result<JourneyOverview> {
        let total = self.listen_total().await?;
        let today = self.listen_data_today().await?;
        Ok(JourneyOverview {
            total_listen_ms: total.total_minutes.saturating_mul(60_000),
            total_play_count: total.total_plays,
            today_listen_ms: today.listened_ms,
        })
    }

    /// 相似歌曲（oracle：weapi `/api/v1/discovery/simiSong`）。
    pub async fn similar_songs(&self, id: u64, limit: usize) -> Result<Vec<Track>> {
        positive_id(id)?;
        let body = self
            .eapi(
                "/api/v1/discovery/simiSong",
                json!({"songid": id, "limit": limit.min(100), "offset": 0}),
                Duration::from_secs(12),
            )
            .await?;
        Ok(values(&body, "songs").map(map_track).collect())
    }

    /// 听歌打卡（oracle：clientlog eapi `/api/feedback/weblog`，startplay+play 两次，
    /// logs = JSON.stringify([{action, json:{type:'song', mainsite:'1', mainsiteWeb:'1', ...}}])。
    pub async fn scrobble(
        &self,
        song_id: u64,
        source_id: u64,
        played_seconds: u64,
    ) -> Result<ScrobbleResult> {
        positive_id(song_id)?;
        let played_seconds = played_seconds.max(1);
        let build_log = |action: &str, extra: serde_json::Map<String, Value>| {
            let mut json = serde_json::Map::new();
            json.insert("type".into(), "song".into());
            json.insert("mainsite".into(), "1".into());
            json.insert("mainsiteWeb".into(), "1".into());
            json.extend(extra);
            json!([{ "action": action, "json": Value::Object(json) }]).to_string()
        };
        let startplay = build_log(
            "startplay",
            serde_json::Map::from_iter([
                ("id".into(), json!(song_id)),
                ("content".into(), json!(format!("id={source_id}"))),
            ]),
        );
        let play = build_log(
            "play",
            serde_json::Map::from_iter([
                ("download".into(), json!(0)),
                ("end".into(), json!("playend")),
                ("id".into(), json!(song_id)),
                ("sourceId".into(), json!(source_id)),
                ("time".into(), json!(played_seconds)),
                ("wifi".into(), json!(0)),
                ("source".into(), json!("list")),
                ("content".into(), json!(format!("id={source_id}"))),
            ]),
        );
        // clientlog 通道（os=osx）：任一失败不阻塞播放，降级为未上报。
        let startplay_ok = self
            .clientlog_eapi("/api/feedback/weblog", json!({ "logs": startplay }))
            .await
            .unwrap_or(false);
        let play_ok = self
            .clientlog_eapi("/api/feedback/weblog", json!({ "logs": play }))
            .await
            .unwrap_or(false);
        Ok(ScrobbleResult {
            reported: startplay_ok && play_ok,
        })
    }

    /// 最近播放分类列表（oracle：weapi `/api/play-record/{kind}/list`，≤100）。
    pub async fn recent_plays(
        &self,
        kind: &str,
        user_id: u64,
        limit: usize,
    ) -> Result<Vec<RecentPlay>> {
        positive_id(user_id)?;
        if !matches!(
            kind,
            "song" | "playlist" | "album" | "djradio" | "voice" | "newvideo"
        ) {
            return Err(Error::Validation("播放记录类型无效".into()));
        }
        let body = self
            .eapi(
                &format!("/api/play-record/{kind}/list"),
                json!({"uid": user_id, "limit": limit.min(100), "offset": 0, "total": true}),
                Duration::from_secs(12),
            )
            .await?;
        Ok(body
            .get("data")
            .filter(|data| data.is_object())
            .map(|data| array(data, "list").map(map_recent_play).collect())
            .unwrap_or_default())
    }

    /// 歌曲音质等级（oracle：eapi `/api/song/music/detail/get` 语义；用 quality_candidates 静态表）。
    pub async fn song_quality_levels(&self, id: u64) -> Result<Vec<QualityOption>> {
        positive_id(id)?;
        let body = self
            .eapi(
                "/api/song/music/detail/get",
                json!({"ids": format!("[{id}]")}),
                Duration::from_secs(12),
            )
            .await?;
        let data = body
            .get("data")
            .filter(|data| data.is_object())
            .unwrap_or(&Value::Null);
        let mut out = Vec::new();
        for key in [
            "jymaster", "sky", "hires", "lossless", "exhigh", "higher", "standard",
        ] {
            let entry = data.get(key).filter(|v| v.is_object());
            let Some(entry) = entry else { continue };
            if entry.as_object().is_some_and(|obj| obj.is_empty()) {
                continue;
            }
            out.push(QualityOption {
                key: key.into(),
                label: key.into(),
                bitrate: number(entry, "br").unwrap_or(0),
                size_bytes: number(entry, "size").unwrap_or(0),
                sample_rate: number(entry, "sr"),
            });
        }
        out.sort_by_key(|option| std::cmp::Reverse(option.bitrate));
        Ok(out)
    }
    /// 未登录可用的个性化公开歌单，不调用账号推荐资源接口。
    pub async fn personalized_playlists(&self, page: PageRequest) -> Result<Vec<PlaylistSummary>> {
        let page = page.bounded(100);
        let body = self
            .eapi(
                "/api/personalized/playlist",
                json!({"limit":page.limit,"offset":page.offset,"total":true,"n":1000}),
                Duration::from_secs(12),
            )
            .await?;
        Ok(values(&body, "result").map(map_playlist).collect())
    }

    /// 未登录可用的热门歌手列表。
    pub async fn popular_artists(&self, page: PageRequest) -> Result<Vec<ArtistSummary>> {
        let page = page.bounded(100);
        let body = self
            .eapi(
                "/api/artist/top",
                json!({"limit":page.limit,"offset":page.offset,"total":true}),
                Duration::from_secs(12),
            )
            .await?;
        Ok(values(&body, "artists").map(map_artist_summary).collect())
    }

    pub async fn personal_fm(&self) -> Result<Vec<Track>> {
        let body = self
            .eapi("/api/v1/radio/get", json!({}), Duration::from_secs(12))
            .await?;
        Ok(values(&body, "data").map(map_track).collect())
    }

    pub async fn personal_fm_batched(
        &self,
        target_count: usize,
        max_batches: usize,
    ) -> Result<Vec<Track>> {
        let target_count = target_count.clamp(1, 100);
        let max_batches = max_batches.clamp(1, 8);
        let mut seen = HashSet::new();
        let mut tracks = Vec::new();
        let mut no_growth = 0;
        for _ in 0..max_batches {
            let batch = self.personal_fm().await?;
            let before = tracks.len();
            for track in batch {
                if seen.insert(track.id) {
                    tracks.push(track);
                    if tracks.len() == target_count {
                        return Ok(tracks);
                    }
                }
            }
            no_growth = if tracks.len() == before {
                no_growth + 1
            } else {
                0
            };
            if no_growth >= 2 {
                break;
            }
        }
        Ok(tracks)
    }

    pub async fn trash_fm_song(&self, id: u64) -> Result<MutationResult> {
        positive_id(id)?;
        self.protected_write(
            "/api/radio/trash/add",
            json!({"songId":id,"alg":"RT","time":25}),
            false,
        )
        .await?;
        Ok(success())
    }

    pub async fn account(&self) -> Result<Option<UserAccount>> {
        let body = self
            .eapi("/api/nuser/account/get", json!({}), Duration::from_secs(12))
            .await?;
        let profile = body.get("profile").unwrap_or(&Value::Null);
        if !profile.is_object() || number(profile, "userId").unwrap_or(0) == 0 {
            return Ok(None);
        }
        Ok(Some(map_user(profile)))
    }

    pub async fn user_profile(&self, user_id: u64) -> Result<UserProfile> {
        positive_id(user_id)?;
        let body = self
            .eapi(
                &format!("/api/v1/user/detail/{user_id}"),
                json!({}),
                Duration::from_secs(12),
            )
            .await?;
        let profile = body.get("profile").unwrap_or(&Value::Null);
        if !profile.is_object() {
            return Err(Error::InvalidResponse("缺少 profile".into()));
        }
        Ok(UserProfile {
            user_id: number(profile, "userId").unwrap_or(user_id),
            nickname: string(profile, "nickname"),
            avatar_url: text(profile, "avatarUrl"),
            signature: text(profile, "signature"),
            follow_count: number(&body, "follows"),
            fan_count: number(&body, "followeds"),
        })
    }

    pub async fn vip_info(&self) -> Result<VipInfo> {
        let account = self.account().await?.ok_or(Error::LoginRequired)?;
        let body = self
            .eapi(
                "/api/music-vip-membership/client/vip/info",
                json!({"userId":account.user_id}),
                Duration::from_secs(12),
            )
            .await?;
        let data = body.get("data").unwrap_or(&Value::Null);
        let red_level = number(data, "redVipLevel")
            .or_else(|| {
                data.pointer("/redVipLevel/redVipLevel")
                    .and_then(Value::as_u64)
            })
            .map(|value| value as u32);
        let vip_level = number(data, "vipLevel").unwrap_or(0);
        Ok(VipInfo {
            is_vip: red_level.unwrap_or(0) > 0 || vip_level > 0,
            expire_time: number(data, "expireTime"),
            red_vip_level: red_level,
        })
    }

    pub async fn liked_song_ids(&self, user_id: u64) -> Result<Vec<u64>> {
        positive_id(user_id)?;
        let body = self
            .eapi(
                "/api/song/like/get",
                json!({"uid":user_id}),
                Duration::from_secs(12),
            )
            .await?;
        Ok(values(&body, "ids").filter_map(Value::as_u64).collect())
    }

    pub async fn like_song(&self, id: u64, like: bool) -> Result<MutationResult> {
        positive_id(id)?;
        self.protected_write(
            "/api/radio/like",
            json!({"alg":"itembased","trackId":id,"like":like,"time":"3"}),
            false,
        )
        .await?;
        Ok(success())
    }

    pub async fn comments(
        &self,
        resource: CommentResource,
        id: u64,
        page: PageRequest,
    ) -> Result<CommentPage> {
        positive_id(id)?;
        let page = page.bounded(100);
        let page_no = page.offset / page.limit + 1;
        let cursor = page.offset.to_string();
        let body = self
            .eapi(
                "/api/v2/resource/comments",
                json!({"threadId":format!("{}{id}", resource.prefix()),"pageNo":page_no,"showInner":true,"pageSize":page.limit,"cursor":cursor,"sortType":99}),
                Duration::from_secs(12),
            )
            .await?;
        let data = body.get("data").unwrap_or(&Value::Null);
        Ok(CommentPage {
            comments: values(data, "comments").map(map_comment).collect(),
            total_count: number(data, "totalCount").unwrap_or(0),
            has_more: boolean(data, "hasMore"),
            cursor: text(data, "cursor").unwrap_or(cursor),
        })
    }

    pub async fn add_comment(
        &self,
        resource: CommentResource,
        id: u64,
        content: &str,
    ) -> Result<Comment> {
        positive_id(id)?;
        let content = non_empty(content, "评论内容")?;
        if content.chars().count() > 140 {
            return Err(Error::Validation("评论内容过长".into()));
        }
        let body = self
            .protected_write(
                "/api/resource/comments/add",
                json!({"threadId":format!("{}{id}", resource.prefix()),"content":content}),
                true,
            )
            .await?;
        body.get("comment")
            .filter(|value| value.is_object())
            .map(map_comment)
            .ok_or_else(|| Error::InvalidResponse("评论响应缺少 comment".into()))
    }

    pub async fn reply_comment(
        &self,
        resource: CommentResource,
        id: u64,
        comment_id: u64,
        content: &str,
    ) -> Result<Comment> {
        positive_id(id)?;
        positive_id(comment_id)?;
        let content = non_empty(content, "回复内容")?;
        if content.chars().count() > 140 {
            return Err(Error::Validation("回复内容过长".into()));
        }
        let body = self
            .protected_write(
                "/api/resource/comments/reply",
                json!({"threadId":format!("{}{id}", resource.prefix()),"commentId":comment_id,"content":content}),
                true,
            )
            .await?;
        body.get("comment")
            .filter(|value| value.is_object())
            .map(map_comment)
            .ok_or_else(|| Error::InvalidResponse("回复响应缺少 comment".into()))
    }

    pub async fn like_comment(
        &self,
        resource: CommentResource,
        id: u64,
        comment_id: u64,
        like: bool,
    ) -> Result<MutationResult> {
        positive_id(id)?;
        positive_id(comment_id)?;
        let action = if like { "like" } else { "unlike" };
        self.protected_write(
            &format!("/api/v1/comment/{action}"),
            json!({"threadId":format!("{}{id}", resource.prefix()),"commentId":comment_id}),
            false,
        )
        .await?;
        Ok(success())
    }

    pub async fn delete_comment(
        &self,
        resource: CommentResource,
        id: u64,
        comment_id: u64,
    ) -> Result<MutationResult> {
        positive_id(id)?;
        positive_id(comment_id)?;
        self.protected_write(
            "/api/resource/comments/delete",
            json!({"threadId":format!("{}{id}", resource.prefix()),"commentId":comment_id}),
            true,
        )
        .await?;
        Ok(success())
    }

    pub async fn follows(&self, user_id: u64, page: PageRequest) -> Result<Vec<UserAccount>> {
        positive_id(user_id)?;
        let page = page.bounded(100);
        let body = self
            .eapi(
                &format!("/api/user/getfollows/{user_id}"),
                json!({"offset":page.offset,"limit":page.limit,"order":true}),
                Duration::from_secs(12),
            )
            .await?;
        Ok(values(&body, "follow").map(map_user).collect())
    }

    pub async fn follow_user(&self, user_id: u64, follow: bool) -> Result<MutationResult> {
        positive_id(user_id)?;
        self.protected_write(
            "/api/user/follow",
            json!({"userId":user_id,"t":if follow {1} else {0}}),
            false,
        )
        .await?;
        Ok(success())
    }

    pub async fn cloud_songs(&self, page: PageRequest) -> Result<CloudPage> {
        let page = page.bounded(100);
        let body = self
            .eapi(
                "/api/v1/cloud/get",
                json!({"limit":page.limit,"offset":page.offset}),
                Duration::from_secs(12),
            )
            .await?;
        Ok(CloudPage {
            songs: values(&body, "data").map(map_cloud_song).collect(),
            total_count: number(&body, "count").unwrap_or(0),
            has_more: boolean(&body, "hasMore"),
        })
    }

    pub async fn cloud_song_url(&self, id: u64) -> Result<Option<String>> {
        positive_id(id)?;
        let body = self
            .eapi(
                "/api/cloud/dowonload",
                json!({"songId":id}),
                Duration::from_secs(12),
            )
            .await?;
        let url = values(&body, "data")
            .next()
            .and_then(|value| text(value, "url"))
            .map(|url| url.replacen("http://", "https://", 1));
        Ok(url)
    }

    pub async fn delete_cloud_song(&self, id: u64) -> Result<MutationResult> {
        positive_id(id)?;
        self.protected_write("/api/cloud/del", json!({"songIds":[id]}), false)
            .await?;
        Ok(success())
    }

    pub async fn search(
        &self,
        keywords: &str,
        kind: SearchKind,
        page: PageRequest,
    ) -> Result<SearchResults> {
        let keywords = non_empty(keywords, "搜索词")?;
        let page = page.bounded(100);
        let body = self
            .eapi(
                "/api/search/get",
                json!({"s":keywords,"type":kind.api_type(),"limit":page.limit,"offset":page.offset}),
                Duration::from_secs(12),
            )
            .await?;
        let result = body.get("result").unwrap_or(&Value::Null);
        Ok(SearchResults {
            tracks: values(result, "songs").map(map_track).collect(),
            albums: values(result, "albums")
                .map(|value| map_album(value, 0))
                .collect(),
            artists: values(result, "artists").map(map_artist_summary).collect(),
            playlists: values(result, "playlists").map(map_playlist).collect(),
        })
    }

    pub async fn mvs(
        &self,
        area: &str,
        kind: &str,
        order: &str,
        page: PageRequest,
    ) -> Result<Vec<MvSummary>> {
        let page = page.bounded(100);
        let body = self
            .eapi(
                "/api/mv/all",
                json!({
                    "tags": json!({"地区":area,"类型":kind,"排序":order}).to_string(),
                    "offset":page.offset,"total":"true","limit":page.limit
                }),
                Duration::from_secs(12),
            )
            .await?;
        Ok(values(&body, "data").map(map_mv).collect())
    }

    pub async fn mv_detail(&self, id: u64) -> Result<MvDetail> {
        positive_id(id)?;
        let body = self
            .eapi(
                "/api/v1/mv/detail",
                json!({"id":id}),
                Duration::from_secs(12),
            )
            .await?;
        let data = body.get("data").unwrap_or(&Value::Null);
        if !data.is_object() {
            return Err(Error::InvalidResponse("缺少 MV 详情".into()));
        }
        Ok(MvDetail {
            mv: map_mv(data),
            description: text(data, "desc"),
            publish_time: text(data, "publishTime"),
            favorite_count: number(data, "subCount"),
            comment_count: number(data, "commentCount"),
        })
    }

    pub async fn subscribe_mv(&self, id: u64, subscribe: bool) -> Result<MutationResult> {
        positive_id(id)?;
        let action = if subscribe { "sub" } else { "unsub" };
        self.protected_write(
            &format!("/api/mv/{action}"),
            json!({"mvId":id,"mvIds":format!("[\"{id}\"]")}),
            false,
        )
        .await?;
        Ok(success())
    }

    pub async fn dj_radios(&self, page: PageRequest) -> Result<Vec<DjRadio>> {
        let page = page.bounded(100);
        let body = self
            .eapi(
                "/api/djradio/hot/v1",
                json!({"limit":page.limit,"offset":page.offset}),
                Duration::from_secs(12),
            )
            .await?;
        Ok(values(&body, "djRadios").map(map_dj_radio).collect())
    }

    pub async fn dj_programs(
        &self,
        radio_id: u64,
        ascending: bool,
        page: PageRequest,
    ) -> Result<Vec<DjProgram>> {
        positive_id(radio_id)?;
        let page = page.bounded(100);
        let body = self
            .eapi(
                "/api/dj/program/byradio",
                json!({"radioId":radio_id,"limit":page.limit,"offset":page.offset,"asc":ascending}),
                Duration::from_secs(12),
            )
            .await?;
        Ok(values(&body, "programs").map(map_dj_program).collect())
    }

    pub async fn subscribe_dj_radio(
        &self,
        radio_id: u64,
        subscribe: bool,
    ) -> Result<MutationResult> {
        positive_id(radio_id)?;
        let action = if subscribe { "sub" } else { "unsub" };
        self.protected_write(
            &format!("/api/djradio/{action}"),
            json!({"id":radio_id}),
            false,
        )
        .await?;
        Ok(success())
    }

    pub async fn charts(&self) -> Result<Vec<ChartSummary>> {
        let body = self
            .eapi("/api/toplist/detail", json!({}), Duration::from_secs(12))
            .await?;
        Ok(values(&body, "list").map(map_chart).collect())
    }

    pub async fn new_songs(&self, area_id: u16) -> Result<Vec<Track>> {
        if !matches!(area_id, 0 | 7 | 8 | 16 | 96) {
            return Err(Error::Validation("新歌地区无效".into()));
        }
        let body = self
            .eapi(
                "/api/v1/discovery/new/songs",
                json!({"areaId":area_id,"total":true}),
                Duration::from_secs(12),
            )
            .await?;
        Ok(values(&body, "data").map(map_track).collect())
    }

    pub async fn listen_total(&self) -> Result<ListenStats> {
        let body = self
            .eapi(
                "/api/content/activity/listen/data/total",
                json!({}),
                Duration::from_secs(12),
            )
            .await?;
        Ok(map_listen_stats(body.get("data").unwrap_or(&body)))
    }

    pub async fn listen_report(
        &self,
        period: &str,
        end_time: Option<&str>,
    ) -> Result<ListenReport> {
        if !matches!(period, "week" | "month" | "year") {
            return Err(Error::Validation("报告周期仅支持 week/month/year".into()));
        }
        let body = self
            .eapi(
                "/api/content/activity/listen/data/report",
                json!({"type":period,"endTime":end_time}),
                Duration::from_secs(12),
            )
            .await?;
        Ok(ListenReport {
            period: period.to_owned(),
            end_time: end_time.map(str::to_owned),
            stats: map_listen_stats(body.get("data").unwrap_or(&body)),
        })
    }

    pub async fn listen_song_rank(
        &self,
        period: &str,
        end_time: Option<&str>,
    ) -> Result<Vec<Track>> {
        if !matches!(period, "week" | "month") {
            return Err(Error::Validation("歌曲排行周期仅支持 week/month".into()));
        }
        let body = self
            .eapi(
                "/api/content/activity/listen/data/song/play/rank",
                json!({"type":period,"endTime":end_time}),
                Duration::from_secs(12),
            )
            .await?;
        Ok(nested_values(
            body.get("data").unwrap_or(&body),
            &["songPlayRank", "rankList"],
        )
        .map(map_rank_track)
        .collect())
    }

    pub async fn followed_events(
        &self,
        cursor: Option<i64>,
        limit: usize,
    ) -> Result<CursorPage<SocialEvent>> {
        let limit = limit.clamp(1, 100);
        let body = self
            .eapi(
                "/api/v1/event/get",
                json!({"pagesize":limit,"lasttime":cursor.unwrap_or(-1)}),
                Duration::from_secs(12),
            )
            .await?;
        Ok(map_event_page(&body))
    }

    pub async fn user_events(
        &self,
        user_id: u64,
        cursor: Option<i64>,
        limit: usize,
    ) -> Result<CursorPage<SocialEvent>> {
        positive_id(user_id)?;
        let limit = limit.clamp(1, 100);
        let body = self
            .eapi(
                &format!("/api/event/get/{user_id}"),
                json!({"getcounts":true,"time":cursor.unwrap_or(-1),"limit":limit,"total":false}),
                Duration::from_secs(12),
            )
            .await?;
        Ok(map_event_page(&body))
    }

    pub async fn notices(
        &self,
        cursor: Option<i64>,
        limit: usize,
    ) -> Result<CursorPage<NoticeMessage>> {
        let limit = limit.clamp(1, 100);
        let body = self
            .eapi(
                "/api/msg/notices",
                json!({"limit":limit,"time":cursor.unwrap_or(-1)}),
                Duration::from_secs(12),
            )
            .await?;
        let items = values(&body, "notices")
            .chain(values(&body, "msgs"))
            .map(map_notice)
            .collect();
        Ok(CursorPage {
            items,
            has_more: boolean(&body, "more") || boolean(&body, "hasMore"),
            next_cursor: signed(&body, "time").or_else(|| signed(&body, "lasttime")),
        })
    }
}

fn positive_id(id: u64) -> Result<()> {
    if id == 0 {
        Err(Error::Validation("资源 id 必须大于 0".into()))
    } else {
        Ok(())
    }
}

fn non_empty<'a>(value: &'a str, name: &str) -> Result<&'a str> {
    let value = value.trim();
    if value.is_empty() {
        Err(Error::Validation(format!("{name}不能为空")))
    } else {
        Ok(value)
    }
}

fn values<'a>(value: &'a Value, key: &str) -> impl Iterator<Item = &'a Value> {
    value
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
}

fn number(value: &Value, key: &str) -> Option<u64> {
    value.get(key).and_then(|value| {
        value
            .as_u64()
            .or_else(|| value.as_i64().and_then(|v| u64::try_from(v).ok()))
            .or_else(|| value.as_str()?.parse().ok())
    })
}

fn string(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(|value| {
            value
                .as_str()
                .map(str::to_owned)
                .or_else(|| value.as_u64().map(|value| value.to_string()))
        })
        .unwrap_or_default()
}

fn text(value: &Value, key: &str) -> Option<String> {
    let value = string(value, key);
    (!value.is_empty()).then_some(value)
}

fn boolean(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn map_artist(value: &Value) -> Artist {
    Artist {
        id: number(value, "id").unwrap_or(0),
        name: string(value, "name"),
    }
}

fn map_album(value: &Value, fallback_id: u64) -> Album {
    Album {
        id: number(value, "id").unwrap_or(fallback_id),
        name: string(value, "name"),
        pic_url: text(value, "picUrl"),
    }
}

fn map_track(value: &Value) -> Track {
    let album = value
        .get("al")
        .or_else(|| value.get("album"))
        .unwrap_or(&Value::Null);
    let fee = number(value, "fee").unwrap_or(0) as u8;
    let privilege = value.get("privilege").unwrap_or(&Value::Null);
    Track {
        id: number(value, "id").unwrap_or(0),
        name: string(value, "name"),
        artists: value
            .get("ar")
            .or_else(|| value.get("artists"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(map_artist)
            .collect(),
        album: map_album(album, 0),
        duration_ms: number(value, "dt")
            .or_else(|| number(value, "duration"))
            .unwrap_or(0),
        fee,
        mv_id: number(value, "mv").or_else(|| number(value, "mvid")),
        is_vip: matches!(fee, 1 | 4),
        no_copyright: privilege
            .get("st")
            .and_then(Value::as_i64)
            .is_some_and(|value| value < 0)
            || number(privilege, "playMaxbr") == Some(0),
    }
}

fn map_playlist(value: &Value) -> PlaylistSummary {
    let creator = value.get("creator").unwrap_or(&Value::Null);
    PlaylistSummary {
        id: number(value, "id").unwrap_or(0),
        name: string(value, "name"),
        cover_url: text(value, "coverImgUrl").or_else(|| text(value, "picUrl")),
        track_count: number(value, "trackCount").unwrap_or(0),
        play_count: number(value, "playCount"),
        owner_id: number(creator, "userId")
            .or_else(|| number(value, "userId"))
            .unwrap_or(0),
        owner_name: text(creator, "nickname"),
        description: text(value, "description"),
    }
}

fn map_artist_summary(value: &Value) -> ArtistSummary {
    ArtistSummary {
        id: number(value, "id").unwrap_or(0),
        name: string(value, "name"),
        pic_url: text(value, "picUrl").or_else(|| text(value, "img1v1Url")),
        aliases: values(value, "alias")
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect(),
        brief_description: text(value, "briefDesc"),
    }
}

fn map_user(value: &Value) -> UserAccount {
    UserAccount {
        user_id: number(value, "userId")
            .or_else(|| number(value, "id"))
            .unwrap_or(0),
        nickname: string(value, "nickname"),
        avatar_url: text(value, "avatarUrl"),
    }
}

fn map_comment(value: &Value) -> Comment {
    let user = value.get("user").unwrap_or(&Value::Null);
    Comment {
        id: number(value, "commentId").unwrap_or(0),
        content: string(value, "content"),
        time_text: text(value, "timeStr"),
        liked_count: number(value, "likedCount").unwrap_or(0),
        liked: boolean(value, "liked"),
        user: user.is_object().then(|| map_user(user)),
    }
}

fn map_cloud_song(value: &Value) -> CloudSong {
    let simple_song = value.get("simpleSong").unwrap_or(value);
    CloudSong {
        cloud_id: number(value, "songId")
            .or_else(|| number(simple_song, "id"))
            .unwrap_or(0),
        track: map_track(simple_song),
        file_name: text(value, "fileName"),
        file_size: number(value, "fileSize"),
    }
}

fn signed(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(|value| {
        value
            .as_i64()
            .or_else(|| value.as_u64().and_then(|value| i64::try_from(value).ok()))
            .or_else(|| value.as_str()?.parse().ok())
    })
}

fn map_mv(value: &Value) -> MvSummary {
    MvSummary {
        id: number(value, "id")
            .or_else(|| number(value, "vid"))
            .unwrap_or(0),
        name: text(value, "name")
            .or_else(|| text(value, "title"))
            .unwrap_or_default(),
        cover_url: text(value, "cover")
            .or_else(|| text(value, "coverUrl"))
            .or_else(|| text(value, "imgurl")),
        duration_ms: number(value, "duration"),
        artists: values(value, "artists").map(map_artist).collect(),
        play_count: number(value, "playCount"),
    }
}

fn map_dj_radio(value: &Value) -> DjRadio {
    DjRadio {
        id: number(value, "id").unwrap_or(0),
        name: string(value, "name"),
        cover_url: text(value, "picUrl").or_else(|| text(value, "coverUrl")),
        description: text(value, "desc").or_else(|| text(value, "description")),
        program_count: number(value, "programCount"),
        subscriber_count: number(value, "subCount"),
        category: text(value, "category"),
    }
}

fn map_dj_program(value: &Value) -> DjProgram {
    DjProgram {
        id: number(value, "id").unwrap_or(0),
        name: string(value, "name"),
        radio: map_dj_radio(value.get("radio").unwrap_or(&Value::Null)),
        main_track: value
            .get("mainSong")
            .filter(|track| track.is_object())
            .map(map_track),
        duration_ms: number(value, "duration"),
        listener_count: number(value, "listenerCount"),
        liked_count: number(value, "likedCount"),
        created_at_ms: number(value, "createTime"),
    }
}

fn map_chart(value: &Value) -> ChartSummary {
    ChartSummary {
        id: number(value, "id").unwrap_or(0),
        name: string(value, "name"),
        cover_url: text(value, "coverImgUrl"),
        update_frequency: text(value, "updateFrequency"),
        description: text(value, "description"),
        preview_tracks: values(value, "tracks").map(map_track).collect(),
    }
}

fn nested_values<'a>(value: &'a Value, keys: &[&str]) -> impl Iterator<Item = &'a Value> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_array))
        .into_iter()
        .flatten()
}

fn map_rank_track(value: &Value) -> Track {
    map_track(
        value
            .get("song")
            .or_else(|| value.get("resource"))
            .unwrap_or(value),
    )
}

fn map_listen_stats(value: &Value) -> ListenStats {
    let total_seconds = number(value, "listenTime")
        .or_else(|| number(value, "totalTime"))
        .or_else(|| number(value, "duration"))
        .unwrap_or(0);
    ListenStats {
        total_minutes: number(value, "totalMinutes").unwrap_or(total_seconds / 60),
        total_plays: number(value, "playCount")
            .or_else(|| number(value, "count"))
            .unwrap_or(0),
        songs: nested_values(value, &["songs", "songPlayRank", "rankList"])
            .map(map_rank_track)
            .collect(),
    }
}

fn map_social_event(value: &Value) -> SocialEvent {
    let resource = value
        .get("resource")
        .or_else(|| value.get("song"))
        .unwrap_or(&Value::Null);
    SocialEvent {
        id: number(value, "id")
            .or_else(|| number(value, "eventId"))
            .unwrap_or(0),
        event_type: text(value, "type"),
        occurred_at_ms: number(value, "eventTime").or_else(|| number(value, "showTime")),
        user: value
            .get("user")
            .filter(|user| user.is_object())
            .map(map_user),
        text: text(value, "msg").or_else(|| text(value, "text")),
        track: resource.is_object().then(|| map_track(resource)),
    }
}

fn map_event_page(value: &Value) -> CursorPage<SocialEvent> {
    CursorPage {
        items: values(value, "event")
            .chain(values(value, "events"))
            .map(map_social_event)
            .collect(),
        has_more: boolean(value, "more") || boolean(value, "hasMore"),
        next_cursor: signed(value, "lasttime").or_else(|| signed(value, "time")),
    }
}

fn map_notice(value: &Value) -> NoticeMessage {
    NoticeMessage {
        id: number(value, "id")
            .or_else(|| number(value, "noticeId"))
            .unwrap_or(0),
        occurred_at_ms: number(value, "time").or_else(|| number(value, "createTime")),
        title: text(value, "title"),
        text: text(value, "notice")
            .or_else(|| text(value, "msg"))
            .or_else(|| text(value, "content"))
            .unwrap_or_default(),
        user: value
            .get("user")
            .or_else(|| value.get("fromUser"))
            .filter(|user| user.is_object())
            .map(map_user),
    }
}

fn success() -> MutationResult {
    MutationResult { succeeded: true }
}

fn map_mv_summary(value: &Value) -> MvSummary {
    MvSummary {
        id: number(value, "id").unwrap_or(0),
        name: string(value, "name"),
        cover_url: text(value, "imgurl16v9")
            .or_else(|| text(value, "cover"))
            .or_else(|| text(value, "picUrl")),
        duration_ms: number(value, "duration"),
        artists: text(value, "artistName")
            .or_else(|| text(value, "artist"))
            .map(|name| Artist { id: 0, name })
            .into_iter()
            .collect(),
        play_count: number(value, "playCount"),
    }
}

fn map_user_account(value: &Value) -> UserAccount {
    UserAccount {
        user_id: number(value, "userId").unwrap_or(0),
        nickname: text(value, "nickname").unwrap_or_default(),
        avatar_url: text(value, "avatarUrl"),
    }
}

fn map_recent_play(value: &Value) -> RecentPlay {
    let played_at_ms = number(value, "playTime").unwrap_or(0);
    let resource = if let Some(song) = value.get("song") {
        RecentPlayResource::Song(map_track(song))
    } else if let Some(playlist) = value.get("playlist") {
        RecentPlayResource::Playlist(map_playlist(playlist))
    } else if let Some(album) = value.get("album") {
        RecentPlayResource::Album(map_album(album, 0))
    } else {
        RecentPlayResource::Song(map_track(&Value::Null))
    };
    RecentPlay {
        played_at_ms,
        resource,
    }
}

/// 从网易云歌单网页 HTML 中提取相关歌单（oracle 同款正则语义：
/// `<a href="/playlist?id=N">名字</a>` 后 400 字符内的 `<img src="封面">`）。
pub(crate) fn parse_related_playlists(html: &str) -> Vec<PlaylistSummary> {
    let pattern = regex::Regex::new(
        r#"<a href="(/playlist\?id=(\d+))"[^>]*>([^<]+)</a>[\s\S]{0,400}?<img src="([^"]+)""#,
    )
    .expect("related playlist regex is static");
    let mut out = Vec::new();
    for captures in pattern.captures_iter(html) {
        let name = captures.get(3).map(|m| m.as_str().trim()).unwrap_or("");
        let id = captures
            .get(2)
            .and_then(|m| m.as_str().parse::<u64>().ok())
            .unwrap_or(0);
        if id == 0 || name.is_empty() {
            continue;
        }
        let cover_url = captures
            .get(4)
            .map(|m| m.as_str().split("?param=").next().unwrap_or("").to_owned())
            .filter(|url| !url.is_empty());
        out.push(PlaylistSummary {
            id,
            name: name.to_owned(),
            cover_url,
            track_count: 0,
            play_count: None,
            owner_id: 0,
            owner_name: None,
            description: None,
        });
        if out.len() >= 30 {
            break;
        }
    }
    out
}

/// 分区降级：Err 或空结果都视为该分区不可用（oracle：聚合接口失败时该分区
/// 隐藏并上报 unavailable，空列表与失败对用户不可区分，统一走降级）。
fn degrade_section<T>(
    result: Result<Vec<T>>,
    section: PublicExploreSection,
    unavailable_sections: &mut Vec<PublicExploreSection>,
) -> Vec<T> {
    match result {
        Ok(items) if !items.is_empty() => items,
        Ok(_) => {
            unavailable_sections.push(section);
            Vec::new()
        }
        Err(_) => {
            unavailable_sections.push(section);
            Vec::new()
        }
    }
}

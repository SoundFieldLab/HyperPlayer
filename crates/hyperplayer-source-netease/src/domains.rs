use serde_json::{json, Value};
use std::{collections::HashSet, time::Duration};

use crate::{
    dto::*,
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

fn degrade_section<T>(
    result: Result<Vec<T>>,
    section: PublicExploreSection,
    unavailable_sections: &mut Vec<PublicExploreSection>,
) -> Vec<T> {
    match result {
        Ok(items) => items,
        Err(_) => {
            unavailable_sections.push(section);
            Vec::new()
        }
    }
}

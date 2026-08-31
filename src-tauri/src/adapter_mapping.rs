use hyperplayer_engine::model::{MediaSource, Track};
use hyperplayer_source_netease::{
    Album, AlbumDetail, Artist, ArtistOverview, ChartSummary, CloudPage, Comment, CommentPage,
    CursorPage, DjProgram, DjRadio, ListenReport, ListenStats, MvDetail, MvSummary, NoticeMessage,
    PlaylistDetail, PlaylistSummary, SocialEvent, UserAccount, VipInfo,
};

use crate::dto::*;

pub(crate) fn track_dto(track: &Track) -> TrackDto {
    let source = match track.source {
        MediaSource::Local { .. } => TrackSourceDto::Local,
        MediaSource::Netease { .. } => TrackSourceDto::Netease,
    };
    TrackDto {
        track_ref: TrackRefDto {
            id: track.id.0.clone(),
            source,
        },
        title: track.title.clone(),
        artists: track.artists.clone(),
        album: track.album.clone(),
        album_id: track.album_id.clone(),
        artist_ids: track.artist_ids.clone(),
        artwork_hash: track.artwork_hash.clone(),
        duration_ms: track.duration_ms,
        quality_label: None,
        playable: true,
    }
}

pub(crate) fn netease_track_dto(track: hyperplayer_source_netease::Track) -> TrackDto {
    let artist_ids = track
        .artists
        .iter()
        .map(|artist| artist.id.to_string())
        .collect();
    TrackDto {
        track_ref: TrackRefDto {
            id: track.id.to_string(),
            source: TrackSourceDto::Netease,
        },
        title: track.name,
        artists: track
            .artists
            .into_iter()
            .map(|artist| artist.name)
            .collect(),
        album: Some(track.album.name),
        album_id: Some(track.album.id.to_string()),
        artist_ids,
        artwork_hash: None,
        duration_ms: Some(track.duration_ms),
        quality_label: None,
        playable: !track.no_copyright,
    }
}

pub(crate) fn netease_playlist_dto(playlist: PlaylistSummary) -> NeteasePlaylistDto {
    NeteasePlaylistDto {
        id: playlist.id,
        name: playlist.name,
        cover_url: playlist.cover_url,
        track_count: playlist.track_count,
        play_count: playlist.play_count,
        owner_id: playlist.owner_id,
        owner_name: playlist.owner_name,
        description: playlist.description,
    }
}

pub(crate) fn netease_album_detail_dto(detail: AlbumDetail) -> NeteaseAlbumDetailDto {
    NeteaseAlbumDetailDto {
        album: netease_album_dto(detail.album),
        description: detail.description,
        publish_time_ms: detail.publish_time_ms,
        artist: detail.artist.map(netease_artist_dto),
        tracks: detail.tracks.into_iter().map(netease_track_dto).collect(),
    }
}

pub(crate) fn netease_playlist_detail_dto(detail: PlaylistDetail) -> NeteasePlaylistDetailDto {
    NeteasePlaylistDetailDto {
        playlist: netease_playlist_dto(detail.summary),
        tracks: detail.tracks.into_iter().map(netease_track_dto).collect(),
    }
}

pub(crate) fn netease_artist_detail_dto(detail: ArtistOverview) -> NeteaseArtistDetailDto {
    NeteaseArtistDetailDto {
        artist: NeteaseArtistSummaryDto {
            id: detail.artist.id,
            name: detail.artist.name,
            image_url: detail.artist.pic_url,
            aliases: detail.artist.aliases,
            brief_description: detail.artist.brief_description,
        },
        hot_tracks: detail
            .hot_songs
            .into_iter()
            .map(netease_track_dto)
            .collect(),
        introduction: detail.introduction,
        fans_count: detail.fans_count,
    }
}

pub(crate) fn netease_user_dto(user: UserAccount) -> NeteaseUserDto {
    NeteaseUserDto {
        user_id: user.user_id,
        nickname: user.nickname,
        avatar_url: user.avatar_url,
    }
}

pub(crate) fn netease_vip_dto(vip: VipInfo, verified_at_ms: u64) -> NeteaseVipDto {
    NeteaseVipDto {
        active: vip.is_vip,
        expires_at_ms: vip.expire_time,
        level: vip.red_vip_level,
        verified_at_ms,
    }
}

pub(crate) fn netease_comment_dto(comment: Comment) -> NeteaseCommentDto {
    NeteaseCommentDto {
        id: comment.id,
        content: comment.content,
        time_text: comment.time_text,
        liked_count: comment.liked_count,
        liked: comment.liked,
        user: comment.user.map(netease_user_dto),
    }
}

pub(crate) fn netease_comment_page_dto(
    page: CommentPage,
    offset: usize,
    limit: usize,
) -> NeteaseCommentPageDto {
    NeteaseCommentPageDto {
        comments: page.comments.into_iter().map(netease_comment_dto).collect(),
        total_count: page.total_count,
        has_more: page.has_more,
        next_cursor: page.has_more.then(|| {
            page.cursor.parse::<usize>().map_or_else(
                |_| (offset + limit).to_string(),
                |cursor| cursor.to_string(),
            )
        }),
    }
}

pub(crate) fn netease_cloud_page_dto(
    page: CloudPage,
    offset: usize,
    limit: usize,
) -> NeteaseCloudPageDto {
    NeteaseCloudPageDto {
        songs: page
            .songs
            .into_iter()
            .map(|song| NeteaseCloudSongDto {
                cloud_id: song.cloud_id,
                track: netease_track_dto(song.track),
                file_name: song.file_name,
                file_size: song.file_size,
            })
            .collect(),
        total_count: page.total_count,
        has_more: page.has_more,
        next_cursor: page.has_more.then(|| (offset + limit).to_string()),
    }
}

pub(crate) fn netease_mv_dto(mv: MvSummary) -> NeteaseMvDto {
    NeteaseMvDto {
        id: mv.id,
        name: mv.name,
        cover_url: mv.cover_url,
        duration_ms: mv.duration_ms,
        artists: mv.artists.into_iter().map(netease_artist_dto).collect(),
        play_count: mv.play_count,
    }
}

pub(crate) fn netease_mv_detail_dto(detail: MvDetail) -> NeteaseMvDetailDto {
    NeteaseMvDetailDto {
        mv: netease_mv_dto(detail.mv),
        description: detail.description,
        publish_time: detail.publish_time,
        favorite_count: detail.favorite_count,
        comment_count: detail.comment_count,
    }
}

pub(crate) fn netease_dj_radio_dto(radio: DjRadio) -> NeteaseDjRadioDto {
    NeteaseDjRadioDto {
        id: radio.id,
        name: radio.name,
        cover_url: radio.cover_url,
        description: radio.description,
        program_count: radio.program_count,
        subscriber_count: radio.subscriber_count,
        category: radio.category,
    }
}

pub(crate) fn netease_dj_program_dto(program: DjProgram) -> NeteaseDjProgramDto {
    NeteaseDjProgramDto {
        id: program.id,
        name: program.name,
        radio: netease_dj_radio_dto(program.radio),
        main_track: program.main_track.map(netease_track_dto),
        duration_ms: program.duration_ms,
        listener_count: program.listener_count,
        liked_count: program.liked_count,
        created_at_ms: program.created_at_ms,
    }
}

pub(crate) fn netease_chart_dto(chart: ChartSummary) -> NeteaseChartDto {
    NeteaseChartDto {
        id: chart.id,
        name: chart.name,
        cover_url: chart.cover_url,
        update_frequency: chart.update_frequency,
        description: chart.description,
        preview_tracks: chart
            .preview_tracks
            .into_iter()
            .map(netease_track_dto)
            .collect(),
    }
}

pub(crate) fn netease_listen_stats_dto(stats: ListenStats) -> NeteaseListenStatsDto {
    NeteaseListenStatsDto {
        total_minutes: stats.total_minutes,
        total_plays: stats.total_plays,
        songs: stats.songs.into_iter().map(netease_track_dto).collect(),
    }
}

pub(crate) fn netease_listen_report_dto(report: ListenReport) -> NeteaseListenReportDto {
    NeteaseListenReportDto {
        period: report.period,
        end_time: report.end_time,
        stats: netease_listen_stats_dto(report.stats),
    }
}

pub(crate) fn netease_event_page_dto(page: CursorPage<SocialEvent>) -> NeteaseEventPageDto {
    NeteaseEventPageDto {
        items: page
            .items
            .into_iter()
            .map(|event| NeteaseSocialEventDto {
                id: event.id,
                event_type: event.event_type,
                occurred_at_ms: event.occurred_at_ms,
                user: event.user.map(netease_user_dto),
                text: event.text,
                track: event.track.map(netease_track_dto),
            })
            .collect(),
        has_more: page.has_more,
        next_cursor: page.next_cursor,
    }
}

pub(crate) fn netease_notice_page_dto(page: CursorPage<NoticeMessage>) -> NeteaseNoticePageDto {
    NeteaseNoticePageDto {
        items: page
            .items
            .into_iter()
            .map(|notice| NeteaseNoticeDto {
                id: notice.id,
                occurred_at_ms: notice.occurred_at_ms,
                title: notice.title,
                text: notice.text,
                user: notice.user.map(netease_user_dto),
            })
            .collect(),
        has_more: page.has_more,
        next_cursor: page.next_cursor,
    }
}

pub(crate) fn netease_album_dto(album: Album) -> NeteaseAlbumDto {
    NeteaseAlbumDto {
        id: album.id,
        name: album.name,
        cover_url: album.pic_url,
    }
}

pub(crate) fn netease_artist_summary_dto(
    artist: hyperplayer_source_netease::ArtistSummary,
) -> NeteaseArtistSummaryDto {
    NeteaseArtistSummaryDto {
        id: artist.id,
        name: artist.name,
        image_url: artist.pic_url,
        aliases: artist.aliases,
        brief_description: artist.brief_description,
    }
}

fn netease_artist_dto(artist: Artist) -> NeteaseArtistDto {
    NeteaseArtistDto {
        id: artist.id,
        name: artist.name,
    }
}

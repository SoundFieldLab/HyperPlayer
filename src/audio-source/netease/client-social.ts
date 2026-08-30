/**
 * 社交端点：红心喜欢、评论（读/发/删/回/赞）、动态、消息、关注关系。
 */
import { COMMENT_RESOURCE_TYPE } from './config'
import { callEapi, callEapiRaw, callWeapi, callWeapiRaw, withRetry, type CallOptions } from './request'
import { asArray, asNumber, asRecord, asString, type CommentItem, type CommentPage, type RawBody } from './types'

function mapComment(value: unknown): CommentItem {
  const comment = asRecord(value)
  const user = asRecord(comment.user)
  return {
    id: asNumber(comment.commentId),
    content: asString(comment.content),
    timeStr: asString(comment.timeStr) || undefined,
    likedCount: asNumber(comment.likedCount) || undefined,
    liked: typeof comment.liked === 'boolean' ? comment.liked : undefined,
    userNickname: asString(user.nickname) || undefined,
    userAvatarUrl: asString(user.avatarUrl) || undefined,
    replyCount: undefined,
  }
}

/* --------------------------------- 红心 --------------------------------- */

/** 红心/取消红心歌曲 */
export async function likeSong(id: number | string, like: boolean, options: CallOptions = {}): Promise<RawBody> {
  return callWeapi<RawBody>('/api/radio/like', { alg: 'itembased', trackId: Number(id), like, time: '3' }, options)
}

/** 喜欢列表（无序 id 集合） */
export async function getLikeList(uid: number | string, options: CallOptions = {}): Promise<number[]> {
  const body = await callEapi<RawBody>('/api/song/like/get', { uid: Number(uid) }, options)
  return asArray(body.ids).map((value) => asNumber(value)).filter((value) => value > 0)
}

/** 批量检查歌曲红心状态 */
export async function checkSongsLiked(ids: (number | string)[], options: CallOptions = {}): Promise<RawBody> {
  return callEapi<RawBody>('/api/song/like/check', { trackIds: JSON.stringify(ids.map(Number)) }, options)
}

/* --------------------------------- 评论 --------------------------------- */

function threadIdOf(resourceType: number, id: number | string): string {
  return `${COMMENT_RESOURCE_TYPE[resourceType] ?? COMMENT_RESOURCE_TYPE[0]!}${Number(id)}`
}

/**
 * 评论列表（v2 接口；sortType 99推荐 2热度 3时间）。
 * v2 连续失败时按参考行为降级 v1 接口（时间排序用 beforeTime 游标）。
 */
export async function getComments(
  id: number | string,
  {
    resourceType = 0,
    limit = 20,
    offset = 0,
    sortType = 99,
    cursor,
  }: { resourceType?: number; limit?: number; offset?: number; sortType?: 99 | 2 | 3; cursor?: string } = {},
  options: CallOptions = {},
): Promise<CommentPage> {
  const pageSize = Math.max(1, limit)
  const pageNo = Math.floor(Math.max(0, offset) / pageSize) + 1
  const threadId = threadIdOf(resourceType, id)
  let resolvedCursor = ''
  if (sortType === 99) resolvedCursor = String((pageNo - 1) * pageSize)
  else if (sortType === 2) resolvedCursor = `normalHot#${(pageNo - 1) * pageSize}`
  else resolvedCursor = cursor ?? '-1'

  try {
    const body = await withRetry(
      () =>
        callEapi<RawBody>(
          '/api/v2/resource/comments',
          { threadId, pageNo, showInner: true, pageSize, cursor: resolvedCursor, sortType },
          options,
        ),
      3,
    )
    const data = asRecord(body.data)
    return {
      comments: asArray(data.comments).map(mapComment),
      totalCount: asNumber(data.totalCount),
      hasMore: Boolean(data.hasMore),
      cursor: asString(data.cursor) || resolvedCursor,
    }
  } catch {
    // v1 降级
    const prefix = COMMENT_RESOURCE_TYPE[resourceType] ?? COMMENT_RESOURCE_TYPE[0]!
    const legacy = await callWeapi<RawBody>(
      `/api/v1/resource/comments/${prefix}${Number(id)}`,
      { rid: Number(id), offset: sortType === 3 ? 0 : offset, limit: pageSize, beforeTime: sortType === 3 ? Number(cursor ?? 0) : 0 },
      options,
    )
    const comments = asArray(sortType === 2 && asArray(legacy.hotComments).length > 0 ? legacy.hotComments : legacy.comments).map(mapComment)
    return {
      comments,
      totalCount: asNumber(legacy.total, comments.length),
      hasMore: sortType === 2 ? false : Boolean(legacy.more),
      cursor: comments.length > 0 ? String(comments[comments.length - 1]?.id ?? '') : '',
      hotComments: asArray(legacy.hotComments).map(mapComment),
    }
  }
}

/** 热门评论 */
export async function getHotComments(
  id: number | string,
  { resourceType = 0, limit = 20 }: { resourceType?: number; limit?: number } = {},
  options: CallOptions = {},
): Promise<CommentItem[]> {
  const prefix = COMMENT_RESOURCE_TYPE[resourceType] ?? COMMENT_RESOURCE_TYPE[0]!
  const body = await callWeapi<RawBody>(
    `/api/v1/resource/hotcomments/${prefix}${Number(id)}`,
    { rid: Number(id), limit, offset: 0, beforeTime: 0 },
    options,
  )
  return asArray(body.hotComments).map(mapComment)
}

/** 评论楼层（楼中楼） */
export async function getCommentFloor(
  id: number | string,
  parentCommentId: number | string,
  { resourceType = 0, limit = 20, time = -1 }: { resourceType?: number; limit?: number; time?: number } = {},
  options: CallOptions = {},
): Promise<RawBody> {
  return callWeapi<RawBody>(
    '/api/resource/comment/floor/get',
    { parentCommentId: Number(parentCommentId), threadId: threadIdOf(resourceType, id), time, limit },
    options,
  )
}

/** 发表评论（t=1 add；eapi + 防作弊 token v2） */
export async function addComment(
  id: number | string,
  content: string,
  { resourceType = 0 }: { resourceType?: number } = {},
  options: CallOptions = {},
): Promise<RawBody> {
  return callEapi<RawBody>('/api/resource/comments/add', { threadId: threadIdOf(resourceType, id), content }, { ...options, checkToken: 'v2' })
}

/** 回复评论（t=2 reply） */
export async function replyComment(
  id: number | string,
  content: string,
  commentId: number | string,
  { resourceType = 0 }: { resourceType?: number } = {},
  options: CallOptions = {},
): Promise<RawBody> {
  return callEapi<RawBody>(
    '/api/resource/comments/reply',
    { threadId: threadIdOf(resourceType, id), content, commentId: Number(commentId) },
    { ...options, checkToken: 'v2' },
  )
}

/** 删除评论（t=0 delete） */
export async function deleteComment(
  id: number | string,
  commentId: number | string,
  { resourceType = 0 }: { resourceType?: number } = {},
  options: CallOptions = {},
): Promise<RawBody> {
  return callEapi<RawBody>(
    '/api/resource/comments/delete',
    { threadId: threadIdOf(resourceType, id), commentId: Number(commentId) },
    { ...options, checkToken: 'v2' },
  )
}

/** 评论点赞/取消点赞 */
export async function likeComment(
  id: number | string,
  commentId: number | string,
  like: boolean,
  { resourceType = 0 }: { resourceType?: number } = {},
  options: CallOptions = {},
): Promise<RawBody> {
  return callWeapi<RawBody>(
    `/api/v1/comment/${like ? 'like' : 'unlike'}`,
    { threadId: threadIdOf(resourceType, id), commentId: Number(commentId) },
    options,
  )
}

/* ------------------------------ 动态/消息/关系 ------------------------------ */

/** 关注动态 */
export async function getFollowedEvents({ pagesize = 20, lasttime = -1 }: { pagesize?: number; lasttime?: number } = {}, options: CallOptions = {}): Promise<RawBody> {
  return callWeapi<RawBody>('/api/v1/event/get', { pagesize, lasttime }, options)
}

/** 用户动态 */
export async function getUserEvents(uid: number | string, { lasttime = -1, limit = 30 }: { lasttime?: number; limit?: number } = {}, options: CallOptions = {}): Promise<RawBody> {
  return callEapi<RawBody>(`/api/event/get/${Number(uid)}`, { getcounts: true, time: lasttime, limit, total: false }, options)
}

/** 通知消息 */
export async function getMsgNotices({ limit = 30, lasttime = -1 }: { limit?: number; lasttime?: number } = {}, options: CallOptions = {}): Promise<RawBody> {
  return callWeapi<RawBody>('/api/msg/notices', { limit, time: lasttime }, options)
}

/** 评论消息 */
export async function getMsgComments(uid: number | string, { limit = 30, before = -1 }: { limit?: number; before?: number } = {}, options: CallOptions = {}): Promise<RawBody> {
  return callWeapi<RawBody>(`/api/v1/user/comments/${Number(uid)}`, { beforeTime: String(before), limit, total: 'true', uid: Number(uid) }, options)
}

/** 关注列表 */
export async function getUserFollows(uid: number | string, { limit = 30, offset = 0 }: { limit?: number; offset?: number } = {}, options: CallOptions = {}): Promise<RawBody> {
  return callWeapi<RawBody>(`/api/user/getfollows/${Number(uid)}`, { offset, limit, order: true }, options)
}

/** 粉丝列表 */
export async function getUserFolloweds(uid: number | string, { limit = 20, offset = 0 }: { limit?: number; offset?: number } = {}, options: CallOptions = {}): Promise<RawBody> {
  return callEapi<RawBody>(`/api/user/getfolloweds/${Number(uid)}`, { userId: Number(uid), time: '0', limit, offset, getcounts: 'true' }, options)
}

/** 关注/取关用户（t 1/0） */
export async function followUser(id: number | string, follow: boolean, options: CallOptions = {}): Promise<RawBody> {
  return callWeapiRaw<RawBody>('/api/user/follow', { userId: Number(id), t: follow ? 1 : 0 }, options)
}

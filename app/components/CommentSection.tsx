import { useEffect, useRef, useState } from "react";
import { ArrowBendUpLeft, CheckCircle, Info, PaperPlaneRight, ThumbsUp, TrashSimple, User, WarningCircle } from "@phosphor-icons/react";
import { bridge, bridgeError } from "../bridge";
import type {
  BackendNeteaseStatusDto,
  NeteaseCommentDto,
  NeteaseCommentPageDto,
  NeteaseCommentResource,
  NeteaseMutationDto,
} from "../bridge/contracts";
import { Cover } from "./ui";
import { RemoteNotice, SectionTitle } from "./ui";
import { useRemote } from "../hooks/useRemote";
import { remoteFailure, remoteSuccess, type RemoteState } from "../remote";

type PendingConfirmation = { mutation: NeteaseMutationDto; label: string; summary: string; token: string };

const DIRECT_LABEL: Record<NeteaseCommentResource, string> = {
  song: "歌曲", mv: "MV", playlist: "歌单", album: "专辑", radio: "电台", video: "视频", event: "动态", digitalAlbum: "数字专辑",
};

function errorText(error: unknown): string {
  const detail = bridgeError(error);
  return detail.message || "未知错误";
}

export function CommentSection({ resource, resourceId }: { resource: NeteaseCommentResource; resourceId: number }): React.JSX.Element {
  const [status, reloadStatus] = useRemote(() => bridge.neteaseStatus(), [], () => false);
  const [comments, reloadComments] = useRemote(
    () => bridge.neteaseComments(resource, resourceId).then((page) => ({ ...page, comments: Array.isArray(page.comments) ? page.comments : [] })),
    [resource, resourceId],
    (value) => value.comments.length === 0,
  );
  const [publishText, setPublishText] = useState("");
  const [replyTarget, setReplyTarget] = useState<number | null>(null);
  const [replyTexts, setReplyTexts] = useState<Record<number, string>>({});
  const [pending, setPending] = useState<PendingConfirmation | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<string | null>(null);
  const publishInput = useRef<HTMLTextAreaElement | null>(null);

  const authenticated = status.status === "ready" && status.data.authenticated;
  const currentUserId = status.status === "ready" ? status.data.userId : null;

  useEffect(() => {
    if (resourceId <= 0) return;
    setReplyTarget(null);
    setPublishText("");
    setWriteError(null);
    setLastResult(null);
  }, [resource, resourceId]);

  async function runMutation(mutation: NeteaseMutationDto, label: string): Promise<void> {
    setWriteError(null);
    setLastResult(null);
    try {
      const confirmation = await bridge.neteasePrepareMutation(mutation);
      setPending({ mutation, label, summary: confirmation.summary, token: confirmation.confirmationToken });
    } catch (error) {
      setWriteError(errorText(error));
    }
  }

  async function confirmCommit(): Promise<void> {
    if (!pending) return;
    setBusy(`confirm:${pending.token}`);
    setWriteError(null);
    try {
      const result = await bridge.neteaseCommitMutation(pending.token, true);
      if (!result.succeeded) throw new Error("后端返回未成功，请稍后重试");
      if (pending.mutation.kind === "addComment") setPublishText("");
      if (pending.mutation.kind === "replyComment") { setReplyTexts({}); setReplyTarget(null); }
      setLastResult(`操作已生效：${pending.label}`);
      setPending(null);
      reloadComments();
    } catch (error) {
      setWriteError(errorText(error));
      setPending(null);
    } finally {
      setBusy(null);
    }
  }

  function cancelCommit(): void {
    if (!pending) return;
    setPending(null);
  }

  async function publishComment(): Promise<void> {
    const content = publishText.trim();
    if (!content) return;
    await runMutation({ kind: "addComment", resource, resourceId, content }, "发布评论");
  }

  async function replyComment(comment: NeteaseCommentDto): Promise<void> {
    const content = replyTexts[comment.id]?.trim();
    if (!content) return;
    await runMutation({ kind: "replyComment", resource, resourceId, commentId: comment.id, content }, "回复评论");
  }

  async function toggleLike(comment: NeteaseCommentDto): Promise<void> {
    if (!authenticated) return;
    await runMutation({ kind: "setCommentFavorite", resource, resourceId, commentId: comment.id, favorite: !comment.liked }, comment.liked ? "取消点赞" : "点赞评论");
  }

  async function deleteComment(comment: NeteaseCommentDto): Promise<void> {
    await runMutation({ kind: "deleteComment", resource, resourceId, commentId: comment.id }, "删除评论");
  }

  const commentActions = (comment: NeteaseCommentDto) => {
    const isOwn = comment.user !== null && currentUserId !== null && String(comment.user.userId) === String(currentUserId);
    const interactionBlocked = busy !== null || pending !== null;
    return (
      <span className="comment-actions">
        <button type="button" className={`comment-like ${comment.liked ? "active" : ""}`} aria-pressed={comment.liked} title={comment.liked ? "取消点赞" : "点赞"} aria-label={comment.liked ? `取消点赞 ${comment.user?.nickname ?? ""} 的评论` : `点赞 ${comment.user?.nickname ?? ""} 的评论`} disabled={!authenticated || interactionBlocked} onClick={() => void toggleLike(comment)}><ThumbsUp weight={comment.liked ? "fill" : "regular"}/><em>{comment.likedCount > 0 ? comment.likedCount : ""}</em></button>
        <button type="button" className="comment-reply-btn" disabled={!authenticated || interactionBlocked} onClick={() => { setReplyTarget(replyTarget === comment.id ? null : comment.id); setWriteError(null); }}><ArrowBendUpLeft/>回复</button>
        {isOwn && <button type="button" className="comment-delete-btn" aria-label="删除自己的评论" disabled={interactionBlocked} onClick={() => void deleteComment(comment)}><TrashSimple/></button>}
      </span>
    );
  };

  return <section aria-label="评论" className="comment-section">
    <SectionTitle>评论</SectionTitle>
    <RemoteNotice state={status} retry={reloadStatus}/>
    {status.status === "ready" && !status.data.authenticated && <div className="remote-state empty"><Info/><b>登录后可以发表评论</b><span>评论写操作需要网易云账号；未登录时评论为只读。</span></div>}
    {status.status === "ready" && status.data.authenticated && (
      <div className="comment-composer">
        <div aria-label="发布评论" className="comment-composer-field"><User/><textarea ref={publishInput} rows={2} maxLength={500} placeholder={`发布评论（${DIRECT_LABEL[resource]}）…`} value={publishText} onChange={(event) => setPublishText(event.target.value)} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") void publishComment(); }}/></div>
        <button type="button" className="button primary" disabled={!publishText.trim() || busy !== null || pending !== null} onClick={() => void publishComment()}><PaperPlaneRight/>发布评论</button>
      </div>
    )}
    {authenticated && <p className="comment-hint"><Info/>评论公开可见，请遵守社区规范；写操作需要二次确认。</p>}
    <RemoteNotice state={comments} empty="暂无评论" retry={reloadComments}/>
    {comments.status === "ready" && <div className="comment-list">{comments.data.comments.map((comment) => (
      <div key={comment.id} role="article">
        {comment.user?.avatarUrl ? <Cover src={comment.user.avatarUrl} alt="" className="avatar-image"/> : <User/>}
        <span><b>{comment.user?.nickname || "网易云用户"}</b><p>{comment.content}</p><small>{comment.timeText || `点赞 ${comment.likedCount}`}</small></span>
        {commentActions(comment)}
        {replyTarget === comment.id && <form className="comment-reply-form" onSubmit={(event) => { event.preventDefault(); void replyComment(comment); }}><input autoFocus maxLength={500} aria-label={`回复 ${comment.user?.nickname || "用户"}`} placeholder={`回复 ${comment.user?.nickname || "用户"}…`} value={replyTexts[comment.id] ?? ""} onChange={(event) => setReplyTexts((current) => ({ ...current, [comment.id]: event.target.value }))}/><button type="submit" className="button secondary" disabled={busy !== null}>回复</button></form>}
      </div>
    ))}</div>}
    {writeError && <div className="comment-error" role="alert"><WarningCircle/>{writeError}</div>}
    {lastResult && <div className="comment-result" role="status"><CheckCircle/>{lastResult}</div>}
    {pending && <div className="modal-backdrop"><div className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="comment-confirm-title"><h2 id="comment-confirm-title">确认{pending.label}</h2><p>将对你的网易云账号执行写操作：<b>{pending.summary}</b>。确认令牌 60 秒内有效，请在窗口内完成确认。</p><div><button className="button secondary" onClick={cancelCommit}>取消</button><button className="button primary" disabled={busy !== null} onClick={() => void confirmCommit()}>{busy !== null ? "正在提交" : "确认执行"}</button></div></div></div>}
  </section>;
}
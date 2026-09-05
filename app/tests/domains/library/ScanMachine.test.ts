import { describe, expect, it, vi } from 'vitest';
import { ScanMachine } from '../../../src/domains/library/ScanMachine';
import { LibraryService } from '../../../src/domains/library/LibraryService';
import { createFakeFs, createFakeSql } from '../../../src/infra/fakes';
import type { TauriFs } from '../../../src/infra/tauriFs';
import { createNullLogger } from '../../../src/shared/logger';

const encoder = new TextEncoder();

function seedFolder(fs: TauriFs, folder: string, files: Array<[string, string]>): void {
  for (const [name, content] of files) {
    fs.writeFile(`${folder}/${name}`, encoder.encode(content));
  }
}

/** 按路径返回可预测元数据的 fake parser。 */
function fakeParser(path: string): Promise<{ title: string; artist: string; duration: number }> {
  const name = path.split('/').pop()?.replace(/\.[^.]+$/u, '') ?? 'unknown';
  return Promise.resolve({ title: name, artist: 'Artist', duration: 180 });
}

function makeScanMachine(fs: TauriFs, parse: typeof fakeParser = fakeParser) {
  const sql = createFakeSql();
  const states: string[] = [];
  const machine = new ScanMachine({
    fs,
    sql,
    parseMetadata: parse,
    onStateChange: (s) => states.push(s.phase),
    logger: createNullLogger(),
  });
  return { machine, sql, states };
}

describe('ScanMachine', () => {
  it('扫描：遍历子目录、解析元数据、每文件夹事务提交、进度上报', async () => {
    const fs = createFakeFs();
    seedFolder(fs, '/music/a', [['song1.mp3', 'x'], ['song2.flac', 'y']]);
    seedFolder(fs, '/music/b', [['song3.mp3', 'z']]);
    const { machine, sql, states } = makeScanMachine(fs);

    await machine.scan(['/music/a', '/music/b']);
    expect(machine.snapshot.phase).toBe('done');
    expect(machine.snapshot.added).toBe(3);
    expect(machine.snapshot.filesScanned).toBe(3);
    expect(states).toContain('scanning');
    expect(states).toContain('summarizing');
    expect(states).toContain('done');

    const tracks = await sql.select<{ path: string; title: string }>('SELECT * FROM tracks');
    expect(tracks).toHaveLength(3);
    expect(tracks.map((t) => t.path)).toEqual(
      expect.arrayContaining(['/music/a/song1.mp3', '/music/a/song2.flac', '/music/b/song3.mp3']),
    );
  });

  it('扫描：带封面元数据时经 saveCover 钩子落盘（专辑键规范化）', async () => {
    const fs = createFakeFs();
    seedFolder(fs, '/music/a', [['song1.mp3', 'x']]);
    const saveCover = vi.fn(async () => {});
    const sql = createFakeSql();
    const machine = new ScanMachine({
      fs,
      sql,
      parseMetadata: async () => ({ title: 'song1', artist: 'Artist', album: 'Album', albumArtist: 'Artist', cover: new Uint8Array([1, 2, 3]), coverFormat: 'image/png' }),
      saveCover,
      logger: createNullLogger(),
    });

    await machine.scan(['/music/a']);
    expect(saveCover).toHaveBeenCalledTimes(1);
    const args = saveCover.mock.calls[0] as unknown as [Uint8Array, string, string];
    const [picture, albumKey, mime] = args;
    expect(albumKey).toBe('artist|album');
    expect(mime).toBe('image/png');
    expect(picture).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('增量：mtime 未变跳过（added=0）', async () => {
    const fs = createFakeFs();
    seedFolder(fs, '/music/a', [['song1.mp3', 'x']]);
    const { machine } = makeScanMachine(fs);
    await machine.scan(['/music/a']);
    expect(machine.snapshot.added).toBe(1);

    await machine.scan(['/music/a']);
    expect(machine.snapshot.added).toBe(1); // 未新增
    expect(machine.snapshot.filesScanned).toBe(1); // 增量跳过：不重新解析
  });

  it('mtime 变化触发更新', async () => {
    const fs = createFakeFs();
    seedFolder(fs, '/music/a', [['song1.mp3', 'old']]);
    const { machine } = makeScanMachine(fs);
    await machine.scan(['/music/a']);
    expect(machine.snapshot.added).toBe(1);

    // 改写文件（mtime 变化）
    fs.writeFile('/music/a/song1.mp3', encoder.encode('new'));
    fs.setMtime('/music/a/song1.mp3', Date.now() + 5000);
    await machine.scan(['/music/a']);
    expect(machine.snapshot.updated).toBe(1);
  });

  it('取消：已提交文件夹保留，phase=cancelled，可续扫', async () => {
    const fs = createFakeFs();
    seedFolder(fs, '/music/a', [['song1.mp3', 'x']]);
    seedFolder(fs, '/music/b', [['song2.mp3', 'y']]);
    const sql = createFakeSql();
    let machine2: ScanMachine;
    let cancelTriggered = false;
    const parse = vi.fn(async (path: string) => {
      if (path.startsWith('/music/b') && !cancelTriggered) {
        cancelTriggered = true;
        machine2.cancel();
      }
      return fakeParser(path);
    });
    machine2 = new ScanMachine({ fs, sql, parseMetadata: parse, logger: createNullLogger() });
    await machine2.scan(['/music/a', '/music/b']);

    expect(machine2.snapshot.phase).toBe('cancelled');
    // folder1 已提交（原子事务保留）
    const tracks = await sql.select<{ path: string }>('SELECT * FROM tracks');
    expect(tracks.map((t) => t.path)).toContain('/music/a/song1.mp3');
    // 续扫剩余文件夹
    await machine2.scan([]);
    expect(machine2.snapshot.phase).toBe('done');
    const after = await sql.select<{ path: string }>('SELECT * FROM tracks');
    expect(after.map((t) => t.path)).toContain('/music/b/song2.mp3');
  });

  it('暂停：文件夹边界生效，resume 续扫', async () => {
    const fs = createFakeFs();
    seedFolder(fs, '/music/a', [['song1.mp3', 'x']]);
    seedFolder(fs, '/music/b', [['song2.mp3', 'y']]);
    const sql = createFakeSql();
    let machine2: ScanMachine;
    let paused = false;
    const parse = vi.fn(async (path: string) => {
      if (path.startsWith('/music/b') && !paused) {
        paused = true;
        machine2.pause();
      }
      return fakeParser(path);
    });
    machine2 = new ScanMachine({ fs, sql, parseMetadata: parse, logger: createNullLogger() });
    await machine2.scan(['/music/a', '/music/b']);
    expect(machine2.snapshot.phase).toBe('paused');

    machine2.resume();
    await new Promise((r) => setTimeout(r, 0));
    await machine2.scan([]); // 续扫
    expect(machine2.snapshot.phase).toBe('done');
  });
});

describe('LibraryService', () => {
  it('查询：模糊搜索 / 艺术家过滤 / 文件夹过滤', async () => {
    const sql = createFakeSql();
    const fs = createFakeFs();
    seedFolder(fs, '/music/a', [['Hello World.mp3', 'x'], ['Another Day.flac', 'y']]);
    seedFolder(fs, '/music/b', [['Hello Again.mp3', 'z']]);
    const machine = new ScanMachine({ fs, sql, parseMetadata: fakeParser, logger: createNullLogger() });
    await machine.scan(['/music/a', '/music/b']);

    const library = new LibraryService(sql);
    const all = await library.queryTracks();
    expect(all).toHaveLength(3);

    const search = await library.queryTracks({ search: 'hello' });
    expect(search).toHaveLength(2);

    const folder = await library.queryTracks({ folder: '/music/a' });
    expect(folder).toHaveLength(2);
  });

  it('播放列表 CRUD（SQLite 持久化）', async () => {
    const sql = createFakeSql();
    const library = new LibraryService(sql);
    const playlistId = await library.createPlaylist('我的歌单');
    expect(playlistId).toBeGreaterThanOrEqual(0);

    // 先入库一首歌再加入播放列表
    const fs = createFakeFs();
    seedFolder(fs, '/music/a', [['song1.mp3', 'x']]);
    const machine = new ScanMachine({ fs, sql, parseMetadata: fakeParser, logger: createNullLogger() });
    await machine.scan(['/music/a']);
    const tracks = await sql.select<{ id: string }>('SELECT * FROM tracks');
    const trackId = tracks[0]?.id ?? '';

    await library.addToPlaylist(playlistId, trackId);
    const list = await library.listPlaylists();
    expect(list[0]?.name).toBe('我的歌单');
    const playlistTracks = await library.getPlaylistTracks(playlistId);
    expect(playlistTracks).toHaveLength(1);
    expect(playlistTracks[0]?.title).toBe('song1');

    await library.removeFromPlaylist(playlistId, trackId);
    expect(await library.getPlaylistTracks(playlistId)).toHaveLength(0);
    await library.deletePlaylist(playlistId);
    expect(await library.listPlaylists()).toHaveLength(0);
  });

  it('removeTrack：仅移除索引，不删除磁盘文件（UI-D23）', async () => {
    const sql = createFakeSql();
    const fs = createFakeFs();
    seedFolder(fs, '/music/a', [['song1.mp3', 'x']]);
    const machine = new ScanMachine({ fs, sql, parseMetadata: fakeParser, logger: createNullLogger() });
    await machine.scan(['/music/a']);
    const tracks = await sql.select<{ id: string }>('SELECT * FROM tracks');
    const trackId = tracks[0]?.id ?? '';

    const library = new LibraryService(sql);
    await library.removeTrack(trackId);
    expect(await library.queryTracks()).toHaveLength(0);
    expect(await fs.exists('/music/a/song1.mp3')).toBe(true); // 磁盘文件保留
  });
});

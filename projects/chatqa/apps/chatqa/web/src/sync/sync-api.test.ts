import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@shell/platform';
import { onSyncEvent, testApi } from '../testing/bridge';
import { blockOf, fileOfKey, fmtBytes, groupByApp, hasConflictMarkers, reasonLabel, resultCounts, resultSentence, stateLabel, syncErrorText, type FileStatus, type SyncProgress } from './sync-api';

afterEach(() => vi.unstubAllGlobals());

/** Giả window.go.test.Service: mọi hàm ghi lại tên + tham số và trả kết quả đặt sẵn (Error = Go trả lỗi). */
function stubGo(results: Record<string, unknown>) {
  const calls: [string, unknown[]][] = [];
  const service = Object.fromEntries(
    Object.entries(results).map(([name, res]) => [
      name,
      (...a: unknown[]) => {
        calls.push([name, a]);
        return res instanceof Error ? Promise.reject(res) : Promise.resolve(res);
      },
    ]),
  );
  vi.stubGlobal('window', { go: { test: { Service: service } } });
  return calls;
}

const cfg = { endpoint: 'minio.local:9000', bucket: 'qa', region: '', pathStyle: true, useTLS: false, evidenceAuto: false, prefix: 'tenants/t1/chatqa', credentialsSet: true, configured: true };

describe('testApi cho đồng bộ nhóm', () => {
  it('gọi đúng hàm Go với đúng tham số và chuẩn hoá mảng null', async () => {
    const calls = stubGo({
      SyncConfig: cfg,
      SetSyncConfig: null,
      SetSyncCredentials: null,
      ClearSyncCredentials: null,
      TestSyncConnection: { ok: true, conditional: false },
      SyncStatus: { files: null, warnings: null, counts: null, conflicts: null },
      SyncPush: { pushed: ['apps/a/docs/prd.md'], conflicts: null, skipped: null, errors: null, warnings: null },
      SyncPull: { pulled: null, deleted: null, merged: ['apps/a/flows/.cqs-flows.json'], conflicts: null, skipped: [{ key: 'k', reason: 'local_changed' }], errors: null, warnings: null },
      SyncConflict: { key: 'apps/a/docs/prd.md' },
      SyncResolve: null,
      SyncKeepMine: null,
      SyncTakeTheirs: null,
      ShareRun: { runId: 'r1', deviceId: 'd1', files: 3, uploaded: 3, skipped: 0, sizeBytes: 10 },
      TeamRuns: null,
      OpenTeamRun: '/tmp/team/d1/r1/evidence.html',
    });
    expect(await testApi.syncConfig()).toEqual(cfg);
    // Go trả null (core giả lập, chưa có cấu hình): mặc định TLS bật, chưa cấu hình.
    expect(await testApi.setSyncConfig(cfg)).toMatchObject({ useTLS: true, configured: false });
    await testApi.setSyncCredentials('AK', 'SK');
    await testApi.clearSyncCredentials();
    expect(await testApi.testSyncConnection()).toEqual({ ok: true, conditional: false });
    expect(await testApi.syncStatus()).toEqual({ files: [], warnings: [], counts: {}, conflicts: [] });
    expect(await testApi.syncPush(['a'])).toEqual({ pushed: ['apps/a/docs/prd.md'], conflicts: [], skipped: [], errors: [], warnings: [] });
    expect((await testApi.syncPull()).merged).toEqual(['apps/a/flows/.cqs-flows.json']);
    await testApi.syncConflict('apps/a/docs/prd.md');
    await testApi.syncResolve('apps/a/docs/prd.md', 'gộp', 'sha-v1');
    await testApi.syncKeepMine('apps/a/docs/prd.md', 'sha-v1');
    await testApi.syncTakeTheirs('apps/a/docs/prd.md', '');
    expect((await testApi.shareRun('r1')).files).toBe(3);
    await testApi.shareRun('r1', true);
    expect(await testApi.teamRuns()).toEqual([]);
    expect(await testApi.openTeamRun('d1', 'r1')).toBe('/tmp/team/d1/r1/evidence.html');
    expect(calls).toEqual([
      ['SyncConfig', []],
      ['SetSyncConfig', [cfg]],
      ['SetSyncCredentials', ['AK', 'SK']],
      ['ClearSyncCredentials', []],
      ['TestSyncConnection', []],
      ['SyncStatus', [[]]],
      ['SyncPush', [['a']]],
      ['SyncPull', [[]]],
      ['SyncConflict', ['apps/a/docs/prd.md']],
      ['SyncResolve', ['apps/a/docs/prd.md', 'gộp', 'sha-v1']],
      ['SyncKeepMine', ['apps/a/docs/prd.md', 'sha-v1']],
      ['SyncTakeTheirs', ['apps/a/docs/prd.md', '']],
      ['ShareRun', ['r1', false]],
      ['ShareRun', ['r1', true]],
      ['TeamRuns', [0]],
      ['OpenTeamRun', ['d1', 'r1']],
    ]);
  });

  it('lỗi Go thành ApiError có mã; chưa đăng nhập / chưa cấu hình là màn trống', async () => {
    stubGo({ SyncPush: new Error('busy: đang đẩy/kéo đồng bộ nhóm'), SyncStatus: new Error('not_signed_in: chưa đăng nhập'), SyncPull: new Error('sync_not_configured: chưa đặt khoá S3') });
    await expect(testApi.syncPush()).rejects.toMatchObject({ code: 'busy' });
    expect(blockOf(await testApi.syncStatus().catch((e: unknown) => e))).toBe('not_signed_in');
    expect(blockOf(await testApi.syncPull().catch((e: unknown) => e))).toBe('sync_not_configured');
    expect(blockOf(new ApiError('network', 0))).toBeNull();
  });

  it('sự kiện test:sync: nghe và huỷ nghe qua runtime Wails; ngoài desktop không làm gì', () => {
    const handlers: Record<string, (d: unknown) => void> = {};
    const off = vi.fn();
    vi.stubGlobal('window', { runtime: { EventsOn: (n: string, cb: (d: unknown) => void) => ((handlers[n] = cb), off), EventsOff: vi.fn() } });
    const seen: SyncProgress[] = [];
    const stop = onSyncEvent((ev) => seen.push(ev));
    handlers['test:sync']({ op: 'push', phase: 'start' });
    expect(seen).toEqual([{ op: 'push', phase: 'start' }]);
    stop();
    expect(off).toHaveBeenCalled();
    vi.stubGlobal('window', {});
    expect(() => onSyncEvent(() => undefined)()).not.toThrow();
  });
});

describe('câu lỗi đồng bộ', () => {
  it('dữ liệu sai: câu chi tiết của Go; mã có trong contracts: câu chung; mã lạ: câu của Go', () => {
    expect(syncErrorText(new ApiError('invalid', 0, { 'chi tiết': 'bản gộp còn dấu xung đột' }))).toBe('bản gộp còn dấu xung đột');
    expect(syncErrorText(new ApiError('sync_not_configured', 0))).toContain('Chưa cấu hình đồng bộ nhóm');
    expect(syncErrorText(new ApiError('not_signed_in', 0))).toContain('Đăng nhập tài khoản công ty');
    expect(syncErrorText(new ApiError('network', 0, { 'chi tiết': 'kho S3 trả 403' }))).toBe('Không kết nối được máy chủ. Kiểm tra mạng.');
    expect(syncErrorText(new ApiError('secret_store_failed', 0))).toContain('kho bí mật');
    expect(syncErrorText(new ApiError('web_runtime_missing', 0))).toContain('bộ chạy trình duyệt');
    expect(syncErrorText(new ApiError('s3_odd_code', 0, { 'chi tiết': 'câu của Go' }))).toBe('câu của Go');
  });
});

describe('tiện ích', () => {
  it('dấu xung đột chỉ tính khi đầu dòng, khớp Go (kể cả dấu trơ trọi)', () => {
    expect(hasConflictMarkers('a\n<<<<<<< của tôi\nb\n=======\nc\n>>>>>>> của họ\n')).toBe(true);
    expect(hasConflictMarkers('<<<<<<<')).toBe(true);
    expect(hasConflictMarkers('a\n>>>>>>>\n')).toBe(true);
    expect(hasConflictMarkers('x\n>>>>>>> của họ')).toBe(true);
    expect(hasConflictMarkers('a\n=======\nb')).toBe(true);
    expect(hasConflictMarkers('a\r\n=======\r\nb')).toBe(true);
    expect(hasConflictMarkers('a <<<<<<< b\n')).toBe(false);
    expect(hasConflictMarkers('========\n')).toBe(false);
    expect(hasConflictMarkers(' =======\n')).toBe(false);
    expect(hasConflictMarkers('đã gộp xong\n')).toBe(false);
  });

  it('lý do remote_empty có nhãn, cả khi là lý do bỏ qua', () => {
    expect(stateLabel('remote_empty')).toContain('không xoá ở máy');
    expect(reasonLabel('remote_empty')).toContain('không xoá ở máy');
    expect(stateLabel('local_changed')).toBe('Đã sửa ở máy');
  });

  it('gom tệp theo app: đã đồng bộ chỉ đếm, xung đột lên đầu', () => {
    const files: FileStatus[] = [
      { key: 'apps/b/docs/x.md', app: 'b', kind: 'doc', state: 'synced' },
      { key: 'apps/a/flows/02.yaml', app: 'a', kind: 'flow', state: 'local_changed' },
      { key: 'apps/a/flows/01.yaml', app: 'a', kind: 'flow', state: 'conflict', reason: 'invalid_flow', author: 'Lan' },
      { key: 'apps/a/docs/prd.md', app: 'a', kind: 'doc', state: 'synced' },
    ];
    const g = groupByApp(files);
    expect(g.map((x) => [x.app, x.synced, x.changed.map((f) => f.key)])).toEqual([
      ['a', 1, ['apps/a/flows/01.yaml', 'apps/a/flows/02.yaml']],
      ['b', 1, []],
    ]);
    expect(fileOfKey('apps/a/flows/01.yaml', 'a')).toBe('flows/01.yaml');
  });

  it('tóm tắt kết quả đẩy/kéo', () => {
    const pull = { op: 'pull' as const, result: { pulled: ['x', 'y'], deleted: [], merged: ['m'], conflicts: [], skipped: [{ key: 'k', reason: 'local_changed' }], errors: [], warnings: [] } };
    expect(resultCounts(pull)).toEqual([
      { label: 'đã kéo', n: 2 },
      { label: 'gộp tự động', n: 1 },
      { label: 'bỏ qua', n: 1 },
    ]);
    expect(resultSentence({ op: 'push', result: { pushed: [], conflicts: ['c'], skipped: [], errors: [], warnings: [] } })).toBe('Đẩy lên xong: 0 đã đẩy, 1 xung đột.');
  });

  it('dung lượng dễ đọc', () => {
    expect(fmtBytes(0)).toBe('0 KB');
    expect(fmtBytes(300)).toBe('1 KB');
    expect(fmtBytes(250 * 1024 * 1024)).toBe('250,0 MB');
  });
});

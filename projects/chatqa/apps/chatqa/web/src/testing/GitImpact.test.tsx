import { describe, expect, it } from 'vitest';
import { diffFileName, fileNameOf } from './TestingPage';

describe('git-impact: tên file tải về', () => {
  const at = new Date(2026, 10, 18, 11, 17, 30); // 2026-11-18 11:17:30 giờ máy

  it('lấy tên repo + ngày giờ xuất', () => {
    expect(diffFileName('/Users/me/code/receiving', at)).toBe('receiving_20261118-111730.json');
  });

  it('bỏ dấu / cuối và hoạt động với đường dẫn Windows', () => {
    expect(diffFileName('/Users/me/code/receiving/', at)).toBe('receiving_20261118-111730.json');
    expect(diffFileName('C:\\code\\mexpress', at)).toBe('mexpress_20261118-111730.json');
  });

  it('thay ký tự không an toàn và có tên dự phòng', () => {
    expect(diffFileName('/srv/my repo (v2)', at)).toBe('my-repo-v2_20261118-111730.json');
    expect(diffFileName('/', at)).toBe('repo_20261118-111730.json');
  });

  it('ưu tiên tên file Go đã lưu để bản tải về khớp', () => {
    expect(fileNameOf('/data/git-impact/receiving_20261118-111730.json')).toBe('receiving_20261118-111730.json');
    expect(fileNameOf('C:\\data\\git-impact\\mexpress_20261118-111730.json')).toBe('mexpress_20261118-111730.json');
    expect(fileNameOf(undefined)).toBe('');
  });
});

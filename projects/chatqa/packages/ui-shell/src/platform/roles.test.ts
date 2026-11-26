import { describe, expect, it } from 'vitest';
import roleCatalog from '@contracts/roles.json';
import { isAdmin, normalizeRole, roleLabel, ROLES } from './roles';

describe('vai (contracts/roles.json)', () => {
  it('5 vai theo đúng thứ tự spec', () => {
    expect(ROLES.map((r) => r.code)).toEqual(['admin', 'manager', 'leader', 'staff', 'vipo']);
    expect(ROLES).toBe(roleCatalog.roles);
  });

  it('vai cũ owner được hiểu là admin; vai lạ không thành admin', () => {
    expect(normalizeRole('owner')).toBe('admin');
    expect(isAdmin('owner')).toBe(true);
    expect(isAdmin('manager')).toBe(false);
    expect(isAdmin(undefined)).toBe(false);
  });

  it('nhãn tiếng Việt lấy từ contracts, không còn "Chủ tài khoản"', () => {
    expect(roleLabel('admin')).toBe('Admin');
    expect(roleLabel('owner')).toBe('Admin');
    expect(roleLabel('staff')).toBe('Nhân viên');
    expect(roleLabel('khong-co')).toBe('');
  });
});

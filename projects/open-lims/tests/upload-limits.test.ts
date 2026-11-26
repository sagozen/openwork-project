import { describe, expect, test } from "bun:test";
import {
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_LABEL,
  isOversized,
  oversizedFilesMessage,
} from "../src/lib/api/upload-limits";

const fileOf = (name: string, size: number) => ({ name, size }) as unknown as File;

describe("trần dung lượng tải lên", () => {
  test("trần người dùng nằm dưới trần thân yêu cầu của máy chủ (15M)", () => {
    // Phần chênh là chỗ cho lớp bao multipart; hai con số bằng nhau thì một tệp vừa đúng trần
    // vẫn bị máy chủ trả 413.
    expect(MAX_UPLOAD_BYTES).toBeLessThan(15 * 1024 * 1024);
    expect(MAX_UPLOAD_LABEL).toBe("10,0 MB");
  });

  test("tệp đúng bằng trần vẫn được nhận, hơn một byte thì không", () => {
    expect(isOversized(fileOf("tem.jpg", MAX_UPLOAD_BYTES))).toBe(false);
    expect(isOversized(fileOf("tem.jpg", MAX_UPLOAD_BYTES + 1))).toBe(true);
  });

  test("không có tệp nào quá nặng thì không có câu báo nào", () => {
    expect(oversizedFilesMessage([fileOf("a.jpg", 1024), fileOf("b.jpg", 2048)])).toBeUndefined();
  });

  test("câu báo gọi tên đúng những tệp bị loại, không phải cả lượt chọn", () => {
    const message = oversizedFilesMessage([
      fileOf("dat.jpg", 1024 * 1024),
      fileOf("nang.jpg", 18 * 1024 * 1024),
    ]);

    expect(message).toContain("nang.jpg");
    expect(message).toContain("18,0 MB");
    expect(message).not.toContain("dat.jpg");
  });
});

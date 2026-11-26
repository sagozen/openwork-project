/// <reference types="node" />
// Gói skill cho AI agent (public/skills/chatqa/) thành skills/chatqa.zip lúc build và khi chạy dev, để trang chủ có
// một tệp tải về cho Claude.ai/Claude Desktop (Settings → Capabilities → Skills nhận zip có thư mục chatqa/ chứa SKILL.md)
// và cho lệnh cài một dòng (curl + unzip vào ~/.claude/skills). Zip sinh từ chính các tệp nguồn nên không lệch nội dung
// và không phải giữ tệp nhị phân trong git.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import type { Plugin } from 'vite';

export const SKILL_NAME = 'chatqa';
export const SKILL_ZIP_PATH = `skills/${SKILL_NAME}.zip`;
const SKILL_DIR = resolve(import.meta.dirname, 'public/skills', SKILL_NAME);

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? listFiles(join(dir, e.name)) : [join(dir, e.name)]))
    .sort();
}

/** Các tệp của skill, tên trong zip là chatqa/<đường dẫn tương đối>. */
export function skillFiles(dir = SKILL_DIR): { name: string; data: Buffer }[] {
  return listFiles(dir).map((f) => ({ name: `${SKILL_NAME}/${relative(dir, f).split(sep).join('/')}`, data: readFileSync(f) }));
}

/** Zip tối giản (deflate, tên UTF-8, giờ cố định 1980-01-01 để build lặp lại cho cùng kết quả). */
export function buildZip(files: { name: string; data: Buffer }[]): Buffer {
  const DOS_TIME = 0;
  const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const body = deflateRawSync(f.data);
    const crc = crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // tạo trên Unix: trình giải nén đọc quyền tệp ở dưới
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(f.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // quyền tệp thường khi giải nén trên macOS/Linux
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** Phát skills/chatqa.zip vào bản build và phục vụ cùng đường đó khi chạy dev. */
export function skillZipPlugin(): Plugin {
  return {
    name: 'chatqa-skill-zip',
    configureServer(server) {
      server.middlewares.use(`/${SKILL_ZIP_PATH}`, (_req, res) => {
        res.setHeader('Content-Type', 'application/zip');
        res.end(buildZip(skillFiles()));
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: SKILL_ZIP_PATH, source: buildZip(skillFiles()) });
    },
  };
}

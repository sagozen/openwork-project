// Đưa khoá ChatQASoftware lên site: tải media lên R2, gỡ khoá cũ, ghi khoá mới vào D1.
//
//   node docs/courses/chatqa/tools/publish-course.mjs plan                 # chỉ sinh build/publish/* để xem (mặc định)
//   node docs/courses/chatqa/tools/publish-course.mjs upload --bucket <r2>  # tải media + tài nguyên lên R2 (không ghi đè nội dung khác)
//   node docs/courses/chatqa/tools/publish-course.mjs apply --database <d1> [--remove <id-khoá-cũ> ...]
//
// Bản ghi khoá giữ đúng khuôn 0.3.0 ({schemaVersion:1, course}) để site 0.3.0 vẫn đọc được. Khoá mở và tài nguyên
// thêm của từng bài nằm ở collection `courseOptions` (0.4.0 đọc, 0.3.0 bỏ qua). Sao lưu D1 trước khi apply
// (ops/scripts/backup-cloudflare.mjs). Không chạy apply khi chưa có bản sao lưu.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { COURSE, LESSONS, RESOURCES, MEDIA_PREFIX, mediaUrl } from '../course.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const build = join(root, 'build');
const out = join(build, 'publish');
mkdirSync(out, { recursive: true });

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { bucket: { type: 'string' }, database: { type: 'string' }, remove: { type: 'string', multiple: true, default: [] } },
});
const cmd = positionals[0] ?? 'plan';
export const COURSE_ID = 'chatqa-co-ban';
const PLUGIN = 'mytutor-lms';

const resourceFile = (key) => {
  const r = RESOURCES[key];
  return { label: r.label, path: r.built ? join(build, r.file) : join(root, 'resources', r.file), file: r.file };
};

function lessonResources(lesson) {
  const keys = [...new Set([...lesson.resources, 'handbook'])];
  return keys.map((k) => ({ label: RESOURCES[k].label, url: mediaUrl(RESOURCES[k].file) }));
}

export function buildRecords(now = Date.now()) {
  const lessons = LESSONS.map((l) => {
    const res = lessonResources(l);
    return {
      record: {
        id: l.id,
        title: l.title,
        module: l.module,
        durationMinutes: l.minutes,
        body: l.notes,
        videoUrl: mediaUrl(`${l.id}.mp4`),
        resourceUrl: res[0].url,
        resourceLabel: res[0].label,
      },
      extra: res.slice(1),
    };
  });
  const course = {
    schemaVersion: 1,
    course: {
      title: COURSE.title,
      summary: COURSE.summary,
      description: COURSE.description,
      instructor: COURSE.instructor,
      status: 'published',
      lessons: lessons.map((l) => l.record),
    },
  };
  const options = {
    schemaVersion: 1,
    courseId: COURSE_ID,
    access: COURSE.access,
    lessonResources: Object.fromEntries(lessons.filter((l) => l.extra.length).map((l) => [l.record.id, l.extra])),
    updatedAt: now,
  };
  return { course, options };
}

export function mediaFiles() {
  const files = [];
  for (const l of LESSONS) {
    files.push({ key: `${MEDIA_PREFIX}/${l.id}.mp4`, path: join(build, 'video', `${l.id}.mp4`), type: 'video/mp4' });
    files.push({ key: `${MEDIA_PREFIX}/${l.id}-poster.jpg`, path: join(build, 'video', `${l.id}-poster.jpg`), type: 'image/jpeg' });
  }
  for (const key of Object.keys(RESOURCES)) {
    const r = resourceFile(key);
    const type = r.file.endsWith('.pdf')
      ? 'application/pdf'
      : r.file.endsWith('.json')
        ? 'application/json'
        : 'text/plain; charset=utf-8';
    files.push({ key: `${MEDIA_PREFIX}/${r.file}`, path: r.path, type });
  }
  return files;
}

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

function sql(records, remove) {
  const iso = new Date().toISOString();
  const lines = [];
  for (const id of remove) {
    // Gỡ khoá cũ cùng quyền học, ghi danh, tiến độ và bài nộp của khoá đó. Tài khoản học viên và nhật ký giữ nguyên.
    lines.push(
      `DELETE FROM _plugin_storage WHERE plugin_id='${PLUGIN}' AND collection='progress' AND substr(id,1,instr(id,'.')-1) IN (SELECT id FROM _plugin_storage WHERE plugin_id='${PLUGIN}' AND collection='enrollments' AND json_extract(data,'$.courseId')=${q(id)});`,
    );
    for (const c of ['submissions', 'entitlements', 'enrollments', 'liveSessions', 'courseOptions'])
      lines.push(
        `DELETE FROM _plugin_storage WHERE plugin_id='${PLUGIN}' AND collection='${c}' AND (json_extract(data,'$.courseId')=${q(id)}${c === 'courseOptions' ? ` OR id=${q(id)}` : ''});`,
      );
    lines.push(`DELETE FROM _plugin_storage WHERE plugin_id='${PLUGIN}' AND collection='courses' AND id=${q(id)};`);
  }
  const upsert = (collection, id, data) =>
    `INSERT INTO _plugin_storage (plugin_id, collection, id, data, created_at, updated_at, revision) VALUES ('${PLUGIN}', '${collection}', ${q(id)}, ${q(JSON.stringify(data))}, ${q(iso)}, ${q(iso)}, ${q(randomUUID())}) ON CONFLICT (plugin_id, collection, id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at, revision=excluded.revision;`;
  lines.push(upsert('courses', COURSE_ID, records.course));
  lines.push(upsert('courseOptions', COURSE_ID, records.options));
  return lines.join('\n') + '\n';
}

const wrangler = (args) => execFileSync('npx', ['--no-install', 'wrangler', ...args], { cwd: join(root, '../../../themes/mytutor'), stdio: 'inherit' });

const records = buildRecords();
writeFileSync(join(out, 'course.json'), JSON.stringify(records, null, 2));
const files = mediaFiles();
const missing = files.filter((f) => !existsSync(f.path));
if (missing.length) throw new Error(`thiếu file: ${missing.map((f) => f.path).join(', ')}`);
writeFileSync(join(out, 'media.json'), JSON.stringify(files, null, 2));
writeFileSync(join(out, 'apply.sql'), sql(records, values.remove));
console.log(`khoá ${COURSE_ID}: ${records.course.course.lessons.length} bài, ${files.length} file media, gỡ ${values.remove.length} khoá cũ`);

if (cmd === 'upload') {
  if (!values.bucket) throw new Error('--bucket <r2-bucket>');
  for (const f of files) {
    wrangler(['r2', 'object', 'put', `${values.bucket}/${f.key}`, '--file', f.path, '--content-type', f.type, '--remote']);
  }
} else if (cmd === 'apply') {
  if (!values.database) throw new Error('--database <d1>');
  wrangler(['d1', 'execute', values.database, '--remote', '--file', join(out, 'apply.sql')]);
} else if (cmd !== 'plan') {
  throw new Error(`lệnh lạ: ${cmd}`);
}

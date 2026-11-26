/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import { inflateRawSync } from 'node:zlib';
import { buildZip, skillFiles } from '../skill-zip';
import { PRODUCT } from './product';
import { skillTabs } from '@shell/pages/public/AgentSkill';

/** Đọc lại zip qua thư mục trung tâm, như một trình giải nén. */
function readZip(zip: Buffer): Map<string, string> {
  const end = zip.length - 22;
  expect(zip.readUInt32LE(end)).toBe(0x06054b50);
  const count = zip.readUInt16LE(end + 10);
  let p = zip.readUInt32LE(end + 16);
  const out = new Map<string, string>();
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(p)).toBe(0x02014b50);
    const size = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const dataAt = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    out.set(name, inflateRawSync(zip.subarray(dataAt, dataAt + size)).toString('utf8'));
    p += 46 + nameLen;
  }
  return out;
}

describe('skill ChatQA cho AI agent', () => {
  const files = skillFiles();

  it('zip có thư mục chatqa/ với SKILL.md và hai tài liệu tham chiếu, nội dung khớp tệp nguồn', () => {
    const entries = readZip(buildZip(files));
    expect([...entries.keys()].sort()).toEqual(['chatqa/SKILL.md', 'chatqa/references/adk.md', 'chatqa/references/mcp.md']);
    for (const f of files) expect(entries.get(f.name)).toBe(f.data.toString('utf8'));
  });

  it('build lặp lại cho cùng zip', () => {
    expect(buildZip(files).equals(buildZip(skillFiles()))).toBe(true);
  });

  it('SKILL.md có frontmatter đúng chuẩn Agent Skills và trỏ tới tài liệu tham chiếu có thật', () => {
    const md = files.find((f) => f.name === 'chatqa/SKILL.md')!.data.toString('utf8');
    const front = /^---\nname: (.+)\ndescription: (.+)\n---\n/.exec(md);
    expect(front?.[1]).toBe('chatqa');
    expect(front![2].length).toBeLessThanOrEqual(1024);
    for (const ref of md.match(/references\/[a-z-]+\.md/g) ?? []) expect(files.some((f) => f.name === `chatqa/${ref}`)).toBe(true);
  });

  it('prompt và lệnh cài dùng địa chỉ trang đang mở và đúng thư mục skill của từng agent', () => {
    const tabs = skillTabs(PRODUCT.landing.agentSkill!, 'https://qa.example.com');
    const code = (id: string) => tabs.find((t) => t.id === id)!.blocks.map((b) => b.code).join('\n');
    expect(code('prompt')).toContain('https://qa.example.com/skills/chatqa.zip');
    expect(code('claude-code')).toContain('-d ~/.claude/skills');
    expect(code('agents')).toContain('-d ~/.agents/skills');
    expect(code('prompt')).toContain('~/.agents/skills');
    expect(code('claude-code')).toContain('Expand-Archive');
  });
});

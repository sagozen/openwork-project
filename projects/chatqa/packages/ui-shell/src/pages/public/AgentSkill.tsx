// Khối "Skill cho AI agent" ngay dưới đầu trang chủ: chép một prompt để agent tự cài, hoặc chép lệnh cài theo từng agent,
// hoặc tải zip cho Claude.ai / Claude Desktop. Lệnh và prompt dùng địa chỉ của trang đang mở nên đúng cả bản thử lẫn bản thật.
import { useState } from 'react';
import { Bot, Check, Copy, Download, FileText, Plug, Sparkles, Terminal } from 'lucide-react';
import type { LandingAgentSkill } from './landing-types';

interface SkillTab {
  id: string;
  label: string;
  hint: string;
  blocks: { caption?: string; code: string }[];
}

/** Lệnh tải zip và giải nén vào thư mục skill của một agent (macOS/Linux và Windows PowerShell). */
function installBlocks(zipUrl: string, name: string, unixDir: string, winDir: string) {
  return [
    {
      caption: 'macOS / Linux',
      code: `mkdir -p ${unixDir} && curl -fsSL ${zipUrl} -o /tmp/${name}-skill.zip && unzip -oq /tmp/${name}-skill.zip -d ${unixDir}`,
    },
    {
      caption: 'Windows PowerShell',
      code: `iwr ${zipUrl} -OutFile $env:TEMP\\${name}-skill.zip; Expand-Archive $env:TEMP\\${name}-skill.zip -DestinationPath ${winDir} -Force`,
    },
  ];
}

export function skillTabs(skill: LandingAgentSkill, origin: string): SkillTab[] {
  const zipUrl = `${origin}${skill.zip}`;
  const n = skill.name;
  const prompt = [
    `Cài skill ${n} (ChatQASoftware) cho tôi rồi giúp tôi kết nối:`,
    `1. Tải ${zipUrl} và giải nén vào thư mục skill của bạn, giữ nguyên thư mục ${n}/ (Claude Code: ~/.claude/skills; Codex, Cursor và agent khác: ~/.agents/skills). Kiểm tra có ${n}/SKILL.md, ${n}/references/mcp.md và ${n}/references/adk.md.`,
    `2. Đọc ${n}/SKILL.md và làm theo "Step 0": kiểm tra đã có tool MCP ${n} chưa. Nếu chưa, hướng dẫn tôi bật MCP trong ChatQASoftware (Điều phối → Kết nối AI (MCP)) và đưa tôi lệnh thêm máy chủ để tôi tự chạy ở cửa sổ terminal riêng. Không yêu cầu tôi dán token vào chat.`,
    `3. Khi đã kết nối, gọi tower_fleet và cho tôi biết máy nào đang rảnh.`,
  ].join('\n');
  return [
    {
      id: 'prompt',
      label: 'Prompt cho agent',
      hint: 'Dán vào Claude Code, Codex hoặc Cursor. Agent tự tải skill, đọc hướng dẫn và dẫn bạn bật MCP.',
      blocks: [{ code: prompt }],
    },
    {
      id: 'claude-code',
      label: 'Claude Code',
      hint: 'Chạy trong terminal rồi mở phiên mới. Hỏi một việc về ChatQA, Claude Code hiện Skill(chatqa).',
      blocks: installBlocks(zipUrl, n, '~/.claude/skills', '$HOME\\.claude\\skills'),
    },
    {
      id: 'agents',
      label: 'Codex, Cursor và agent khác',
      hint: 'Thư mục skill dùng chung: Codex, Cursor, Gemini CLI, Copilot, Cline đều đọc. Mở phiên mới để nạp.',
      blocks: installBlocks(zipUrl, n, '~/.agents/skills', '$HOME\\.agents\\skills'),
    },
    {
      id: 'claude-app',
      label: 'Claude.ai / Desktop',
      hint: 'Tải zip, không giải nén. Vào Settings → Capabilities → Skills → Upload skill và chọn tệp. Tool MCP chạy được ở Claude Desktop (máy chủ MCP của app chỉ nghe trên máy bạn).',
      blocks: [],
    },
  ];
}

function CopyBlock({ caption, code }: { caption?: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  };
  return (
    <div className="overflow-hidden rounded-[10px] bg-text ring-1 ring-black/10">
      <div className="flex items-center gap-[8px] border-b border-white/10 px-[12px] py-[7px]">
        <span className="text-[11px]/[14px] font-semibold text-white/60">{caption ?? 'Prompt'}</span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={copy}
          className="inline-flex items-center gap-[5px] rounded-[6px] bg-white/10 px-[9px] py-[4px] text-[11.5px]/[14px] font-semibold text-white hover:bg-white/20"
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? 'Đã chép' : 'Chép'}
        </button>
      </div>
      <pre className="max-h-[260px] overflow-auto px-[14px] py-[12px] text-[12px]/[19px] whitespace-pre-wrap break-all text-white/90">
        <code>{code}</code>
      </pre>
    </div>
  );
}

export function AgentSkill({ skill }: { skill: LandingAgentSkill }) {
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const tabs = skillTabs(skill, origin);
  const [active, setActive] = useState(tabs[0].id);
  const tab = tabs.find((t) => t.id === active) ?? tabs[0];

  return (
    <section id="skill" className="scroll-mt-[70px] border-b border-border bg-surface">
      <div className="mx-auto grid w-full max-w-[1080px] gap-[28px] px-[20px] py-[44px] lg:grid-cols-[0.85fr_1.15fr]">
        <div>
          <p className="inline-flex items-center gap-[6px] text-[11px]/[14px] font-bold tracking-[1.4px] text-accent-ink uppercase">
            <Sparkles size={13} className="text-accent" />
            Skill cho AI agent
          </p>
          <h2 className="mt-[6px] text-[22px]/[30px] font-bold sm:text-[26px]/[34px]">{skill.title}</h2>
          <p className="mt-[8px] text-[13.5px]/[22px] text-text-2">{skill.intro}</p>

          <ol className="mt-[16px] flex flex-col gap-[10px]">
            {[
              { icon: <Download size={14} />, title: 'Cài skill', text: 'Chép prompt cho agent, hoặc chạy một lệnh, hoặc tải zip.' },
              { icon: <Plug size={14} />, title: 'Bật MCP trong app', text: 'Điều phối → Kết nối AI (MCP). Agent dẫn bạn thêm máy chủ, token không đi qua chat.' },
              { icon: <Bot size={14} />, title: 'Giao việc', text: 'Agent chạy flow, viết flow, đọc báo cáo hoặc giao cho đội agent ADK.' },
            ].map((s, i) => (
              <li key={s.title} className="flex items-start gap-[10px]">
                <span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[8px] bg-accent-soft text-accent">{s.icon}</span>
                <div>
                  <p className="text-[13.5px]/[18px] font-bold">
                    {i + 1}. {s.title}
                  </p>
                  <p className="mt-[2px] text-[12.5px]/[19px] text-text-2">{s.text}</p>
                </div>
              </li>
            ))}
          </ol>

          <div className="mt-[18px] flex flex-wrap gap-[10px]">
            <a
              href={skill.zip}
              download
              className="inline-flex h-[40px] items-center gap-[8px] rounded-[9px] bg-accent px-[16px] text-[13.5px]/[18px] font-semibold text-white hover:brightness-95"
            >
              <Download size={15} />
              Tải {skill.name}.zip
            </a>
            <a
              href={skill.skillMd}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-[40px] items-center gap-[8px] rounded-[9px] bg-surface px-[14px] text-[13px]/[18px] font-semibold text-text shadow-[inset_0_0_0_1px_var(--color-border)] hover:bg-bg"
            >
              <FileText size={15} />
              Xem SKILL.md
            </a>
          </div>
        </div>

        <div className="rounded-[14px] bg-bg p-[14px] ring-1 ring-border sm:p-[18px]">
          <div role="tablist" aria-label="Cách cài skill" className="flex flex-wrap gap-[6px]">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={t.id === tab.id}
                onClick={() => setActive(t.id)}
                className={`inline-flex items-center gap-[6px] rounded-[8px] px-[11px] py-[6px] text-[12.5px]/[16px] font-semibold ${
                  t.id === tab.id ? 'bg-surface text-text shadow-[inset_0_0_0_1px_var(--color-border)]' : 'text-text-3 hover:text-text'
                }`}
              >
                {t.id === 'prompt' ? <Sparkles size={13} /> : <Terminal size={13} />}
                {t.label}
              </button>
            ))}
          </div>
          <p className="mt-[12px] text-[12.5px]/[19px] text-text-2">{tab.hint}</p>
          <div role="tabpanel" className="mt-[10px] flex flex-col gap-[10px]">
            {tab.blocks.map((b) => (
              <CopyBlock key={b.caption ?? 'prompt'} caption={b.caption} code={b.code} />
            ))}
            {tab.blocks.length === 0 ? (
              <a
                href={skill.zip}
                download
                className="inline-flex h-[40px] w-fit items-center gap-[8px] rounded-[9px] bg-accent px-[16px] text-[13.5px]/[18px] font-semibold text-white hover:brightness-95"
              >
                <Download size={15} />
                Tải {skill.name}.zip
              </a>
            ) : null}
          </div>
          <p className="mt-[14px] text-[11.5px]/[17px] text-text-3">Sau khi cài, thử giao việc:</p>
          <ul className="mt-[6px] flex flex-col gap-[6px]">
            {skill.examples.map((ex) => (
              <li key={ex} className="rounded-[8px] bg-surface px-[11px] py-[8px] text-[12.5px]/[19px] text-text-2 ring-1 ring-border">
                “{ex}”
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

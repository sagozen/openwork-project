import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Badge, Button, Tooltip } from "@fluentui/react-components";
import { ArrowDownload20Regular, Eye20Regular } from "@fluentui/react-icons";
import { NoAccess } from "@/components/lims/NoAccess";
import { PageHead, useDlpToast } from "@/components/lims/common";
import { useAuth } from "@/lib/auth/AuthProvider";
import { SUPPORT_DOCS, SUPPORT_DOC_GROUPS } from "@/lib/support/support-data";
import { SupportHero, SupportShell } from "@/components/lims/support/SupportUI";

export const Route = createFileRoute("/_app/ho-tro/tai-lieu")({
  head: () => ({
    meta: [
      { title: "Tài liệu phần mềm - Hỗ trợ DLP LIMS" },
      {
        name: "description",
        content:
          "Thư viện tài liệu PDF: hướng dẫn sử dụng theo vai trò, quy trình nghiệp vụ, biểu mẫu BM và ghi chú phiên bản.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: DocLibrary,
});

function DocLibrary() {
  const { can } = useAuth();
  const toast = useDlpToast();
  const [q, setQ] = useState("");

  const groups = useMemo(() => {
    const key = q.trim().toLowerCase();
    return SUPPORT_DOC_GROUPS.map((g) => ({
      group: g,
      docs: SUPPORT_DOCS.filter(
        (d) =>
          d.group === g &&
          (!key || d.title.toLowerCase().includes(key) || d.desc.toLowerCase().includes(key)),
      ),
    })).filter((g) => g.docs.length > 0);
  }, [q]);

  if (!can("support.view")) return <NoAccess screen="Tài liệu hỗ trợ" />;

  return (
    <SupportShell>
      <PageHead
        crumbs={[{ label: "Hỗ trợ người dùng", to: "/ho-tro" }, { label: "Tài liệu" }]}
        title="Tài liệu phần mềm"
        description="Tải tài liệu hướng dẫn sử dụng, quy trình nghiệp vụ và biểu mẫu ở bản mới nhất."
      />

      <SupportHero
        title="Tìm tài liệu bạn cần"
        subtitle="Gõ tên vai trò, quy trình hoặc mã biểu mẫu."
        value={q}
        onChange={setQ}
        placeholder="Ví dụ: thí nghiệm viên, BM03, release notes…"
      />

      {groups.map(({ group, docs }) => (
        <section key={group} className="dlp-sup__panel">
          <div className="dlp-sup__group-label">{group}</div>
          <div className="dlp-sup__list">
            {docs.map((d) => (
              <div key={d.id} className="dlp-sup__row dlp-sup__row--static">
                <span className="dlp-sup__row-main">
                  <span className="dlp-sup__row-title">{d.title}</span>
                  <span className="dlp-sup__row-desc">{d.desc}</span>
                  <span className="dlp-sup__row-desc">
                    {d.version} · cập nhật {d.updated} · {d.size}
                  </span>
                </span>
                <span className="dlp-sup__row-meta">
                  {d.url ? (
                    <>
                      <Tooltip content="Xem trước trong tab mới" relationship="label">
                        <Button
                          size="small"
                          appearance="secondary"
                          icon={<Eye20Regular />}
                          as="a"
                          href={d.url}
                          target="_blank"
                        >
                          Xem trước
                        </Button>
                      </Tooltip>
                      <Button
                        size="small"
                        appearance="primary"
                        icon={<ArrowDownload20Regular />}
                        as="a"
                        href={d.url}
                        download
                      >
                        Tải PDF
                      </Button>
                    </>
                  ) : (
                    <>
                      <Badge appearance="outline" color="informative">
                        Sắp cập nhật
                      </Badge>
                      <Button
                        size="small"
                        appearance="secondary"
                        icon={<ArrowDownload20Regular />}
                        onClick={() =>
                          toast(
                            "Tài liệu đang được biên soạn",
                            `${d.title} sẽ có bản tải về ở phiên bản kế tiếp.`,
                            "info",
                          )
                        }
                      >
                        Nhận thông báo
                      </Button>
                    </>
                  )}
                </span>
              </div>
            ))}
          </div>
        </section>
      ))}

      {groups.length === 0 ? (
        <div className="dlp-sup__panel dlp-sup__panel-body--pad">
          Không tìm thấy tài liệu phù hợp với “{q}”.
        </div>
      ) : null}
    </SupportShell>
  );
}

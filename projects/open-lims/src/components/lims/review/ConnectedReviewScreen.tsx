import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Field,
  Input,
  Textarea,
  Checkbox,
  Spinner,
  MessageBar,
  MessageBarBody,
} from "@fluentui/react-components";
import { ArrowDownload20Regular, Clock20Regular } from "@fluentui/react-icons";
import { PageHead, useDlpToast } from "@/components/lims/common";
import { apiErrorMessage, useApiClient } from "@/lib/api";
import { sampleApi } from "@/features/sample/sample-api";
import { saveBlob } from "@/features/report";
interface Queue {
  content: {
    sampleCode: string;
    requestCode: string;
    parameterCount: number;
    status: { name: string };
  }[];
  page: { number: number; totalPages: number };
}
export function ConnectedReviewScreen({
  canWrite,
  canTrace,
}: {
  canWrite: boolean;
  canTrace: boolean;
}) {
  const api = useApiClient();
  const cache = useQueryClient();
  const toast = useDlpToast();
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState("");
  const [comment, setComment] = useState("");
  const [failed, setFailed] = useState<string[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const queue = useQuery({
    queryKey: ["sample-review-queue", page, filter],
    queryFn: () =>
      api.get<Queue>(
        `/technical-reviews?page=${page}&size=50&status=SUBMITTED${filter ? `&parameterCode=${encodeURIComponent(filter)}` : ""}`,
      ),
  });
  const picked = selected || queue.data?.content[0]?.sampleCode || "";
  const detail = useQuery({
    queryKey: ["sample-review", picked],
    queryFn: () => sampleApi.review(api, picked),
    enabled: !!picked,
  });
  const history = useQuery({
    queryKey: ["sample-result-versions", picked],
    queryFn: () =>
      api.get<{
        content: {
          version: number;
          decision: string;
          failedParameters: string[];
          comment: string;
          actorId: string;
          occurredAt: string;
          parameters: {
            code: string;
            name: string;
            resultSets: {
              testPart: string;
              finalResult: { value?: string; unit?: string } | null;
            }[];
          }[];
        }[];
      }>(`/samples/${encodeURIComponent(picked)}/result-versions`),
    enabled: historyOpen && canTrace && !!picked,
  });
  const action = useMutation({
    mutationFn: (decision: "ACCEPT" | "RETURN") =>
      sampleApi.decide(api, picked, {
        version: detail.data!.version,
        decision,
        ...(decision === "RETURN" ? { comment: comment.trim(), failedParameters: failed } : {}),
      }),
    onSuccess: async () => {
      setComment("");
      setFailed([]);
      await cache.invalidateQueries();
      toast("Đã ghi quyết định cho cả mẫu");
    },
  });
  const download = useMutation({
    mutationFn: async (f: { id: string; documentId: string; fileName: string }) =>
      saveBlob(await sampleApi.downloadReviewFile(api, picked, f.documentId), f.fileName),
  });
  return (
    <div className="dlp-technical-review">
      <PageHead
        title="Kiểm tra kỹ thuật"
        description="Một quyết định cho toàn bộ chỉ tiêu của mẫu."
      />
      <Field label="Lọc mã chỉ tiêu">
        <Input
          value={filter}
          onChange={(_, d) => {
            setFilter(d.value);
            setPage(1);
            setSelected("");
          }}
        />
      </Field>
      {[queue.error, detail.error, action.error, download.error].filter(Boolean).map((e, i) => (
        <MessageBar key={i} intent="error">
          <MessageBarBody>{apiErrorMessage(e)}</MessageBarBody>
        </MessageBar>
      ))}
      <div className="dlp-technical-review__layout">
        <section className="dlp-card dlp-technical-review__queue" aria-label="Mẫu chờ kiểm tra">
          {queue.isPending ? <Spinner /> : null}
          {queue.data?.content.map((s) => (
            <Button
              className="dlp-technical-review__queue-item"
              key={s.sampleCode}
              appearance={picked === s.sampleCode ? "primary" : "subtle"}
              onClick={() => {
                setSelected(s.sampleCode);
                setFailed([]);
                setComment("");
                setHistoryOpen(false);
              }}
            >
              <span className="dlp-technical-review__sample-code">{s.sampleCode}</span>
              <span>
                {s.requestCode} · {s.parameterCount} chỉ tiêu
              </span>
            </Button>
          ))}
          {queue.data && !queue.data.content.length ? <p>Không có mẫu chờ kiểm tra.</p> : null}
          <div className="dlp-technical-review__actions">
            <Button disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
              Trước
            </Button>
            <span>
              Trang {page}/{queue.data?.page.totalPages || 1}
            </span>
            <Button
              disabled={page >= (queue.data?.page.totalPages || 1)}
              onClick={() => setPage((p) => p + 1)}
            >
              Sau
            </Button>
          </div>
        </section>
        <section className="dlp-card dlp-technical-review__detail" aria-label="Kết quả mẫu">
          {picked && detail.isPending ? <Spinner label="Đang tải mẫu…" /> : null}
          {!picked ? <p>Chọn một mẫu để kiểm tra.</p> : null}
          {detail.data ? (
            <>
              <h2>
                {picked} · v{detail.data.version}
              </h2>
              {detail.data.parameters.map((p) => (
                <div key={p.code} className="dlp-technical-review__parameter">
                  <h3>
                    {p.code} · {p.name}
                  </h3>
                  <p>{p.method}</p>
                  <div className="dlp-technical-review__results">
                    {p.resultSets.map((s) => (
                      <p key={s.testPart}>
                        {s.testPart}: {s.finalResult?.value ?? "Chưa chốt"} {s.finalResult?.unit}
                      </p>
                    ))}
                  </div>
                  <div className="dlp-technical-review__files">
                    {p.technicalFiles.map((f) => (
                      <Button
                        key={f.id}
                        icon={
                          f.status === "AVAILABLE" ? <ArrowDownload20Regular /> : <Clock20Regular />
                        }
                        disabled={download.isPending || f.status !== "AVAILABLE"}
                        title={
                          f.status === "AVAILABLE"
                            ? `Tải ${f.fileName}`
                            : "File chưa sẵn sàng để tải"
                        }
                        aria-label={`Tải file kỹ thuật ${f.fileName}`}
                        onClick={() => download.mutate(f)}
                      >
                        {f.fileName}
                      </Button>
                    ))}
                  </div>
                  <Checkbox
                    label="Chỉ tiêu cần sửa khi trả mẫu"
                    checked={failed.includes(p.code)}
                    disabled={!canWrite}
                    onChange={(_, d) =>
                      setFailed((current) =>
                        d.checked ? [...current, p.code] : current.filter((c) => c !== p.code),
                      )
                    }
                  />
                </div>
              ))}
              <Field label="Lý do trả mẫu">
                <Textarea value={comment} onChange={(_, d) => setComment(d.value)} />
              </Field>
              <div className="dlp-technical-review__actions">
                <Button
                  appearance="primary"
                  disabled={
                    !canWrite ||
                    action.isPending ||
                    !detail.data.allowedActions.includes("review:accept")
                  }
                  onClick={() => {
                    if (window.confirm("Chấp nhận toàn bộ kết quả của mẫu?"))
                      action.mutate("ACCEPT");
                  }}
                >
                  Chấp nhận cả mẫu
                </Button>
                <Button
                  disabled={
                    !canWrite ||
                    action.isPending ||
                    !comment.trim() ||
                    !failed.length ||
                    !detail.data.allowedActions.includes("review:return")
                  }
                  onClick={() => {
                    if (window.confirm("Trả cả mẫu; lab chỉ được sửa những chỉ tiêu đã chọn?"))
                      action.mutate("RETURN");
                  }}
                >
                  Trả lại mẫu
                </Button>
              </div>
              {canTrace && detail.data.hasPreviousVersions ? (
                <Button onClick={() => setHistoryOpen((v) => !v)}>Lịch sử lưu vết</Button>
              ) : null}
              {historyOpen ? (
                <>
                  {history.isPending ? <Spinner /> : null}
                  {history.error ? <p>{apiErrorMessage(history.error)}</p> : null}
                  {history.data?.content.map((v) => (
                    <div key={v.version}>
                      v{v.version} · {v.comment} · {v.occurredAt}
                      {v.parameters.map((p) => (
                        <div key={p.code}>
                          {p.name}
                          {p.resultSets.map((r) => (
                            <p key={r.testPart}>
                              {r.testPart}: {r.finalResult?.value} {r.finalResult?.unit}
                            </p>
                          ))}
                        </div>
                      ))}
                    </div>
                  ))}
                </>
              ) : null}
            </>
          ) : null}
        </section>
      </div>
    </div>
  );
}

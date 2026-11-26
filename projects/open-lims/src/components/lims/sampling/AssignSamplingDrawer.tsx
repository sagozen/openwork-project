import {
  Badge,
  Button,
  Drawer,
  DrawerBody,
  DrawerFooter,
  DrawerHeader,
  DrawerHeaderTitle,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Radio,
  Textarea,
} from "@fluentui/react-components";
import { Dismiss20Regular } from "@fluentui/react-icons";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiErrorMessage, useApiClient } from "@/lib/api";
import { samplingApi, samplingKeys } from "@/features/sampling";
import { useAuth } from "@/lib/auth/AuthProvider";
import { useDlpToast } from "@/components/lims/common/toast";
import { FieldLabel } from "@/components/lims/common";
import { toneToColor } from "@/lib/admin/tone";
import { BM01_PLACE, SAMPLERS } from "@/lib/admin/sampling-data";

export interface AssignResult {
  samplerId: string;
  samplerName: string;
  date: string;
  time: string;
  place: string;
  note: string;
}

/* S-05 · Drawer «Phân công lấy mẫu» (UC-08, D02) - mở từ S-10/S-11. */
export function AssignSamplingDrawer({
  recordId,
  open,
  onOpenChange,
  onConfirm,
  defaultDate = "02/08/2026",
  defaultTime = "08:00",
  bm01Place,
}: {
  recordId: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onConfirm: (r: AssignResult) => void;
  defaultDate?: string;
  defaultTime?: string;
  /** Địa điểm khai trên BM01 của chính hồ sơ này. Trường này không bắt buộc khi tạo hồ sơ nên
   *  có thể trống - lúc đó điều phối viên tự nhập địa điểm hẹn. Bản demo (không có dữ liệu thật)
   *  dùng địa điểm fixture; ở chế độ dữ liệu thật tuyệt đối không lấy fixture, nếu không câu "đã
   *  sửa khác BM01" so với một địa điểm không liên quan tới hồ sơ. */
  bm01Place?: string;
}) {
  const { usesClerk } = useAuth();
  const api = useApiClient();
  const cache = useQueryClient();
  const notify = useDlpToast();
  const [samplerId, setSamplerId] = useState(SAMPLERS[0]!.id);
  const [date, setDate] = useState(defaultDate);
  const [time, setTime] = useState(defaultTime);
  const declaredPlace = (bm01Place ?? (usesClerk ? "" : BM01_PLACE)).trim();
  const [place, setPlace] = useState(declaredPlace);
  const [note, setNote] = useState("");
  const remoteSamplers = useQuery({
    queryKey: ["sampling", "samplers", date],
    queryFn: () => samplingApi.samplers(api, { date }),
    enabled: usesClerk && open,
  });
  const assign = useMutation({
    mutationFn: () =>
      samplingApi.assign(api, recordId, {
        samplerId,
        scheduledDate: date,
        scheduledTime: time,
        location: place,
        ...(note.trim() ? { note: note.trim() } : {}),
      }),
    onSuccess: async () => cache.invalidateQueries({ queryKey: samplingKeys.all }),
  });
  useEffect(() => {
    if (open) {
      setSamplerId(SAMPLERS[0]!.id);
      setDate(usesClerk ? new Date().toISOString().slice(0, 10) : defaultDate);
      setTime(defaultTime);
      setPlace(declaredPlace);
      setNote("");
    }
  }, [open, defaultDate, defaultTime, declaredPlace, usesClerk]);

  useEffect(() => {
    const first = remoteSamplers.data?.content[0];
    if (usesClerk && first && !remoteSamplers.data?.content.some((item) => item.id === samplerId)) {
      setSamplerId(first.id);
    }
  }, [remoteSamplers.data, samplerId, usesClerk]);

  const samplerOptions = usesClerk
    ? (remoteSamplers.data?.content ?? []).map((s) => ({
        id: s.id,
        name: s.fullName,
        load: `${s.assignedCount} lượt được giao · ${s.completedCount} hoàn tất hôm nay`,
        state: s.available ? "Sẵn sàng" : "Không khả dụng",
        tone: s.available ? ("success" as const) : ("danger" as const),
        available: s.available,
      }))
    : SAMPLERS;
  const sampler = samplerOptions.find((s) => s.id === samplerId) ?? samplerOptions[0];
  // Hồ sơ có thể không khai địa điểm: khi đó không có gì để so sánh hay "lấy lại", chỉ nhập mới.
  const placeChanged = !!declaredPlace && place !== declaredPlace;

  return (
    <Drawer
      type="overlay"
      position="end"
      separator
      open={open}
      onOpenChange={(_, d) => onOpenChange(d.open)}
      style={{ width: 420 }}
    >
      <DrawerHeader>
        <DrawerHeaderTitle
          action={
            <Button
              appearance="subtle"
              icon={<Dismiss20Regular />}
              aria-label="Đóng"
              onClick={() => onOpenChange(false)}
            />
          }
        >
          Phân công lấy mẫu - {recordId}
        </DrawerHeaderTitle>
      </DrawerHeader>

      <DrawerBody>
        <div style={{ display: "flex", flexDirection: "column", gap: 16, paddingBottom: 16 }}>
          <MessageBar intent="info">
            <MessageBarBody>
              <MessageBarTitle>Quản lý một cửa:</MessageBarTitle>
              Chỉ nhân viên thuộc chi nhánh CN1 mới nhận được lượt này. Nhân viên được giao sẽ thấy
              lượt trên ứng dụng hiện trường và nhận thông báo in-app.
            </MessageBarBody>
          </MessageBar>

          <div>
            <div
              style={{
                font: "600 12px/16px var(--font-family-base)",
                color: "var(--foreground-secondary)",
                marginBottom: 8,
              }}
            >
              Nhân viên lấy mẫu
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              {remoteSamplers.isError ? (
                <MessageBar intent="error">
                  <MessageBarBody>{apiErrorMessage(remoteSamplers.error)}</MessageBarBody>
                </MessageBar>
              ) : null}
              {samplerOptions.map((sm) => {
                const on = sm.id === samplerId;
                return (
                  <div
                    key={sm.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => setSamplerId(sm.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") setSamplerId(sm.id);
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      padding: 10,
                      border: `1px solid ${on ? "var(--border-accent)" : "var(--border-subtle)"}`,
                      borderRadius: "var(--radius-control)",
                      cursor: "pointer",
                      background: on ? "var(--background-selected)" : "var(--background-surface)",
                    }}
                  >
                    <Radio checked={on} onChange={() => setSamplerId(sm.id)} label="" />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ font: "14px/20px var(--font-family-base)" }}>{sm.name}</div>
                      <div className="dlp-datagrid__secondary">{sm.load}</div>
                    </div>
                    <Badge appearance="tint" size="small" color={toneToColor(sm.tone)}>
                      {sm.state}
                    </Badge>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Hai lớp cùng phải co thì ô "Giờ hẹn" mới không bị đẩy ra ngoài mép phải drawer:
              - `minWidth: 0` cho ô ngày co được dưới bề rộng nội dung;
              - `Input` của Fluent mang `min-width` mặc định RỘNG HƠN ô 120px, nên chính nó tràn ra
                khỏi thẻ bọc. Ép `minWidth: 0` + `width: 100%` cho cả hai ô nhập.
              Sửa mỗi thẻ bọc là chưa đủ - đó là lý do lần chỉnh trước trông giống đã xong mà màn
              hình vẫn cắt. */}
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <Field label="Ngày lấy mẫu">
                <Input
                  style={{ minWidth: 0, width: "100%" }}
                  value={date}
                  onChange={(_, d) => setDate(d.value)}
                />
              </Field>
            </div>
            <div style={{ width: 120, flexShrink: 0 }}>
              <Field label="Giờ hẹn">
                <Input
                  style={{ minWidth: 0, width: "100%" }}
                  value={time}
                  onChange={(_, d) => setTime(d.value)}
                />
              </Field>
            </div>
          </div>

          <Field
            label={
              <FieldLabel
                label="Địa điểm lấy mẫu"
                tooltip={
                  !declaredPlace
                    ? "BM01 chưa khai địa điểm - nhập địa điểm hẹn lấy mẫu"
                    : placeChanged
                      ? `Đã sửa khác BM01 (${declaredPlace})`
                      : "Điền sẵn từ BM01 - chỉ sửa nếu khách đổi địa điểm"
                }
              />
            }
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <Textarea
                rows={4}
                resize="vertical"
                style={{ width: "100%" }}
                value={place}
                placeholder="Nhập địa chỉ, tên kho hoặc khu vực lấy mẫu"
                onChange={(_, d) => setPlace(d.value)}
              />
              {placeChanged ? (
                <Button
                  size="small"
                  style={{ alignSelf: "flex-start" }}
                  onClick={() => setPlace(declaredPlace)}
                >
                  Lấy lại BM01
                </Button>
              ) : null}
            </div>
          </Field>

          <Field label="Ghi chú điều phối">
            <Textarea
              rows={2}
              value={note}
              placeholder="Ví dụ: liên hệ kho trước 30 phút"
              onChange={(_, d) => setNote(d.value)}
            />
          </Field>
        </div>
      </DrawerBody>

      <DrawerFooter>
        <Button
          appearance="primary"
          disabled={!sampler?.available || assign.isPending || !date || !time || !place.trim()}
          onClick={async () => {
            if (!sampler) return;
            if (usesClerk) {
              try {
                await assign.mutateAsync();
              } catch (error) {
                notify(apiErrorMessage(error), undefined, "error");
                return;
              }
            }
            onConfirm({ samplerId, samplerName: sampler.name, date, time, place, note });
          }}
        >
          Xác nhận phân công
        </Button>
        <Button onClick={() => onOpenChange(false)}>Huỷ</Button>
      </DrawerFooter>
    </Drawer>
  );
}

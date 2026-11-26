import {
  Badge,
  Button,
  Input,
  Menu,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
} from "@fluentui/react-components";
import { PersonSwap20Regular, Tag20Regular, TagDismiss20Regular } from "@fluentui/react-icons";
import { useState } from "react";
import { RECORD_TAGS, type TagDef } from "@/lib/admin/records-view-data";
import { toneToColor } from "@/lib/admin/tone";
import type { RecordsView } from "@/lib/admin/records-view-state";
import { PermissionButton } from "@/components/lims/common/PermissionButton";
import { useDlpToast } from "@/components/lims/common/toast";

const HANDLERS = ["Trần Minh", "Nguyễn Hà", "Lê Quang", "Phạm Thu", "Chưa phân công"];

export function SelectionBar({
  view,
  canWrite,
  bulkSupported = true,
  tagCatalog,
  onAttachTag,
  onDetachTag,
  tagBusy,
}: {
  view: RecordsView;
  canPii?: boolean;
  canWrite: boolean;
  /** Tắt khi backend chưa có API thao tác hàng loạt: chỉ hiện lý do, không giả lập kết quả. */
  bulkSupported?: boolean;
  /** Danh mục nhãn thật để chọn. Vắng mặt ở chế độ minh hoạ, nơi dùng dữ liệu dựng sẵn. */
  tagCatalog?: TagDef[];
  /** Có mặt nghĩa là gắn/gỡ nhãn ghi thật lên máy chủ. */
  onAttachTag?: (tagCode: string) => void;
  onDetachTag?: (tagCode: string) => void;
  tagBusy?: boolean;
}) {
  const [newTag, setNewTag] = useState("");
  const toast = useDlpToast();
  const n = view.selected.length;
  if (n === 0) return null;

  // Chế độ thật: gắn/gỡ nhãn có endpoint, còn đổi người xử lý thì chưa - nên thanh này chỉ bày
  // đúng phần làm được, và nói ra phần chưa có thay vì để một nút không dẫn tới đâu.
  if (onAttachTag && onDetachTag) {
    const catalog = tagCatalog ?? [];
    return (
      <div className="dlp-selectionbar" role="region" aria-label="Thao tác trên phiếu đã chọn">
        <span style={{ fontWeight: 600 }}>Đã chọn {n} phiếu</span>
        <div style={{ flex: 1 }} />

        <Menu>
          <MenuTrigger disableButtonEnhancement>
            <PermissionButton
              allowed={canWrite && !tagBusy && catalog.length > 0}
              size="small"
              icon={<Tag20Regular />}
            >
              Gắn nhãn
            </PermissionButton>
          </MenuTrigger>
          <MenuPopover>
            <MenuList>
              {catalog.map((t) => (
                <MenuItem key={t.code ?? t.name} onClick={() => onAttachTag(t.code ?? t.name)}>
                  <Badge appearance="tint" color={toneToColor(t.color)}>
                    {t.name}
                  </Badge>
                  <span className="dlp-datagrid__secondary" style={{ marginLeft: 8 }}>
                    {t.scope}
                  </span>
                </MenuItem>
              ))}
            </MenuList>
          </MenuPopover>
        </Menu>

        <Menu>
          <MenuTrigger disableButtonEnhancement>
            <PermissionButton
              allowed={canWrite && !tagBusy && catalog.length > 0}
              size="small"
              icon={<TagDismiss20Regular />}
            >
              Gỡ nhãn
            </PermissionButton>
          </MenuTrigger>
          <MenuPopover>
            <MenuList>
              {catalog.map((t) => (
                <MenuItem key={t.code ?? t.name} onClick={() => onDetachTag(t.code ?? t.name)}>
                  {t.name}
                </MenuItem>
              ))}
            </MenuList>
          </MenuPopover>
        </Menu>

        <span className="dlp-datagrid__secondary">
          Đổi người xử lý hàng loạt chưa có API - mở từng phiếu.
        </span>
        <Button size="small" appearance="transparent" onClick={() => view.setSelected([])}>
          Bỏ chọn
        </Button>
      </div>
    );
  }

  if (!bulkSupported) {
    return (
      <div className="dlp-selectionbar" role="region" aria-label="Thao tác trên phiếu đã chọn">
        <span style={{ fontWeight: 600 }}>Đã chọn {n} phiếu</span>
        <div style={{ flex: 1 }} />
        <span className="dlp-datagrid__secondary">
          Màn này chưa có thao tác hàng loạt. Mở từng phiếu để gắn nhãn hoặc đổi người xử lý.
        </span>
        <Button size="small" appearance="transparent" onClick={() => view.setSelected([])}>
          Bỏ chọn
        </Button>
      </div>
    );
  }

  return (
    <div className="dlp-selectionbar" role="region" aria-label="Thao tác trên phiếu đã chọn">
      <span style={{ fontWeight: 600 }}>Đã chọn {n} phiếu</span>
      <div style={{ flex: 1 }} />

      <Menu>
        <MenuTrigger disableButtonEnhancement>
          <PermissionButton allowed={canWrite} size="small" icon={<Tag20Regular />}>
            Gắn nhãn
          </PermissionButton>
        </MenuTrigger>
        <MenuPopover>
          <MenuList>
            {RECORD_TAGS.slice(0, 6).map((t) => (
              <MenuItem
                key={t.name}
                onClick={() => {
                  view.addTagToSelected(t.name);
                  toast("Đã gắn nhãn", `${t.name} · ${n} phiếu`);
                }}
              >
                <Badge appearance="tint" color={toneToColor(t.color)}>
                  {t.name}
                </Badge>
                <span className="dlp-datagrid__secondary" style={{ marginLeft: 8 }}>
                  {t.scope}
                </span>
              </MenuItem>
            ))}
            <div style={{ display: "flex", gap: 6, padding: "8px 10px" }}>
              <Input
                size="small"
                value={newTag}
                onChange={(_, d) => setNewTag(d.value)}
                placeholder="Nhãn mới…"
                aria-label="Tên nhãn mới"
              />
              <Button
                size="small"
                appearance="primary"
                disabled={!newTag.trim()}
                onClick={() => {
                  const name = newTag.trim();
                  view.addTagToSelected(name);
                  setNewTag("");
                  toast("Đã tạo và gắn nhãn", `${name} · ${n} phiếu`);
                }}
              >
                Thêm
              </Button>
            </div>
          </MenuList>
        </MenuPopover>
      </Menu>

      <Menu>
        <MenuTrigger disableButtonEnhancement>
          <PermissionButton allowed={canWrite} size="small" icon={<TagDismiss20Regular />}>
            Gỡ nhãn
          </PermissionButton>
        </MenuTrigger>
        <MenuPopover>
          <MenuList>
            {RECORD_TAGS.slice(0, 6).map((t) => (
              <MenuItem
                key={t.name}
                onClick={() => {
                  view.removeTagFromSelected(t.name);
                  toast("Đã gỡ nhãn", `${t.name} · ${n} phiếu`);
                }}
              >
                {t.name}
              </MenuItem>
            ))}
          </MenuList>
        </MenuPopover>
      </Menu>

      <Menu>
        <MenuTrigger disableButtonEnhancement>
          <PermissionButton allowed={canWrite} size="small" icon={<PersonSwap20Regular />}>
            Đổi người xử lý
          </PermissionButton>
        </MenuTrigger>
        <MenuPopover>
          <MenuList>
            {HANDLERS.map((h) => (
              <MenuItem
                key={h}
                onClick={() => {
                  view.assignHandlerToSelected(h);
                  toast("Đã đổi người xử lý", `${h} · ${n} phiếu`);
                }}
              >
                {h}
              </MenuItem>
            ))}
          </MenuList>
        </MenuPopover>
      </Menu>

      <Button size="small" appearance="transparent" onClick={() => view.setSelected([])}>
        Bỏ chọn
      </Button>
    </div>
  );
}

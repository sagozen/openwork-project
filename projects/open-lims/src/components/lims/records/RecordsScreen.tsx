import type { ReactElement, ReactNode } from "react";
import { useState } from "react";
import { Badge, Button } from "@fluentui/react-components";
import {
  Add20Regular,
  ArrowDownload20Regular,
  Board20Regular,
  Eye20Regular,
  Filter20Regular,
  Table20Regular,
  TableColumnTopBottom20Regular,
  Tag20Regular,
  TaskListSquareLtr20Regular,
} from "@fluentui/react-icons";
import {
  FilterChips,
  PageHead,
  PermissionButton,
  PopoverMenu,
  SearchInput,
  SegmentedControl,
  StatStrip,
  Toolbar,
  useDlpToast,
  type FilterChip,
  type StatItem,
} from "@/components/lims/common";
import { ColumnDrawer } from "./ColumnDrawer";
import { FilterDrawer } from "./FilterDrawer";
import { RecordsBoard } from "./RecordsBoard";
import { RecordsTable } from "./RecordsTable";
import { RecordsWorklist, type WorklistPanels } from "./RecordsWorklist";
import { SaveViewDialog } from "./SaveViewDialog";
import { SelectionBar } from "./SelectionBar";
import { TagFilterPanel } from "./TagFilterPanel";
import { ViewMenu } from "./ViewMenu";
import { condLabel, type TagDef } from "@/lib/admin/records-view-data";
import type { RecordsView, Variant } from "@/lib/admin/records-view-state";
import { exportRecordsCsv } from "@/lib/admin/records-export";

const VARIANTS: { id: Variant; label: string; icon: ReactElement }[] = [
  { id: "A", label: "Bảng dày", icon: <Table20Regular /> },
  { id: "B", label: "Worklist + hàng chờ", icon: <TaskListSquareLtr20Regular /> },
  { id: "C", label: "Bảng theo trạng thái", icon: <Board20Regular /> },
];

export interface RecordsScreenProps {
  view: RecordsView;
  canPii: boolean;
  canWrite: boolean;
  stats: StatItem[];
  /** Danh mục nhãn cho bảng lọc nhãn. */
  tagCatalog: TagDef[];
  /** Cột cố định của bảng theo trạng thái; các trạng thái khác trong dữ liệu được thêm sau. */
  boardBaseColumns: string[];
  panels: WorklistPanels;
  /** Còn bật khi hệ thống có API thao tác hàng loạt (gắn/gỡ nhãn, đổi người xử lý). */
  bulkSupported: boolean;
  /** Gắn/gỡ nhãn ghi thật lên máy chủ; vắng mặt ở chế độ minh hoạ. */
  onAttachTag?: (tagCode: string) => void;
  onDetachTag?: (tagCode: string) => void;
  tagBusy?: boolean;
  /** Số đếm của chế độ xem chỉ hiển thị khi số đó có thật. */
  showViewCounts: boolean;
  searchPlaceholder: string;
  onCreate: () => void;
  alert?: ReactNode;
  /** Bộ lọc chỉ có ở bản chạy thật (trạng thái, chi nhánh, khoảng ngày…). */
  extraFilters?: ReactNode;
  extraChips?: FilterChip[];
  onClearExtraFilters?: () => void;
  /** Spinner/thông báo lỗi hiển thị trên vùng nội dung. */
  status?: ReactNode;
  /** Thanh phân trang dưới bảng. */
  footer?: ReactNode;
  exportDisabled?: boolean;
}

/** Bố cục chung của màn Hồ sơ kiểm nghiệm (S-10), dùng cho cả bản mockup lẫn bản chạy dữ liệu
 *  thật để hai màn không lệch nhau về chế độ xem, cột, nhãn và ba phương án bố cục. */
export function RecordsScreen({
  view,
  canPii,
  canWrite,
  stats,
  tagCatalog,
  boardBaseColumns,
  panels,
  bulkSupported,
  onAttachTag,
  onDetachTag,
  tagBusy,
  showViewCounts,
  searchPlaceholder,
  onCreate,
  alert,
  extraFilters,
  extraChips = [],
  onClearExtraFilters,
  status,
  footer,
  exportDisabled = false,
}: RecordsScreenProps) {
  const toast = useDlpToast();
  const [viewMenu, setViewMenu] = useState(false);
  const [tagPanel, setTagPanel] = useState(false);
  const [saveDialog, setSaveDialog] = useState(false);
  const [filterDrawer, setFilterDrawer] = useState(false);
  const [colDrawer, setColDrawer] = useState(false);

  const chips: FilterChip[] = [
    ...view.state.tags.map((t) => ({
      label: `Nhãn: ${t}`,
      remove: () => view.toggleTag(t),
    })),
    ...view.state.conds.map((c, i) => ({
      label: condLabel(c),
      remove: () => view.patch({ conds: view.state.conds.filter((_, k) => k !== i) }),
    })),
    ...extraChips,
  ];

  const clearAll = () => {
    view.clearAllFilters();
    onClearExtraFilters?.();
  };

  const exportCsv = () => {
    exportRecordsCsv(view.visibleColumns, view.rows, canPii);
    toast("Đã xuất dữ liệu", `${view.rows.length} dòng theo bộ lọc hiện tại`);
  };

  return (
    <>
      <PageHead
        crumbs={[{ label: "Nghiệp vụ" }, { label: "Hồ sơ kiểm nghiệm" }]}
        title="Hồ sơ kiểm nghiệm"
        description="Theo dõi toàn bộ lượt kiểm nghiệm: tiến độ mẫu, tình trạng thanh toán và người xử lý."
        actions={
          <>
            <Button
              icon={<ArrowDownload20Regular />}
              disabled={exportDisabled || view.rows.length === 0}
              onClick={exportCsv}
            >
              Xuất dữ liệu
            </Button>
            <PermissionButton
              allowed={canWrite}
              appearance="primary"
              icon={<Add20Regular />}
              onClick={onCreate}
            >
              Tạo yêu cầu mới
            </PermissionButton>
          </>
        }
      />

      <div className="dlp-stack">
        <StatStrip items={stats} />

        {alert}

        <Toolbar
          left={
            <>
              <div style={{ position: "relative" }}>
                <Button icon={<Eye20Regular />} onClick={() => setViewMenu((v) => !v)}>
                  {view.currentView?.name ?? "Chế độ xem"}
                </Button>
                <PopoverMenu
                  open={viewMenu}
                  onClose={() => setViewMenu(false)}
                  width={320}
                  label="Chế độ xem"
                >
                  <ViewMenu
                    view={view}
                    showCounts={showViewCounts}
                    onClose={() => setViewMenu(false)}
                    onSaveNew={() => {
                      setViewMenu(false);
                      setSaveDialog(true);
                    }}
                  />
                </PopoverMenu>
              </div>

              {view.dirty ? (
                <>
                  <Badge appearance="tint" color="warning">
                    Đã chỉnh sửa
                  </Badge>
                  <Button size="small" onClick={() => setSaveDialog(true)}>
                    Lưu thay đổi
                  </Button>
                </>
              ) : null}

              <SearchInput
                value={view.query}
                onChange={view.setQuery}
                placeholder={searchPlaceholder}
                label="Tìm hồ sơ"
              />
            </>
          }
          right={
            <>
              <div style={{ position: "relative" }}>
                <Button
                  icon={<Tag20Regular />}
                  appearance={view.state.tags.length ? "primary" : "secondary"}
                  onClick={() => setTagPanel((v) => !v)}
                >
                  {view.state.tags.length ? `Nhãn · ${view.state.tags.length}` : "Nhãn"}
                </Button>
                <PopoverMenu
                  open={tagPanel}
                  onClose={() => setTagPanel(false)}
                  align="right"
                  width={360}
                  label="Lọc theo nhãn"
                >
                  <TagFilterPanel
                    view={view}
                    tags={tagCatalog}
                    onClose={() => setTagPanel(false)}
                  />
                </PopoverMenu>
              </div>

              <Button
                icon={<Filter20Regular />}
                appearance={chips.length ? "primary" : "secondary"}
                onClick={() => setFilterDrawer(true)}
              >
                {chips.length ? `Bộ lọc · ${chips.length}` : "Bộ lọc"}
              </Button>
              <Button icon={<TableColumnTopBottom20Regular />} onClick={() => setColDrawer(true)}>
                Cột
              </Button>

              <SegmentedControl
                items={VARIANTS}
                value={view.state.variant}
                onChange={(id) => view.patch({ variant: id }, false)}
                label="Phương án bố cục"
              />
            </>
          }
        />

        <FilterChips chips={chips} onClearAll={clearAll} />

        {status}

        {view.state.variant === "A" ? (
          <div>
            <SelectionBar
              view={view}
              canWrite={canWrite}
              bulkSupported={bulkSupported}
              tagCatalog={tagCatalog}
              onAttachTag={onAttachTag}
              onDetachTag={onDetachTag}
              tagBusy={tagBusy}
            />
            <RecordsTable view={view} canPii={canPii} />
          </div>
        ) : null}
        {view.state.variant === "B" ? (
          <RecordsWorklist view={view} canPii={canPii} panels={panels} />
        ) : null}
        {view.state.variant === "C" ? (
          <RecordsBoard view={view} baseColumns={boardBaseColumns} />
        ) : null}

        {footer}
      </div>

      <SaveViewDialog view={view} open={saveDialog} onOpenChange={setSaveDialog} />
      <FilterDrawer
        view={view}
        open={filterDrawer}
        onOpenChange={setFilterDrawer}
        extra={extraFilters}
      />
      <ColumnDrawer view={view} open={colDrawer} onOpenChange={setColDrawer} />
    </>
  );
}

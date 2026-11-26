// Interface primitives shared by the admin and the theme. They render the
// shared classes in ui.css and take every visible label as a prop, so each
// surface supplies its own wording and language.
export { CopyField } from "./copy-field.js";
export { Disclosure } from "./disclosure.js";
export { EmptyState } from "./empty-state.js";
export { Icon, type IconName } from "./icon.js";
export { InlineAlert, type Tone } from "./inline-alert.js";
export { ProgressMeter } from "./progress-meter.js";
export { Sheet } from "./sheet.js";
export { Skeleton } from "./skeleton.js";
export { StatusPill } from "./status-pill.js";
export { Tabs } from "./tabs.js";
export { showToast, ToastRegion } from "./toast.js";
export {
  useConfirmDialog,
  type Confirm,
  type ConfirmOptions,
  type ConfirmResult,
} from "./confirm-dialog.js";

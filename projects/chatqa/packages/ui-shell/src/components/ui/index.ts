// Design system pen.dev: mọi thành phần dùng chung đi qua cửa này (import { Button } from '../components/ui').
// Card, Badge, PageHeader, ErrorText là thành phần cũ cho các trang chưa chuyển sang pen.
export { Card, Badge, PageHeader, ErrorText } from './legacy';
export { cx } from './cx';
export { Button, type ButtonProps, type ButtonSize, type ButtonVariant } from './Button';
export { Input, type InputProps, type InputSize } from './Input';
export { Tabs, type TabItem } from './Tabs';
export { DataTable, type Column, type DataTableProps } from './DataTable';
export { Menu, MenuItem, MenuNote } from './Menu';
export { RoleChip, roleOf, AppChip, StatusDot, Tag, OnlyRequestTag, Avatar, type AvatarTone, type RoleCode } from './chips';
export { Toggle, type ToggleProps } from './Toggle';
export { Checkbox } from './Checkbox';
export { Segmented, type SegmentOption } from './Segmented';
export { Dialog, type DialogProps, type DialogTone } from './Dialog';
export { Banner } from './Banner';
export { Toast } from './Toast';
export { Stepper } from './Stepper';

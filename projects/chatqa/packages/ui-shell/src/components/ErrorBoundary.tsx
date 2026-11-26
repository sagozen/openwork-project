import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';

interface Props {
  scope: string;
  children: ReactNode;
}

/** Bắt lỗi render của 1 vùng (1 phân hệ) - phần còn lại của app vẫn dùng được. */
export class ErrorBoundary extends Component<Props, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[${this.props.scope}]`, error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className="mx-auto mt-16 max-w-lg rounded-xl border border-red-200 bg-red-50 p-6 text-center">
        <AlertTriangle className="mx-auto text-red-600" />
        <h2 className="mt-3 font-semibold text-red-900">{this.props.scope} gặp lỗi hiển thị</h2>
        <p className="mt-1 text-sm text-red-800">
          Dữ liệu đã lưu trên máy không bị ảnh hưởng. Các phân hệ khác vẫn dùng bình thường.
        </p>
        <p className="mt-3 break-all font-mono text-xs text-red-700/80">{this.state.error.message}</p>
        <button
          onClick={() => this.setState({ error: null })}
          className="mt-4 inline-flex h-9 items-center rounded-lg bg-red-700 px-3.5 text-sm font-medium text-white hover:bg-red-800"
        >
          Thử lại
        </button>
      </div>
    );
  }
}

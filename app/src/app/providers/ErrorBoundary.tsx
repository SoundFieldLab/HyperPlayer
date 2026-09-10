import { Component, type ErrorInfo, type ReactNode } from 'react';
import { errorMessage } from '../../shared/errors';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/** 渲染层兜底：任何子树抛错都落在可操作的错误页，而不是整窗白屏。 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('render: 组件树异常', error, info.componentStack);
  }

  private reload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <main
        role="alert"
        style={{
          height: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 16,
          padding: 24,
          textAlign: 'center',
        }}
      >
        <h1 style={{ fontSize: 20, fontWeight: 600 }}>界面出现问题</h1>
        <p style={{ maxWidth: 560, opacity: 0.8, wordBreak: 'break-all' }}>
          {errorMessage(this.state.error)}
        </p>
        <div style={{ display: 'flex', gap: 12 }}>
          <button type="button" className="hp-button hp-button--primary" onClick={this.reload}>
            重新加载
          </button>
        </div>
      </main>
    );
  }
}

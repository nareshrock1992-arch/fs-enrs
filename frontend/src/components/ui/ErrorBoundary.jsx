import { Component } from 'react';

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary] Uncaught render error:', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 text-center px-4">
          <div className="w-12 h-12 rounded-full bg-red-500/15 flex items-center justify-center">
            <span className="text-red-500 text-xl font-bold">!</span>
          </div>
          <div>
            <p className="text-base font-semibold text-text-primary">Something went wrong</p>
            <p className="text-sm text-text-muted mt-1 max-w-sm">
              {this.state.error?.message || 'An unexpected error occurred on this page.'}
            </p>
          </div>
          <button
            className="btn-primary text-sm"
            onClick={() => this.setState({ error: null })}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

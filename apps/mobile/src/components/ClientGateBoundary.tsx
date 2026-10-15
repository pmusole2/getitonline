import { Component, type ReactNode } from 'react';

interface ClientGateBoundaryProps {
  readonly children: ReactNode;
}

interface ClientGateBoundaryState {
  readonly failed: boolean;
}

// Contains a failed gate check. Without this, an error thrown during render would reach the app-level error
// screen and block launch. A failed check renders nothing, and the gate keeps the decision it already holds.
export class ClientGateBoundary extends Component<ClientGateBoundaryProps, ClientGateBoundaryState> {
  state: ClientGateBoundaryState = { failed: false };

  static getDerivedStateFromError(): ClientGateBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.warn('Version check failed; the last version decision is kept.', error);
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

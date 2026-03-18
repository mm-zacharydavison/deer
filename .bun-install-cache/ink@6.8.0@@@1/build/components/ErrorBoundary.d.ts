import React, { PureComponent, type ReactNode } from 'react';
type Props = {
    readonly children: ReactNode;
    readonly onError: (error: Error) => void;
};
type State = {
    readonly error?: Error;
};
export default class ErrorBoundary extends PureComponent<Props, State> {
    static displayName: string;
    static getDerivedStateFromError(error: Error): {
        error: Error;
    };
    state: State;
    componentDidCatch(error: Error): void;
    render(): string | number | bigint | boolean | Iterable<React.ReactNode> | Promise<string | number | bigint | boolean | React.ReactPortal | React.ReactElement<unknown, string | React.JSXElementConstructor<any>> | Iterable<React.ReactNode> | null | undefined> | React.JSX.Element | null | undefined;
}
export {};

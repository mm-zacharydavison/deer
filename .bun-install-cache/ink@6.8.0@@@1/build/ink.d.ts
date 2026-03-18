import { type ReactNode } from 'react';
import { type CursorPosition } from './log-update.js';
import { type KittyKeyboardOptions } from './kitty-keyboard.js';
/**
Performance metrics for a render operation.
*/
export type RenderMetrics = {
    /**
    Time spent rendering in milliseconds.
    */
    renderTime: number;
};
export type Options = {
    stdout: NodeJS.WriteStream;
    stdin: NodeJS.ReadStream;
    stderr: NodeJS.WriteStream;
    debug: boolean;
    exitOnCtrlC: boolean;
    patchConsole: boolean;
    onRender?: (metrics: RenderMetrics) => void;
    isScreenReaderEnabled?: boolean;
    waitUntilExit?: () => Promise<unknown>;
    maxFps?: number;
    incrementalRendering?: boolean;
    /**
    Enable React Concurrent Rendering mode.

    When enabled:
    - Suspense boundaries work correctly with async data
    - `useTransition` and `useDeferredValue` are fully functional
    - Updates can be interrupted for higher priority work

    Note: Concurrent mode changes the timing of renders. Some tests may need to use `act()` to properly await updates. The `concurrent` option only takes effect on the first render for a given stdout. If you need to change the rendering mode, call `unmount()` first.

    @default false
    @experimental
    */
    concurrent?: boolean;
    kittyKeyboard?: KittyKeyboardOptions;
};
export default class Ink {
    /**
    Whether this instance is using concurrent rendering mode.
    */
    readonly isConcurrent: boolean;
    private readonly options;
    private readonly log;
    private cursorPosition;
    private readonly throttledLog;
    private readonly isScreenReaderEnabled;
    private isUnmounted;
    private isUnmounting;
    private lastOutput;
    private lastOutputToRender;
    private lastOutputHeight;
    private lastTerminalWidth;
    private readonly container;
    private readonly rootNode;
    private fullStaticOutput;
    private exitPromise?;
    private exitResult;
    private beforeExitHandler?;
    private restoreConsole?;
    private readonly unsubscribeResize?;
    private readonly throttledOnRender?;
    private hasPendingThrottledRender;
    private kittyProtocolEnabled;
    private cancelKittyDetection?;
    constructor(options: Options);
    getTerminalWidth: () => number;
    resized: () => void;
    resolveExitPromise: (result?: unknown) => void;
    rejectExitPromise: (reason?: Error) => void;
    unsubscribeExit: () => void;
    handleAppExit: (errorOrResult?: unknown) => void;
    setCursorPosition: (position: CursorPosition | undefined) => void;
    restoreLastOutput: () => void;
    calculateLayout: () => void;
    onRender: () => void;
    render(node: ReactNode): void;
    writeToStdout(data: string): void;
    writeToStderr(data: string): void;
    unmount(error?: Error | number | null): void;
    waitUntilExit(): Promise<unknown>;
    clear(): void;
    patchConsole(): void;
    private initKittyKeyboard;
    private confirmKittySupport;
    private enableKittyProtocol;
}

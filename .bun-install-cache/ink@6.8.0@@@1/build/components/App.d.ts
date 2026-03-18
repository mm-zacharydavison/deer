import React, { type ReactNode } from 'react';
import { type CursorPosition } from '../log-update.js';
type Props = {
    readonly children: ReactNode;
    readonly stdin: NodeJS.ReadStream;
    readonly stdout: NodeJS.WriteStream;
    readonly stderr: NodeJS.WriteStream;
    readonly writeToStdout: (data: string) => void;
    readonly writeToStderr: (data: string) => void;
    readonly exitOnCtrlC: boolean;
    readonly onExit: (errorOrResult?: unknown) => void;
    readonly setCursorPosition: (position: CursorPosition | undefined) => void;
};
declare function App({ children, stdin, stdout, stderr, writeToStdout, writeToStderr, exitOnCtrlC, onExit, setCursorPosition, }: Props): React.ReactNode;
declare namespace App {
    var displayName: string;
}
export default App;

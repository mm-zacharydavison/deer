export type Props = {
    /**
    Exit (unmount) the whole Ink app.

    - `exit()` — resolves `waitUntilExit()` with `undefined`.
    - `exit(new Error('…'))` — rejects `waitUntilExit()` with the error.
    - `exit(value)` — resolves `waitUntilExit()` with `value`.
    */
    readonly exit: (errorOrResult?: Error | unknown) => void;
};
/**
`AppContext` is a React context that exposes a method to manually exit the app (unmount).
*/
declare const AppContext: import("react").Context<Props>;
export default AppContext;

import { type CursorPosition } from '../log-update.js';
/**
`useCursor` is a React hook that lets you control the terminal cursor position.

Setting a cursor position makes the cursor visible at the specified coordinates (relative to the Ink output origin). This is useful for IME (Input Method Editor) support, where the composing character is displayed at the cursor location.

Pass `undefined` to hide the cursor.
*/
declare const useCursor: () => {
    setCursorPosition: (position: CursorPosition | undefined) => void;
};
export default useCursor;

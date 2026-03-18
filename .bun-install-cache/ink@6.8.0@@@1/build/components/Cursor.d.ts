import React, { type RefObject } from 'react';
import { type DOMElement, type CursorAnchorMode } from '../dom.js';
export type Props = {
    /**
    Optional reference to anchor cursor coordinates to a different element.

    By default, `anchorRef` uses `anchor="textEnd"` behavior to follow the rendered end of that element's text, including wrapping and wide characters.

    Use this for inputs where the cursor should stay at the visible end of text.

    If `anchorRef` is set but currently unresolved, Ink hides the cursor for that frame unless `anchor="flow"` is used.

    If multiple `<Cursor>` components are rendered in one frame, the last rendered one controls terminal cursor position.
    */
    readonly anchorRef?: RefObject<DOMElement | null>;
    /**
    Anchor mode used to resolve cursor coordinates.

    - `'flow'`: Anchor to `<Cursor />` position in layout flow.
    Use this when you place `<Cursor />` exactly where it should appear.

    - `'origin'`: Anchor to content origin (top-left) of `anchorRef` or parent when no `anchorRef` is provided.
    Use this for manual `x/y` positioning.

    - `'textEnd'`: Anchor to rendered end of text for `anchorRef` or parent when no `anchorRef` is provided.
    Use this when cursor should follow wrapped text.

    Defaults to `'flow'` when `anchorRef` is omitted and `'textEnd'` when `anchorRef` is provided.

    `'flow'` is the default without `anchorRef` to avoid coupling cursor position to surrounding sibling text changes.
    */
    readonly anchor?: CursorAnchorMode;
    /**
    Horizontal offset from resolved anchor position.
    */
    readonly x?: number;
    /**
    Vertical offset from resolved anchor position.
    */
    readonly y?: number;
};
/**
Declaratively position the terminal cursor relative to a container.

Use this component when building reusable inputs where absolute root coordinates are inconvenient.

`<Cursor>` must not be rendered inside `<Text>`.

@example
```jsx
import {Box, Cursor, Text} from 'ink';
import {useRef} from 'react';

const prompt = '> ';
const value = 'hello';

const Example = () => {
    return (
        <Box flexDirection="row">
            <Text>{prompt}</Text>
            <Text>{value}</Text>
            <Cursor />
        </Box>
    );
};
```

```jsx
const ExampleWithAnchor = () => {
    const lineReference = useRef();

    return (
        <Box flexDirection="column">
            <Box ref={lineReference}>
                <Text>{`${prompt}${value}`}</Text>
            </Box>
            <Cursor anchorRef={lineReference} />
        </Box>
    );
};
```
*/
export default function Cursor({ anchorRef, anchor, x, y }: Props): React.JSX.Element;

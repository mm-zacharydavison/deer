export type InputParser = {
    push: (chunk: string) => string[];
    hasPendingEscape: () => boolean;
    flushPendingEscape: () => string | undefined;
    reset: () => void;
};
export declare const createInputParser: () => InputParser;

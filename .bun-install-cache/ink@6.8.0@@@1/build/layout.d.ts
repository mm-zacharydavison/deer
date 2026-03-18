import { type DOMElement } from './dom.js';
export type Position = {
    x: number;
    y: number;
};
export declare const getAbsolutePosition: (node: DOMElement) => Position | undefined;
export declare const getAbsoluteContentPosition: (node: DOMElement) => Position | undefined;

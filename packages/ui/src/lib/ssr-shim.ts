/**
 * Playwright CT Node/SSR Mocks
 * 
 * This file provides a minimal environment to satisfy browser-only libraries 
 * (like solid-toast or reactivity-store) during the Vite SSR building pass 
 * in Node.js.
 */

// 1. Global Browser Environment Mocks
if (typeof (global as any).window === 'undefined') {
  const noop = () => { };
  const mockElement = {
    style: {},
    appendChild: noop,
    addEventListener: noop,
    removeEventListener: noop,
    setAttribute: noop,
    removeAttribute: noop,
    getAttribute: noop,
    classList: { add: noop, remove: noop, contains: () => false },
    childNodes: [],
    children: [],
    lastChild: null,
    firstChild: null,
  };

  (global as any).window = {
    addEventListener: noop,
    removeEventListener: noop,
    dispatchEvent: () => true,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    matchMedia: () => ({ matches: false, addListener: noop, removeListener: noop }),
    requestAnimationFrame: (cb: any) => setTimeout(cb, 0),
    cancelAnimationFrame: (id: any) => clearTimeout(id),
    localStorage: { getItem: noop, setItem: noop, removeItem: noop, clear: noop },
    sessionStorage: { getItem: noop, setItem: noop, removeItem: noop, clear: noop },
    location: { href: 'http://localhost' },
    navigator: { userAgent: 'Playwright-CT', language: 'en-US', languages: ['en-US'] },
    Node: class { }, Element: class { }, HTMLElement: class { }, CustomEvent: class { },
  };

  (global as any).document = {
    createElement: () => ({ ...mockElement }),
    createComment: () => ({ ...mockElement }),
    createTextNode: () => ({ ...mockElement }),
    createDocumentFragment: () => ({ ...mockElement }),
    addEventListener: noop,
    removeEventListener: noop,
    documentElement: { style: {}, lang: '', dir: '' },
    body: { appendChild: noop },
    head: { appendChild: noop },
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
  };

  (global as any).EventSource = class { };
  (global as any).Node = (global as any).window.Node;
}

// 2. Component/Library Mock Hooks
export const toast = {
    success: () => {},
    error: () => {},
    loading: () => {},
    dismiss: () => {},
    promise: (p: any) => p,
};
export const Toaster = () => null;

export const useState = () => [null, () => {}];
export const useEffect = () => {};
export const useMemo = (fn: any) => fn();
export const useCallback = (fn: any) => fn;
export const useRef = (val: any) => ({ current: val });
export const useContext = () => ({});
export const useLayoutEffect = () => {};
export const useReducer = () => [null, () => {}];
export const useSyncExternalStore = (s: any, g: any) => g();
export const isValidElement = () => false;
export const version = '18.0.0';
export const createElement = () => null;

export default {
    useState, useEffect, useMemo, useCallback, useRef, useContext, 
    useLayoutEffect, useReducer, useSyncExternalStore, 
    isValidElement, version, createElement
};

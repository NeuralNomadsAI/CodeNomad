/** @jsxImportSource solid-js */
import { TestProvider } from "../src/lib/test-provider"
import '../src/index.css'

// Playwright CT Global Decorator
export default (props: { children: any }) => (
  <TestProvider>
    {props.children}
  </TestProvider>
);

// Systemic shim for SolidJS/React hybrid environments
if (typeof window !== 'undefined') {
  (window as any).__CODENOMAD_API_BASE__ = 'http://localhost:3001';
  (window as any).__CODENOMAD_EVENTS_URL__ = '/api/events';

  if (typeof (window as any).EventSource === 'undefined') {
    (window as any).EventSource = class {
      constructor() {}
      close() {}
      onmessage = null;
      onerror = null;
      onopen = null;
      addEventListener() {}
      removeEventListener() {}
    };
  }

  (window as any).React = {
    createElement: () => null,
    Fragment: () => null,
    useState: (s: any) => [s, () => {}],
    useEffect: () => {},
    useMemo: (f: any) => f(),
    useCallback: (f: any) => f,
    createContext: () => ({ Provider: () => null }),
    useContext: () => ({}),
    useLayoutEffect: () => {},
    useRef: () => ({ current: null }),
  };
}

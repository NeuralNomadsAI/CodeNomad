// Playwright CT entry point
// Unified context providers are now injected directly in the specs.
import '../src/styles/tokens.css'
import '../src/styles/utilities.css'
import '../src/styles/controls.css'
import '../src/styles/messaging.css'
import '../src/styles/panels/tabs.css'
import '../src/styles/panels/empty-loading.css'
import '../src/styles/panels/modal.css'
import '../src/styles/panels/panel-shell.css'
import '../src/styles/panels/session-layout.css'

// Systemic shim for SolidJS/React hybrid environments
// This ensures that third-party libraries (like icons or older components)
// don't crash when looking for the React global.
if (typeof window !== 'undefined') {
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

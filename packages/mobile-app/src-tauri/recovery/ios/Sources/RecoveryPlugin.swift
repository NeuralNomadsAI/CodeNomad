import Tauri
import UIKit
import WebKit

// Native UIKit control outside WKWebView; no frontend permission grants.
class RecoveryPlugin: Plugin {
    private weak var webview: WKWebView?
    private var button: UIButton?
    private var generation = UUID().uuidString
    private var urlObservation: NSKeyValueObservation?
    private var loadingObservation: NSKeyValueObservation?

    private func launcherReady() -> Bool {
        // Every caller runs on the main queue, including Tauri background IPC.
        guard let button = button, let webview = webview else { return false }
        return button.window != nil && webview.window === button.window &&
            !webview.isLoading && webview.url?.absoluteString == "tauri://localhost/index.html"
    }

    // Rust-only readiness query. WKUserScript supports document-start injection.
    @objc public func readiness(_ invoke: Invoke) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { invoke.resolve(["ready": false]); return }
            invoke.resolve(["ready": self.launcherReady(), "generation": self.generation])
        }
    }

    @objc public func connect(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(ConnectionArgs.self)
        DispatchQueue.main.async { [weak self] in
            guard let self = self, self.launcherReady(), args.generation == self.generation,
                  let url = URL(string: args.endpoint), url.scheme == "https",
                  url.user == nil, url.password == nil else {
                invoke.resolve(["connected": false]); return
            }
            self.generation = UUID().uuidString
            self.webview?.load(URLRequest(url: url))
            invoke.resolve(["connected": true])
        }
    }

    override func load(webview: WKWebView) {
        DispatchQueue.main.async { [weak self, weak webview] in
            guard let self = self, let webview = webview,
                  let root = webview.superview else { return }
            self.generation = UUID().uuidString
            self.webview = webview
            self.urlObservation = webview.observe(\.url, options: [.new]) { [weak self] _, _ in
                self?.documentChanged()
            }
            self.loadingObservation = webview.observe(\.isLoading, options: [.new]) { [weak self] _, change in
                if change.newValue == true { self?.documentChanged() }
            }
            self.button?.removeFromSuperview()
            let control = UIButton(type: .system)
            control.setTitle("↩ CodeNomad", for: .normal)
            control.accessibilityLabel = "↩ CodeNomad"
            control.setTitleColor(.white, for: .normal)
            control.backgroundColor = UIColor(red: 0, green: 82 / 255, blue: 204 / 255, alpha: 1)
            control.contentEdgeInsets = UIEdgeInsets(top: 12, left: 12, bottom: 12, right: 12)
            control.translatesAutoresizingMaskIntoConstraints = false
            control.addTarget(self, action: #selector(self.recover), for: .touchUpInside)
            root.addSubview(control)
            NSLayoutConstraint.activate([
                control.trailingAnchor.constraint(equalTo: root.safeAreaLayoutGuide.trailingAnchor, constant: -12),
                control.bottomAnchor.constraint(equalTo: root.safeAreaLayoutGuide.bottomAnchor, constant: -12),
                control.heightAnchor.constraint(greaterThanOrEqualToConstant: 48)
            ])
            self.button = control
        }
    }

    @objc private func recover() {
        generation = UUID().uuidString
        webview?.stopLoading()
        // The navigation admission policy revokes remote authority on return.
        webview?.load(URLRequest(url: URL(string: "tauri://localhost/index.html")!))
    }

    private func documentChanged() {
        if Thread.isMainThread { generation = UUID().uuidString }
        else { DispatchQueue.main.async { [weak self] in self?.generation = UUID().uuidString } }
    }
}

private struct ConnectionArgs: Decodable {
    let endpoint: String
    let generation: String
}

@_cdecl("init_plugin_mobile_recovery")
func initPlugin() -> Plugin {
    RecoveryPlugin()
}

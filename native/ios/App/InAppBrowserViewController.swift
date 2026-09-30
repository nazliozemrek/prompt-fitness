//
//  InAppBrowserViewController.swift  (App target)
//  In-app browser for ChatGPT, Claude and Gemini with a live footprint panel.
//
//  Privacy and security model:
//  - This is a plain WKWebView, separate from the Capacitor bridge: the chat sites can't reach any
//    native plugin.
//  - public/inapp.js (built from extension/src/inapp.ts) runs in an isolated WKContentWorld. The
//    page's own scripts can't read it, and only that world can post to the "promptFitness" handler.
//  - Messages are accepted only from the main frame of the three chat hosts over https, and every
//    entry is re-validated by SharedStore.sanitize (numbers only) before it's handed to the dashboard
//    (onEntry), which validates it again and saves it on the device.
//  - Prompt Fitness adds no network requests. The web view talks to the chat sites exactly as Safari
//    would; links to other sites open in the system browser.
//

import UIKit
import WebKit

final class InAppBrowserViewController: UIViewController {

    enum Site: String, CaseIterable {
        case chatgpt = "chatgpt.com"
        case claude = "claude.ai"
        case gemini = "gemini.google.com"

        var title: String {
            switch self {
            case .chatgpt: return "ChatGPT"
            case .claude: return "Claude"
            case .gemini: return "Gemini"
            }
        }
        var url: URL { URL(string: "https://\(rawValue)/")! }
    }

    /// Hosts the measurement script reports from (must match ALLOWED_HOSTS in extension/src/api.ts).
    private static let measuredHosts: Set<String> = Set(Site.allCases.map(\.rawValue))
    /// Top-level navigation stays in the app only for the chat sites and their sign-in pages.
    private static let inAppDomains = ["chatgpt.com", "openai.com", "claude.ai", "anthropic.com", "gemini.google.com"]
    private static let inAppExactHosts: Set<String> = [
        "accounts.google.com", "consent.google.com", "appleid.apple.com",
        "login.live.com", "login.microsoftonline.com",
    ]
    private static let handlerName = "promptFitness"
    private static let world = WKContentWorld.defaultClient

    var onClose: ((_ counted: Int) -> Void)?
    /// Receives each sanitized numeric entry as soon as a reply is counted.
    var onEntry: ((_ entry: [String: Any]) -> Void)?

    private var site: Site
    private var webView: WKWebView!
    private let progress = UIProgressView(progressViewStyle: .bar)
    private let siteControl = UISegmentedControl(items: Site.allCases.map(\.title))
    private let statsLabel = UILabel()
    private let statusLabel = UILabel()
    private var progressObservation: NSKeyValueObservation?

    private var count = 0
    private var waterMl = 0.0
    private var wh = 0.0
    private var co2g = 0.0
    private var lastScore: Int?

    init(site: Site) {
        self.site = site
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .fullScreen
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    // MARK: - Setup

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground

        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()   // keeps the user signed in; "Clear website data" removes it
        let content = config.userContentController
        if let script = Self.loadMeasurementScript() {
            content.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentEnd,
                                               forMainFrameOnly: true, in: Self.world))
        } else {
            statusLabel.text = "Measurement script missing. Run npm run cap:sync."
        }
        content.add(WeakMessageHandler(self), contentWorld: Self.world, name: Self.handlerName)

        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true

        progressObservation = webView.observe(\.estimatedProgress, options: [.new]) { [weak self] wv, _ in
            guard let self else { return }
            self.progress.setProgress(Float(wv.estimatedProgress), animated: true)
            self.progress.isHidden = wv.estimatedProgress >= 1
        }

        layout()
        renderStats()
        load(site)
    }

    private func layout() {
        let close = UIButton(type: .system)
        close.setTitle("Done", for: .normal)
        close.titleLabel?.font = .preferredFont(forTextStyle: .headline)
        close.addTarget(self, action: #selector(closeTapped), for: .touchUpInside)

        siteControl.selectedSegmentIndex = Site.allCases.firstIndex(of: site) ?? 0
        siteControl.addTarget(self, action: #selector(siteChanged), for: .valueChanged)
        siteControl.accessibilityLabel = "AI service"

        let more = UIButton(type: .system)
        more.setImage(UIImage(systemName: "ellipsis.circle"), for: .normal)
        more.accessibilityLabel = "More"
        more.showsMenuAsPrimaryAction = true
        more.menu = UIMenu(children: [
            UIAction(title: "Reload", image: UIImage(systemName: "arrow.clockwise")) { [weak self] _ in self?.webView.reload() },
            UIAction(title: "Open in Safari", image: UIImage(systemName: "safari")) { [weak self] _ in
                if let url = self?.webView.url { UIApplication.shared.open(url) }
            },
            UIAction(title: "Clear website data", image: UIImage(systemName: "trash"), attributes: .destructive) { [weak self] _ in
                self?.confirmClearWebsiteData()
            },
        ])

        let top = UIStackView(arrangedSubviews: [close, siteControl, more])
        top.axis = .horizontal
        top.spacing = 12
        top.alignment = .center
        close.setContentHuggingPriority(.required, for: .horizontal)
        more.setContentHuggingPriority(.required, for: .horizontal)

        statsLabel.font = .monospacedDigitSystemFont(ofSize: UIFont.preferredFont(forTextStyle: .subheadline).pointSize, weight: .semibold)
        statsLabel.adjustsFontForContentSizeCategory = true
        statsLabel.numberOfLines = 0
        statsLabel.accessibilityTraits.insert(.updatesFrequently)
        statusLabel.font = .preferredFont(forTextStyle: .caption1)
        statusLabel.adjustsFontForContentSizeCategory = true
        statusLabel.textColor = .secondaryLabel
        statusLabel.numberOfLines = 0
        if statusLabel.text == nil { statusLabel.text = "Measured on this device. Message text never leaves the page." }

        let panel = UIStackView(arrangedSubviews: [statsLabel, statusLabel])
        panel.axis = .vertical
        panel.spacing = 4
        panel.isLayoutMarginsRelativeArrangement = true
        panel.directionalLayoutMargins = NSDirectionalEdgeInsets(top: 10, leading: 16, bottom: 10, trailing: 16)
        let panelBackground = UIView()
        panelBackground.backgroundColor = .secondarySystemBackground

        for v in [top, progress, webView!, panelBackground, panel] as [UIView] {
            v.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(v)
        }
        let guide = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            top.topAnchor.constraint(equalTo: guide.topAnchor, constant: 6),
            top.leadingAnchor.constraint(equalTo: guide.leadingAnchor, constant: 16),
            top.trailingAnchor.constraint(equalTo: guide.trailingAnchor, constant: -16),

            progress.topAnchor.constraint(equalTo: top.bottomAnchor, constant: 6),
            progress.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            progress.trailingAnchor.constraint(equalTo: view.trailingAnchor),

            webView.topAnchor.constraint(equalTo: progress.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            webView.bottomAnchor.constraint(equalTo: panel.topAnchor),

            panel.leadingAnchor.constraint(equalTo: guide.leadingAnchor),
            panel.trailingAnchor.constraint(equalTo: guide.trailingAnchor),
            panel.bottomAnchor.constraint(equalTo: guide.bottomAnchor),

            panelBackground.topAnchor.constraint(equalTo: panel.topAnchor),
            panelBackground.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            panelBackground.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            panelBackground.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
    }

    private static func loadMeasurementScript() -> String? {
        guard let url = Bundle.main.url(forResource: "inapp", withExtension: "js", subdirectory: "public") else { return nil }
        return try? String(contentsOf: url, encoding: .utf8)
    }

    private func load(_ site: Site) {
        self.site = site
        webView.load(URLRequest(url: site.url))
    }

    // MARK: - Actions

    @objc private func closeTapped() {
        dismiss(animated: true)
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if isBeingDismissed { onClose?(count) }
    }

    @objc private func siteChanged() {
        let all = Site.allCases
        guard all.indices.contains(siteControl.selectedSegmentIndex) else { return }
        load(all[siteControl.selectedSegmentIndex])
    }

    private func confirmClearWebsiteData() {
        let alert = UIAlertController(
            title: "Clear website data?",
            message: "Signs you out of ChatGPT, Claude and Gemini in this app and removes their cookies and caches. Your Prompt Fitness numbers are kept.",
            preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        alert.addAction(UIAlertAction(title: "Clear", style: .destructive) { [weak self] _ in
            let store = WKWebsiteDataStore.default()
            store.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast) {
                guard let self else { return }
                self.load(self.site)
            }
        })
        present(alert, animated: true)
    }

    // MARK: - Live panel

    private func renderStats() {
        if count == 0 {
            statsLabel.text = "Chat as usual. Each reply's footprint appears here when it finishes."
            return
        }
        let water = waterMl < 10 ? String(format: "%.1f mL", waterMl) : String(format: "%.0f mL", waterMl)
        var parts = ["\(count) repl\(count == 1 ? "y" : "ies")", "\(water) water", String(format: "%.2f Wh", wh), String(format: "%.1f g CO₂", co2g)]
        if let lastScore { parts.append("last score \(lastScore)") }
        statsLabel.text = parts.joined(separator: " · ")
    }

    fileprivate func receive(_ message: WKScriptMessage) {
        let origin = message.frameInfo.securityOrigin
        guard message.world == Self.world,
              message.frameInfo.isMainFrame,
              origin.protocol == "https",
              Self.measuredHosts.contains(origin.host),
              let body = message.body as? [String: Any],
              let type = body["type"] as? String
        else { return }

        switch type {
        case "ready":
            statusLabel.text = "Measuring on this device. Message text never leaves the page."
        case "log":
            guard let raw = body["entry"] as? [String: Any], let entry = SharedStore.sanitize(raw),
                  entry["src"] as? String == "inapp" else { return }
            onEntry?(entry)
            count += 1
            waterMl += Self.amount(body["waterMl"])
            wh += Self.amount(body["wh"])
            co2g += Self.amount(body["co2g"])
            lastScore = entry["s"] as? Int
            renderStats()
            UIAccessibility.post(notification: .announcement, argument: statsLabel.text)
        default:
            break
        }
    }

    /// Display-only footprint numbers: finite, non-negative and bounded, otherwise ignored.
    private static func amount(_ value: Any?) -> Double {
        guard let n = value as? NSNumber else { return 0 }
        let d = n.doubleValue
        return d.isFinite && d >= 0 && d < 1_000_000 ? d : 0
    }

    // MARK: - Navigation policy

    private static func staysInApp(_ host: String) -> Bool {
        let h = host.lowercased()
        return inAppExactHosts.contains(h) || inAppDomains.contains { h == $0 || h.hasSuffix("." + $0) }
    }

    private func openExternally(_ url: URL) {
        guard let scheme = url.scheme?.lowercased(), ["https", "http", "mailto"].contains(scheme) else { return }
        UIApplication.shared.open(url)
    }
}

// MARK: - WKNavigationDelegate, WKUIDelegate

extension InAppBrowserViewController: WKNavigationDelegate, WKUIDelegate {

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url, let scheme = url.scheme?.lowercased() else { return decisionHandler(.cancel) }
        if scheme == "about" || scheme == "blob" { return decisionHandler(.allow) }
        guard scheme == "https" else {
            openExternally(url)
            return decisionHandler(.cancel)
        }
        // Sub-frames (bot checks, embeds) load normally; the measurement script only runs in the main frame.
        if let frame = action.targetFrame, !frame.isMainFrame { return decisionHandler(.allow) }
        if let host = url.host, Self.staysInApp(host) { return decisionHandler(.allow) }
        openExternally(url)
        decisionHandler(.cancel)
    }

    /// target="_blank" and window.open: stay in this web view for allowed hosts, otherwise use the system browser.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url {
            if url.scheme?.lowercased() == "https", let host = url.host, Self.staysInApp(host) {
                webView.load(action.request)
            } else {
                openExternally(url)
            }
        }
        return nil
    }
}

/// Breaks the retain cycle between WKUserContentController and the view controller.
private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    private weak var target: InAppBrowserViewController?
    init(_ target: InAppBrowserViewController) { self.target = target }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.receive(message)
    }
}

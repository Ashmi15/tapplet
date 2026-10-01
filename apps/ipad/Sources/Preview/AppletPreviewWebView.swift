import SwiftUI
@preconcurrency import WebKit

enum PreviewContentSecurity {
    static let ruleListIdentifier = "tapplet-preview-offline-v3"
    static let encodedRules = #"[{"trigger":{"url-filter":".*"},"action":{"type":"block"}},{"trigger":{"url-filter":"^about:blank$"},"action":{"type":"ignore-previous-rules"}},{"trigger":{"url-filter":"^tapplet-preview://preview/"},"action":{"type":"ignore-previous-rules"}},{"trigger":{"url-filter":"^data:"},"action":{"type":"ignore-previous-rules"}},{"trigger":{"url-filter":"^blob:"},"action":{"type":"ignore-previous-rules"}}]"#

    @MainActor
    static func allowsNavigation(to url: URL?, isMainFrame: Bool, isFormSubmission: Bool) -> Bool {
        guard isMainFrame, !isFormSubmission, let url else { return false }
        return (url.scheme == AssetSchemeHandler.scheme && url.host == "preview")
            || url.absoluteString == "about:blank"
    }
}

enum PreviewProtectionReadiness: Equatable {
    case compiling
    case installed
    case failed(String)

    var permitsLoading: Bool { self == .installed }
}

enum PreviewLoadState: Equatable {
    case loading
    case ready
    case failed(String)
}

struct AppletPreviewWebView: UIViewRepresentable {
    let source: ArtifactSource
    let localAssets: [LocalAppletAssetFile]
    @Binding var state: PreviewLoadState
    @Binding var presentableError: String?
    var onSnapshot: ((Data) -> Void)?

    init(
        source: ArtifactSource,
        localAssets: [LocalAppletAssetFile],
        state: Binding<PreviewLoadState> = .constant(.loading),
        presentableError: Binding<String?> = .constant(nil),
        onSnapshot: ((Data) -> Void)? = nil
    ) {
        self.source = source
        self.localAssets = localAssets
        _state = state
        _presentableError = presentableError
        self.onSnapshot = onSnapshot
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(state: $state, presentableError: $presentableError, onSnapshot: onSnapshot, assets: localAssets)
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.preferences.isTextInteractionEnabled = true
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.mediaTypesRequiringUserActionForPlayback = .all
        configuration.setURLSchemeHandler(context.coordinator.handler, forURLScheme: AssetSchemeHandler.scheme)

        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.isOpaque = false
        view.backgroundColor = .clear
        view.scrollView.contentInsetAdjustmentBehavior = .never
        view.allowsBackForwardNavigationGestures = false
        context.coordinator.view = view
        context.coordinator.installProtection(in: configuration.userContentController)
        context.coordinator.load(source)
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        context.coordinator.state = $state
        context.coordinator.presentableError = $presentableError
        context.coordinator.onSnapshot = onSnapshot
        context.coordinator.handler.assets = localAssets
        let coordinator = context.coordinator
        DispatchQueue.main.async {
            coordinator.load(source)
        }
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate {
        var state: Binding<PreviewLoadState>
        var presentableError: Binding<String?>
        var onSnapshot: ((Data) -> Void)?
        let handler: AssetSchemeHandler
        weak var view: WKWebView?
        private var displayed: ArtifactSource?
        private var requested: ArtifactSource?
        private var activeNavigation: WKNavigation?
        private var rejectedRevisionID: String?
        private var restoring = false
        private var snapshottedRevisionIDs: Set<String> = []
        private var protection: PreviewProtectionReadiness = .compiling

        init(state: Binding<PreviewLoadState>, presentableError: Binding<String?>, onSnapshot: ((Data) -> Void)?, assets: [LocalAppletAssetFile]) {
            self.state = state
            self.presentableError = presentableError
            self.onSnapshot = onSnapshot
            handler = AssetSchemeHandler(assets)
        }

        func load(_ source: ArtifactSource) {
            guard source.revision.id != rejectedRevisionID,
                  source.revision.id != requested?.revision.id
            else { return }
            if case let .failed(message) = protection {
                state.wrappedValue = .failed(message)
                presentableError.wrappedValue = message
                return
            }
            rejectedRevisionID = nil
            requested = source
            restoring = false
            state.wrappedValue = .loading
            guard protection.permitsLoading else { return }
            loadRequestedSource()
        }

        func installProtection(in userContentController: WKUserContentController) {
            guard let store = WKContentRuleListStore.default() else {
                failProtection("The preview could not be secured and was not opened. WebKit did not return an offline rule list.")
                return
            }
            store.lookUpContentRuleList(
                forIdentifier: PreviewContentSecurity.ruleListIdentifier
            ) { [weak self, weak userContentController] existing, _ in
                Task { @MainActor in
                    guard let self else { return }
                    if let existing {
                        self.applyProtection(existing, to: userContentController)
                        return
                    }
                    self.compileProtection(in: store, userContentController: userContentController)
                }
            }
        }

        private func compileProtection(
            in store: WKContentRuleListStore,
            userContentController: WKUserContentController?
        ) {
            store.compileContentRuleList(
                forIdentifier: PreviewContentSecurity.ruleListIdentifier,
                encodedContentRuleList: PreviewContentSecurity.encodedRules
            ) { [weak self, weak userContentController] ruleList, error in
                Task { @MainActor in
                    guard let self else { return }
                    guard let ruleList, error == nil else {
                        let detail = error?.localizedDescription ?? "WebKit did not return an offline rule list."
                        self.failProtection("The preview could not be secured and was not opened. \(detail)")
                        return
                    }
                    self.applyProtection(ruleList, to: userContentController)
                }
            }
        }

        private func applyProtection(_ ruleList: WKContentRuleList, to userContentController: WKUserContentController?) {
            guard let userContentController else {
                failProtection("The preview could not be secured and was not opened. WebKit did not return an offline rule list.")
                return
            }
            userContentController.add(ruleList)
            protection = .installed
            loadRequestedSource()
        }

        private func failProtection(_ message: String) {
            protection = .failed(message)
            state.wrappedValue = .failed(message)
            presentableError.wrappedValue = message
            requested = nil
        }

        private func loadRequestedSource() {
            guard protection.permitsLoading, let requested else { return }
            activeNavigation = view?.loadHTMLString(
                requested.html,
                baseURL: AssetSchemeHandler.documentBaseURL
            )
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void
        ) {
            let type = navigationAction.navigationType
            let allowed = PreviewContentSecurity.allowsNavigation(
                to: navigationAction.request.url,
                isMainFrame: navigationAction.targetFrame?.isMainFrame == true,
                isFormSubmission: type == .formSubmitted || type == .formResubmitted
            )
            decisionHandler(allowed ? .allow : .cancel)
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            guard navigation === activeNavigation, let requested else { return }
            activeNavigation = nil
            displayed = requested
            state.wrappedValue = .ready
            if restoring {
                restoring = false
                return
            }
            guard onSnapshot != nil,
                  snapshottedRevisionIDs.insert(requested.revision.id).inserted
            else { return }
            let revisionID = requested.revision.id
            webView.takeSnapshot(with: nil) { [weak self] image, _ in
                guard self?.displayed?.revision.id == revisionID,
                      let data = image?.jpegData(compressionQuality: 0.72)
                else { return }
                self?.onSnapshot?(data)
            }
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            guard navigation === activeNavigation else { return }
            recover(webView)
        }

        func webView(
            _ webView: WKWebView,
            didFailProvisionalNavigation navigation: WKNavigation!,
            withError error: Error
        ) {
            guard navigation === activeNavigation else { return }
            recover(webView)
        }

        private func recover(_ webView: WKWebView) {
            guard !restoring else { return }
            activeNavigation = nil
            let message = "The new preview could not open. Your previous preview was restored."
            state.wrappedValue = .failed(message)
            presentableError.wrappedValue = message
            guard let displayed, displayed.revision.id != requested?.revision.id else { return }
            rejectedRevisionID = requested?.revision.id
            restoring = true
            requested = displayed
            activeNavigation = webView.loadHTMLString(
                displayed.html,
                baseURL: AssetSchemeHandler.documentBaseURL
            )
        }
    }
}

final class AssetSchemeHandler: NSObject, WKURLSchemeHandler, @unchecked Sendable {
    static let scheme = "tapplet-preview"
    static let documentBaseURL = URL(string: "tapplet-preview://preview/")!
    private let lock = NSLock()
    private var stored: [LocalAppletAssetFile]

    var assets: [LocalAppletAssetFile] {
        get { lock.withLock { stored } }
        set { lock.withLock { stored = newValue } }
    }

    init(_ assets: [LocalAppletAssetFile]) { stored = assets }

    static func assetID(from url: URL) -> String? {
        guard url.scheme == scheme, url.host == "preview" else { return nil }
        let components = url.pathComponents.filter { $0 != "/" }
        guard components.count == 2, components[0] == "assets" else { return nil }
        return components[1].removingPercentEncoding
    }

    func webView(_ webView: WKWebView, start task: any WKURLSchemeTask) {
        guard let requestURL = task.request.url,
              let id = Self.assetID(from: requestURL),
              let asset = assets.first(where: { $0.id == id }),
              let fileURL = LocalAppletAssetStorage.url(for: asset),
              let data = try? Data(contentsOf: fileURL)
        else {
            task.didFailWithError(URLError(.fileDoesNotExist))
            return
        }
        task.didReceive(URLResponse(url: requestURL, mimeType: asset.mediaType, expectedContentLength: data.count, textEncodingName: nil))
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: any WKURLSchemeTask) {}
}

import SwiftUI
import XCTest
@preconcurrency import WebKit
@testable import Tapplet

final class AppletPreviewSecurityTests: XCTestCase {
    func testOfflineRuleListBlocksEveryLoadThenAllowsOnlyLocalSchemes() throws {
        let data = try XCTUnwrap(PreviewContentSecurity.encodedRules.data(using: .utf8))
        let rules = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [[String: Any]])
        let blockTrigger = try XCTUnwrap(rules[0]["trigger"] as? [String: Any])
        let blockAction = try XCTUnwrap(rules[0]["action"] as? [String: Any])

        XCTAssertEqual(rules.count, 5)
        XCTAssertEqual(blockTrigger["url-filter"] as? String, ".*")
        XCTAssertEqual(blockAction["type"] as? String, "block")
        let localFilters = try rules.dropFirst().map { rule in
            let action = try XCTUnwrap(rule["action"] as? [String: Any])
            XCTAssertEqual(action["type"] as? String, "ignore-previous-rules")
            let trigger = try XCTUnwrap(rule["trigger"] as? [String: Any])
            return try XCTUnwrap(trigger["url-filter"] as? String)
        }
        XCTAssertEqual(Set(localFilters), Set(["^about:blank$", "^tapplet-preview://preview/", "^data:", "^blob:"]))
        for externalScheme in ["http:", "https:", "ws:", "wss:", "ftp:"] {
            XCTAssertFalse(localFilters.contains(where: { $0.contains(externalScheme) }))
        }
    }

    @MainActor
    func testOfflineRuleListCompilesAndBundledPreviewReachesReady() async throws {
        try await checkBundledPreview(takesSnapshot: false)
    }

    @MainActor
    func testEditorPreviewTakesOneSnapshotPerRevision() async throws {
        try await checkBundledPreview(takesSnapshot: true)
    }

    @MainActor
    private func checkBundledPreview(takesSnapshot: Bool) async throws {
        let storageDirectory = FileManager.default.temporaryDirectory
            .appending(path: UUID().uuidString, directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: storageDirectory) }
        let store = TappletStore(
            storageDirectory: storageDirectory,
            bundle: Bundle(for: TappletStore.self)
        )
        let source = try XCTUnwrap(store.examples.first?.source)
        var loadState = PreviewLoadState.loading
        var presentableError: String?
        var snapshots: [Data] = []
        let ready = expectation(description: "Bundled preview reaches ready after offline rules install")
        let coordinator = AppletPreviewWebView.Coordinator(
            state: Binding(
                get: { loadState },
                set: {
                    loadState = $0
                    if $0 == .ready { ready.fulfill() }
                }
            ),
            presentableError: Binding(
                get: { presentableError },
                set: { presentableError = $0 }
            ),
            onSnapshot: takesSnapshot ? { snapshots.append($0) } : nil,
            assets: []
        )
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.setURLSchemeHandler(
            coordinator.handler,
            forURLScheme: AssetSchemeHandler.scheme
        )
        let webView = SnapshotCountingWebView(
            frame: CGRect(x: 0, y: 0, width: 1024, height: 768),
            configuration: configuration
        )
        coordinator.view = webView
        webView.navigationDelegate = coordinator

        coordinator.installProtection(in: configuration.userContentController)
        coordinator.load(source)

        await fulfillment(of: [ready], timeout: 10)
        XCTAssertEqual(loadState, .ready)
        XCTAssertNil(presentableError)
        XCTAssertEqual(webView.snapshotCount, takesSnapshot ? 1 : 0)
        XCTAssertEqual(snapshots.count, takesSnapshot ? 1 : 0)
        if takesSnapshot {
            XCTAssertNotNil(UIImage(data: try XCTUnwrap(snapshots.first)))
        }
        coordinator.load(source)
        XCTAssertEqual(webView.snapshotCount, takesSnapshot ? 1 : 0, "Updating with the same revision must not take another snapshot")
        withExtendedLifetime(webView) {}
    }

    func testProtectionReadinessFailsClosedUntilRuleListIsInstalled() {
        XCTAssertFalse(PreviewProtectionReadiness.compiling.permitsLoading)
        XCTAssertTrue(PreviewProtectionReadiness.installed.permitsLoading)
        XCTAssertFalse(PreviewProtectionReadiness.failed("compile failed").permitsLoading)
    }

    @MainActor
    func testNavigationPolicyOnlyAllowsInitialManagedMainFrameNavigation() throws {
        let managed = try XCTUnwrap(URL(string: "tapplet-preview://preview/"))
        let external = try XCTUnwrap(URL(string: "https://example.com/collect"))

        XCTAssertTrue(PreviewContentSecurity.allowsNavigation(to: managed, isMainFrame: true, isFormSubmission: false))
        XCTAssertTrue(PreviewContentSecurity.allowsNavigation(to: URL(string: "about:blank"), isMainFrame: true, isFormSubmission: false))
        XCTAssertFalse(PreviewContentSecurity.allowsNavigation(to: external, isMainFrame: true, isFormSubmission: false))
        XCTAssertFalse(PreviewContentSecurity.allowsNavigation(to: URL(string: "tapplet-preview://other/"), isMainFrame: true, isFormSubmission: false))
        XCTAssertFalse(PreviewContentSecurity.allowsNavigation(to: managed, isMainFrame: false, isFormSubmission: false))
        XCTAssertFalse(PreviewContentSecurity.allowsNavigation(to: managed, isMainFrame: true, isFormSubmission: true))
        XCTAssertFalse(PreviewContentSecurity.allowsNavigation(to: nil, isMainFrame: true, isFormSubmission: false))
    }
}

@MainActor
private final class SnapshotCountingWebView: WKWebView {
    private(set) var snapshotCount = 0

    override func takeSnapshot(
        with snapshotConfiguration: WKSnapshotConfiguration?,
        completionHandler: @escaping @MainActor @Sendable (UIImage?, (any Error)?) -> Void
    ) {
        snapshotCount += 1
        let image = UIGraphicsImageRenderer(size: CGSize(width: 4, height: 4)).image { context in
            UIColor.white.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 4, height: 4))
        }
        completionHandler(image, nil)
    }
}

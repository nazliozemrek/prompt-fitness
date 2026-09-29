//
//  InAppBrowserPlugin.swift  (App target)
//  Exposes the in-app AI browser and the Safari extension settings shortcut to the web layer
//  as `InAppBrowser.open({ site })` and `InAppBrowser.openExtensionSettings()`.
//

import Foundation
import Capacitor
import SafariServices
import UIKit

@objc(InAppBrowserPlugin)
public class InAppBrowserPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "InAppBrowserPlugin"
    public let jsName = "InAppBrowser"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openExtensionSettings", returnType: CAPPluginReturnPromise),
    ]

    /// Opens the browser on one of the three chat sites. Emits "closed" with { counted } when dismissed.
    @objc func open(_ call: CAPPluginCall) {
        guard let site = InAppBrowserViewController.Site(rawValue: call.getString("site") ?? "") else {
            call.reject("Unknown site")
            return
        }
        DispatchQueue.main.async { [weak self] in
            guard let self, let presenter = self.bridge?.viewController else {
                call.reject("No view controller")
                return
            }
            let browser = InAppBrowserViewController(site: site)
            browser.onClose = { [weak self] counted in
                self?.notifyListeners("closed", data: ["counted": counted])
            }
            presenter.present(browser, animated: true) { call.resolve() }
        }
    }

    /// iOS 26.2+: opens Safari's extension settings with Prompt Fitness highlighted (public API).
    /// Earlier versions: opens this app's page in Settings; the dashboard shows the remaining steps.
    /// Private URL schemes such as App-Prefs: are not used; App Review rejects them.
    @objc func openExtensionSettings(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if #available(iOS 26.2, *), let appId = Bundle.main.bundleIdentifier {
                SFSafariSettings.openExtensionsSettings(forIdentifiers: [appId + ".Extension"]) { error in
                    if error == nil {
                        call.resolve(["opened": true, "target": "safari"])
                    } else {
                        Self.openAppSettings(call)
                    }
                }
            } else {
                Self.openAppSettings(call)
            }
        }
    }

    private static func openAppSettings(_ call: CAPPluginCall) {
        guard let url = URL(string: UIApplication.openSettingsURLString) else {
            call.resolve(["opened": false, "target": "none"])
            return
        }
        UIApplication.shared.open(url) { ok in
            call.resolve(["opened": ok, "target": "app"])
        }
    }
}

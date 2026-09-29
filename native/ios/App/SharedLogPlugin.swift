//
//  SharedLogPlugin.swift  (App target)
//  Exposes SharedStore.drain() to the web layer as `SharedLog.drain()`.
//

import Foundation
import Capacitor

@objc(SharedLogPlugin)
public class SharedLogPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SharedLogPlugin"
    public let jsName = "SharedLog"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "drain", returnType: CAPPluginReturnPromise),
    ]

    @objc func drain(_ call: CAPPluginCall) {
        DispatchQueue.global(qos: .userInitiated).async {
            let entries = SharedStore.drain()
            call.resolve(["entries": entries])
        }
    }
}

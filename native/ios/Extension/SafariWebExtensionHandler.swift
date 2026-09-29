//
//  SafariWebExtensionHandler.swift  (Safari Extension target)
//  Receives numeric usage entries from background.js via browser.runtime.sendNativeMessage
//  and stores them in the App Group so the container app can show them.
//

import SafariServices

final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    func beginRequest(with context: NSExtensionContext) {
        let item = context.inputItems.first as? NSExtensionItem

        let message: Any?
        if #available(iOS 17.0, macOS 14.0, *) {
            message = item?.userInfo?[SFExtensionMessageKey]
        } else {
            message = item?.userInfo?["message"]
        }

        var ok = false
        if let dict = message as? [String: Any], let type = dict["type"] as? String {
            switch type {
            case "log":
                if let entry = dict["entry"] as? [String: Any] {
                    SharedStore.append(entry)   // sanitized inside; non-numeric data is rejected
                    ok = true
                }
            case "clear":
                SharedStore.clear()
                ok = true
            default:
                break
            }
        }

        let response = NSExtensionItem()
        let payload: [String: Any] = ["ok": ok]
        if #available(iOS 17.0, macOS 14.0, *) {
            response.userInfo = [SFExtensionMessageKey: payload]
        } else {
            response.userInfo = ["message": payload]
        }
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }
}

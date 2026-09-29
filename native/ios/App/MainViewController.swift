//
//  MainViewController.swift  (App target)
//  Registers the local SharedLog and InAppBrowser plugins. Main.storyboard must use this class
//  (scripts/setup-ios.sh patches the storyboard automatically).
//

import UIKit
import Capacitor

class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(SharedLogPlugin())
        bridge?.registerPluginInstance(InAppBrowserPlugin())
    }
}

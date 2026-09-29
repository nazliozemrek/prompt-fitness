//
//  MainViewController.swift  (App target)
//  Registers the local SharedLog plugin. Main.storyboard must use this class
//  (scripts/setup-ios.sh patches the storyboard automatically).
//

import UIKit
import Capacitor

class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(SharedLogPlugin())
    }
}

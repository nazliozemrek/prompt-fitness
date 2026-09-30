//
//  ShareViewController.swift  (ShareExtension target, "Improve prompt")
//  Select a prompt in any app, tap Share → Improve prompt, copy the leaner version back.
//
//  Privacy: the shared text is analyzed in memory by coach.js (built from shared/share-coach.ts)
//  running in JavaScriptCore, which has no network APIs. Nothing is stored or sent. The only
//  output is what the user chooses to copy to the clipboard.
//

import UIKit
import SwiftUI
import JavaScriptCore
import UniformTypeIdentifiers

final class ShareViewController: UIViewController {

    private let model = CoachModel()

    override func viewDidLoad() {
        super.viewDidLoad()
        let root = CoachView(model: model) { [weak self] in
            self?.extensionContext?.completeRequest(returningItems: nil)
        }
        let host = UIHostingController(rootView: root)
        addChild(host)
        host.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(host.view)
        NSLayoutConstraint.activate([
            host.view.topAnchor.constraint(equalTo: view.topAnchor),
            host.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
        host.didMove(toParent: self)
        loadSharedText { [weak self] text in self?.model.load(text) }
    }

    /// Reads plain text from the share sheet (a text selection, or a note's content).
    private func loadSharedText(_ done: @escaping (String?) -> Void) {
        let items = extensionContext?.inputItems as? [NSExtensionItem] ?? []
        let providers = items.flatMap { $0.attachments ?? [] }
        let textType = UTType.plainText.identifier
        if let provider = providers.first(where: { $0.hasItemConformingToTypeIdentifier(textType) }) {
            provider.loadItem(forTypeIdentifier: textType, options: nil) { item, _ in
                let text = (item as? String)
                    ?? (item as? NSAttributedString)?.string
                    ?? (item as? Data).flatMap { String(data: $0, encoding: .utf8) }
                DispatchQueue.main.async { done(text) }
            }
        } else {
            done(items.first?.attributedContentText?.string)
        }
    }
}

// MARK: - Coaching engine (shared rules via JavaScriptCore)

struct CoachResult: Decodable {
    struct Note: Decodable, Hashable { let label: String; let ok: Bool; let text: String }
    struct Rewrite: Decodable { let text: String; let changes: [String]; let score: Int; let waterMl: Double; let waterText: String }
    struct Recommendation: Decodable { let title: String; let detail: String; let fits: Bool }
    let ok: Bool
    let model: String?
    let score: Int?
    let waterMl: Double?
    /// Modeled footprint as an honest range, e.g. "~10–41 mL".
    let waterText: String?
    let notes: [Note]?
    let rewrite: Rewrite?
    let recommendation: Recommendation?
}

final class CoachEngine {
    private static let maxChars = 20_000
    private let coachJSON: JSValue?

    init() {
        guard let url = Bundle.main.url(forResource: "coach", withExtension: "js"),
              let source = try? String(contentsOf: url, encoding: .utf8),
              let context = JSContext()
        else { coachJSON = nil; return }
        context.evaluateScript(source)
        coachJSON = context.objectForKeyedSubscript("PromptFitnessCoach")?.objectForKeyedSubscript("coachJSON")
    }

    func coach(_ text: String, modelId: String) -> CoachResult? {
        guard let fn = coachJSON, !fn.isUndefined,
              let json = fn.call(withArguments: [String(text.prefix(Self.maxChars)), modelId])?.toString(),
              let data = json.data(using: .utf8)
        else { return nil }
        return try? JSONDecoder().decode(CoachResult.self, from: data)
    }
}

@MainActor
final class CoachModel: ObservableObject {
    enum Service: String, CaseIterable, Identifiable {
        case chatgpt = "ChatGPT", claude = "Claude", gemini = "Gemini"
        var id: String { rawValue }
        /// Same defaults as the extension and in-app browser (DEFAULT_SITE_MODEL).
        var modelId: String {
            switch self {
            case .chatgpt: return "gpt4o"
            case .claude: return "sonnet"
            case .gemini: return "gemini-pro"
            }
        }
    }

    @Published private(set) var text: String?
    @Published private(set) var result: CoachResult?
    @Published private(set) var engineMissing = false
    @Published var copied = false
    @Published var service: Service = .chatgpt { didSet { run() } }

    private lazy var engine = CoachEngine()

    func load(_ shared: String?) {
        let trimmed = shared?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        text = trimmed.isEmpty ? nil : trimmed
        run()
    }

    func copyRewrite() {
        guard let rewrite = result?.rewrite?.text else { return }
        UIPasteboard.general.string = rewrite
        copied = true
    }

    private func run() {
        copied = false
        guard let text else { result = nil; return }
        result = engine.coach(text, modelId: service.modelId)
        engineMissing = result == nil
    }
}

// MARK: - UI

struct CoachView: View {
    @ObservedObject var model: CoachModel
    let close: () -> Void

    var body: some View {
        NavigationView {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if model.text == nil {
                        emptyState
                    } else if let r = model.result, r.ok, let score = r.score {
                        Picker("Used with", selection: $model.service) {
                            ForEach(CoachModel.Service.allCases) { Text($0.rawValue).tag($0) }
                        }
                        .pickerStyle(.segmented)
                        scoreHeader(score: score, waterText: r.waterText ?? "")
                        if let rw = r.rewrite {
                            rewriteCard(rw, before: score, beforeText: r.waterText ?? "")
                        } else {
                            Label("Already lean. Nothing to cut.", systemImage: "checkmark.seal.fill")
                                .foregroundColor(.green)
                        }
                        if let rec = r.recommendation { recommendationCard(rec) }
                        notesSection(r.notes ?? [])
                    } else if model.engineMissing {
                        Text("Couldn't load the coaching rules. Reinstall the app.").foregroundColor(.secondary)
                    }
                    Text("Analyzed on this device. Your text isn't saved or sent anywhere.")
                        .font(.footnote)
                        .foregroundColor(.secondary)
                }
                .padding()
            }
            .navigationTitle("Improve prompt")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close", action: close) }
            }
        }
        .navigationViewStyle(.stack)
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("No text to check").font(.headline)
            Text("Select your prompt first, then tap Share → Improve prompt.")
                .foregroundColor(.secondary)
        }
    }

    private func scoreHeader(score: Int, waterText: String) -> some View {
        HStack(alignment: .center, spacing: 14) {
            Text("\(score)")
                .font(.system(size: 44, weight: .bold, design: .rounded))
                .foregroundColor(Self.color(for: score))
                .accessibilityLabel("Efficiency score \(score)")
            VStack(alignment: .leading, spacing: 2) {
                Text("Efficiency score").font(.subheadline).foregroundColor(.secondary)
                Text(Self.verdict(score)).font(.headline)
                Text("Estimated \(waterText) of water per request").font(.footnote).foregroundColor(.secondary)
            }
        }
    }

    private func rewriteCard(_ rw: CoachResult.Rewrite, before: Int, beforeText: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Try this version", systemImage: "sparkles").font(.headline)
            Text("Score \(before) → \(rw.score) · \(beforeText) → \(rw.waterText) (est.)")
                .font(.footnote.monospacedDigit())
                .foregroundColor(.green)
            Text(rw.text)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(12)
                .background(Color(.secondarySystemBackground))
                .cornerRadius(12)
            VStack(alignment: .leading, spacing: 4) {
                Text("Why this is better").font(.subheadline.weight(.semibold))
                ForEach(rw.changes, id: \.self) { change in
                    Text("• \(change)").font(.footnote).foregroundColor(.secondary)
                }
            }
            Button {
                model.copyRewrite()
            } label: {
                Label(model.copied ? "Copied ✓ Paste it into your chat." : "Copy optimized prompt",
                      systemImage: model.copied ? "checkmark" : "doc.on.doc")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
        }
        .padding()
        .background(Color.green.opacity(0.08))
        .cornerRadius(16)
    }

    private func recommendationCard(_ rec: CoachResult.Recommendation) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Recommended for this task").font(.caption).foregroundColor(.secondary).textCase(.uppercase)
            Text(rec.title).font(.headline)
            Text(rec.detail).font(.subheadline).foregroundColor(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
        .background(Color(.secondarySystemBackground))
        .cornerRadius(16)
        .accessibilityElement(children: .combine)
    }

    private func notesSection(_ notes: [CoachResult.Note]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Why this score").font(.headline)
            ForEach(notes, id: \.self) { note in
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: note.ok ? "checkmark.circle.fill" : "arrow.right.circle.fill")
                        .foregroundColor(note.ok ? .green : .orange)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(note.label).font(.subheadline.weight(.semibold))
                        Text(note.text).font(.subheadline).foregroundColor(.secondary)
                    }
                }
                .accessibilityElement(children: .combine)
            }
        }
    }

    private static func color(for s: Int) -> Color { s >= 70 ? .green : s >= 40 ? .orange : .red }
    private static func verdict(_ s: Int) -> String {
        s >= 85 ? "Lean and clear. Great prompt." : s >= 65 ? "Good, with a little room to trim." : s >= 40 ? "Could be tighter." : "Needs a rewrite to be efficient."
    }
}

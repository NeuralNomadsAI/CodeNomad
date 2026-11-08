// Native NSURL drag source, built with `swiftc mac-file-source.swift -o file-source`.
import AppKit

final class FileSource: NSView, NSDraggingSource {
    let file: URL
    init(file: URL) {
        self.file = file
        super.init(frame: NSRect(x: 0, y: 0, width: 200, height: 80))
    }
    required init?(coder: NSCoder) { fatalError("Use init(file:)") }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func draw(_ dirtyRect: NSRect) {
        ("Drag fixture file" as NSString).draw(at: NSPoint(x: 30, y: 35), withAttributes: nil)
    }
    override func mouseDown(with event: NSEvent) {
        let item = NSDraggingItem(pasteboardWriter: file as NSURL)
        item.setDraggingFrame(bounds, contents: NSImage(named: NSImage.multipleDocumentsName))
        beginDraggingSession(with: [item], event: event, source: self)
    }
    func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation { .copy }
    func draggingSession(_ session: NSDraggingSession, endedAt point: NSPoint, operation: NSDragOperation) {
        print("drag-end \(operation.rawValue)")
        fflush(stdout)
    }
}

let file = URL(fileURLWithPath: CommandLine.arguments[1]).standardizedFileURL
precondition(FileManager.default.fileExists(atPath: file.path))
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let window = NSWindow(contentRect: NSRect(x: 800, y: 30, width: 200, height: 80),
                      styleMask: [.titled, .closable], backing: .buffered, defer: false)
window.title = "Capabilities file source"
window.level = .floating
window.contentView = FileSource(file: file)
window.makeKeyAndOrderFront(nil)
app.run()

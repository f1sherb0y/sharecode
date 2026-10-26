import AppKit
import ScreenCaptureKit
import AVFoundation
let root = URL(fileURLWithPath: "/tmp/sharecode-capture-benchmark")
try! FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let started = ProcessInfo.processInfo.systemUptime
let activity = ProcessInfo.processInfo.beginActivity(options: [.userInitiated, .idleSystemSleepDisabled], reason: "Local capture comparison")
func now() -> Double { ProcessInfo.processInfo.systemUptime }
final class Source: NSView {
    var counter = 0
    var spot = false
    override var isFlipped: Bool { true }
    override func draw(_ dirtyRect: NSRect) {
        NSColor.black.setFill(); bounds.fill()
        for i in 0..<16 {
            (((counter >> i) & 1) == 1 ? NSColor.white : NSColor.black).setFill()
            NSRect(x: bounds.width * Double(i) / 16, y: bounds.height * 0.45, width: bounds.width / 16, height: bounds.height * 0.1).fill()
        }
        for i in 0..<30 {
            NSColor(calibratedHue: Double((i + counter) % 90) / 90, saturation: 0.7, brightness: 0.65, alpha: 1).setFill()
            NSRect(x: bounds.width * Double(i) / 30, y: 0, width: bounds.width / 30, height: bounds.height * 0.4).fill()
            NSRect(x: bounds.width * Double(i) / 30, y: bounds.height * 0.6, width: bounds.width / 30, height: bounds.height * 0.4).fill()
        }
        if spot { NSColor.white.setFill(); NSRect(x:bounds.width-1,y:bounds.height-1,width:1,height:1).fill() }
    }
}
final class Bench: NSObject, SCStreamOutput, SCStreamDelegate {
    var preparations = [VirtualOutputPreparation(width: 1920, height: 1080), VirtualOutputPreparation(width: 3840, height: 2160)]
    var displays: [SharedVirtualDisplay] = []
    var windows: [SharedOutputWindow] = []
    let source = Source()
    let video = AVSampleBufferDisplayLayer()
    var screenshots = ScreenshotCapture()
    var stream: SCStream?
    var filter: SCContentFilter?
    var mode = "waiting", motion = "static", width = 1920, height = 1080
    var ticket = 0, frames = 0, enqueued = 0, duplicates = 0, invalid = 0, errors = 0, ticks = 0
    var lastCounter = -1, lastFrame = 0.0, begin = 0.0
    var gaps: [Double] = [], latency: [Double] = [], generationTimes: [Int:Double] = [:]
    var requestStats = "", ready = false
    func setup() {
        if displays.count < 2 {
            let prep = preparations[displays.count]
            let state = prep.poll()
            if state == .failed { mode = "display-error"; return }
            if state == .ready, let display = prep.display { displays.append(display) }
            return
        }
        guard windows.isEmpty else { return }
        for d in displays { let w=SharedOutputWindow(screen:d.screen!); windows.append(w); w.orderFrontRegardless() }
        source.frame = NSRect(origin:.zero,size:windows[0].contentView!.bounds.size)
        source.autoresizingMask = [.width,.height]
        windows[0].contentView=source
        let view=windows[1].contentView!; view.wantsLayer=true; view.layer?.backgroundColor=NSColor.black.cgColor
        video.frame=view.bounds; video.videoGravity = .resizeAspect; view.layer?.addSublayer(video)
        SCShareableContent.getExcludingDesktopWindows(false,onScreenWindowsOnly:false) { content,error in DispatchQueue.main.async {
            guard let content, let d=content.displays.first(where:{$0.displayID==self.displays[0].id}) else { self.mode="content-error";return }
            self.filter=SCContentFilter(display:d,including:content.applications.filter{$0.processID==ProcessInfo.processInfo.processIdentifier},exceptingWindows:[])
            self.ready=true;self.mode="idle"
        }}
    }
    func change(_ command:String) {
        let fields=command.split(separator:":").map(String.init)
        if fields.count == 2, fields[0] == "motion", ready {
            motion = fields[1]
            if motion == "pixel" { source.spot.toggle();source.needsDisplay=true }
            return
        }
        guard fields.count>=3, ready else { return }
        ticket += 1; let generation=ticket
        screenshots.stop(); let old=stream;stream=nil;old?.stopCapture{_ in};video.flushAndRemoveImage()
        mode=fields[0]; motion=fields[1];width=Int(fields[2])!;height=width*9/16
        frames=0;enqueued=0;duplicates=0;invalid=0;errors=0;gaps=[];latency=[];lastCounter = -1; lastFrame=0;begin=now()
        guard mode != "idle" else { return }
        let c=SCStreamConfiguration();c.width=width;c.height=height;c.minimumFrameInterval=CMTime(value:1,timescale:30);c.queueDepth=3;c.pixelFormat=kCVPixelFormatType_32BGRA;c.showsCursor=true
        if mode.hasPrefix("snapshot") {
            screenshots = ScreenshotCapture(adaptive: mode != "snapshot-fixed", useMetal: mode != "snapshot-cpu")
            screenshots.start(filter:filter!,configuration:c,frame:{[weak self] b in guard let self,self.ticket==generation else{return};self.consume(b)},failure:{[weak self] e in self?.errors += 1;self?.requestStats=e})
        } else {
            let s=SCStream(filter:filter!,configuration:c,delegate:self);stream=s
            do {try s.addStreamOutput(self,type:.screen,sampleHandlerQueue:.main);s.startCapture{e in if let e {DispatchQueue.main.async{self.errors += 1;self.requestStats=e.localizedDescription}}}} catch {errors += 1;requestStats=error.localizedDescription}
        }
    }
    func consume(_ buffer:CMSampleBuffer) {
        guard buffer.isValid, let pixels=CMSampleBufferGetImageBuffer(buffer) else {invalid += 1;return}
        let t=now(); if lastFrame>0 {gaps.append((t-lastFrame)*1000)};lastFrame=t;frames += 1
        CVPixelBufferLockBaseAddress(pixels,.readOnly)
        let p=CVPixelBufferGetBaseAddress(pixels)!.assumingMemoryBound(to:UInt8.self), row=CVPixelBufferGetBytesPerRow(pixels), w=CVPixelBufferGetWidth(pixels),h=CVPixelBufferGetHeight(pixels)
        var counter=0
        for i in 0..<16 {let x=Int((Double(i)+0.5)*Double(w)/16);if p[(h/2)*row+x*4]>128 {counter |= 1<<i}}
        CVPixelBufferUnlockBaseAddress(pixels,.readOnly)
        if counter==lastCounter {duplicates += 1};lastCounter=counter
        if let generated=generationTimes[counter],motion=="dynamic" {latency.append((t-generated)*1000)}
        if video.status == .failed {errors += 1;video.flush()}
        if video.isReadyForMoreMediaData {
            if let array=CMSampleBufferGetSampleAttachmentsArray(buffer,createIfNecessary:true) {
                let entry=unsafeBitCast(CFArrayGetValueAtIndex(array,0),to:CFMutableDictionary.self)
                CFDictionarySetValue(entry,Unmanaged.passUnretained(kCMSampleAttachmentKey_DisplayImmediately).toOpaque(),Unmanaged.passUnretained(kCFBooleanTrue).toOpaque())
            }
            video.enqueue(buffer);enqueued += 1
        }
    }
    func stream(_ stream:SCStream,didOutputSampleBuffer b:CMSampleBuffer,of type:SCStreamOutputType) {
        guard self.stream === stream,type == .screen else{return}
        guard let a=CMSampleBufferGetSampleAttachmentsArray(b,createIfNecessary:false) as? [[SCStreamFrameInfo:Any]],let raw=a.first?[.status] as? Int,SCFrameStatus(rawValue:raw) == .complete else{return}
        consume(b)
    }
    func stream(_ stream:SCStream,didStopWithError error:Error) {DispatchQueue.main.async{self.errors += 1;self.requestStats=error.localizedDescription}}
    func tick() {
        ticks += 1
        if !ready {setup()}
        if motion=="blink", ticks % 15 == 0 {source.spot.toggle();source.needsDisplay=true}
        if motion=="dynamic" {source.counter=(source.counter+1)&65535;generationTimes[source.counter]=now();source.needsDisplay=true}
        if ticks%30==0 {
            let state:[String:Any]=["metalComparisons":screenshots.metalComparisons,"cpuComparisons":screenshots.cpuComparisons,"pid":ProcessInfo.processInfo.processIdentifier,"ready":ready,"mode":mode,"motion":motion,"width":width,"height":height,"frames":frames,"enqueued":enqueued,"duplicates":duplicates,"invalid":invalid,"errors":errors,"error":requestStats,"elapsed":now()-begin,"lastFrameAge":lastFrame==0 ? -1:now()-lastFrame,"gapMs":gaps,"latencyMs":latency,"displays":displays.map{["id":Int($0.id),"width":$0.width,"height":$0.height]},"thermal":ProcessInfo.processInfo.thermalState.rawValue,"timestamp":Date().timeIntervalSince1970]
            if let data=try? JSONSerialization.data(withJSONObject:state) {try? data.write(to:root.appendingPathComponent("status.json"),options:.atomic)}
            gaps=[];latency=[]
        }
    }
    func stop() {screenshots.stop();stream?.stopCapture{_ in};stream=nil;for w in windows {w.orderOut(nil);w.close()};windows=[];displays=[];preparations=[]}
}
let bench=Bench();var command=""
let timer=Timer.scheduledTimer(withTimeInterval:1.0/30,repeats:true){_ in
    if let next=try? String(contentsOf:root.appendingPathComponent("command"),encoding:.utf8),next != command {
        if next=="quit" {bench.stop();app.terminate(nil)}
        if bench.ready {command=next;bench.change(next)}
    }
    bench.tick()
}
RunLoop.main.add(timer,forMode:.common)
app.run()

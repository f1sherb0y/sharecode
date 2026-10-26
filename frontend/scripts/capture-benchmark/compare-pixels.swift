import Foundation
import Metal
import CoreVideo
import Darwin

@main struct PixelComparisonExperiment {
    static func cpuTime() -> Double {
        var usage = rusage(); getrusage(RUSAGE_SELF, &usage)
        return Double(usage.ru_utime.tv_sec + usage.ru_stime.tv_sec) + Double(usage.ru_utime.tv_usec + usage.ru_stime.tv_usec) / 1_000_000
    }
    static func main() throws {
        let device = MTLCreateSystemDefaultDevice()!
        let queue = device.makeCommandQueue()!
        let library = try device.makeLibrary(source: """
        #include <metal_stdlib>
        using namespace metal;
        kernel void changed(texture2d<float, access::read> a [[texture(0)]],
                            texture2d<float, access::read> b [[texture(1)]],
                            device atomic_uint *result [[buffer(0)]],
                            uint2 xy [[thread_position_in_grid]]) {
            if (xy.x >= a.get_width() || xy.y >= a.get_height()) return;
            if (any(a.read(xy) != b.read(xy))) atomic_store_explicit(result, 1u, memory_order_relaxed);
        }
        """, options: nil)
        let pipeline = try device.makeComputePipelineState(function: library.makeFunction(name: "changed")!)
        var cache: CVMetalTextureCache?; CVMetalTextureCacheCreate(nil,nil,device,nil,&cache)
        let flag = device.makeBuffer(length: 4, options: .storageModeShared)!
        var results = [[String:Any]]()
        for width in [1920,3840] {
            let height = width * 9 / 16
            func buffer() -> CVPixelBuffer {
                var b: CVPixelBuffer?
                let options = [kCVPixelBufferIOSurfacePropertiesKey: [:], kCVPixelBufferMetalCompatibilityKey:true] as CFDictionary
                precondition(CVPixelBufferCreate(nil,width,height,kCVPixelFormatType_32BGRA,options,&b) == noErr)
                CVPixelBufferLockBaseAddress(b!,[])
                memset(CVPixelBufferGetBaseAddress(b!)!,114,CVPixelBufferGetBytesPerRow(b!)*height)
                CVPixelBufferUnlockBaseAddress(b!,[])
                return b!
            }
            let a=buffer(),b=buffer()
            func texture(_ p:CVPixelBuffer) -> CVMetalTexture {
                var t: CVMetalTexture?
                precondition(CVMetalTextureCacheCreateTextureFromImage(nil,cache!,p,nil,.bgra8Unorm,width,height,0,&t) == noErr)
                return t!
            }
            let ta=texture(a),tb=texture(b)
            for scenario in ["identical","first-pixel","last-pixel"] {
                CVPixelBufferLockBaseAddress(b,[])
                let p=CVPixelBufferGetBaseAddress(b)!,stride=CVPixelBufferGetBytesPerRow(b)
                memset(p,114,stride*height)
                if scenario != "identical" {p.storeBytes(of:UInt8(115),toByteOffset:scenario == "first-pixel" ? 0 : (height-1)*stride+(width-1)*4,as:UInt8.self)}
                CVPixelBufferUnlockBaseAddress(b,[])
                for method in ["memcmp","Metal"] {
                    func compare() -> Bool {
                        if method == "memcmp" {return !screenshotPixelsEqual(a,b)}
                        flag.contents().storeBytes(of: UInt32(0),as:UInt32.self)
                        let command=queue.makeCommandBuffer()!,encoder=command.makeComputeCommandEncoder()!
                        encoder.setComputePipelineState(pipeline);encoder.setTexture(CVMetalTextureGetTexture(ta),index:0);encoder.setTexture(CVMetalTextureGetTexture(tb),index:1);encoder.setBuffer(flag,offset:0,index:0)
                        encoder.dispatchThreads(MTLSize(width:width,height:height,depth:1),threadsPerThreadgroup:MTLSize(width:16,height:16,depth:1));encoder.endEncoding();command.commit();command.waitUntilCompleted()
                        precondition(command.status == .completed)
                        return flag.contents().load(as:UInt32.self) != 0
                    }
                    for _ in 0..<5 {precondition(compare() == (scenario != "identical"))}
                    let cpu=cpuTime(),wall=ProcessInfo.processInfo.systemUptime,count=100
                    for _ in 0..<count {precondition(compare() == (scenario != "identical"))}
                    results.append(["width":width,"height":height,"scenario":scenario,"method":method,"iterations":count,"cpuMsPerComparison":(cpuTime()-cpu)*1000/Double(count),"wallMsPerComparison":(ProcessInfo.processInfo.systemUptime-wall)*1000/Double(count)])
                }
            }
        }
        let data=try JSONSerialization.data(withJSONObject:results,options:[.prettyPrinted,.sortedKeys]);print(String(data:data,encoding:.utf8)!)
    }
}

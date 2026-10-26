// CGVirtualDisplay is a private CoreGraphics API. Resolve classes dynamically so
// an OS without the API can still launch the client. No driver or root helper.
// Interface reference: Chromium ui/display/mac/test/virtual_display_util_mac.mm.
#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>

@interface SCVirtualDescriptor : NSObject
@property unsigned int vendorID, productID, serialNum;
@property(strong) NSString *name;
@property CGSize sizeInMillimeters;
@property unsigned int maxPixelsWide, maxPixelsHigh;
@property CGPoint redPrimary, greenPrimary, bluePrimary, whitePoint;
@property(strong) dispatch_queue_t queue;
@end
@interface SCVirtualSettings : NSObject
@property(strong) NSArray *modes;
@property unsigned int hiDPI;
@end
@interface SCVirtualMode : NSObject
- (id)initWithWidth:(unsigned int)width height:(unsigned int)height refreshRate:(double)rate;
@end
@interface SCVirtualDisplay : NSObject
- (id)initWithDescriptor:(id)descriptor;
- (BOOL)applySettings:(id)settings;
@property(readonly) unsigned int displayID;
@end

// An app-specific EDID identity also keeps outputs from other client instances
// out of the source selector. Do not exclude unrelated virtual displays.
static const uint32_t vendor = 0x5343, product = 0x5343;

int32_t sharecode_virtual_display_available(void) {
    NSDictionary *interfaces = @{
        @"CGVirtualDisplayDescriptor": @[@"setVendorID:", @"setProductID:", @"setSerialNum:",
            @"setName:", @"setSizeInMillimeters:", @"setMaxPixelsWide:", @"setMaxPixelsHigh:",
            @"setRedPrimary:", @"setGreenPrimary:", @"setBluePrimary:", @"setWhitePoint:", @"setQueue:"],
        @"CGVirtualDisplaySettings": @[@"setModes:", @"setHiDPI:"],
        @"CGVirtualDisplayMode": @[@"initWithWidth:height:refreshRate:"],
        @"CGVirtualDisplay": @[@"initWithDescriptor:", @"applySettings:", @"displayID"]
    };
    for (NSString *name in interfaces) {
        Class cls = NSClassFromString(name);
        if (!cls) return 0;
        for (NSString *selector in interfaces[name])
            if (![cls instancesRespondToSelector:NSSelectorFromString(selector)]) return 0;
    }
    return 1;
}

int32_t sharecode_virtual_display_is_output(uint32_t displayID) {
    return CGDisplayVendorNumber(displayID) == vendor && CGDisplayModelNumber(displayID) == product;
}

void *sharecode_virtual_display_create(uint32_t width, uint32_t height, uint32_t *displayID) {
    *displayID = 0;
    if (!sharecode_virtual_display_available() || width < 2 || height < 2 || width > 3840 || height > 2160) return NULL;
    @try {
        SCVirtualDescriptor *descriptor = [[NSClassFromString(@"CGVirtualDisplayDescriptor") alloc] init];
        descriptor.name = @"secondary monitor";
        descriptor.vendorID = vendor;
        descriptor.productID = product;
        descriptor.serialNum = arc4random_uniform(UINT32_MAX - 1) + 1;
        descriptor.queue = dispatch_get_main_queue();
        descriptor.maxPixelsWide = width;
        descriptor.maxPixelsHigh = height;
        descriptor.sizeInMillimeters = CGSizeMake(width * 25.4 / 110, height * 25.4 / 110);
        descriptor.redPrimary = CGPointMake(0.64, 0.33);
        descriptor.greenPrimary = CGPointMake(0.30, 0.60);
        descriptor.bluePrimary = CGPointMake(0.15, 0.06);
        descriptor.whitePoint = CGPointMake(0.3127, 0.3290);
        SCVirtualDisplay *display = [[NSClassFromString(@"CGVirtualDisplay") alloc] initWithDescriptor:descriptor];
        SCVirtualSettings *settings = [[NSClassFromString(@"CGVirtualDisplaySettings") alloc] init];
        SCVirtualMode *mode = [[NSClassFromString(@"CGVirtualDisplayMode") alloc] initWithWidth:width / 2 height:height / 2 refreshRate:60];
        if (!display || !settings || !mode) return NULL;
        settings.hiDPI = 1; // Half-sized logical mode, full captured pixel resolution.
        settings.modes = @[mode];
        if (![display applySettings:settings] || !display.displayID) return NULL;
        *displayID = display.displayID;
        return (__bridge_retained void *)display;
    } @catch (NSException *exception) {
        return NULL;
    }
}

void sharecode_virtual_display_destroy(void *handle) {
    if (handle) { __unused id display = (__bridge_transfer id)handle; }
}

"""Send Return to the qualification app's native dialog, never another process."""
import ctypes as c
import sys

cg = c.CDLL('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')
cf = c.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
cg.CGEventCreateKeyboardEvent.restype = c.c_void_p
cg.CGEventCreateKeyboardEvent.argtypes = [c.c_void_p, c.c_ushort, c.c_bool]
cg.CGEventPostToPid.argtypes = [c.c_int, c.c_void_p]
cf.CFRelease.argtypes = [c.c_void_p]
for down in [True, False]:
    event = cg.CGEventCreateKeyboardEvent(None, 36, down)
    if not event:
        raise RuntimeError('Cannot create native Return event')
    cg.CGEventPostToPid(int(sys.argv[1]), event)
    cf.CFRelease(event)

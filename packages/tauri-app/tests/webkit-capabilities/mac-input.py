"""Native VM input helper: click X Y, key virtual-keycode, or text VALUE."""
import ctypes as c
import sys
import time

class Point(c.Structure):
    _fields_ = [('x', c.c_double), ('y', c.c_double)]

cg = c.CDLL('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')
cf = c.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
cg.CGEventCreateMouseEvent.argtypes = [c.c_void_p, c.c_uint32, Point, c.c_uint32]
cg.CGEventCreateMouseEvent.restype = c.c_void_p
cg.CGEventCreateKeyboardEvent.argtypes = [c.c_void_p, c.c_uint16, c.c_bool]
cg.CGEventCreateKeyboardEvent.restype = c.c_void_p
cg.CGEventKeyboardSetUnicodeString.argtypes = [c.c_void_p, c.c_ulong, c.c_void_p]
cg.CGEventPost.argtypes = [c.c_uint32, c.c_void_p]
cf.CFRelease.argtypes = [c.c_void_p]

def post(event):
    cg.CGEventPost(0, event)
    cf.CFRelease(event)
    time.sleep(0.05)

if sys.argv[1] == 'click':
    point = Point(float(sys.argv[2]), float(sys.argv[3]))
    for kind in (5, 1, 2):
        post(cg.CGEventCreateMouseEvent(None, kind, point, 0))
elif sys.argv[1] == 'key':
    for down in (True, False):
        post(cg.CGEventCreateKeyboardEvent(None, int(sys.argv[2]), down))
elif sys.argv[1] == 'text':
    text = sys.argv[2].encode('utf-16-le')
    buf = c.create_string_buffer(text)
    for down in (True, False):
        event = cg.CGEventCreateKeyboardEvent(None, 0, down)
        cg.CGEventKeyboardSetUnicodeString(event, len(text) // 2, buf)
        post(event)
else:
    raise ValueError('click, key or text required')

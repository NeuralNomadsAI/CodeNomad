"""Native VM input helper: click/right-click X Y, key virtual-keycode, or text VALUE."""
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
cg.CGEventSetFlags.argtypes = [c.c_void_p, c.c_uint64]
cf.CFRelease.argtypes = [c.c_void_p]

def post(event):
    cg.CGEventPost(0, event)
    cf.CFRelease(event)
    time.sleep(0.05)

if sys.argv[1] in ('click', 'right-click'):
    point = Point(float(sys.argv[2]), float(sys.argv[3]))
    right = sys.argv[1] == 'right-click'
    for kind in ((5, 3, 4) if right else (5, 1, 2)):
        post(cg.CGEventCreateMouseEvent(None, kind, point, 1 if right else 0))
elif sys.argv[1] == 'key':
    for down in (True, False):
        event = cg.CGEventCreateKeyboardEvent(None, int(sys.argv[2]), down)
        cg.CGEventSetFlags(event, 0)
        post(event)
elif sys.argv[1] == 'chord':
    for down in (True, False):
        event = cg.CGEventCreateKeyboardEvent(None, int(sys.argv[3]), down)
        cg.CGEventSetFlags(event, int(sys.argv[2], 0) if down else 0)
        post(event)
elif sys.argv[1] == 'drag':
    x, y, end_x, end_y = map(float, sys.argv[2:6])
    post(cg.CGEventCreateMouseEvent(None, 5, Point(x, y), 0))
    post(cg.CGEventCreateMouseEvent(None, 1, Point(x, y), 0))
    for step in range(1, 31):
        point = Point(x + (end_x - x) * step / 30, y + (end_y - y) * step / 30)
        post(cg.CGEventCreateMouseEvent(None, 6, point, 0))
    post(cg.CGEventCreateMouseEvent(None, 2, Point(end_x, end_y), 0))
elif sys.argv[1] == 'text':
    for character in sys.argv[2]:
        text = character.encode('utf-16-le')
        buf = c.create_string_buffer(text)
        for down in (True, False):
            event = cg.CGEventCreateKeyboardEvent(None, 0, down)
            cg.CGEventSetFlags(event, 0)
            cg.CGEventKeyboardSetUnicodeString(event, len(text) // 2, buf)
            post(event)
else:
    raise ValueError('click, right-click, key, chord, drag or text required')

"""Replay the engine's GL commands on Mesa EGL/GLES, without a browser.

This validates real shader compilation, linking and framebuffer rendering.
It is not web UI QA or a measurement of performance on a mobile GPU.
"""
import base64
import ctypes as C
import ctypes.util
import json
import sys
from pathlib import Path
from PIL import Image

trace=json.loads(Path(sys.argv[1]).read_text())
width,height=trace['width'],trace['height']
egl=C.CDLL(ctypes.util.find_library('EGL'))
egl.eglGetProcAddress.restype=C.c_void_p
egl.eglGetProcAddress.argtypes=[C.c_char_p]

def ep(name,result,args):
 fn=getattr(egl,name);fn.restype=result;fn.argtypes=args;return fn
def gl(name,result,args):
 pointer=egl.eglGetProcAddress(name.encode())
 if not pointer:raise RuntimeError('Missing GLES function '+name)
 return C.CFUNCTYPE(result,*args)(pointer)

I,U,F,B,P=C.c_int,C.c_uint,C.c_float,C.c_ubyte,C.c_void_p
display_fn=C.CFUNCTYPE(P,U,P,C.POINTER(I))(egl.eglGetProcAddress(b'eglGetPlatformDisplayEXT'))
display=display_fn(0x31DD,None,None)
major,minor=I(),I()
if not ep('eglInitialize',U,[P,C.POINTER(I),C.POINTER(I)])(display,C.byref(major),C.byref(minor)):raise RuntimeError('EGL initialization failed')
ep('eglBindAPI',U,[U])(0x30A0)
attributes=(I*15)(0x3033,1,0x3040,0x40,0x3024,8,0x3023,8,0x3022,8,0x3021,8,0x3025,24,0x3038)
config,count=P(),I()
ep('eglChooseConfig',U,[P,C.POINTER(I),C.POINTER(P),I,C.POINTER(I)])(display,attributes,C.byref(config),1,C.byref(count))
if not count.value:raise RuntimeError('No GLES3 pbuffer configuration')
surface=ep('eglCreatePbufferSurface',P,[P,P,C.POINTER(I)])(display,config,(I*5)(0x3057,width,0x3056,height,0x3038))
context=ep('eglCreateContext',P,[P,P,P,C.POINTER(I)])(display,config,None,(I*3)(0x3098,3,0x3038))
if not ep('eglMakeCurrent',U,[P,P,P,P])(display,surface,surface,context):raise RuntimeError('Could not activate GLES3 context')

handles={}
objects={'createTexture':'Textures','createFramebuffer':'Framebuffers','createBuffer':'Buffers','createVertexArray':'VertexArrays'}
simple={
 'activeTexture':[U],'attachShader':[U,U],'bindBuffer':[U,U],'bindFramebuffer':[U,U],'bindTexture':[U,U],'bindVertexArray':[U],
 'blendFunc':[U,U],'clear':[U],'clearColor':[F,F,F,F],'clearDepth':[F],'compileShader':[U],'deleteShader':[U],
 'depthFunc':[U],'depthMask':[B],'disable':[U],'drawArrays':[U,I,I],'drawElements':[U,I,U,P],
 'enable':[U],'enableVertexAttribArray':[U],'flush':[],'framebufferTexture2D':[U,U,U,U,I],
 'linkProgram':[U],'pixelStorei':[U,I],'texParameteri':[U,U,I],'texParameterf':[U,U,F],
 'uniform1f':[I,F],'uniform1i':[I,I],'uniform2f':[I,F,F],'useProgram':[U],'viewport':[I,I,I,I],
 'generateMipmap':[U],'vertexAttribPointer':[U,I,U,B,I,P],
}
get_error=gl('glGetError',U,[])
shader_count=program_count=0

def decode(arg):
 if arg is None:return 0
 if isinstance(arg,dict) and 'ref' in arg:return handles[arg['ref']]
 if isinstance(arg,dict) and 'bytes' in arg:return C.create_string_buffer(base64.b64decode(arg['bytes']))
 return arg
def check_status(kind,handle,property):
 result=I();gl('glGet'+kind+'iv',None,[U,U,C.POINTER(I)])(handle,property,C.byref(result))
 if not result.value:
  length=I();gl('glGet'+kind+'iv',None,[U,U,C.POINTER(I)])(handle,0x8B84,C.byref(length))
  message=C.create_string_buffer(max(1,length.value));gl('glGet'+kind+'InfoLog',None,[U,I,C.POINTER(I),P])(handle,len(message),None,message)
  raise RuntimeError(kind+' validation failed: '+message.value.decode(errors='replace'))

for index,command in enumerate(trace['commands']):
 name=command['name'];args=[decode(x) for x in command['args']];result=None
 if name in objects:
  value=U();gl('glGen'+objects[name],None,[I,C.POINTER(U)])(1,C.byref(value));result=value.value
 elif name=='createShader':result=gl('glCreateShader',U,[U])(*args);shader_count+=1
 elif name=='createProgram':result=gl('glCreateProgram',U,[])();program_count+=1
 elif name=='shaderSource':
  data=args[1].encode();pointer=C.c_char_p(data);length=I(len(data));gl('glShaderSource',None,[U,I,C.POINTER(C.c_char_p),C.POINTER(I)])(args[0],1,C.byref(pointer),C.byref(length))
 elif name=='getUniformLocation':result=gl('glGetUniformLocation',I,[U,C.c_char_p])(args[0],args[1].encode())
 elif name=='bufferData':
  data=args[1];gl('glBufferData',None,[U,C.c_ssize_t,P,U])(args[0],C.sizeof(data)-1,data,args[2])
 elif name=='texImage2D':gl('glTexImage2D',None,[U,I,I,I,I,I,U,U,P])(*args)
 elif name=='uniformMatrix4fv':gl('glUniformMatrix4fv',None,[I,I,B,P])(args[0],1,args[1],args[2])
 elif name in ['uniform2fv','uniform3fv','uniform4fv']:
  values=(F*len(args[1]))(*args[1]) if isinstance(args[1],list) else args[1]
  gl('gl'+name[0].upper()+name[1:],None,[I,I,P])(args[0],1,values)
 elif name in simple:
  entry='glClearDepthf' if name=='clearDepth' else 'gl'+name[0].upper()+name[1:]
  gl(entry,None,simple[name])(*args)
 else:raise RuntimeError('Unimplemented trace command '+name)
 if 'result' in command:handles[command['result']]=result
 if name=='compileShader':check_status('Shader',args[0],0x8B81)
 if name=='linkProgram':check_status('Program',args[0],0x8B82)
 error=get_error()
 if error:raise RuntimeError(f'GLES error {error:#x} at {index} {name}')

gl('glFinish',None,[])()
pixels=(B*(width*height*4))()
gl('glReadPixels',None,[I,I,I,I,U,U,P])(0,0,width,height,0x1908,0x1401,pixels)
Image.frombytes('RGBA',(width,height),bytes(pixels)).transpose(Image.Transpose.FLIP_TOP_BOTTOM).convert('RGB').save(sys.argv[2])
get_string=gl('glGetString',C.c_char_p,[U])
report={'engineTest':True,'browserVerified':False,'driver':get_string(0x1F01).decode(),'version':get_string(0x1F02).decode(),'compiledShaders':shader_count,'linkedPrograms':program_count,'image':sys.argv[2],'width':width,'height':height,'glError':get_error()}
print(json.dumps(report))
ep('eglMakeCurrent',U,[P,P,P,P])(display,None,None,None)
ep('eglDestroyContext',U,[P,P])(display,context)
ep('eglDestroySurface',U,[P,P])(display,surface)
ep('eglTerminate',U,[P])(display)

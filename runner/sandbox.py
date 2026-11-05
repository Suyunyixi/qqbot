"""Execute one Python script after applying process-level Linux restrictions."""
import ctypes
import errno
import os
import resource
import runpy
import sys


def restrict(network):
    resource.setrlimit(resource.RLIMIT_CPU, (900, 901))
    resource.setrlimit(resource.RLIMIT_FSIZE, (128 * 1024 * 1024, 128 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_NOFILE, (128, 128))
    lib = ctypes.CDLL('libseccomp.so.2', use_errno=True)
    lib.seccomp_init.argtypes = [ctypes.c_uint32]
    lib.seccomp_init.restype = ctypes.c_void_p
    lib.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    lib.seccomp_syscall_resolve_name.restype = ctypes.c_int
    lib.seccomp_rule_add.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint]
    lib.seccomp_load.argtypes = [ctypes.c_void_p]
    lib.seccomp_release.argtypes = [ctypes.c_void_p]
    ctx = lib.seccomp_init(0x7fff0000)  # SCMP_ACT_ALLOW
    if not ctx:
        raise RuntimeError('无法初始化脚本安全策略')
    try:
        denied = ['unshare', 'setns', 'ptrace', 'setsid', 'setpgid', 'kill', 'tkill', 'tgkill']
        if not network:
            denied += ['socket', 'connect', 'bind', 'listen', 'accept', 'accept4']
        for name in denied:
            number = lib.seccomp_syscall_resolve_name(name.encode())
            if number >= 0 and lib.seccomp_rule_add(ctx, 0x00050000 | errno.EPERM, number, 0) != 0:
                raise RuntimeError('无法设置脚本安全策略')
        if lib.seccomp_load(ctx) != 0:
            raise RuntimeError('无法启用脚本安全策略')
    finally:
        lib.seccomp_release(ctx)


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit('需要提供脚本路径')
    script = sys.argv[1]
    network = sys.argv[2] == '1'
    sys.argv = [script]
    sys.dont_write_bytecode = True
    sys.path.insert(0, os.path.dirname(script))
    restrict(network)
    if script.endswith('.sh'):
        os.execv('/bin/sh', ['/bin/sh', script])
    runpy.run_path(script, run_name='__main__')

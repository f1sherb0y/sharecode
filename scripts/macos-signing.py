#!/usr/bin/env python3
"""Stable, free macOS code identity. Never silently create or rotate release keys."""
import argparse
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import secrets
import shlex
import signal
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
PIN = ROOT / 'docs/macos/signing-identity.json'
LOCAL = Path.home() / '.tauri/sharecode-macos'


def run(args, **kwargs):
    # Do not echo commands: some security arguments contain temporary passwords.
    result = subprocess.run(args, capture_output=True, **kwargs)
    if result.returncode:
        raise RuntimeError(f'{Path(args[0]).name} {args[1]} failed (exit {result.returncode})')
    return result.stdout


def fingerprint(cert, algorithm):
    return hashlib.new(algorithm, cert).hexdigest().upper()


def initialize():
    if PIN.exists() or LOCAL.exists():
        raise RuntimeError('Signing identity already initialized. Restore the existing backup; never regenerate it.')
    LOCAL.mkdir(parents=True, mode=0o700)
    password = secrets.token_urlsafe(48)
    (LOCAL / 'password').write_text(password)
    env = dict(os.environ, SHARECODE_P12_PASSWORD=password)
    with tempfile.TemporaryDirectory(prefix='sharecode-cert-') as tmp:
        key, pem = str(Path(tmp) / 'key.pem'), str(Path(tmp) / 'cert.pem')
        run(['openssl', 'req', '-x509', '-newkey', 'rsa:3072', '-nodes', '-days', '10950',
             '-subj', '/CN=ShareCode Client Code Signing/', '-addext', 'extendedKeyUsage=codeSigning',
             '-addext', 'keyUsage=digitalSignature', '-keyout', key, '-out', pem])
        # Legacy P12 encryption is needed by macOS security import. The export is password protected.
        run(['openssl', 'pkcs12', '-export', '-legacy', '-inkey', key, '-in', pem,
             '-out', str(LOCAL / 'identity.p12'), '-passout', 'env:SHARECODE_P12_PASSWORD'], env=env)
        cert = run(['openssl', 'x509', '-in', pem, '-outform', 'DER'])
    for path in LOCAL.iterdir():
        path.chmod(0o600)
    PIN.write_text(json.dumps({'name': 'ShareCode Client Code Signing',
                              'sha1': fingerprint(cert, 'sha1'),
                              'sha256': fingerprint(cert, 'sha256'),
                              'identifier': 'dev.sharecode.client'}, indent=2) + '\n')
    print(f'Created persistent signing identity in {LOCAL}. Back up identity.p12 AND password securely.')
    print(f'Public identity pin: {PIN}')


def verify(app, identifier=None):
    pin = json.loads(PIN.read_text())
    identifier = identifier or pin['identifier']
    run(['codesign', '--verify', '--deep', '--strict', '--all-architectures', str(app)])
    with tempfile.TemporaryDirectory(prefix='sharecode-verify-') as tmp:
        # Validate every slice, including the non-native half of universal builds.
        import plistlib
        info = plistlib.loads((app / 'Contents/Info.plist').read_bytes())
        if info['CFBundleIdentifier'] != identifier:
            raise RuntimeError('Unexpected bundle identifier')
        binary = app / 'Contents/MacOS' / info['CFBundleExecutable']
        arches = run(['lipo', '-archs', str(binary)]).decode().split()
        for arch in arches:
            prefix = str(Path(tmp) / (arch + '-cert'))
            run(['codesign', '-d', '--arch', arch, '--extract-certificates=' + prefix, str(app)])
            cert = Path(prefix + '0').read_bytes()
            if fingerprint(cert, 'sha256') != pin['sha256']:
                raise RuntimeError(f'{arch}: signing certificate differs from the committed identity')
            # codesign writes display diagnostics to stderr, requirements to stdout.
            p = subprocess.run(['codesign', '-d', '--arch', arch, '-r-', str(app)], capture_output=True, text=True)
            requirement = next((line.removeprefix('designated => ') for line in (p.stdout + p.stderr).splitlines() if line.startswith('designated => ')), '')
            expected = f'identifier "{identifier}" and certificate leaf = H"{pin["sha1"].lower()}"'
            if p.returncode or requirement != expected:
                raise RuntimeError(f'{arch}: designated requirement changed: {requirement}')
    print(f'Verified fixed certificate and designated requirement: {app}')


def with_identity(command, build_umask):
    pin = json.loads(PIN.read_text())
    env = dict(os.environ)
    encoded = env.pop('SHARECODE_MACOS_CERTIFICATE_BASE64', None)
    password = env.pop('SHARECODE_MACOS_CERTIFICATE_PASSWORD', None)
    if encoded is not None or password is not None:
        if not encoded or not password:
            raise RuntimeError('Both SHARECODE_MACOS_CERTIFICATE_BASE64 and SHARECODE_MACOS_CERTIFICATE_PASSWORD are required')
        payload = base64.b64decode(encoded, validate=True)
    else:
        if env.get('CI') or not (LOCAL / 'identity.p12').is_file():
            raise RuntimeError(f'Missing fixed signing identity. Restore {LOCAL}, or configure the two SHARECODE_MACOS_CERTIFICATE_* secrets. No ad-hoc fallback.')
        payload = (LOCAL / 'identity.p12').read_bytes()
        password = (LOCAL / 'password').read_text().strip()
    # The user keychain search list is shared by all builds. Serialize its changes.
    with open(Path.home() / '.tauri/sharecode-macos-signing.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        with tempfile.TemporaryDirectory(prefix='sharecode-signing-') as tmp:
            tmp = Path(tmp)
            p12, keychain = tmp / 'identity.p12', tmp / 'build.keychain-db'
            p12.write_bytes(payload)
            p12.chmod(0o600)
            original = shlex.split(run(['security', 'list-keychains', '-d', 'user']).decode())
            keychain_password = secrets.token_urlsafe(32)
            created = False
            previous_handler = signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
            try:
                run(['security', 'create-keychain', '-p', keychain_password, str(keychain)])
                created = True
                run(['security', 'set-keychain-settings', '-lut', '21600', str(keychain)])
                run(['security', 'unlock-keychain', '-p', keychain_password, str(keychain)])
                run(['security', 'import', str(p12), '-k', str(keychain), '-P', password, '-T', '/usr/bin/codesign'])
                run(['security', 'set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', keychain_password, str(keychain)])
                pem = run(['security', 'find-certificate', '-c', pin['name'], '-p', str(keychain)])
                cert = run(['openssl', 'x509', '-outform', 'DER'], input=pem)
                if fingerprint(cert, 'sha256') != pin['sha256'] or fingerprint(cert, 'sha1') != pin['sha1']:
                    raise RuntimeError('Certificate does not match committed identity; refusing to build')
                run(['security', 'list-keychains', '-d', 'user', '-s', *original, str(keychain)])
                for name in list(env):
                    if name.startswith('APPLE_'):
                        env.pop(name)
                env['APPLE_SIGNING_IDENTITY'] = pin['sha1']
                env['APPLE_SIGNING_KEYCHAIN'] = str(keychain)
                env['SHARECODE_SIGNING_KEYCHAIN'] = str(keychain)
                # Direct exec arguments, not shell interpolation; child receives no P12 secrets.
                # Protect key material without changing app/DMG permissions for other users.
                os.umask(build_umask)
                try:
                    return subprocess.call(command, env=env)
                finally:
                    os.umask(0o077)
            finally:
                try:
                    run(['security', 'list-keychains', '-d', 'user', '-s', *original])
                finally:
                    if created:
                        run(['security', 'delete-keychain', str(keychain)])
                    signal.signal(signal.SIGTERM, previous_handler)


def main():
    build_umask = os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    sub.add_parser('init', help='One-time initialization only; refuses replacement')
    verify_parser = sub.add_parser('verify')
    verify_parser.add_argument('app', type=Path)
    verify_parser.add_argument('--identifier', help='Isolated test identity; default is production')
    run_parser = sub.add_parser('run')
    run_parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.action == 'init':
        initialize()
    elif args.action == 'verify':
        verify(args.app, args.identifier)
    else:
        command = args.command
        if command and command[0] == '--':
            command = command[1:]
        if not command:
            parser.error('run requires a command')
        LOCAL.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        return with_identity(command, build_umask)
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (RuntimeError, OSError, ValueError) as error:
        print(f'macOS signing: {error}', file=sys.stderr)
        sys.exit(1)
